import { weekdayNumber } from "@rememberme/core";
import type { To } from "react-router-dom";
import { Link } from "react-router-dom";
import { monthDates, monthLabel, shiftMonth } from "@/lib/month-grid";
import { cn } from "@/lib/utils";

const WEEKDAY_FULL = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
] as const;
const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;

const NO_ENTRIES: ReadonlySet<string> = new Set();

/**
 * Build `n` unique semantic blank-cell keys (e.g. `month-blank-lead-002`) by a
 * plain count loop. The prefix scopes each pool and the zero-padded two/three
 * digit token keeps keys distinct and stably orderable within the pool, so a
 * blank is keyed by its slot, not its React position (`map` callback index).
 */
function addBlanks(n: number, prefix = "slot"): string[] {
	const out: string[] = [];
	for (let k = 1; k <= n; k += 1) {
		out.push(`month-blank-${prefix}-${offsetToken(k)}`);
	}
	return out;
}

/** Zero-padded (2-digit) counter token for a semantic slot key. */
function offsetToken(k: number): string {
	return String(k).padStart(2, "0");
}

export interface MonthGridProps {
	/** Civil year of the month to render. */
	year: number;
	/** Civil month (1..12). */
	month: number;
	/**
	 * Dates (YYYY-MM-DD) that have journal entries this month. Omit (or pass an
	 * empty set) for a normal linked grid with empty semantics; pass `null` to
	 * render the loading placeholder body (no day links, no entry/today
	 * markers, no sr-only entry text) while the caller's month read is pending.
	 */
	entryDates?: ReadonlySet<string> | null;
	/**
	 * Build a router target for a day cell; defaults to `/journal/:date`.
	 * Month navigation is state-changed in the parent (not a route), so there
	 * is no `linkForDate` for the prev/next controls — they are buttons.
	 */
	linkForDate?: (date: string) => To;
	/** Advance to the newer (later) month; no-op when at the upper boundary. */
	onNext?: () => void;
	/** Move back to the earlier month; no-op when at the lower boundary. */
	onPrevious?: () => void;
	/**
	 * Today's calendar date (YYYY-MM-DD) in the saved timezone, used to mark
	 * the current month's day with `data-today`.
	 */
	today?: string;
}

/**
 * Accessible full day label including the year, e.g. "Saturday, August 1, 2026".
 * (Unlike the WeekStrip, the month grid shows the year so months from
 * different years are distinguishable.)
 */
function dayLabel(date: string): string {
	const weekday = WEEKDAY_FULL[weekdayNumber(date) - 1];
	const month = MONTHS[Number(date.slice(5, 7)) - 1];
	const day = Number(date.slice(8, 10));
	return `${weekday}, ${month} ${day}, ${date.slice(0, 4)}`;
}

/**
 * MonthGrid — a single browserable calendar month for the Archive page.
 *
 * Newest-first navigation: the later (newer) month is reached from the TOP
 * control, the earlier (back) month from the BOTTOM one, both clamped at the
 * representable 0000-01 / 9999-12 boundaries (a boundary control renders as a
 * disabled button, never a link). Layout is a deterministic 6-week grid: 7
 * weekday header cells plus 42 day slots (leader/trailer blanks derived from
 * `weekdayNumber(first-of-month)`), so the grid height is stable across
 * months regardless of where the first weekday falls.
 *
 * Each day that has an entry carries `data-has-entry` and an sr-only "Entry
 * saved" status; the day matching the saved-timezone "today" carries
 * `data-today`. Day cells are native router `<Link>`s to `/journal/:date`.
 * Semantic `.month-*` classes in global.css provide the presentation.
 */
