/**
 * React binding for the settings repository.
 *
 * Reads the merged settings from the bootstrap-opened database through the
 * StorageProvider context. On web/test/dev there is no storage layer, so
 * `settings` stays `null` (the honest non-native state) and `update` fails
 * closed with an explicit error rather than pretending to persist.
 *
 * `update(patch)` persists and immediately refreshes the local state with the
 * read-back merged settings; `reload()` re-reads from storage (used by the
 * Settings screen to resync after an external change).
 *
 * Concurrency contract (Task 9):
 * - Updates issued by ONE hook instance are serialized end-to-end (a FIFO
 *   queue per instance), so overlapping calls commit in call order and the
 *   final committed state is always the NEWEST authoritative read-back — a
 *   stale read-back from an earlier update can never land after a newer one.
 * - Reads are generation-guarded: a load that started before a newer read or
 *   update (or before unmount) is dropped, so an out-of-order storage response
 *   can never clobber fresher committed state.
 * - Loads and updates are storage-identity-guarded: a read/update captured
 *   under a database handle this hook no longer reads (the bootstrap gate
 *   swapped it out or cleared it to null) never commits into the current
 *   handle, and never repopulates the honest null seam with a removed
 *   database's value or error. The write still lands on its own handle and its
 *   own siblings are still notified (identity-scoped), but local state is only
 *   ever written by the handle currently bound to this hook.
 * - A successful update (or read) clears any stale error; a failed update
 *   records its message in `error` and still rethrows so awaiting callers see
 *   the rejection. (The platform-unavailable throw, with no storage to read
 *   from, records nothing — there is no UI tier to show it.)
 * - A successful update notifies every OTHER mounted hook instance bound to
 *   the SAME storage handle (module-level subscription, scoped by handle
 *   identity) so they re-read storage and converge on the new value without a
 *   reload or app restart — e.g. the AppearanceSync hook applies a live
 *   appearance change made from the Settings screen. The updating instance is
 *   excluded because it already committed the update's authoritative read-back
 *   (no redundant public get), and a hook on a DIFFERENT handle is never
 *   notified (its storage did not change; reloading it could surface another
 *   database's failure as its own error). Each instance unsubscribes on
 *   unmount, so cleanup never touches another instance's registration.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { DatabaseHandle } from "@/db/bootstrap";
import type { AppSettings } from "@/db/settings";
import {
	publishSettingsChanged,
	type SettingsListener,
	subscribeSettingsChanged,
} from "@/db/settings-events";
import { useStorage } from "@/db/storage";

export interface UseSettingsResult {
	/** Merged stored settings; `null` while loading or with no storage. */
	settings: AppSettings | null;
	/**
	 * Last error: set when a storage read fails or a storage-backed update
	 * rejects (the update also rethrows); cleared to `null` by the next
	 * successful read or update. Never set by the no-storage platform
	 * rejection (nothing can render it).
	 */
	error: string | null;
	/**
	 * Persist a partial patch and refresh local state with the merged result.
	 * Rejects (after recording `error`) when the storage write fails.
	 */
	update(patch: Partial<AppSettings>): Promise<AppSettings>;
	/** Re-read settings from storage (no-op, clearing to `null`, without storage). */
	reload(): Promise<void>;
}

