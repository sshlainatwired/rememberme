import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseHandle } from "@/db/bootstrap";
import type { AppSettings } from "@/db/settings";
import { createTestHandle } from "@/db/test-helper";
import type {
	WeeklyNotificationAction,
	WeeklyNotificationAdapter,
	WeeklyNotificationSettings,
} from "./weekly-notification-adapter";
import { WeeklyNotificationCoordinator } from "./weekly-notification-coordinator";

const snapshot: WeeklyNotificationSettings = {
	enabled: true,
	hour: 9,
	timezone: "Europe/London",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

async function settle(): Promise<void> {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function fakeAdapter() {
	let listener: ((action: WeeklyNotificationAction) => void | Promise<void>) | undefined;
	const remove = vi.fn(async () => {});
	const adapter: WeeklyNotificationAdapter = {
		reconcile: vi.fn(async () => ({ scheduled: true, caughtUp: false })),
		getPermissionStatus: vi.fn(async () => ({ status: "prompt" as const, blockedAt: null })),
		requestPermission: vi.fn(async () => ({ status: "prompt" as const, blockedAt: null })),
		openNotificationSettings: vi.fn(async () => {}),
		addActionListener: vi.fn(async (next) => {
			listener = next;
			return remove;
		}),
	};
	return { adapter, remove, emit: (action: WeeklyNotificationAction) => listener?.(action) };
}

async function owner(): Promise<DatabaseHandle> {
	return createTestHandle();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("WeeklyNotificationCoordinator owner reconciliation", () => {
	it("makes zero native calls for null owners or unresolved snapshots", async () => {
		const { adapter } = fakeAdapter();
		const coordinator = new WeeklyNotificationCoordinator(adapter);
		const first = await owner();
		coordinator.start(vi.fn());
		coordinator.setOwner(null, null);
		coordinator.setOwner(first, null);
		await settle();
		expect(adapter.reconcile).not.toHaveBeenCalled();
	});

	it("reconciles the current owner's first valid primitive snapshot exactly once", async () => {
		const { adapter } = fakeAdapter();
		const coordinator = new WeeklyNotificationCoordinator(adapter);
		const first = await owner();
		coordinator.start(vi.fn());
		coordinator.setOwner(first, snapshot);
		coordinator.setOwner(first, { ...snapshot });
		await settle();
		expect(adapter.reconcile).toHaveBeenCalledTimes(1);
		expect(adapter.reconcile).toHaveBeenCalledWith(snapshot);
	});

	it("drops a stale initial settings result and reconciles B only after B resolves", async () => {
		const { adapter } = fakeAdapter();
		const coordinator = new WeeklyNotificationCoordinator(adapter);
		const first = await owner();
		const second = await owner();
		const firstRead = deferred<AppSettings>();
		const secondRead = deferred<AppSettings>();
		vi.spyOn(first.settings, "get").mockReturnValue(firstRead.promise);
		vi.spyOn(second.settings, "get").mockReturnValue(secondRead.promise);
		coordinator.start(vi.fn());
		coordinator.setOwner(first, null);
		void coordinator.reconcile();
		coordinator.setOwner(second, null);
		firstRead.resolve({
			...snapshot,
			weeklyReviewEnabled: true,
			weeklyReviewHour: 10,
			timezone: "UTC",
			biometricEnabled: false,
			appearance: "system",
		});
		await settle();
		expect(adapter.reconcile).not.toHaveBeenCalled();
		void coordinator.reconcile();
		secondRead.resolve({
			...snapshot,
			weeklyReviewEnabled: true,
			weeklyReviewHour: 11,
			timezone: "UTC",
			biometricEnabled: false,
			appearance: "system",
		});
		await settle();
		expect(adapter.reconcile).toHaveBeenCalledTimes(1);
		expect(adapter.reconcile).toHaveBeenCalledWith({ enabled: true, hour: 11, timezone: "UTC" });
	});

	it("reads foreground settings directly from the captured current owner", async () => {
		const { adapter } = fakeAdapter();
		const coordinator = new WeeklyNotificationCoordinator(adapter);
		const first = await owner();
		const get = vi.spyOn(first.settings, "get").mockResolvedValue({
			...snapshot,
			weeklyReviewEnabled: false,
			weeklyReviewHour: 20,
			biometricEnabled: false,
			appearance: "system",
		});
		coordinator.start(vi.fn());
		coordinator.setOwner(first, null);
		await coordinator.reconcile();
		expect(get).toHaveBeenCalledTimes(1);
		expect(adapter.reconcile).toHaveBeenCalledWith({
			enabled: false,
			hour: 20,
			timezone: "Europe/London",
		});
	});

	it("drops a stale foreground result after owner B replaces A", async () => {
		const { adapter } = fakeAdapter();
		const coordinator = new WeeklyNotificationCoordinator(adapter);
		const first = await owner();
		const second = await owner();
		const firstRead = deferred<Awaited<ReturnType<typeof first.settings.get>>>();
		vi.spyOn(first.settings, "get").mockReturnValue(firstRead.promise);
		coordinator.start(vi.fn());
		coordinator.setOwner(first, null);
		void coordinator.reconcile();
		coordinator.setOwner(second, null);
		firstRead.resolve({
			...snapshot,
			weeklyReviewEnabled: true,
			weeklyReviewHour: 9,
			biometricEnabled: false,
			appearance: "system",
		});
		await settle();
		expect(adapter.reconcile).not.toHaveBeenCalled();
	});

	it("aborts a queued A update before its adapter side effect when B replaces A", async () => {
		const firstCall = deferred<{ scheduled: boolean; caughtUp: boolean }>();
		const { adapter } = fakeAdapter();
		vi.mocked(adapter.reconcile).mockReturnValueOnce(firstCall.promise);
		const coordinator = new WeeklyNotificationCoordinator(adapter);
		const first = await owner();
		const second = await owner();
		coordinator.start(vi.fn());
		coordinator.setOwner(first, snapshot);
		await settle();
		coordinator.setOwner(first, { ...snapshot, hour: 10 });
		coordinator.setOwner(second, null);
		firstCall.resolve({ scheduled: true, caughtUp: false });
		await settle();
		expect(adapter.reconcile).toHaveBeenCalledTimes(1);
	});

	it("runs B after an in-flight A reconciliation completes without committing A's result", async () => {
		const firstResult = { scheduled: false, caughtUp: true };
		const secondResult = { scheduled: true, caughtUp: false };
		const firstCall = deferred<typeof firstResult>();
		const { adapter } = fakeAdapter();
		vi.mocked(adapter.reconcile)
			.mockReturnValueOnce(firstCall.promise)
			.mockResolvedValue(secondResult);
		const committed: Array<typeof secondResult> = [];
		const coordinator = new WeeklyNotificationCoordinator(adapter, (status) => {
			committed.push(status);
		});
		const first = await owner();
		const second = await owner();
		coordinator.start(vi.fn());
		coordinator.setOwner(first, snapshot);
		await settle();
		coordinator.setOwner(second, { ...snapshot, hour: 11 });
		expect(adapter.reconcile).toHaveBeenCalledTimes(1);
		firstCall.resolve(firstResult);
		await settle();
		expect(adapter.reconcile).toHaveBeenCalledTimes(2);
		expect(adapter.reconcile).toHaveBeenLastCalledWith({ ...snapshot, hour: 11 });
		// No transitional status is allowed: only B's result may be committed after the swap.
		expect(committed).toEqual([secondResult]);
	});

	it("recovers its serialized tail after an adapter rejection", async () => {
		const { adapter } = fakeAdapter();
		vi.mocked(adapter.reconcile)
			.mockRejectedValueOnce(new Error("native unavailable"))
			.mockResolvedValueOnce({ scheduled: true, caughtUp: false });
		const coordinator = new WeeklyNotificationCoordinator(adapter);
		const first = await owner();
		coordinator.start(vi.fn());
		coordinator.setOwner(first, snapshot);
		coordinator.setOwner(first, { ...snapshot, hour: 10 });
		await settle();
		expect(adapter.reconcile).toHaveBeenCalledTimes(2);
	});

	it("keeps one native listener across owner changes and removes both listeners on stop", async () => {
		const { adapter, remove } = fakeAdapter();
		const addDocument = vi.spyOn(document, "addEventListener");
		const removeDocument = vi.spyOn(document, "removeEventListener");
		const coordinator = new WeeklyNotificationCoordinator(adapter);
		const first = await owner();
		const second = await owner();
		coordinator.start(vi.fn());
		await settle();
		coordinator.setOwner(first, null);
		coordinator.setOwner(second, null);
		expect(adapter.addActionListener).toHaveBeenCalledTimes(1);
		expect(addDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
		coordinator.stop();
		await settle();
		expect(remove).toHaveBeenCalledTimes(1);
		expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
	});

	it("does not commit a result after stop", async () => {
		const result = deferred<{ scheduled: boolean; caughtUp: boolean }>();
		const { adapter } = fakeAdapter();
		vi.mocked(adapter.reconcile).mockReturnValueOnce(result.promise);
		const committed: unknown[] = [];
		const coordinator = new WeeklyNotificationCoordinator(
			adapter,
			(next: { scheduled: boolean; caughtUp: boolean }) => committed.push(next),
		);
		const first = await owner();
		coordinator.start(vi.fn());
		coordinator.setOwner(first, snapshot);
		await settle();
		coordinator.stop();
		result.resolve({ scheduled: true, caughtUp: false });
		await settle();
		expect(committed).toEqual([]);
	});
});
