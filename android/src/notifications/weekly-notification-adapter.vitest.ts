import { describe, expect, it, vi } from "vitest";
import {
	createNoopWeeklyNotificationAdapter,
	createWeeklyNotificationAdapter,
	type NotificationPermissionResult,
	type WeeklyNotificationAction,
	type WeeklyNotificationSettings,
} from "./weekly-notification-adapter";

const settings: WeeklyNotificationSettings = {
	enabled: true,
	hour: 9,
	timezone: "Europe/London",
};

function action(id: string): WeeklyNotificationAction {
	return { id, route: "/weekly" };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: Error) => void;
	const promise = new Promise<T>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, resolve, reject };
}

async function settle(): Promise<void> {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function fakePlugin(actions: WeeklyNotificationAction[] = []) {
	let warmListener: ((next: WeeklyNotificationAction) => void) | undefined;
	const removalSettled: Promise<void>[] = [];
	const addListener = vi.fn(
		async (_event: string, listener: (next: WeeklyNotificationAction) => void) => {
			warmListener = listener;
			const removal = deferred<void>();
			removalSettled.push(removal.promise);
			return {
				remove: vi.fn(async () => {
					removal.resolve();
				}),
			};
		},
	);
	const consumePendingActions = vi.fn(async () => ({ actions: [...actions] }));
	const acknowledgeAction = vi.fn(async ({ id }: { id: string }) => {
		const index = actions.findIndex((item) => item.id === id);
		if (index >= 0) actions.splice(index, 1);
	});
	return {
		reconcile: vi.fn(async () => ({ scheduled: true, caughtUp: false })),
		getPermissionStatus: vi.fn(
			async (): Promise<NotificationPermissionResult> => ({
				status: "granted",
				blockedAt: null,
			}),
		),
		requestPermission: vi.fn(
			async (): Promise<NotificationPermissionResult> => ({
				status: "granted",
				blockedAt: null,
			}),
		),
		openNotificationSettings: vi.fn(async () => {}),
		addListener,
		consumePendingActions,
		acknowledgeAction,
		removalSettled,
		emit(next: WeeklyNotificationAction) {
			warmListener?.(next);
		},
	};
}

describe("weekly notification adapter public delegation", () => {
	it("forwards settings, permission calls, and exact native event payloads", async () => {
		const plugin = fakePlugin([{ id: "cold-1", route: "/weekly" }]);
		const adapter = createWeeklyNotificationAdapter(plugin);
		const listener = vi.fn();

		expect(await adapter.reconcile(settings)).toEqual({ scheduled: true, caughtUp: false });
		expect(await adapter.getPermissionStatus()).toEqual({ status: "granted", blockedAt: null });
		expect(await adapter.requestPermission()).toEqual({ status: "granted", blockedAt: null });
		await adapter.openNotificationSettings();
		await adapter.addActionListener(listener);

		expect(plugin.reconcile).toHaveBeenCalledWith(settings);
		expect(plugin.addListener).toHaveBeenCalledWith(
			"weeklyNotificationAction",
			expect.any(Function),
		);
		expect(plugin.consumePendingActions).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith({ id: "cold-1", route: "/weekly" });
		expect(plugin.acknowledgeAction).toHaveBeenCalledWith({ id: "cold-1" });
	});

	it("keeps consume and acknowledgement off the public adapter surface", () => {
		const adapter = createWeeklyNotificationAdapter(fakePlugin());
		expect(adapter).not.toHaveProperty("consumePendingActions");
		expect(adapter).not.toHaveProperty("acknowledgeAction");
	});
});

describe("weekly notification adapter action state machine", () => {
	it("delivers warm actions, preserves FIFO, and caps one consume batch at eight unique IDs", async () => {
		const plugin = fakePlugin(Array.from({ length: 10 }, (_, index) => action(`id-${index}`)));
		const seen: string[] = [];
		const adapter = createWeeklyNotificationAdapter(plugin);
		await adapter.addActionListener((next) => {
			seen.push(next.id);
		});

		plugin.emit(action("warm-after-cold"));
		await settle();

		expect(seen).toEqual(["id-0", "id-1", "id-2", "id-3", "id-4", "id-5", "id-6", "id-7"]);
		expect(plugin.acknowledgeAction).toHaveBeenCalledTimes(8);
	});

	it("does not let installation duplicates consume cap slots", async () => {
		const retained = Array.from({ length: 7 }, (_, index) => action(`retained-${index}`));
		const plugin = fakePlugin();
		plugin.consumePendingActions
			.mockResolvedValueOnce({ actions: retained })
			.mockResolvedValueOnce({ actions: [] });
		const seen: string[] = [];
		let retain = true;
		const callback = vi.fn((next: WeeklyNotificationAction) => {
			if (retain) return Promise.reject(new Error("retain"));
			seen.push(next.id);
		});
		const adapter = createWeeklyNotificationAdapter(plugin);

		const remove = await adapter.addActionListener(callback);
		await settle();
		remove();
		await plugin.removalSettled[0];
		retain = false;

		plugin.addListener.mockImplementationOnce(async (_event, listener) => {
			listener(action("retained-0"));
			listener(action("unique-after-duplicate"));
			return { remove: vi.fn(async () => {}) };
		});
		await adapter.addActionListener(callback);
		await settle();

		expect(seen).toEqual([...retained.map((item) => item.id), "unique-after-duplicate"]);
	});

	it("keeps the current binding after a retired registration fails", async () => {
		const plugin = fakePlugin();
		const registration = deferred<Awaited<ReturnType<typeof plugin.addListener>>>();
		const registrationError = new Error("registration failed");
		plugin.addListener.mockImplementationOnce(async () => registration.promise);
		const adapter = createWeeklyNotificationAdapter(plugin);
		const retired = adapter.addActionListener(vi.fn());
		await Promise.resolve();

		const currentListener = vi.fn();
		await adapter.addActionListener(currentListener);
		registration.reject(registrationError);

		await expect(retired).rejects.toBe(registrationError);
		plugin.emit(action("warm-after-retired-registration-failure"));
		await settle();

		expect(plugin.consumePendingActions).toHaveBeenCalledTimes(1);
		expect(currentListener).toHaveBeenCalledWith({
			id: "warm-after-retired-registration-failure",
			route: "/weekly",
		});
	});

	it("removes a retired handle after deferred consume failure without stopping the current binding", async () => {
		const plugin = fakePlugin();
		const firstHandle = { remove: vi.fn(async () => {}) };
		const consume = deferred<{ actions: WeeklyNotificationAction[] }>();
		const consumeError = new Error("consume failed");
		plugin.addListener.mockImplementationOnce(async () => firstHandle);
		plugin.consumePendingActions.mockImplementationOnce(() => consume.promise);
		const adapter = createWeeklyNotificationAdapter(plugin);
		const retired = adapter.addActionListener(vi.fn());
		await settle();

		const currentListener = vi.fn();
		await adapter.addActionListener(currentListener);
		consume.reject(consumeError);

		await expect(retired).rejects.toBe(consumeError);
		expect(firstHandle.remove).toHaveBeenCalledTimes(1);
		plugin.emit(action("warm-after-retired-consume-failure"));
		await settle();

		expect(currentListener).toHaveBeenCalledWith({
			id: "warm-after-retired-consume-failure",
			route: "/weekly",
		});
	});

	it("removes an acquired native listener when consuming actions fails", async () => {
		const plugin = fakePlugin();
		const consumeError = new Error("consume failed");
		const removeError = new Error("remove failed");
		const remove = vi.fn(async () => {
			throw removeError;
		});
		plugin.addListener.mockImplementationOnce(async () => ({ remove }));
		plugin.consumePendingActions.mockRejectedValueOnce(consumeError);
		const adapter = createWeeklyNotificationAdapter(plugin);

		await expect(adapter.addActionListener(vi.fn())).rejects.toBe(consumeError);
		expect(remove).toHaveBeenCalledTimes(1);
	});

	it("queues a tap during installation and pumps it after consume in FIFO order", async () => {
		const removeHandle = vi.fn(async () => {});
		const installation = deferred<{ remove: typeof removeHandle }>();
		const plugin = fakePlugin([action("cold")]);
		plugin.addListener.mockImplementationOnce(async (_event, listener) => {
			listener(action("during-install"));
			return installation.promise;
		});
		const seen: string[] = [];
		const pending = createWeeklyNotificationAdapter(plugin).addActionListener((next) => {
			seen.push(next.id);
		});
		await Promise.resolve();
		expect(seen).toEqual([]);
		installation.resolve({ remove: removeHandle });
		await pending;
		await settle();
		expect(seen).toEqual(["cold", "during-install"]);
	});

	it("rebuffers callback failure and retries it on the next bind without native replay", async () => {
		const plugin = fakePlugin([action("retry")]);
		const callback = vi
			.fn()
			.mockRejectedValueOnce(new Error("callback failed"))
			.mockResolvedValue(undefined);
		const adapter = createWeeklyNotificationAdapter(plugin);
		const remove = await adapter.addActionListener(callback);
		remove();
		await plugin.removalSettled[0];
		await adapter.addActionListener(callback);

		expect(callback).toHaveBeenCalledTimes(2);
		expect(plugin.consumePendingActions).toHaveBeenCalledTimes(2);
		expect(plugin.acknowledgeAction).toHaveBeenCalledTimes(1);
	});

	it("never re-calls a successful callback when acknowledgement fails, then retries ack on rebind", async () => {
		const plugin = fakePlugin([action("awaiting")]);
		plugin.acknowledgeAction.mockRejectedValueOnce(new Error("ack failed"));
		const callback = vi.fn();
		const adapter = createWeeklyNotificationAdapter(plugin);
		const remove = await adapter.addActionListener(callback);
		remove();
		await plugin.removalSettled[0];
		await adapter.addActionListener(callback);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(plugin.acknowledgeAction).toHaveBeenCalledTimes(2);
		expect(plugin.acknowledgeAction).toHaveBeenLastCalledWith({ id: "awaiting" });
	});

	it("makes one acknowledgement attempt per pump", async () => {
		const plugin = fakePlugin([action("awaiting")]);
		plugin.acknowledgeAction.mockRejectedValue(new Error("still unavailable"));
		const adapter = createWeeklyNotificationAdapter(plugin);
		await adapter.addActionListener(vi.fn());
		expect(plugin.acknowledgeAction).toHaveBeenCalledTimes(1);

		plugin.emit(action("warm"));
		await settle();
		expect(
			plugin.acknowledgeAction.mock.calls.filter(([payload]) => payload.id === "awaiting"),
		).toHaveLength(2);
	});

	it("continues acknowledgement after removal during delivery without calling the removed listener again", async () => {
		const delivery = deferred<void>();
		const plugin = fakePlugin([action("in-flight")]);
		const callback = vi.fn(() => delivery.promise);
		const adapter = createWeeklyNotificationAdapter(plugin);
		const remove = await adapter.addActionListener(callback);
		remove();
		delivery.resolve();
		await plugin.removalSettled[0];
		await Promise.resolve();

		plugin.emit(action("after-removal"));
		await Promise.resolve();
		expect(callback).toHaveBeenCalledTimes(1);
		expect(plugin.acknowledgeAction).toHaveBeenCalledWith({ id: "in-flight" });
	});

	it("preserves the same adapter state across a StrictMode-style unbind and rebind", async () => {
		const plugin = fakePlugin([action("once")]);
		const callback = vi.fn();
		const adapter = createWeeklyNotificationAdapter(plugin);
		const remove = await adapter.addActionListener(callback);
		remove();
		await plugin.removalSettled[0];
		await adapter.addActionListener(callback);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(plugin.acknowledgeAction).toHaveBeenCalledTimes(1);
	});
});

describe("weekly notification no-op adapter", () => {
	it("is unsupported, never prompts, and isolates mutable status results", async () => {
		const adapter = createNoopWeeklyNotificationAdapter();
		expect(await adapter.reconcile(settings)).toEqual({ scheduled: false, caughtUp: false });
		const status = await adapter.getPermissionStatus();
		status.status = "granted";
		status.blockedAt = "runtime";
		expect(await adapter.getPermissionStatus()).toEqual({ status: "unsupported", blockedAt: null });
		const request = await adapter.requestPermission();
		request.status = "denied";
		request.blockedAt = "app";
		expect(await adapter.requestPermission()).toEqual({ status: "unsupported", blockedAt: null });
		await expect(adapter.openNotificationSettings()).resolves.toBeUndefined();
		await expect(adapter.addActionListener(vi.fn())).resolves.toBeTypeOf("function");
	});
});
