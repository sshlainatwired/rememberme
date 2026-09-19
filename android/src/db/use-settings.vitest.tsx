import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseHandle } from "@/db/bootstrap";
import { type AppSettings, DEFAULT_SETTINGS } from "@/db/settings";
import { StorageProvider } from "@/db/storage";
import { createTestHandle } from "@/db/test-helper";
import { useSettings } from "@/db/use-settings";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Storage-backed render helper: wraps the hook in the provider over a handle. */
function wrapper(database: DatabaseHandle | null) {
	return function SettingsWrapper({ children }: { children: ReactNode }) {
		return <StorageProvider database={database}>{children}</StorageProvider>;
	};
}

describe("useSettings", () => {
	it("loads stored settings merged over safe defaults", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "Europe/Istanbul" });
		const { result } = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		await waitFor(() => expect(result.current.settings?.timezone).toBe("Europe/Istanbul"));
		// untouched keys keep their safe defaults
		expect(result.current.settings?.weeklyReviewEnabled).toBe(false);
		expect(result.current.settings?.appearance).toBe("system");
		expect(result.current.error).toBeNull();
	});

	it("drops a stale earlier load that resolves after a newer reload", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "Europe/Istanbul" });

		// First (mount) read hangs; resolve it LATER with a STALE value after a
		// reload has already committed the newer stored value. The hook must
		// only ever commit the newest generation's result.
		let releaseStale!: (value: AppSettings) => void;
		const stale = new Promise<AppSettings>((resolve) => {
			releaseStale = resolve;
		});
		// Capture the real get() BEFORE spying so the stub can delegate.
		const realGet = handle.settings.get.bind(handle.settings);
		const getSpy = vi.spyOn(handle.settings, "get");
		getSpy.mockReturnValueOnce(stale); // mount load hangs
		getSpy.mockImplementation(() => realGet()); // reload reads storage

		const { result } = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		// reload resolves immediately with the CURRENT stored value
		await act(async () => {
			await result.current.reload();
		});
		expect(result.current.settings?.timezone).toBe("Europe/Istanbul");

		// Now the STALE first read resolves (out of order). The older result
		// must NOT overwrite the newer reload's settings/error.
		await act(async () => {
			releaseStale({ ...DEFAULT_SETTINGS, timezone: "Pacific/Kiritimati" });
		});
		expect(result.current.settings?.timezone).toBe("Europe/Istanbul");
		expect(result.current.error).toBeNull();
	});

	it("does not commit settings/error from a load that resolves after unmount", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "Europe/Istanbul" });

		let release!: (value: AppSettings) => void;
		const pending = new Promise<AppSettings>((resolve) => {
			release = resolve;
		});
		const getSpy = vi.spyOn(handle.settings, "get").mockReturnValue(pending);

		const { result, unmount } = renderHook(() => useSettings(), {
			wrapper: wrapper(handle),
		});
		expect(getSpy).toHaveBeenCalledTimes(1);
		expect(result.current.settings).toBeNull();

		unmount();
		// Resolving a pending load AFTER unmount must not write to the dead
		// component (or resurrect it / log errors).
		await act(async () => {
			release({ ...DEFAULT_SETTINGS, timezone: "Pacific/Kiritimati" });
		});
		expect(result.current.settings).toBeNull();
		expect(result.current.error).toBeNull();
	});

	it("update({ timezone }) persists to storage and refreshes local state", async () => {
		const handle = await createTestHandle();
		const { result } = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		await waitFor(() => expect(result.current.settings).not.toBeNull());
		await act(async () => {
			const next = await result.current.update({ timezone: "America/New_York" });
			expect(next.timezone).toBe("America/New_York");
		});
		expect(result.current.settings?.timezone).toBe("America/New_York");
		expect((await handle.settings.get()).timezone).toBe("America/New_York");
	});

	it("is null and refuses update when there is no storage", async () => {
		const { result } = renderHook(() => useSettings(), { wrapper: wrapper(null) });
		await waitFor(() => expect(result.current.settings).toBeNull());
		await expect(result.current.update({ timezone: "UTC" })).rejects.toThrow(
			/unavailable on this platform/i,
		);
	});

	it("clears a stale load error once a subsequent update succeeds", async () => {
		const handle = await createTestHandle();
		const getSpy = vi.spyOn(handle.settings, "get");
		getSpy.mockRejectedValueOnce(new Error("Corrupt settings: boom"));
		const { result } = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		await waitFor(() => expect(result.current.error).toMatch(/Corrupt settings: boom/));
		expect(result.current.settings).toBeNull();

		// The stored state is actually fine; a successful update must clear the
		// stale error (the form would otherwise keep showing a failure banner).
		await act(async () => {
			const next = await result.current.update({ appearance: "dark" });
			expect(next.appearance).toBe("dark");
		});
		expect(result.current.settings?.appearance).toBe("dark");
		expect(result.current.error).toBeNull();
	});

	it("records the update error and still rethrows it", async () => {
		const handle = await createTestHandle();
		const { result } = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		await waitFor(() => expect(result.current.settings).not.toBeNull());

		vi.spyOn(handle.settings, "update").mockRejectedValueOnce(new Error("disk full"));
		await act(async () => {
			await expect(result.current.update({ timezone: "Europe/Istanbul" })).rejects.toThrow(
				/disk full/,
			);
		});
		expect(result.current.error).toMatch(/disk full/);
	});

	it("propagates a successful update to other mounted hook instances", async () => {
		const handle = await createTestHandle();
		const first = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		const second = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		await waitFor(() => expect(first.result.current.settings).not.toBeNull());
		await waitFor(() => expect(second.result.current.settings).not.toBeNull());
		expect(second.result.current.settings?.appearance).toBe("system");

		// Updating through ONE hook instance must reach every other mounted
		// consumer (e.g. the AppearanceSync hook) without a reload/app restart.
		await act(async () => {
			await first.result.current.update({ appearance: "dark" });
		});
		await waitFor(() => expect(second.result.current.settings?.appearance).toBe("dark"));
		expect(second.result.current.error).toBeNull();

		first.unmount();
		second.unmount();
	});

	it("converges overlapping updates to the newest authoritative read-back", async () => {
		const handle = await createTestHandle();
		const { result } = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		await waitFor(() => expect(result.current.settings).not.toBeNull());

		// Two updates fire in the same frame (no await between them). They must
		// serialize so the LAST call's authoritative read-back lands last: final
		// hook state and storage both converge on the newest values.
		await act(async () => {
			const first = result.current.update({ timezone: "Europe/Istanbul" });
			const second = result.current.update({
				timezone: "Pacific/Kiritimati",
				appearance: "dark",
			});
			const [a, b] = await Promise.all([first, second]);
			expect(a.timezone).toBe("Europe/Istanbul");
			expect(b.timezone).toBe("Pacific/Kiritimati");
			expect(b.appearance).toBe("dark");
		});
		expect(result.current.settings?.timezone).toBe("Pacific/Kiritimati");
		expect(result.current.settings?.appearance).toBe("dark");
		const stored = await handle.settings.get();
		expect(stored.timezone).toBe("Pacific/Kiritimati");
		expect(stored.appearance).toBe("dark");
	});

	it("drops a stale deferred load that resolves after a successful update", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "Europe/Istanbul" });

		// The mount read hangs; resolve it LATER with a STALE value after an
		// update has already committed. The stale read must never revert the
		// update's authoritative hook state.
		let releaseStale!: (value: AppSettings) => void;
		const stale = new Promise<AppSettings>((resolve) => {
			releaseStale = resolve;
		});
		const realGet = handle.settings.get.bind(handle.settings);
		const getSpy = vi.spyOn(handle.settings, "get");
		getSpy.mockReturnValueOnce(stale); // mount load hangs
		getSpy.mockImplementation(() => realGet()); // later reads hit storage

		const { result } = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		await act(async () => {
			await result.current.update({ timezone: "Pacific/Kiritimati" });
		});
		expect(result.current.settings?.timezone).toBe("Pacific/Kiritimati");

		// Now the STALE first read resolves (out of order) with the pre-update
		// value; it must not clobber the update's committed state.
		await act(async () => {
			releaseStale({ ...DEFAULT_SETTINGS, timezone: "America/New_York" });
		});
		expect(result.current.settings?.timezone).toBe("Pacific/Kiritimati");
		expect(result.current.error).toBeNull();
	});

	it("reload() picks up an external settings.update change", async () => {
		const handle = await createTestHandle();
		const { result } = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		await waitFor(() => expect(result.current.settings).not.toBeNull());
		// another owner writes the setting directly against storage
		await act(async () => {
			await handle.settings.update({ weeklyReviewHour: 21 });
		});
		expect(result.current.settings?.weeklyReviewHour).toBe(20);
		await act(async () => {
			await result.current.reload();
		});
		expect(result.current.settings?.weeklyReviewHour).toBe(21);
	});

	it("does not reload or inject an error into a hook on a DIFFERENT storage handle", async () => {
		const handleA = await createTestHandle();
		const handleB = await createTestHandle();
		// Distinct databases: A carries a value B's storage does not have.
		await handleA.settings.update({ appearance: "light" });

		const a = renderHook(() => useSettings(), { wrapper: wrapper(handleA) });
		const b = renderHook(() => useSettings(), { wrapper: wrapper(handleB) });
		await waitFor(() => expect(a.result.current.settings?.appearance).toBe("light"));
		await waitFor(() => expect(b.result.current.settings?.appearance).toBe("system"));

		// Arm A's read to reject: IF handle B's update wrongly triggered a reload
		// of A, the injected failure would surface as an error on A. Cross-handle
		// updates must never notify — listeners are scoped to their own storage.
		const getASpy = vi.spyOn(handleA.settings, "get");
		getASpy.mockRejectedValueOnce(new Error("handle A storage closed"));
		await act(async () => {
			await b.result.current.update({ appearance: "dark" });
		});

		expect(getASpy).not.toHaveBeenCalled(); // A was never asked to re-read
		expect(a.result.current.error).toBeNull(); // no error injected into A
		expect(a.result.current.settings?.appearance).toBe("light"); // A keeps its own DB value
		// B's own instance commits its authoritative read-back.
		expect(b.result.current.settings?.appearance).toBe("dark");

		a.unmount();
		b.unmount();
	});

	it("does not re-read storage to refresh the instance that performed the update", async () => {
		const handle = await createTestHandle();
		const { result } = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		await waitFor(() => expect(result.current.settings).not.toBeNull());

		// The updater already commits the update's authoritative read-back, so
		// the cross-instance notify must exclude it — no redundant public get().
		const getSpy = vi.spyOn(handle.settings, "get");
		await act(async () => {
			await result.current.update({ appearance: "dark" });
		});
		expect(result.current.settings?.appearance).toBe("dark");
		expect(result.current.error).toBeNull();
		expect(getSpy).not.toHaveBeenCalled();
	});

	it("still converges a mounted sibling when the updating instance unmounts before its write settles", async () => {
		const handle = await createTestHandle();
		const first = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		const second = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		await waitFor(() => expect(first.result.current.settings).not.toBeNull());
		await waitFor(() => expect(second.result.current.settings).not.toBeNull());

		// Unmount the origin BEFORE the update runs: its listener entry is gone,
		// yet the mounted sibling on the same handle must still converge on the
		// persisted change (the write landed even though the origin is gone).
		const updateAfterUnmount = first.result.current.update;
		first.unmount();
		await act(async () => {
			await updateAfterUnmount({ appearance: "dark" });
		});
		await waitFor(() => expect(second.result.current.settings?.appearance).toBe("dark"));
		expect(second.result.current.error).toBeNull();
		second.unmount();
	});

	it("recovers after a rejected queued update: the next update still runs and converges", async () => {
		const handle = await createTestHandle();
		const { result } = renderHook(() => useSettings(), { wrapper: wrapper(handle) });
		await waitFor(() => expect(result.current.settings).not.toBeNull());

		// The first update rejects (once). The FIFO tail must not wedge: the next
		// queued update still executes and converges hook state + storage.
		vi.spyOn(handle.settings, "update").mockRejectedValueOnce(new Error("disk full"));
		let firstRejected = false;
		await act(async () => {
			try {
				await result.current.update({ timezone: "Europe/Istanbul" });
			} catch {
				firstRejected = true;
			}
		});
		expect(firstRejected).toBe(true);
		expect(result.current.error).toMatch(/disk full/);

		await act(async () => {
			await result.current.update({ timezone: "Pacific/Kiritimati", appearance: "dark" });
		});
		expect(result.current.settings?.timezone).toBe("Pacific/Kiritimati");
		expect(result.current.settings?.appearance).toBe("dark");
		expect(result.current.error).toBeNull();
		const stored = await handle.settings.get();
		expect(stored.timezone).toBe("Pacific/Kiritimati");
		expect(stored.appearance).toBe("dark");
	});

	it("clears settings and error synchronously when rebinding to a deferred handle", async () => {
		const handleA = await createTestHandle();
		const handleB = await createTestHandle();
		await handleA.settings.update({
			timezone: "America/New_York",
			appearance: "light",
			weeklyReviewEnabled: true,
			weeklyReviewHour: 7,
		});
		await handleB.settings.update({ timezone: "Asia/Tokyo", appearance: "dark" });

		let releaseB!: (value: AppSettings) => void;
		const deferredB = new Promise<AppSettings>((resolve) => {
			releaseB = resolve;
		});
		const getBSpy = vi.spyOn(handleB.settings, "get").mockReturnValue(deferredB);

		let database: DatabaseHandle | null = handleA;
		function SwappableWrapper({ children }: { children: ReactNode }) {
			return <StorageProvider database={database}>{children}</StorageProvider>;
		}
		const { result, rerender } = renderHook(() => useSettings(), {
			wrapper: SwappableWrapper,
		});
		await waitFor(() => expect(result.current.settings?.timezone).toBe("America/New_York"));
		await act(async () => {
			await result.current.update({ appearance: "dark" });
		});
		await waitFor(() => expect(result.current.error).toBeNull());

		database = handleB;
		rerender();
		expect(getBSpy).toHaveBeenCalledTimes(1);
		expect(result.current.settings).toBeNull();
		expect(result.current.error).toBeNull();

		await act(async () => {
			releaseB({ ...DEFAULT_SETTINGS, timezone: "Asia/Tokyo", appearance: "dark" });
			await Promise.resolve();
		});
		await waitFor(() => expect(result.current.settings?.timezone).toBe("Asia/Tokyo"));
	});

	it("clears resolved settings synchronously when storage is cleared to null", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "America/New_York", appearance: "light" });

		let database: DatabaseHandle | null = handle;
		function SwappableWrapper({ children }: { children: ReactNode }) {
			return <StorageProvider database={database}>{children}</StorageProvider>;
		}
		const { result, rerender } = renderHook(() => useSettings(), {
			wrapper: SwappableWrapper,
		});
		await waitFor(() => expect(result.current.settings?.timezone).toBe("America/New_York"));

		database = null;
		rerender();
		expect(result.current.settings).toBeNull();
		expect(result.current.error).toBeNull();
	});

	it("never commits a deferred update from a swapped-out handle into the current handle", async () => {
		const handleA = await createTestHandle();
		const handleB = await createTestHandle();
		// Distinct stored values so a wrong cross-handle commit is observable.
		await handleA.settings.update({ timezone: "America/New_York" });
		await handleB.settings.update({ timezone: "Europe/Istanbul" });

		// A's NEXT settings.update hangs until released (the write is in flight
		// when the live database is swapped out from under the hook).
		let releaseAUpdate!: (value: AppSettings) => void;
		const deferredA = new Promise<AppSettings>((resolve) => {
			releaseAUpdate = resolve;
		});
		vi.spyOn(handleA.settings, "update").mockReturnValueOnce(deferredA);

		// A mutable database slot lets the SAME hook instance rebind to a new
		// storage handle (as the bootstrap gate does on logout/re-open).
		let database: DatabaseHandle | null = handleA;
		function SwappableWrapper({ children }: { children: ReactNode }) {
			return <StorageProvider database={database}>{children}</StorageProvider>;
		}
		const { result, rerender } = renderHook(() => useSettings(), {
			wrapper: SwappableWrapper,
		});
		await waitFor(() => expect(result.current.settings?.timezone).toBe("America/New_York"));

		// Fire an update against handle A; it stalls on the deferred write (the
		// queued run starts on the resolved FIFO tail once microtasks drain).
		const pendingAUpdate = result.current.update({ timezone: "Pacific/Auckland" });

		// Swap the live storage to handle B: B loads and commits ITS value while
		// A's update is still in flight.
		database = handleB;
		rerender();
		await waitFor(() => expect(result.current.settings?.timezone).toBe("Europe/Istanbul"));
		expect(result.current.settings?.appearance).toBe("system");
		expect(result.current.error).toBeNull();

		// Now A's deferred write settles with A's read-back. The write landed (the
		// awaited update resolves with its value) and may notify handle A's other
		// listeners, but it must NOT overwrite the B-bound hook's state or error.
		await act(async () => {
			releaseAUpdate({ ...DEFAULT_SETTINGS, timezone: "Pacific/Auckland", appearance: "light" });
			await expect(pendingAUpdate).resolves.toMatchObject({
				timezone: "Pacific/Auckland",
			});
		});
		expect(result.current.settings?.timezone).toBe("Europe/Istanbul");
		expect(result.current.settings?.appearance).toBe("system");
		expect(result.current.error).toBeNull();
		// B's storage was never written by the stale A read-back.
		expect((await handleB.settings.get()).timezone).toBe("Europe/Istanbul");
	});

	it("does not repopulate the null seam with a deferred load from a swapped-out handle", async () => {
		const handleA = await createTestHandle();
		await handleA.settings.update({ timezone: "America/New_York" });

		// A's initial (mount) read hangs; it resolves only AFTER the live storage
		// is cleared to null. The hook must stay on the honest null seam — a
		// deferred value from the removed handle must not repopulate settings.
		let releaseALoad!: (value: AppSettings) => void;
		const deferredALoad = new Promise<AppSettings>((resolve) => {
			releaseALoad = resolve;
		});
		const getASpy = vi.spyOn(handleA.settings, "get").mockReturnValueOnce(deferredALoad);

		let database: DatabaseHandle | null = handleA;
		function SwappableWrapper({ children }: { children: ReactNode }) {
			return <StorageProvider database={database}>{children}</StorageProvider>;
		}
		const { result, rerender } = renderHook(() => useSettings(), {
			wrapper: SwappableWrapper,
		});
		expect(getASpy).toHaveBeenCalledTimes(1);
		expect(result.current.settings).toBeNull();

		// Swap the live storage away to null (no storage layer on this platform);
		// the null seam must not re-read the removed handle.
		database = null;
		rerender();
		expect(getASpy).toHaveBeenCalledTimes(1);
		expect(result.current.settings).toBeNull();
		expect(result.current.error).toBeNull();

		// A's deferred mount read resolves with A's stored value; it must not
		// repopulate the null seam (and a failure must not inject A's error).
		await act(async () => {
			releaseALoad({ ...DEFAULT_SETTINGS, timezone: "Pacific/Kiritimati" });
			await Promise.resolve();
		});
		expect(result.current.settings).toBeNull();
		expect(result.current.error).toBeNull();
	});
});
