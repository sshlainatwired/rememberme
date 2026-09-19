/**
 * Platform-neutral weekly-digest content model (web + Android).
 *
 * Extracted from the web's `server/jobs/weekly-digest.ts` per the reuse-matrix
 * promise: the pure calendar/week/content model (Monday–Sunday ordering,
 * `DigestDay` = date + nullable content, `mostRecentSunday` week math) lives
 * here as pure functions over civil `YYYY-MM-DD` strings — no wall clock, no
 * zone, no instant. Anything that needs "now" or a timezone stays on the
 * caller side (web: `server/jobs/weekly-digest.ts`, unchanged).
 *
 * No `Date`, no Luxon, no Node, no server imports — only the pure civil
 * calendar helpers in `./calendar.ts`.
 */
import type { CalendarDate } from "./calendar";
import { addDays, weekDates, weekdayNumber } from "./calendar";

/** One day of a weekly digest: a civil calendar date and its entry content. */
export interface DigestDay {
	/** `YYYY-MM-DD` civil calendar date (Monday–Sunday week order). */
	date: CalendarDate;
	/** The journal entry content for that date, or `null` when absent. */
	content: string | null;
}

/** An exact Monday–Sunday week of digest days (7 elements, readonly). */
export type DigestWeek = readonly [
	DigestDay,
	DigestDay,
	DigestDay,
	DigestDay,
	DigestDay,
	DigestDay,
	DigestDay,
];

/**
 * Build the seven Monday–Sunday digest days for the week starting on the
 * Monday `weekStart`. `contentByDate` maps `YYYY-MM-DD` → entry content;
 * dates with no entry (or entries outside the week) map to `content: null`.
 * Content strings are preserved byte-for-byte (empty, whitespace, newlines,
 * Unicode) — nothing is trimmed or normalized.
 *
 * `weekStart` must be a valid Monday; invalid or non-Monday inputs are
 * rejected via the shared `weekDates` helper.
 */
export function buildDigestWeek(
	weekStart: string,
	contentByDate: ReadonlyMap<string, string>,
): DigestWeek {
	const dates = weekDates(weekStart);
	const out: DigestDay[] = [];
	for (const date of dates) {
		const content = contentByDate.get(date);
		out.push({ date, content: content === undefined ? null : content });
	}
	// SAFETY: `dates` has exactly 7 elements (a `Week` tuple), so `out` is an
	// exact 7-tuple of DigestDay and the cast below is exact by construction.
	return out as unknown as DigestWeek;
}

/**
 * The most recent Sunday (inclusive) at or before the civil date `date`.
 * Sunday maps to itself; Monday–Saturday map to the previous Sunday.
 * Matches the web semantics of `mostRecentSunday` in
 * `server/jobs/weekly-digest.ts` (`weekday % 7` days back, Luxon weekday
 * Mon=1..Sun=7 → Sunday 0), computed purely on the civil calendar so no zone
 * can shift the result.
 *
 * Boundary-safe: the offset is applied to `date` directly via
 * {@link weekdayNumber} instead of building the containing Monday–Sunday week,
 * so dates whose week touches the representable 0000..9999 range resolve to
 * the nearest in-range Sunday (0000-01-02 maps to itself; every
 * 9999-12-27..9999-12-31 maps to 9999-12-26). A date whose prior Sunday lies
 * outside the range (0000-01-01) still throws a RangeError, matching the rest
 * of the calendar module.
 */
export function mostRecentSunday(date: string): string {
	return addDays(date, -(weekdayNumber(date) % 7));
}
