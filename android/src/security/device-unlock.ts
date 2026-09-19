import { CapacitorSQLite } from "@capacitor-community/sqlite";
import type { AppSettings } from "@/db/settings";

export interface NativeKeyProtectionPlugin {
	prepareKeyAccess(): Promise<unknown>;
	getKeyProtectionStatus(): Promise<unknown>;
	setKeyProtection(options: { enabled: boolean }): Promise<unknown>;
	authenticateSession(): Promise<unknown>;
}

export interface DeviceUnlockStatus {
	enabled: boolean;
	available: boolean;
}

export interface DeviceUnlockChange {
	status: "changed" | "cancelled";
	enabled: boolean;
}

export interface DeviceUnlockAdapter {
	prepare(): Promise<{ enabled: boolean; authenticated: boolean }>;
	status(): Promise<DeviceUnlockStatus>;
	setEnabled(enabled: boolean): Promise<DeviceUnlockChange>;
	authenticate(): Promise<"authenticated" | "cancelled">;
}

interface DeviceUnlockSettings {
	get(): Promise<AppSettings>;
	update(patch: Partial<AppSettings>): Promise<AppSettings>;
}

const INVALID_RESPONSE = "Device security returned an invalid response.";
const NATIVE_UNAVAILABLE = "Device security is unavailable.";
const SERVICE_CLOSED = "Device security service is closed.";

export class DeviceUnlockCancelledError extends Error {
	readonly code = "device_unlock_cancelled";

	constructor() {
		super("Device authentication was cancelled.");
		this.name = "DeviceUnlockCancelledError";
	}
}

export function isDeviceUnlockCancelled(error: unknown): boolean {
	return (
		error instanceof DeviceUnlockCancelledError ||
		(error !== null &&
			typeof error === "object" &&
			(error as { code?: unknown }).code === "device_unlock_cancelled")
	);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(INVALID_RESPONSE);
	}
	const actual = Object.keys(value).sort((a, b) => a.localeCompare(b));
	const expected = [...keys].sort((a, b) => a.localeCompare(b));
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(INVALID_RESPONSE);
	}
	return value as Record<string, unknown>;
}

function boolean(value: unknown): boolean {
	if (value !== true && value !== false) throw new Error(INVALID_RESPONSE);
	return value;
}

function nativeCode(error: unknown): string | null {
	if (error === null || typeof error !== "object" || Array.isArray(error)) return null;
	const code = (error as Record<string, unknown>).code;
	return typeof code === "string" ? code : null;
}

async function nativeResult(call: () => Promise<unknown>): Promise<unknown> {
	try {
		return await call();
	} catch (error) {
		if (nativeCode(error) === "key_protection_cancelled") {
			throw new DeviceUnlockCancelledError();
		}
		throw new Error(NATIVE_UNAVAILABLE);
	}
}

export function createDeviceUnlockAdapter(plugin: NativeKeyProtectionPlugin): DeviceUnlockAdapter {
	return {
		async prepare() {
			const result = record(await nativeResult(() => plugin.prepareKeyAccess()), [
				"enabled",
				"authenticated",
			]);
			const enabled = boolean(result.enabled);
			const authenticated = boolean(result.authenticated);
			if (enabled !== authenticated) throw new Error(INVALID_RESPONSE);
			return { enabled, authenticated };
		},
		async status() {
			const result = record(await nativeResult(() => plugin.getKeyProtectionStatus()), [
				"enabled",
				"available",
			]);
			return { enabled: boolean(result.enabled), available: boolean(result.available) };
		},
		async setEnabled(enabled) {
			const result = record(await nativeResult(() => plugin.setKeyProtection({ enabled })), [
				"status",
				"enabled",
			]);
			if (result.status !== "changed" && result.status !== "cancelled") {
				throw new Error(INVALID_RESPONSE);
			}
			return { status: result.status, enabled: boolean(result.enabled) };
		},
		async authenticate() {
			const result = record(await nativeResult(() => plugin.authenticateSession()), ["status"]);
			if (result.status !== "authenticated" && result.status !== "cancelled") {
				throw new Error(INVALID_RESPONSE);
			}
			return result.status;
		},
	};
}

export function createNativeDeviceUnlockAdapter(): DeviceUnlockAdapter {
	// SAFETY: the pinned CapacitorSQLite Java plugin implements these four
	// app-owned methods; the package proxy dispatches method names dynamically,
	// while its upstream TypeScript declaration intentionally remains untouched.
	return createDeviceUnlockAdapter(CapacitorSQLite as unknown as NativeKeyProtectionPlugin);
}

/** Inert test/non-native seam. It never pretends system authentication exists. */
export function createUnavailableDeviceUnlockAdapter(): DeviceUnlockAdapter {
	return {
		prepare: async () => ({ enabled: false, authenticated: false }),
		status: async () => ({ enabled: false, available: false }),
		setEnabled: async () => {
			throw new Error(NATIVE_UNAVAILABLE);
		},
		authenticate: async () => {
			throw new Error(NATIVE_UNAVAILABLE);
		},
	};
}

/**
 * Serializes native key-protection changes and mirrors native authority into
 * SQLite only after the native transition succeeds. It never handles the
 * SQLCipher passphrase; the bridge exposes status booleans only.
 */
export class DeviceUnlockService {
	private tail: Promise<unknown> = Promise.resolve();
	private closed = false;
	private epoch = 0;

	constructor(
		private readonly adapter: DeviceUnlockAdapter,
		private readonly settings: DeviceUnlockSettings,
		private readonly publishCommittedSettings: () => void,
	) {}

	getStatus(): Promise<DeviceUnlockStatus> {
		return this.enqueue((check) => this.readStatus(check));
	}

	authenticateSession(): Promise<"authenticated" | "cancelled"> {
		return this.enqueue(async (check) => {
			const result = await this.adapter.authenticate();
			check();
			return result;
		});
	}

	setEnabled(enabled: boolean): Promise<DeviceUnlockChange> {
		return this.enqueue(async (check) => {
			const result = await this.adapter.setEnabled(enabled);
			check();
			if (result.status === "cancelled") return result;
			if (result.enabled !== enabled) {
				throw new Error("Native key-protection result did not match the requested state.");
			}
			await this.mirror(result.enabled, check);
			return result;
		});
	}

	reconcile(): Promise<DeviceUnlockStatus> {
		return this.enqueue(async (check) => {
			const status = await this.readStatus(check);
			await this.mirror(status.enabled, check);
			return status;
		});
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.epoch += 1;
	}

	private async readStatus(check: () => void): Promise<DeviceUnlockStatus> {
		const status = await this.adapter.status();
		check();
		return status;
	}

	private async mirror(enabled: boolean, check: () => void): Promise<void> {
		const current = await this.settings.get();
		check();
		if (current.biometricEnabled === enabled) return;
		await this.settings.update({ biometricEnabled: enabled });
		// The write is durable now. Publication must occur even if disposal races
		// after commit; listeners need to converge on the committed mirror.
		this.publishCommittedSettings();
	}

	private enqueue<T>(operation: (check: () => void) => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Error(SERVICE_CLOSED));
		const operationEpoch = this.epoch;
		const check = () => {
			if (this.closed || operationEpoch !== this.epoch) throw new Error(SERVICE_CLOSED);
		};
		const run = this.tail.then(async () => {
			check();
			return operation(check);
		});
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}
