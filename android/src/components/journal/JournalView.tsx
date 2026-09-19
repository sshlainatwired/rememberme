import {
	addDays,
	type CalendarDate,
	formatDay,
	type InstantLike,
	mondayOfWeek,
} from "@rememberme/core";
import { BookOpenText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import JournalEditor from "@/components/journal/JournalEditor";
import WeekStrip from "@/components/journal/WeekStrip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DatabaseHandle } from "@/db/bootstrap";
import { useStorage } from "@/db/storage";

export interface JournalViewProps {
	date: CalendarDate;
	/** Injectable instant seam; retained for the Today page's `now`. */
	now?: InstantLike;
}

type MarkerPhase = "loading" | "ready" | "error" | "unavailable";

interface MarkerState {
	ownerWeekStart: CalendarDate;
	phase: MarkerPhase;
	dates: ReadonlySet<string> | null;
}

interface EntryState {
	loading: boolean;
	content: string | null;
	error: string | null;
}

function markerStateFor(storage: DatabaseHandle | null, weekStart: CalendarDate): MarkerState {
	return {
		ownerWeekStart: weekStart,
		phase: storage ? "loading" : "unavailable",
		dates: null,
	};
}

function entryStateFor(storage: DatabaseHandle | null): EntryState {
	return {
		loading: storage !== null,
		content: null,
		error: null,
	};
}

/**
 * JournalView — the daily journal screen for one calendar date: a week-marker
 * WeekStrip plus a keyed, fail-closed editor.
 *
 * Contract (Phase 5 Task 7):
 * - Week markers come from `storage.journal.listDates(this week)`, and are
 *   refreshed through `onSaved` after every successful save/delete (and through
 *   `onFlush` after the editor's unmount flush), so a just-written entry lights
 *   up its weekday (and a cleared entry loses it).
 * - Marker requests carry a per-week generation token. The generation is
 *   bumped whenever the visible week changes AND on every re-request, so a
 *   stale previous-week response — whether it resolves or fails late — can
 *   never overwrite the currently-visible week's marker set.
 * - The editor workspace is keyed by `date` (`key={date}`), and entry state is
 *   synchronously owned by both the storage handle and date. Its load
 *   continuation checks the current owner, generation, and cancellation, so an
 *   old handle/date's in-flight load can never paint or write through the new
 *   editor.
 * - A `journal.get` rejection fails closed: an accessible alert shows the
 *   retained reason and NO editor renders (typing must not overwrite an entry
 *   the view failed to read).
 * - Marker state is owned by the visible week and storage handle. Loading,
 *   error, unavailable, and owner-mismatch states pass unknown markers to
 *   WeekStrip rather than claiming that days are empty.
 * - Without storage (web/test/dev / App-alone) the WeekStrip still renders
 *   neutral navigation, and the editor fails closed with a truthful message —
 *   there is no browser-storage fallback.
 */
export default function JournalView({ date }: JournalViewProps) {
	const storage = useStorage();
	const weekStart = mondayOfWeek(date);
	const [markers, setMarkers] = useState<MarkerState>(() => markerStateFor(storage, weekStart));
	const [markerOwner, setMarkerOwner] = useState(() => ({ storage, weekStart }));
	const [entryOwner, setEntryOwner] = useState(() => ({ storage, date }));
	const [entry, setEntry] = useState<EntryState>(() => entryStateFor(storage));
	const entryGenerationRef = useRef(0);
	const entryOwnerRef = useRef({ storage, date });
	// Generation of the marker request the CURRENTLY-visible week belongs to.
	// Bumped whenever the visible week changes, so every response (success or
	// failure) is applied only if it is still the latest generation.
	const markerGenerationRef = useRef(0);
	// Invalidate marker data during render, before a visible-week/handle change
	// can commit a frame with the previous owner's set.
	if (markerOwner.storage !== storage || markerOwner.weekStart !== weekStart) {
		setMarkerOwner({ storage, weekStart });
		markerGenerationRef.current += 1;
		setMarkers(markerStateFor(storage, weekStart));
	}
	if (entryOwner.storage !== storage || entryOwner.date !== date) {
		const nextOwner = { storage, date };
		setEntryOwner(nextOwner);
		entryOwnerRef.current = nextOwner;
		entryGenerationRef.current += 1;
		setEntry(entryStateFor(storage));
	}
	// Breaks handleFlush<->loadDates cycle so handleFlush is stably memoized
	// (its identity only depends on weekStart).
	const loadDatesRef = useRef<() => Promise<void>>(() => Promise.resolve());

	const loadDates = useCallback(async () => {
		if (!storage) return;
		const generation = ++markerGenerationRef.current;
		setMarkers({ ownerWeekStart: weekStart, phase: "loading", dates: null });
		try {
			const dates = await storage.journal.listDates(weekStart, addDays(weekStart, 6));
			if (generation === markerGenerationRef.current) {
				setMarkers({ ownerWeekStart: weekStart, phase: "ready", dates: new Set(dates) });
			}
		} catch {
			// Stale failures (a newer week already took over the generation) are
			// ignored; only the current week's own failure becomes an error state.
			if (generation === markerGenerationRef.current) {
				setMarkers({ ownerWeekStart: weekStart, phase: "error", dates: null });
			}
		}
	}, [storage, weekStart]);
	loadDatesRef.current = loadDates;

	// Current-visible-week guarded parent callback for the editor's unmount
	// flush. The editor already confirmed the flush landed without touching
	// post-unmount state; this only refreshes markers when the flush's week is
	// still the one this view shows (via the generation guard in loadDates).
	// `[]` deps keep it referentially stable across renders (it reads the live
	// loadDates through loadDatesRef, which is reassigned every render), so the
	// keyed editor never re-mounts just because onFlush's identity changed.
	const handleFlush = useCallback(() => {
		void loadDatesRef.current();
	}, []);

	// Load this week's markers. Each call forks its own generation so a late
	// response can never clobber a fresher date set (success or failure).
	useEffect(() => {
		void loadDates();
		return () => {
			// Invalidate the generation for THIS invocation (and any superseded
			// ones that shared it) when the effect tears down on a week change.
			markerGenerationRef.current += 1;
		};
	}, [loadDates]);

	// Load the open date's entry; owner, generation, and cancellation guards
	// ensure an old handle/date cannot overwrite the new date's editor. A
	// rejection is fail-closed: an accessible alert retains the reason and no
	// editor renders.
	useEffect(() => {
		const ownerStorage = storage;
		const ownerDate = date;
		const generation = ++entryGenerationRef.current;
		let cancelled = false;
		const isCurrent = () =>
			!cancelled &&
			generation === entryGenerationRef.current &&
			entryOwnerRef.current.storage === ownerStorage &&
			entryOwnerRef.current.date === ownerDate;
		if (!storage) {
			if (isCurrent()) setEntry({ loading: false, content: null, error: null });
			return () => {
				cancelled = true;
				if (entryGenerationRef.current === generation) entryGenerationRef.current += 1;
			};
		}
		void storage.journal
			.get(date)
			.then((row) => {
				if (isCurrent()) setEntry({ loading: false, content: row?.content ?? "", error: null });
			})
			.catch((reason) => {
				if (isCurrent())
					setEntry({ loading: false, content: null, error: String(reason?.message ?? reason) });
			});
		return () => {
			cancelled = true;
			if (entryGenerationRef.current === generation) entryGenerationRef.current += 1;
		};
	}, [date, storage]);

	return (
		<section aria-labelledby="journal-title" className="page-section">
			<div className="page-heading-row">
				<BookOpenText className="page-icon" aria-hidden="true" />
				<h1 id="journal-title" className="page-title">
					{formatDay(date)}
				</h1>
			</div>

			<WeekStrip
				currentDate={date}
				weekStart={weekStart}
				entryDates={
					markers.ownerWeekStart === weekStart && markers.phase === "ready" ? markers.dates : null
				}
			/>

			<Card>
				<CardHeader>
					<CardTitle>Write your entry</CardTitle>
				</CardHeader>
				<CardContent>
					{!storage ? (
						<p className="muted-text">
							Editing requires the on-device database, which is only available inside the Android
							app.
						</p>
					) : entry.loading ? (
						<p className="loading-text" role="status">
							Loading…
						</p>
					) : entry.error !== null ? (
						<div role="alert">
							<p>We couldn't load this entry.</p>
							<p className="muted-text">Please try again.</p>
						</div>
					) : (
						<JournalEditor
							key={date}
							date={date}
							service={storage.journal}
							initialContent={entry.content}
							onSaved={() => void loadDates()}
							onFlush={handleFlush}
						/>
					)}
				</CardContent>
			</Card>
		</section>
	);
}
