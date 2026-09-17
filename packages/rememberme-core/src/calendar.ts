/**
 * Pure civil-calendar helpers (platform-neutral core).
 *
 * All functions operate exclusively on `YYYY-MM-DD` calendar-date strings and
 * proleptic-Gregorian civil arithmetic. There is deliberately no wall clock,
 * no instant, and no IANA zone anywhere in this module — the whole class of
 * "local calendar arithmetic accidentally done in UTC" bugs is impossible here
 * by construction. Anything that needs an instant (e.g. "today in zone X")
 * lives in `./timezone.ts` and never feeds back into this module.
 */

/** A calendar date as `YYYY-MM-DD` — years padded to 4 digits, range 0000..9999. */
export type CalendarDate = string;

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

const WEEKDAYS = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
] as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
	switch (month) {
		case 2:
			return isLeapYear(year) ? 29 : 28;
		case 4:
		case 6:
		case 9:
		case 11:
			return 30;
		default:
			return 31;
	}
}

/** Whether `value` is a real calendar date in `YYYY-MM-DD` form. */
export function isCalendarDate(value: string): boolean {
	const m = DATE_PATTERN.exec(value);
	if (!m) return false;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** Parses a validated date; throws a clear error for anything malformed. */
function parseDate(value: string): { year: number; month: number; day: number } {
	const m = DATE_PATTERN.exec(value);
	if (!m) return invalidDate(value);
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
		return invalidDate(value);
	}
	return { year, month, day };
}

function invalidDate(value: string): never {
	throw new RangeError(`Invalid calendar date: ${JSON.stringify(value)} (expected YYYY-MM-DD)`);
}

/**
 * Days since 1970-01-01 for a civil date (proleptic Gregorian), after Howard
 * Hinnant's `days_from_civil`. Pure integer arithmetic — no Date, no zone.
 */
