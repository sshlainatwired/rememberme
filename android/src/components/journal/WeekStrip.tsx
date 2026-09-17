import { addDays, formatWeekRange, mondayOfWeek, weekDates } from "@rememberme/core";
import { Link, type To } from "react-router-dom";
import { cn } from "@/lib/utils";

const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const WEEKDAY_FULL = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
] as const;
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

export interface WeekStripProps {
	/** Calendar date of the currently open journal (YYYY-MM-DD). */
	currentDate: string;
	/** Monday of the week to show; defaults to the week of `currentDate`. */
	weekStart?: string;
	/** Entry dates present this week; null means the current week's result is unknown. */
	entryDates?: ReadonlySet<string> | null;
	/**
	 * Build a router target for a day cell (and, from it, the prev/next week
	 * links). Defaults to the `/journal/:date` route; pass a custom builder to
	 * override, e.g. to keep a legacy target.
	 */
	linkForDate?: (date: string) => To;
}

/** Accessible long label, e.g. "Wednesday, August 12" (index = weekday 0..6). */
function dayLabel(date: string, weekdayIndex: number): string {
	const month = MONTHS[Number(date.slice(5, 7)) - 1];
	const day = Number(date.slice(8, 10));
	return `${WEEKDAY_FULL[weekdayIndex]}, ${month} ${day}`;
}

/** Return an adjacent week start, or null when its full week is out of range. */
function navigableWeekStart(monday: string, offset: number): string | null {
	try {
		const target = addDays(monday, offset);
		weekDates(target);
		return target;
	} catch (error) {
		if (error instanceof RangeError) return null;
		throw error;
	}
}

/**
 * WeekStrip — Monday–Sunday calendar strip (adapted from the web
 * `components/journal/WeekStrip.astro`). All range/date math comes from the
 * shared `@rememberme/core` calendar helpers; this component only adds
 * presentation, router targets, and accessibility: component-local 44×44px
 * touch targets on every day cell, `aria-current` on the open day, long
 * labelled links, and a per-date `aria-describedby` sr-only status
 * ("Entry saved"/"No entry") so assistive tech hears entry state without
 * changing the day's accessible name.
 *
 * Day cells and the prev/next week links default to the `/journal/:date`
 * route (a custom `linkForDate` builder overrides the target). At the
 * representable year boundaries, an unavailable adjacent week is replaced by
 * an inert 44×44px spacer so rendering and header alignment remain stable.
 *
 * Phase 5 Task 1: layout/presentation comes entirely from the semantic classes
 * (`.week-strip`, `.week-nav-row`, `.week-grid`, `.weekday-link`, …) in
 * global.css — plain physical CSS for Chrome/WebView 60. No Tailwind
 * utilities remain in the markup (they generated no CSS after the plugin was
 * dropped); the strip is a flex row of percentage-width cells with 44px/56px
 * minima, the full-bleed edge bleed and the `sm:` breakpoint are encoded in
 * the stylesheet itself.
 */
export default function WeekStrip({
	currentDate,
	weekStart,
	entryDates = NO_ENTRIES,
	linkForDate = (date: string) => `/journal/${date}`,
}: WeekStripProps) {
	const monday = weekStart ?? mondayOfWeek(currentDate);
	const days = weekDates(monday);
	const prevStart = navigableWeekStart(monday, -7);
	const nextStart = navigableWeekStart(monday, 7);

	return (
		<section aria-labelledby="weekstrip-range" className="week-strip">
			<div className="week-nav-row">
				{prevStart ? (
					<Link to={linkForDate(prevStart)} aria-label="Previous week" className="week-nav-link">
						←
					</Link>
				) : (
					<span aria-hidden="true" className="week-nav-spacer" />
				)}
				<h2 id="weekstrip-range" className="week-range-title">
					{formatWeekRange(monday)}
				</h2>
				{nextStart ? (
					<Link to={linkForDate(nextStart)} aria-label="Next week" className="week-nav-link">
						→
					</Link>
				) : (
					<span aria-hidden="true" className="week-nav-spacer" />
				)}
			</div>
			<ol className="week-grid">
				{days.map((date, index) => {
					const markersKnown = entryDates !== null;
					const hasEntry = markersKnown && entryDates.has(date);
					const isCurrent = date === currentDate;
					const href = linkForDate(date);
					const entryStatusId = `weekstrip-entry-${date}`;
					return (
						<li key={date} className="weekday-cell">
							<Link
								to={href}
								aria-label={dayLabel(date, index)}
								aria-current={isCurrent ? "date" : undefined}
								aria-describedby={markersKnown ? entryStatusId : undefined}
								data-has-entry={markersKnown ? (hasEntry ? "true" : "false") : undefined}
								className={cn(
									"weekday-link",
									isCurrent ? "weekday-link-current" : "weekday-link-idle",
								)}
							>
								<span className="weekday-name">{WEEKDAY_SHORT[index]}</span>
								<span className={cn("weekday-marker", hasEntry ? "weekday-marker-has" : undefined)}>
									{markersKnown ? (hasEntry ? "✓" : "—") : ""}
								</span>
								{markersKnown && (
									<span id={entryStatusId} className="sr-only">
										{hasEntry ? "Entry saved" : "No entry"}
									</span>
								)}
							</Link>
						</li>
					);
				})}
			</ol>
		</section>
	);
}