/** Extract a safe single-line message from an arbitrary rejection. */
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function useSettings(): UseSettingsResult {
	const storage = useStorage();
	const [settings, setSettings] = useState<AppSettings | null>(null);
	const [error, setError] = useState<string | null>(null);

	// The listener THIS instance registered (set in the subscription effect),
	// so a successful update can exclude itself from its own broadcast.
	const selfListenerRef = useRef<SettingsListener | null>(null);

	// Generation + mounted guards: only the NEWEST read started by this hook
	// (and only while the component is still mounted) may commit settings or
	// error. A stale read that resolves AFTER a newer reload/update — or after
	// unmount — is dropped, so an out-of-order storage response can never
	// clobber fresher state or write into a dead component.
	const generationRef = useRef(0);
	const mountedRef = useRef(true);

	// The storage handle (or null) this hook is CURRENTLY bound to, kept live so
	// a post-await commit can prove it belongs to the handle that started the
	// operation. When the bootstrap gate swaps the database or clears it, an
	// operation captured under the old handle must not commit into a hook now
	// reading a different — or no — database.
	const storageRef = useRef<DatabaseHandle | null>(storage);

	// Per-instance FIFO queue for update() calls: a later update only starts
	// after the previous one settled, so commit order equals call order and
	// the last commit is always the newest authoritative read-back.
	const updateTailRef = useRef<Promise<unknown>>(Promise.resolve());

	// A provider rebind is observable during render, before passive effects run.
	// Clear owner-bound state in that render so consumers cannot paint values from
	// the previous database while the replacement handle's read is pending. The
	// queue reset also lets updates for the replacement handle start immediately,
	// rather than waiting behind work captured by the old handle.
	if (storageRef.current !== storage) {
		storageRef.current = storage;
		++generationRef.current;
		updateTailRef.current = Promise.resolve();
		setSettings(null);
		setError(null);
	}

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const load = useCallback(async () => {
		// Invalidate any in-flight read captured under an earlier handle or
		// generation BEFORE the no-storage branch, so a deferred load from a
		// swapped-out handle can never repopulate the null seam after storage is
		// cleared (settings + error reset to the honest non-native state).
		const generation = ++generationRef.current;
		if (!storage) {
			setSettings(null);
			setError(null);
			return;
		}
		const captured = storage;
		try {
			const next = await captured.settings.get();
			if (
				generation !== generationRef.current ||
				!mountedRef.current ||
				captured !== storageRef.current
			) {
				return;
			}
			setSettings(next);
			setError(null);
		} catch (e) {
			if (
				generation !== generationRef.current ||
				!mountedRef.current ||
				captured !== storageRef.current
			) {
				return;
			}
			setError(message(e));
		}
	}, [storage]);

	// Storage-identity lifecycle + cross-instance subscription, declared before
	// the load effect so the load it starts owns the newest generation. Identity
	// state is reset synchronously above during render; this effect only replaces
	// the handle-scoped listener after commit. Old queued operations may still
	// complete (persisting to their own handle) and notify their own siblings, but
	// the identity+generation guards below refuse their commits. The no-storage
	// transition still runs the null branch of load(), so a deferred load from a
	// swapped-out handle can never repopulate the null seam.
	//
	// The subscription half re-reads whenever ANOTHER instance bound to the SAME
	// storage handle persists a change, so every mounted consumer converges on
	// the new stored value without a reload/app restart. Scoping by handle
	// identity means an update on a different database never reloads this hook
	// (its storage did not change). No storage -> no peers exist; nothing to
	// subscribe. load() never notifies, so this cannot loop. Unsubscribes on
	// unmount.
	useEffect(() => {
		if (!storage) return;
		const onChange: SettingsListener = () => {
			void load();
		};
		selfListenerRef.current = onChange;
		const unsubscribe = subscribeSettingsChanged(storage, onChange);
		return () => {
			selfListenerRef.current = null;
			unsubscribe();
		};
	}, [storage, load]);

	useEffect(() => {
		void load();
	}, [load]);

	const update = useCallback(
		async (patch: Partial<AppSettings>): Promise<AppSettings> => {
			if (!storage) {
				throw new Error("Settings storage is unavailable on this platform.");
			}
			// The handle this call was made against; the write persists THERE even if
			// the hook later rebinds, while local commits stay scoped to it.
			const captured = storage;
			const run = updateTailRef.current.then(async () => {
				// A queued call that outlived its handle (rebind while pending) must not
				// bump the current generation — that would starve the current handle's
				// in-flight load. It persists to its own handle and notifies its own
				// siblings, but never commits locally.
				const currentHandle = captured === storageRef.current;
				if (currentHandle) ++generationRef.current;
				const generation = generationRef.current;
				const mayCommit = () =>
					currentHandle &&
					mountedRef.current &&
					generation === generationRef.current &&
					captured === storageRef.current;
				let next: AppSettings;
				try {
					next = await captured.settings.update(patch);
				} catch (cause) {
					// Record the failure for the form's error tier, then rethrow so
					// awaiting callers still observe the rejection. A failure on a
					// swapped-out handle must never surface as THIS handle's error.
					if (mayCommit()) setError(message(cause));
					throw cause;
				}
				// Commit only the read-back of a write that still belongs to the handle
				// this hook currently reads (identity + generation current, mounted) —
				// the authoritative state of the CURRENT database.
				if (mayCommit()) {
					setSettings(next);
					setError(null);
				}
				// The write landed even if THIS instance unmounted mid-flight or rebind
				// to another handle, so other mounted consumers on the SAME captured
				// handle must still converge on it (the origin is excluded — it already
				// committed the read-back while still current).
				publishSettingsChanged(captured, selfListenerRef.current);
				return next;
			});
			// Keep the tail resolvable even when an update rejects, so the next
			// queued update still runs (same discipline as the DB Serializer).
			updateTailRef.current = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
		[storage],
	);

	return { settings, error, update, reload: load };
}