export default function MonthGrid({
	year,
	month,
	entryDates = NO_ENTRIES, // omitted -> normal empty semantics (backcompat)
	linkForDate = (date: string) => `/journal/${date}`,
	onNext,
	onPrevious,
	today,
}: MonthGridProps) {
	const label = monthLabel(year, month);
	const days = monthDates(year, month);
	// Mon=1..Sun=7; leading blanks are the weekday slots before the first day.
	const leadingBlanks = weekdayNumber(days[0]) - 1;
	// Deterministic 42-slot (6 week) grid; trailing blanks fill the rest.
	const trailingBlanks = 42 - leadingBlanks - days.length;

	// Semantic keys for the leading/trailing spacer slots, precomputed by raw
	// loops (not by the map callback index) so every blank React key is stable
	// and independent of render order. They are content-free presentation
	// (aria-hidden) cells, so the key is a deterministic slot string rather than
	// an `addDays` date — which would overflow the 0000..9999 range and crash at
	// the month boundary (e.g. 0000-01 / 9999-12). `addBlanks(out, k)` is a pure
	// loop seeding the pool from a leading zero-count.
	const leadKeys = addBlanks(leadingBlanks);
	const trailKeys = addBlanks(trailingBlanks);

	const next = shiftMonth(year, month, 1);
	const prev = shiftMonth(year, month, -1);
	// Navigation is disabled ONLY at the representable month boundary (0000-01
	// / 9999-12). Absence of a handler is a caller contract (the Archive page
	// always provides one) and does not disable the control.
	const nextDisabled = next === null;
	const prevDisabled = prev === null;

	// The loading announcement is a SIBLING of the busy region, never a child:
	// an aria-busy ancestor makes assistive tech defer a nested live region's
	// reading until busy clears, so a role=status "Loading…" inside the busy
	// section would never be spoken while the month read is in flight. The
	// region itself keeps aria-busy (its 42-slot body is still being replaced).
	return (
		<>
			{entryDates === null && (
				<p role="status" className="muted-text">
					Loading your journal…
				</p>
			)}
			<section
				aria-labelledby="monthgrid-title"
				className="month-grid-card"
				// While entry dates are loading (null) the region is busy even though
				// navigation and the deterministic 42-slot placeholder body stay up.
				aria-busy={entryDates === null ? true : undefined}
			>
				<div className="month-nav-row month-nav-row-top">
					<button
						type="button"
						className="month-nav-button"
						aria-label="Next month"
						disabled={nextDisabled}
						onClick={nextDisabled ? undefined : onNext}
					>
						→
					</button>
				</div>
				<h2 id="monthgrid-title" className="month-title">
					{label}
				</h2>
				<div className="month-nav-row month-nav-row-bottom">
					<button
						type="button"
						className="month-nav-button"
						aria-label="Previous month"
						disabled={prevDisabled}
						onClick={prevDisabled ? undefined : onPrevious}
					>
						←
					</button>
				</div>

				{/* Loading placeholder body: `entryDates` is null while the caller's
				    month read is in flight. The month heading and nav stay mounted
				    (rapid navigation works), the deterministic 42-slot body is kept,
				    but day cells are non-links and aria-hidden with no
				    entry/today status semantics — we never claim an entry exists or
				    is absent before the read settles. The accessible role=status
				    announcement lives OUTSIDE this section (see above). */}
				{entryDates === null ? (
					<div className="month-grid" aria-hidden="true">
						{WEEKDAY_SHORT.map((short, index) => (
							<div key={short} className="month-weekday-header">
								<abbr title={WEEKDAY_FULL[index]}>{short}</abbr>
							</div>
						))}
						{leadKeys.map((key) => (
							<div key={key} className="month-day-blank" data-blank="true" aria-hidden="true" />
						))}
						{days.map((date) => (
							<div key={date} className="month-day-cell" aria-hidden="true">
								<span className="month-day-number">{Number(date.slice(8, 10))}</span>
							</div>
						))}
						{trailKeys.map((key) => (
							<div key={key} className="month-day-blank" data-blank="true" aria-hidden="true" />
						))}
					</div>
				) : (
					<div className="month-grid">
						{WEEKDAY_SHORT.map((short, index) => (
							<div key={short} className="month-weekday-header">
								<abbr title={WEEKDAY_FULL[index]}>{short}</abbr>
							</div>
						))}
						{leadKeys.map((key) => (
							<div key={key} className="month-day-blank" data-blank="true" aria-hidden="true" />
						))}
						{days.map((date) => {
							const hasEntry = entryDates.has(date);
							const isToday = date === today;
							const statusId = `month-entry-${date}`;
							return (
								<div key={date} className="month-day-cell">
									<Link
										to={linkForDate(date)}
										aria-label={dayLabel(date)}
										aria-describedby={statusId}
										data-has-entry={hasEntry ? "true" : "false"}
										data-today={isToday ? "true" : "false"}
										className={cn(
											"month-day-link",
											hasEntry && "month-day-link-has",
											isToday && "month-day-link-today",
										)}
									>
										<span className="month-day-number">{Number(date.slice(8, 10))}</span>
										<span id={statusId} className="sr-only">
											{hasEntry ? "Entry saved" : "No entry"}
										</span>
									</Link>
								</div>
							);
						})}
						{trailKeys.map((key) => (
							<div key={key} className="month-day-blank" data-blank="true" aria-hidden="true" />
						))}
					</div>
				)}
			</section>
		</>
	);
}