function civilToDays(year: number, month: number, day: number): number {
	const y = year - (month <= 2 ? 1 : 0);
	const era = Math.floor(y / 400);
	const yoe = y - era * 400; // [0, 399]
	const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

/** Inverse of `civilToDays` (Hinnant's `civil_from_days`). */
function daysToCivil(z: number): { year: number; month: number; day: number } {
	const shifted = z + 719468;
	const era = Math.floor(shifted / 146097);
	const doe = shifted - era * 146097; // [0, 146096]
	const yoe = Math.floor(
		(doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
	);
	const year = yoe + era * 400;
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const month = mp + (mp < 10 ? 3 : -9);
	return { year: year + (month <= 2 ? 1 : 0), month, day };
}

/**
 * Pads a year to four digits (`1` → `0001`), rejecting values outside the
 * representable range 0000..9999 before formatting. Single shared year
 * formatter so machine `YYYY-MM-DD`, `formatDay`, and `formatWeekRange` all
 * emit 4-digit years (matching the legacy `yyyy` output).
 */
function formatYear(year: number): string {
	if (year < 0 || year > 9999) {
		throw new RangeError(
			`Calendar date year out of range 0000..9999: ${year} (civil arithmetic under/overflow)`,
		);
	}
	return String(year).padStart(4, "0");
}

function format(d: { year: number; month: number; day: number }): string {
	const yyyy = formatYear(d.year);
	const mm = String(d.month).padStart(2, "0");
	const dd = String(d.day).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

/**
 * The Monday (`YYYY-MM-DD`) of the Monday–Sunday week containing `date`.
 * Purely civil: the same calendar date maps to the same Monday in every zone.
 */
export function mondayOfWeek(date: string): string {
	const { year, month, day } = parseDate(date);
	const z = civilToDays(year, month, day);
	const weekday = ((z % 7) + 7) % 7; // 1970-01-01 (z=0) was a Thursday (weekday 4)
	const mondayOffset = (weekday + 3) % 7; // days back to Monday
	return format(daysToCivil(z - mondayOffset));
}

/**
 * The weekday number of `date` in the Monday=1 … Sunday=7 convention used by
 * Luxon/ISO (`weekdayNumber(date) % 7` is the days back to the previous
 * Sunday, matching the web digest's `weekday % 7` math). Purely civil, no
 * zone; throws on malformed input. Like {@link mondayOfWeek}, derived from
 * the day count so no week is ever materialized — safe at the representable
 * 0000..9999 boundary (no full-week construction that could overflow).
 */
export function weekdayNumber(date: string): number {
	const { year, month, day } = parseDate(date);
	const z = civilToDays(year, month, day);
	const daysSinceEpoch = ((z % 7) + 7) % 7; // 1970-01-01 (z=0) was a Thursday
	return ((daysSinceEpoch + 3) % 7) + 1; // Mon=1 … Sun=7
}

/**
 * The seven dates Monday–Sunday of the week whose `weekStart` is a Monday.
 * Accepts any civil date and returns the week *containing* it when `weekStart`
 * is not itself a Monday? No — `weekStart` must be a Monday; pass any date
 * through {@link mondayOfWeek} first. Rejects non-Mondays to catch misuse.
 */
export type Week = readonly [string, string, string, string, string, string, string];
export function weekDates(weekStart: string): Week {
	const { year, month, day } = parseDate(weekStart);
	const monday = mondayOfWeek(format({ year, month, day }));
	if (monday !== format({ year, month, day })) {
		throw new RangeError(
			`weekDates expects a Monday (YYYY-MM-DD); got ${JSON.stringify(weekStart)} — call mondayOfWeek(date) first`,
		);
	}
	const start = civilToDays(year, month, day);
	const out: string[] = [];
	for (let i = 0; i < 7; i += 1) {
		out.push(format(daysToCivil(start + i)));
	}
	// SAFETY: the loop above runs exactly 7 times (i = 0..6), so `out` always
	// has length 7 and the tuple cast below is exact by construction.
	return out as unknown as Week;
}

/**
 * Add `days` calendar days to `date` (negative goes backwards).
 *
 * `days` must be a safe integer (`Number.isSafeInteger`) — `NaN`, `±Infinity`
 * and fractions are rejected rather than silently producing garbage — and
 * the result must stay within the representable year range 0000..9999 or a
 * `RangeError` is thrown.
 */
export function addDays(date: string, days: number): string {
	if (!Number.isSafeInteger(days)) {
		throw new RangeError(`addDays expects a whole number of days; got ${days}`);
	}
	const { year, month, day } = parseDate(date);
	return format(daysToCivil(civilToDays(year, month, day) + days));
}

/**
 * Human-readable label for a civil date, e.g. "Monday · August 10, 2026".
 *
 * The weekday and month derive from the civil date itself and never depend on
 * a timezone, so the optional `timezone` argument is accepted only to preserve
 * the legacy web signature (`formatDay(date, timezone)`) and is intentionally
 * unused — no instant arithmetic happens here. Invalid input is returned
 * unchanged, matching the legacy helper's behavior.
 */
export function formatDay(date: string, _timezone?: string): string {
	if (!isCalendarDate(date)) return date;
	const { year, month, day } = parseDate(date);
	// Monday of the containing week is 1 day before Monday; the weekday of
	// `date` is its distance from that Monday plus one (Mon = 1 … Sun = 7).
	const monday = mondayOfWeek(date);
	const weekday = daysBetween(monday, date) + 1;
	return `${WEEKDAYS[weekday - 1]} · ${MONTHS[month - 1]} ${day}, ${formatYear(year)}`;
}

/** Days from `from` to `to` (positive when `to` is later). */
function daysBetween(from: string, to: string): number {
	const a = parseDate(from);
	const b = parseDate(to);
	return civilToDays(b.year, b.month, b.day) - civilToDays(a.year, a.month, a.day);
}

/**
 * Label for a whole Monday–Sunday week, e.g. "August 10 — August 16, 2026"
 * (year shown on the end date only, matching the web WeekStrip).
 * `weekStart` must be a Monday.
 */
export function formatWeekRange(weekStart: string): string {
	const days = weekDates(weekStart);
	const start = parseDate(days[0]);
	const end = parseDate(days[6]);
	return `${MONTHS[start.month - 1]} ${start.day} — ${MONTHS[end.month - 1]} ${end.day}, ${formatYear(end.year)}`;
}
