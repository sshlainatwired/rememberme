/**
 * Pure civil-calendar month helpers for the Archive month grid.
 *
 * Deliberately local and standalone: this module re-derives month shapes from
 * the shared civil calendar (`@rememberme/core` is NOT touched — YAGNI —
 * because the shared module exposes no month iterator). All math is pure
 * integer/deterministic civil arithmetic on `YYYY-MM-DD` strings and `year`
 * + `month` (1..12) pairs, with explicitly representable 0000..9999 bounds.
 *
 * Everything here is free of the wall clock and zone — month shape depends
 * only on the civil year/month, never on an instant.
 */

import type { CalendarDate } from "@rememberme/core";

/** A Gregorian leap year is divisible by 4, except centuries unless by 400. */
export function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Days in `month` (1..12) for `year`. Throws a `RangeError` for any month
 * outside 1..12 (a `daysInMonth` call is the canonical validation guard the
 * other helpers reuse).
 */
export function daysInMonth(year: number, month: number): number {
	if (!Number.isInteger(month) || month < 1 || month > 12) {
		throw new RangeError(`Invalid month ${JSON.stringify(month)} (expected 1..12).`);
	}
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

const MONTH_NAMES = [
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

/** Every `YYYY-MM-DD` in `month` of `year` (inclusive, ascending). */
export function monthDates(year: number, month: number): CalendarDate[] {
	daysInMonth(year, month); // validate the month
	const days: CalendarDate[] = [];
	for (let d = 1; d <= daysInMonth(year, month); d += 1) {
		days.push(
			`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
		);
	}
	return days;
}

/** Human label for a month, e.g. "August 2026" (year padded to 4 digits). */
export function monthLabel(year: number, month: number): string {
	daysInMonth(year, month);
	return `${MONTH_NAMES[month - 1]} ${String(year).padStart(4, "0")}`;
}

export interface YearMonth {
	year: number;
	month: number;
}

/**
 * Shift a month by `delta` (only ±1), carrying across the year boundary.
 * Returns `null` when the result would fall outside the representable range
 * 0000-01 .. 9999-12 (used to disable navigation at the boundary).
 */
export function shiftMonth(year: number, month: number, delta: 1 | -1): YearMonth | null {
	daysInMonth(year, month);
	const next = month + delta;
	if (next === 0) {
		return year - 1 < 0 ? null : { year: year - 1, month: 12 };
	}
	if (next === 13) {
		return year + 1 > 9999 ? null : { year: year + 1, month: 1 };
	}
	const clamped = { year, month: next };
	if (clamped.year < 0 || clamped.year > 9999) return null;
	return clamped;
}
