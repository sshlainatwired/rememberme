import { type CalendarDate, JOURNAL_CONTENT_MAX } from "@rememberme/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JournalService } from "@/db/journal";

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface JournalEditorProps {
	date: CalendarDate;
	service: JournalService | null;
	/** Preloaded entry content; null = "loading" until provided. */
	initialContent?: string | null;
	/** Called after a successful save/delete (parent refreshes markers). */
	onSaved?: (content: string) => void;
	/**
	 * Called ONLY after a successful unmount flush lands on the current week
	 * (see JournalView). Used to refresh the flushed date's week marker; never
	 * fires on the normal debounced/retried saves (those use `onSaved`).
	 */
	onFlush?: () => void;
}

const SAVE_DEBOUNCE_MS = 800;
const RETRY_DELAY_MS = 5_000;
const MAX_ERROR = "Entry is limited to 100,000 characters.";
const RETRY_ERROR = "Could not save — retrying in a few seconds.";

/**
 * enforceMax — revert an overflowing textarea event to the editor's current
 * accepted value. Because overflow does not change `value` state, React may
 * skip a re-render (the MAX_ERROR text is unchanged on repeated overflow), so
 * the DOM node is reset imperatively to guarantee it snaps back to the
 * accepted value regardless of render skipping.
 */
function enforceMax(target: HTMLTextAreaElement, accepted: string) {
	target.value = accepted;
}

/**
 * JournalEditor — the debounced, fail-closed daily editor.
 *
 * Contract (Phase 5 Task 7):
 * - Saves are debounced 800ms and always send the NEWEST value.
 * - Writes are SERIALIZED: exactly one `service.upsert` is in flight at any
 *   time, and the writes that follow are ORDERED after it, so the database
 *   completion order always matches the editor's intent order (an older value
 *   can never land after a newer one). A stale save resolving or failing late
 *   is ignored entirely — it can never paint a stale "Saved"/error, arm a
 *   stale retry, or notify the parent with an outdated value.
 * - A failed save shows an explicit error and retries the LATEST value every
 *   5s until it succeeds (the retry reads `valueRef.current` at fire time, so
 *   a later keystroke wins the retry chain).
 * - Empty content saves through `journal.upsert`'s delete semantics (row
 *   removed, `onSaved("")`).
 * - Input is capped at exactly `JOURNAL_CONTENT_MAX` (100,000) Unicode code
 *   points, matching the shared core schema (astral characters count once);
 *   overflow is rejected client-side, never reaches the repository, and the
 *   DOM is snapped back even on repeated overflow.
 * - The workspace is keyed by `date` at the PARENT (JournalView mounts this
 *   with `key={date}`), so one mount == one date. Every async save flush
 *   checks cancellation, so an old date (or an unmount) can never mutate a
 *   newer date's row or touch state after unmount.
 * - Unmount flushes a dirty value AFTER any in-flight write (ordering above),
 *   catching any rejection, with NO post-unmount setState and no `onSaved`;
 *   only `onFlush` reports the completed flush to the parent (guarded by the
 *   parent's current-week/request generation).
 * - App backgrounding flushes dirty text immediately through the same
 *   serialized save path instead of waiting for the debounce timer.
 * - A `beforeunload` guard is registered only while dirty and removed when
 *   the entry becomes clean or the editor unmounts.
 *
 * Web reference: mirrors the web app's debounce/retry/latest-value save loop.
 * The web `SaveStatus`'s saved-timestamp line is adapted to a plain "Saved"
 * status using this app's semantic Chrome-60-safe classes; its `savedAt`
 * instant is dropped (tests assert the exact "Saved" text and the guard uses
 * `saveState` for reactivity).
 */
