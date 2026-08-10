import { DateTime } from "luxon";

/**
 * Timezone-aware date helpers. "Today" is always determined in the user's
 * configured timezone — never server UTC.
 */

/** Today's calendar date (YYYY-MM-DD) in the given IANA timezone. */
export function todayInTimezone(timezone: string): string {
	return DateTime.now().setZone(timezone).toFormat("yyyy-MM-dd");
}

/** Human-readable weekday + date, e.g. "Monday · August 10, 2026". */
export function formatDay(date: string, timezone: string): string {
	const dt = DateTime.fromISO(date, { zone: timezone });
	if (!dt.isValid) return date;
	return dt.toFormat("cccc · LLLL d, yyyy");
}

/** "August 3 — August 9" style range for a Monday..Sunday week. */
export function formatWeekRange(weekStart: string, weekEnd: string, timezone: string): string {
	const start = DateTime.fromISO(weekStart, { zone: timezone });
	const end = DateTime.fromISO(weekEnd, { zone: timezone });
	if (!start.isValid || !end.isValid) return `${weekStart} — ${weekEnd}`;
	const sameMonth = start.month === end.month && start.year === end.year;
	if (sameMonth) return `${start.toFormat("MMMM d")} — ${end.toFormat("MMMM d, yyyy")}`;
	return `${start.toFormat("MMMM d")} — ${end.toFormat("MMMM d, yyyy")}`;
}
