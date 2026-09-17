import { type InstantLike, todayInTimezone } from "@rememberme/core";
import { CalendarDays } from "lucide-react";
import { useEffect, useState } from "react";
import { deviceTimezone } from "@/auth/device-timezone";
import MonthGrid from "@/components/archive/MonthGrid";
import { Card, CardContent } from "@/components/ui/card";
import type { DatabaseHandle } from "@/db/bootstrap";
import { useStorage } from "@/db/storage";
import { useSettings } from "@/db/use-settings";
import { monthDates, shiftMonth } from "@/lib/month-grid";

export interface ArchiveProps {
	/** Current instant; defaults to the wall clock, injectable for tests. */
	now?: InstantLike;
}

/**
 * Archive — browse past journal entries as a browserable month grid.
 *
 * Phase 5 Task 8. The visible month defaults to the month of today in the
 * SAVED timezone (`settings.timezone`, seeded by first-run setup), and the
 * `data-today` marker uses that same saved-zone date. Month-relative entry
 * markers come from `storage.journal.listDates(monthStart, monthEnd)`.
 *
 * The component is split into a guarded outer `Archive` and an inner
 * `ReadyArchive` that is mounted ONLY after the saved settings have resolved
 * to a non-null value. This is what makes the saved timezone authoritative
 * for the first visible month: the inner component's `useState` initializers
 * (and a single captured `now`) run from the saved zone, so the device zone
 * is never consulted for the visible month once a real storage read succeeds
 * — and there is no one-shot effect that could reset user navigation after a
 * later settings read.
 *
 * Fail-closed tiers, mirroring Today/Settings:
 * - No storage (web/test/dev / App-alone): the on-device-database message, and
 *   never a rendered grid (also no device-zone flash).
 * - Real storage but settings still loading: an accessible loading status, and
 *   the section is aria-busy.
 * - Real storage but the settings read failed: an accessible alert, no grid.
 * - A `listDates` rejection for the visible month: an accessible alert, and
 *   the grid stays closed (no empty-month copy — we never claim "no entries"
 *   when we failed to read).
 * - Month navigation carries a per-month cancellation flag so a stale
 *   previous-month response (success or failure) can never overwrite or clear
 *   the visible month's markers/status (rapid next/prev is safe).
 */
export default function Archive({ now }: ArchiveProps) {
	const storage = useStorage();
	const { settings, error } = useSettings();

	// A real storage read is pending (settings null, no error yet) or failed;
	// Archive fails closed here — no saved-zone month, no grid.
	const pending = storage !== null && settings === null && error === null;
	const failed = storage !== null && settings === null && error !== null;

	// The device zone is only ever consulted when there is NO saved settings
	// value to read from — the inner grid never sees it once settings resolve.
	const zone = settings?.timezone ?? deviceTimezone();

	return (
		<>
			{/* Settings-tier loading announcement: a SIBLING of the busy section,
			    never a child. An aria-busy ancestor makes assistive tech defer a
			    nested live region's reading until busy clears — and the busy
			    settings tier clears only by REPLACING this status with the ready
			    content — so a nested role=status would never be spoken. The outer
			    region keeps aria-busy while the tier is being loaded (same pattern
			    as the MonthGrid month read). */}
			{pending && (
				<p role="status" className="muted-text">
					Loading your journal…
				</p>
			)}
			<section
				aria-labelledby="archive-title"
				className="page-section"
				// Outer aria-busy covers ONLY the outer settings tier (whose loading
				// status announcement renders above, outside this section). The ready
				// month-read's busy is owned by MonthGrid's own region, so a failed
				// month read never leaves the outer region busy under an alert.
				aria-busy={pending || undefined}
			>
				<div className="page-heading-row">
					<CalendarDays className="page-icon" aria-hidden="true" />
					<h1 id="archive-title" className="page-title">
						Archive
					</h1>
				</div>

				{!storage ? (
					<Card>
						<CardContent>
							<p className="muted-text">
								Editing requires the on-device database, which is only available inside the Android
								app.
							</p>
						</CardContent>
					</Card>
				) : pending ? null : failed ? (
					<div role="alert">
						<p>We couldn't load your archive.</p>
						<p className="muted-text">Please try again.</p>
					</div>
				) : (
					<ReadyArchive now={now ?? new Date()} zone={zone} storage={storage} />
				)}
			</section>
		</>
	);
}