export default function JournalEditor({
	date,
	service,
	initialContent = "",
	onSaved,
	onFlush,
}: JournalEditorProps) {
	const [value, setValue] = useState(initialContent ?? "");
	const [loading, setLoading] = useState(initialContent === null);
	const [saveState, setSaveState] = useState<SaveState>(initialContent === null ? "idle" : "saved");
	const [error, setError] = useState<string | null>(null);

	const valueRef = useRef(value);
	valueRef.current = value;
	const lastSavedRef = useRef(initialContent ?? "");
	const cancelledRef = useRef(false);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Single-flight lock: the snapshot whose upsert is currently in flight.
	const inFlightWriteRef = useRef<string | null>(null);
	// True when a write was REQUESTED while one was already in flight. The
	// request is serialized behind the in-flight write and drained the moment
	// it settles (DRAINED WITH THE LATEST VALUE), so the database completion
	// order always matches the editor's intent order.
	const pendingRef = useRef(false);
	// True when the queued pending write is the unmount flush (its outcome
	// reports to the parent; an ordinary pending write is just the latest
	// debounced/retried value).
	const flushPendingRef = useRef(false);
	// True while the CURRENTLY in-flight write is the flush, so its success
	// routes to `onFlush` (fallback `onSaved`) and never touches state.
	const flushOutcomeRef = useRef(false);
	const flushCallbackRef = useRef(onFlush);
	const onSavedRef = useRef(onSaved);
	// Breaks the write<->saveLatest cycle: write retries via saveLatestRef and
	// drains via writeRef, so neither identity depends on the other.
	const saveLatestRef = useRef<() => void>(() => {});
	const writeRef = useRef<(snapshot: string, isFlush: boolean) => void>(() => {});
	// True while a background flush has enqueued a write at the storage layer;
	// prevents duplicate flush writes for the same hidden transition.
	const backgroundFlushRef = useRef(false);

	onSavedRef.current = onSaved;
	flushCallbackRef.current = onFlush;

	// Reset the editor when the preloaded content changes. The parent mounts
	// this component with `key={date}`, so one mount is one date's workspace;
	// this effect covers the loading -> loaded transition on that same mount.
	useEffect(() => {
		cancelledRef.current = false;
		lastSavedRef.current = initialContent ?? "";
		inFlightWriteRef.current = null;
		pendingRef.current = false;
		flushPendingRef.current = false;
		flushOutcomeRef.current = false;
		setValue(initialContent ?? "");
		setLoading(initialContent === null);
		setSaveState(initialContent === null ? "idle" : "saved");
		setError(null);
	}, [initialContent]);

	/**
	 * drain — start the queued write once the in-flight write settles. The
	 * queue holds INTENT only: the value is always re-read through valueRef at
	 * drain time (nothing can interleave between a settle and its drain), so
	 * the write that runs is always the editor's latest value and the queue
	 * can never resurrect an older snapshot. A queued FLUSH always runs (the
	 * parent must learn the value persisted); a queued plain write runs only
	 * while the editor is still dirty.
	 */
	const drain = () => {
		if (inFlightWriteRef.current !== null) return;
		if (!pendingRef.current) return;
		pendingRef.current = false;
		const isFlush = flushPendingRef.current;
		flushPendingRef.current = false;
		const latest = valueRef.current;
		if (isFlush || latest !== lastSavedRef.current) {
			void writeRef.current(latest, isFlush);
		}
	};

	/**
	 * Serialized, latest-wins write.
	 *
	 * Exactly one upsert is in flight at any time; a request that arrives
	 * while one is running is queued (pendingRef) and drained the moment the
	 * in-flight write settles — with the LATEST value — so the database
	 * completion order always matches the editor's intent order (an older
	 * value can never land after a newer one).
	 *
	 * A write's own outcome is applied only when the write is still the
	 * editor's latest value AND the editor is still mounted; otherwise it is
	 * a STALE outcome and is ignored entirely — it never paints Saved/error,
	 * never arms a retry, and never fires onSaved. The unmount flush is the
	 * one exception: its success reports to the parent through `onFlush`
	 * (falling back to `onSaved` when the parent gave no onFlush), with no
	 * state writes, because the editor is already gone but the parent must
	 * still learn that the flushed value persisted. Flush failures are silent
	 * (the value never persisted) and are always caught.
	 */
	const runWrite = (snapshot: string, isFlush: boolean) => {
		if (inFlightWriteRef.current !== null) return; // single-flight (safety)
		inFlightWriteRef.current = snapshot;
		flushOutcomeRef.current = isFlush;
		void (async () => {
			try {
				await service?.upsert(date, snapshot);
			} catch {
				const settled = inFlightWriteRef.current ?? snapshot;
				const wasFlush = flushOutcomeRef.current;
				inFlightWriteRef.current = null;
				flushOutcomeRef.current = false;
				// A stale failure (a newer value was typed) is silent, and so is
				// any failure after unmount (flush included): no stale error, no
				// stale retry, no unhandled rejection.
				if (!cancelledRef.current && !wasFlush && valueRef.current === settled) {
					setSaveState("error");
					setError(RETRY_ERROR);
					if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
					retryTimerRef.current = setTimeout(() => void saveLatestRef.current(), RETRY_DELAY_MS);
				}
				drain();
				return;
			}
			const settled = inFlightWriteRef.current ?? snapshot;
			const wasFlush = flushOutcomeRef.current;
			inFlightWriteRef.current = null;
			flushOutcomeRef.current = false;
			if (cancelledRef.current) {
				// Post-unmount: never touch state. Only the flush write reports —
				// through onFlush, or onSaved when no onFlush was given (editor
				// used standalone), so the parent still learns it persisted.
				if (wasFlush) {
					lastSavedRef.current = settled;
					if (flushCallbackRef.current) flushCallbackRef.current();
					else onSavedRef.current?.(settled);
				}
			} else if (valueRef.current === settled) {
				lastSavedRef.current = settled;
				setSaveState("saved");
				onSavedRef.current?.(settled);
			}
			// Stale success (a newer value was typed): silent — drain below
			// starts the newer value's own write.
			drain();
		})();
	};
	writeRef.current = runWrite;

	const saveLatest = useCallback(() => {
		// Cancel any already-armed retry so exactly one retry chain runs at a
		// time; the retry always re-reads the LATEST value when it fires.
		if (retryTimerRef.current) {
			clearTimeout(retryTimerRef.current);
			retryTimerRef.current = null;
		}
		const current = valueRef.current;
		if (current === lastSavedRef.current) return;
		setSaveState("saving");
		setError(null);
		if (inFlightWriteRef.current !== null) {
			// Serialized tail: queue this request; the latest value is drained
			// as soon as the in-flight write settles.
			pendingRef.current = true;
			return;
		}
		void writeRef.current(current, false);
	}, []);

	saveLatestRef.current = saveLatest;

	// Debounced save: (re)arm a save 800ms after the newest value/typing change.
	useEffect(() => {
		if (loading) return undefined;
		if (value === lastSavedRef.current) return undefined;
		saveTimerRef.current = setTimeout(() => void saveLatestRef.current(), SAVE_DEBOUNCE_MS);
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		};
	}, [value, loading]);

	// Android may kill the WebView after the app backgrounds without unmounting
	// React, so the debounce timer may never fire. Persist the newest text the
	// moment the document becomes hidden. When no save is in flight this is a
	// normal serialized write; when one IS in flight, the newest snapshot is
	// enqueued directly through `service.upsert` (a real queued native
	// operation at the storage layer) instead of a JS pending flag that a
	// killed process can lose before drain() runs. The storage-layer queue
	// still orders it after the in-flight write, so the database always ends
	// with the newest value.
	useEffect(() => {
		const flushOnBackground = () => {
			if (document.visibilityState !== "hidden") return;
			if (saveTimerRef.current) {
				clearTimeout(saveTimerRef.current);
				saveTimerRef.current = null;
			}
			const current = valueRef.current;
			if (current === lastSavedRef.current || backgroundFlushRef.current) return;
			if (retryTimerRef.current) {
				clearTimeout(retryTimerRef.current);
				retryTimerRef.current = null;
			}
			setSaveState("saving");
			setError(null);
			if (inFlightWriteRef.current === null) {
				void writeRef.current(current, false);
				return;
			}
			backgroundFlushRef.current = true;
			void service
				?.upsert(date, current)
				.then(() => {
					backgroundFlushRef.current = false;
					if (cancelledRef.current) return;
					// Apply the outcome only if no newer value was typed in the
					// meantime and no later write took over the editor's state.
					if (inFlightWriteRef.current === null && valueRef.current === current) {
						lastSavedRef.current = current;
						setSaveState("saved");
						onSavedRef.current?.(current);
					}
				})
				.catch(() => {
					backgroundFlushRef.current = false;
					if (cancelledRef.current) return;
					setSaveState("error");
					setError(RETRY_ERROR);
					if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
					retryTimerRef.current = setTimeout(() => void saveLatestRef.current(), RETRY_DELAY_MS);
				});
		};
		document.addEventListener("visibilitychange", flushOnBackground);
		return () => document.removeEventListener("visibilitychange", flushOnBackground);
	}, [date, service]);

	// Dirty guard for page close: re-evaluated on every value/saveState change,
	// so a completed save (lastSavedRef catches up) tears the listener down. The
	// saveState read keeps the listener lifecycle following completed saves.
	useEffect(() => {
		const dirty = value !== lastSavedRef.current;
		if (!dirty && saveState !== "saving") return undefined;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", handler);
		return () => {
			window.removeEventListener("beforeunload", handler);
		};
	}, [value, saveState]);

	// Unmount: cancel all in-flight work and flush a dirty value fire-and-forget.
	// The flush is ORDERED after any in-flight write (single-flight lock: a
	// flush requested while a write is running is queued and drained only once
	// that write settles, so the latest value always lands last — it can never
	// be clobbered by the older in-flight write). The flush rejection is caught
	// inside runWrite (no unhandled rejection), there is NO post-unmount
	// setState, and on success it reports ONLY through `onFlush` (fallback
	// `onSaved` when the parent gave none).
	useEffect(
		() => () => {
			cancelledRef.current = true;
			if (retryTimerRef.current) {
				clearTimeout(retryTimerRef.current);
				retryTimerRef.current = null;
			}
			if (saveTimerRef.current) {
				clearTimeout(saveTimerRef.current);
				saveTimerRef.current = null;
			}
			if (valueRef.current !== lastSavedRef.current) {
				if (inFlightWriteRef.current !== null) {
					pendingRef.current = true;
					flushPendingRef.current = true;
				} else {
					void writeRef.current(valueRef.current, true);
				}
			}
		},
		[],
	);

	const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const next = e.target.value;
		if (Array.from(next).length > JOURNAL_CONTENT_MAX) {
			setError(MAX_ERROR);
			enforceMax(e.target, value);
			return;
		}
		setError(null);
		setValue(next);
		setSaveState("idle");
	};

	return (
		<div className="editor">
			{loading ? (
				<p className="loading-text" role="status">
					Loading entry…
				</p>
			) : (
				<>
					<textarea
						className="editor-textarea"
						aria-label={`Journal entry for ${date}`}
						value={value}
						onChange={handleChange}
					/>
					{error && (
						<p className="editor-status editor-status-error" role="alert">
							{error}
						</p>
					)}
					{saveState === "saving" && (
						<p className="editor-status" role="status">
							Saving…
						</p>
					)}
					{saveState === "saved" && (
						<p className="editor-status editor-status-saved" role="status">
							Saved
						</p>
					)}
				</>
			)}
		</div>
	);
}
