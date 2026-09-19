import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/db/settings";
import {
	createDeviceUnlockAdapter,
	type DeviceUnlockAdapter,
	DeviceUnlockCancelledError,
	DeviceUnlockService,
	type NativeKeyProtectionPlugin,
} from "@/security/device-unlock";

const defaults: AppSettings = {
	timezone: "UTC",
	weeklyReviewEnabled: false,
	weeklyReviewHour: 20,
	biometricEnabled: false,
	appearance: "system",
};

function native(overrides: Partial<NativeKeyProtectionPlugin> = {}): NativeKeyProtectionPlugin {
	return {
		prepareKeyAccess: vi.fn(async () => ({ enabled: false, authenticated: false })),
		getKeyProtectionStatus: vi.fn(async () => ({ enabled: false, available: true })),
		setKeyProtection: vi.fn(async ({ enabled }) => ({ status: "changed", enabled })),
		authenticateSession: vi.fn(async () => ({ status: "authenticated" })),
		...overrides,
	};
}

function settings(initial: AppSettings = defaults) {
	let current = initial;
	return {
		get: vi.fn(async () => current),
		update: vi.fn(async (patch: Partial<AppSettings>) => {
			current = { ...current, ...patch };
			return current;
		}),
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function invoke(
	adapter: DeviceUnlockAdapter,
	method: keyof NativeKeyProtectionPlugin,
): Promise<unknown> {
	switch (method) {
		case "prepareKeyAccess":
			return adapter.prepare();
		case "getKeyProtectionStatus":
			return adapter.status();
		case "setKeyProtection":
			return adapter.setEnabled(true);
		case "authenticateSession":
			return adapter.authenticate();
		default:
			throw new Error(`Unexpected native method: ${String(method)}`);
	}
}

describe("device unlock native adapter: strict exact response parsing", () => {
	it("accepts exact prepare/status/set/authenticate responses", async () => {
		const plugin = native({
			prepareKeyAccess: vi.fn(async () => ({ enabled: true, authenticated: true })),
			getKeyProtectionStatus: vi.fn(async () => ({ enabled: true, available: true })),
		});
		const adapter = createDeviceUnlockAdapter(plugin);
		expect(await adapter.prepare()).toEqual({ enabled: true, authenticated: true });
		expect(await adapter.status()).toEqual({ enabled: true, available: true });
		expect(await adapter.setEnabled(false)).toEqual({ status: "changed", enabled: false });
		expect(await adapter.authenticate()).toBe("authenticated");
		expect(plugin.setKeyProtection).toHaveBeenCalledWith({ enabled: false });
	});

	it.each([
		[
			"prepare extra field",
			"prepareKeyAccess",
			{ enabled: false, authenticated: false, secret: "x" },
		],
		["prepare wrong type", "prepareKeyAccess", { enabled: 0, authenticated: false }],
		["status missing field", "getKeyProtectionStatus", { enabled: false }],
		[
			"status extra field",
			"getKeyProtectionStatus",
			{ enabled: false, available: true, mode: "x" },
		],
		["set unknown status", "setKeyProtection", { status: "ok", enabled: true }],
		["set extra field", "setKeyProtection", { status: "changed", enabled: true, passphrase: "x" }],
		["auth unknown status", "authenticateSession", { status: "ok" }],
		["auth extra field", "authenticateSession", { status: "authenticated", secret: "x" }],
	] as const)("rejects malformed %s without echoing values", async (_label, method, result) => {
		const plugin = native({ [method]: vi.fn(async () => result) });
		const adapter = createDeviceUnlockAdapter(plugin);
		const operation = invoke(adapter, method);
		await expect(operation).rejects.toThrow("Device security returned an invalid response.");
		await expect(operation).rejects.not.toThrow(/secret|passphrase|mode|\bx\b/i);
	});

	it.each([
		{ enabled: true, authenticated: false },
		{ enabled: false, authenticated: true },
	])("rejects an impossible prepare state %#", async (result) => {
		const adapter = createDeviceUnlockAdapter(
			native({ prepareKeyAccess: vi.fn(async () => result) }),
		);
		await expect(adapter.prepare()).rejects.toThrow(
			"Device security returned an invalid response.",
		);
	});

	it("maps native cancellation to a typed transient error and masks every other rejection", async () => {
		const cancelled = createDeviceUnlockAdapter(
			native({
				prepareKeyAccess: vi.fn(async () =>
					Promise.reject({ code: "key_protection_cancelled", message: "raw native cancellation" }),
				),
			}),
		);
		await expect(cancelled.prepare()).rejects.toBeInstanceOf(DeviceUnlockCancelledError);

		const failed = createDeviceUnlockAdapter(
			native({
				getKeyProtectionStatus: vi.fn(async () =>
					Promise.reject(new Error("keystore alias at /data/user/0 secret")),
				),
			}),
		);
		await expect(failed.status()).rejects.toThrow("Device security is unavailable.");
		await expect(failed.status()).rejects.not.toThrow(/keystore|\/data|secret/i);
	});

	it.each([
		["prepare", "prepareKeyAccess", "KeyPermanentlyInvalidatedException"],
		["status", "getKeyProtectionStatus", "protected alias is missing"],
		["set", "setKeyProtection", "conflicting passphrase copies"],
		["session", "authenticateSession", "keystore path /data/user/0"],
	] as const)("masks %s key-loss and invalidation failures", async (_label, method, detail) => {
		const plugin = native({
			[method]: vi.fn(async () =>
				Promise.reject({ code: "key_protection_state", message: detail }),
			),
		});
		const operation = invoke(createDeviceUnlockAdapter(plugin), method);
		await expect(operation).rejects.toThrow("Device security is unavailable.");
		await expect(operation).rejects.not.toThrow(/invalidated|alias|passphrase|keystore|\/data/i);
	});

	it("treats set/auth cancellation as normal exact results", async () => {
		const adapter = createDeviceUnlockAdapter(
			native({
				setKeyProtection: vi.fn(async () => ({ status: "cancelled", enabled: false })),
				authenticateSession: vi.fn(async () => ({ status: "cancelled" })),
			}),
		);
		expect(await adapter.setEnabled(true)).toEqual({ status: "cancelled", enabled: false });
		expect(await adapter.authenticate()).toBe("cancelled");
	});
});

describe("DeviceUnlockService", () => {
	it("mirrors a changed native state then publishes only after the settings commit", async () => {
		const order: string[] = [];
		const repository = settings();
		repository.update.mockImplementation(async (patch) => {
			order.push("settings");
			return { ...defaults, ...patch };
		});
		const publish = vi.fn(() => order.push("publish"));
		const adapter: DeviceUnlockAdapter = {
			prepare: vi.fn(),
			status: vi.fn(async () => ({ enabled: false, available: true })),
			setEnabled: vi.fn(async () => {
				order.push("native");
				return { status: "changed", enabled: true } as const;
			}),
			authenticate: vi.fn(),
		};
		const service = new DeviceUnlockService(adapter, repository, publish);

		expect(await service.setEnabled(true)).toEqual({ status: "changed", enabled: true });
		expect(repository.update).toHaveBeenCalledWith({ biometricEnabled: true });
		expect(order).toEqual(["native", "settings", "publish"]);
		expect(publish).toHaveBeenCalledOnce();
	});

	it("does not write or publish on cancellation", async () => {
		const repository = settings();
		const publish = vi.fn();
		const adapter: DeviceUnlockAdapter = {
			prepare: vi.fn(),
			status: vi.fn(),
			setEnabled: vi.fn(async () => ({ status: "cancelled", enabled: false }) as const),
			authenticate: vi.fn(),
		};
		const service = new DeviceUnlockService(adapter, repository, publish);
		expect(await service.setEnabled(true)).toEqual({ status: "cancelled", enabled: false });
		expect(repository.update).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
	});

	it("rejects a native result that does not match the requested target", async () => {
		const repository = settings();
		const service = new DeviceUnlockService(
			{
				prepare: vi.fn(),
				status: vi.fn(),
				setEnabled: vi.fn(async () => ({ status: "changed", enabled: false }) as const),
				authenticate: vi.fn(),
			},
			repository,
			vi.fn(),
		);
		await expect(service.setEnabled(true)).rejects.toThrow(/did not match/i);
		expect(repository.update).not.toHaveBeenCalled();
	});

	it("reconciles the SQLite mirror to native authority and skips an equal mirror", async () => {
		const repository = settings({ ...defaults, biometricEnabled: true });
		const publish = vi.fn();
		const status = vi.fn(async () => ({ enabled: false, available: true }));
		const service = new DeviceUnlockService(
			{ prepare: vi.fn(), status, setEnabled: vi.fn(), authenticate: vi.fn() },
			repository,
			publish,
		);
		expect(await service.reconcile()).toEqual({ enabled: false, available: true });
		expect(repository.update).toHaveBeenCalledWith({ biometricEnabled: false });
		expect(publish).toHaveBeenCalledOnce();

		repository.update.mockClear();
		publish.mockClear();
		expect(await service.reconcile()).toEqual({ enabled: false, available: true });
		expect(repository.update).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
	});

	it("publishes nothing on mirror failure and later reconciliation repairs it", async () => {
		const repository = settings();
		repository.update.mockRejectedValueOnce(new Error("disk failure"));
		const publish = vi.fn();
		const service = new DeviceUnlockService(
			{
				prepare: vi.fn(),
				status: vi.fn(async () => ({ enabled: true, available: true })),
				setEnabled: vi.fn(async () => ({ status: "changed", enabled: true }) as const),
				authenticate: vi.fn(),
			},
			repository,
			publish,
		);
		await expect(service.setEnabled(true)).rejects.toThrow("disk failure");
		expect(publish).not.toHaveBeenCalled();
		expect(await service.reconcile()).toEqual({ enabled: true, available: true });
		expect(repository.update).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenCalledOnce();
	});

	it("serializes in-process authentication and returns its typed outcome", async () => {
		const authenticate = vi
			.fn()
			.mockResolvedValueOnce("authenticated")
			.mockResolvedValueOnce("cancelled");
		const service = new DeviceUnlockService(
			{ prepare: vi.fn(), status: vi.fn(), setEnabled: vi.fn(), authenticate },
			settings(),
			vi.fn(),
		);
		expect(await service.authenticateSession()).toBe("authenticated");
		expect(await service.authenticateSession()).toBe("cancelled");
		expect(authenticate).toHaveBeenCalledTimes(2);
	});

	it("serializes native operations and recovers its queue after rejection", async () => {
		const first = deferred<{ status: "changed"; enabled: true }>();
		const setEnabled = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockRejectedValueOnce(new Error("second failed"))
			.mockResolvedValueOnce({ status: "cancelled", enabled: true });
		const repository = settings();
		const service = new DeviceUnlockService(
			{ prepare: vi.fn(), status: vi.fn(), setEnabled, authenticate: vi.fn() },
			repository,
			vi.fn(),
		);
		const one = service.setEnabled(true);
		const two = service.setEnabled(false);
		const three = service.setEnabled(false);
		await Promise.resolve();
		expect(setEnabled).toHaveBeenCalledTimes(1);
		first.resolve({ status: "changed", enabled: true });
		await expect(one).resolves.toEqual({ status: "changed", enabled: true });
		await expect(two).rejects.toThrow("second failed");
		await expect(three).resolves.toEqual({ status: "cancelled", enabled: true });
		expect(setEnabled).toHaveBeenCalledTimes(3);
	});

	it("disposal invalidates a pending completion before it can mirror or publish", async () => {
		const pending = deferred<{ status: "changed"; enabled: true }>();
		const repository = settings();
		const publish = vi.fn();
		const service = new DeviceUnlockService(
			{
				prepare: vi.fn(),
				status: vi.fn(),
				setEnabled: vi.fn(() => pending.promise),
				authenticate: vi.fn(),
			},
			repository,
			publish,
		);
		const operation = service.setEnabled(true);
		service.dispose();
		pending.resolve({ status: "changed", enabled: true });
		await expect(operation).rejects.toThrow(/closed/i);
		expect(repository.update).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
		await expect(service.getStatus()).rejects.toThrow(/closed/i);
	});
});