/**
 * Inner ready component — mounted ONLY after a non-null validated settings
 * read, so its `useState` initializers (first visible month, marker/status
 * state) always run from the SAVED timezone and never from a device-zone
 * first paint. `now` is captured once per mount so the month and `data-today`
 * can't drift across a midnight boundary mid-session.
 */
function ReadyArchive({
	now,
	zone,
	storage,
}: {
	now: InstantLike;
	zone: string;
	storage: DatabaseHandle;
}) {
	// Resolve the saved-zone date exactly once for this ready mount. A plain
	// `new Date()`/instant recomputed per render could cross midnight mid-
	// session and silently shift the month under the user; capturing it once
	// keeps the session's "today" and first visible month stable.
	const [today] = useState(() => todayInTimezone(zone, now));
	const [year, setYear] = useState(() => Number(today.slice(0, 4)));
	const [month, setMonth] = useState(() => Number(today.slice(5, 7)));
	const [entryDates, setEntryDates] = useState<ReadonlySet<string> | null>(null);
	const [entryError, setEntryError] = useState<string | null>(null);

	const monthDays = monthDates(year, month);
	const first = monthDays[0];
	const last = monthDays[monthDays.length - 1];

	// Load the visible month's entry dates. Each navigation to a new
	// `first`/`last` starts a fresh load; a `cancelled` flag drops stale
	// responses (success or failure) so rapid month navigation never lets an
	// older month's response overwrite the visible month's markers/status.
	// The busy state for this read is owned by MonthGrid's own region (its
	// `aria-busy`), NOT by the outer Archive section.
	// `storage` is non-null here — ReadyArchive only mounts once settings
	// (which require storage) resolved non-null.
	useEffect(() => {
		setEntryError(null);
		let cancelled = false;
		setEntryDates(null); // back to loading for the newly-visible month
		void storage.journal
			.listDates(first, last)
			.then((dates) => {
				if (!cancelled) setEntryDates(new Set(dates));
			})
			.catch((reason) => {
				if (!cancelled) {
					setEntryDates(null);
					setEntryError(String(reason?.message ?? reason));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [storage, first, last]);

	return (
		<>
			{entryError !== null ? (
				<div role="alert">
					<p>We couldn't load this month's entries.</p>
					<p className="muted-text">Please try again.</p>
				</div>
			) : (
				<>
					{/* The grid stays mounted during a month read so navigation remains
					    available (rapid next/prev works) and the visible month never
					    flickers. While `entryDates` is null the grid renders its own
					    loading placeholder body (no day links, no entry/today markers,
					    no sr-only text, no empty-month copy) — so we never claim an
					    entry exists — or is absent — before the read settles.

					    The nav handlers batch the reset to loading (setEntryDates(null)
					    + clear entryError) with the year/month change, so the FIRST
					    commit of the new month renders loading placeholders — never the
					    previous month's resolved marker set re-rendered against the new
					    month's dates. The load effect still carries the per-month
					    `cancelled` generation flag, so the batched reset does not weaken
					    stale-response cancellation. */}
					<MonthGrid
						year={year}
						month={month}
						entryDates={entryDates}
						today={today}
						onPrevious={() => {
							const p = shiftMonth(year, month, -1);
							if (p) {
								setEntryDates(null);
								setEntryError(null);
								setYear(p.year);
								setMonth(p.month);
							}
						}}
						onNext={() => {
							const n = shiftMonth(year, month, 1);
							if (n) {
								setEntryDates(null);
								setEntryError(null);
								setYear(n.year);
								setMonth(n.month);
							}
						}}
					/>
					{entryDates !== null && entryDates.size === 0 && (
						<p className="muted-text">No entries this month.</p>
					)}
				</>
			)}
		</>
	);
}
