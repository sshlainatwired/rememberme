import { describe, expect, test } from "bun:test";
import { DateTime } from "luxon";
import {
	addDays,
	formatDay,
	formatWeekRange,
	isCalendarDate,
	mondayOfWeek,
	weekDates,
	weekdayNumber,
} from "./calendar";

/**
 * Oracle: the civil Monday (YYYY-MM-DD) containing a calendar date, derived
 * purely from the civil date (luxon view pinned to UTC never changes the
 * civil y/m/d fields; weekday is a civil property).
 */
function luxonMonday(date: string): string {
	const dt = DateTime.fromISO(date, { zone: "UTC" });
	return dt.minus({ days: dt.weekday - 1 }).toFormat("yyyy-MM-dd");
}

/**
 * The OLD web implementation of `mondayOfWeek` (server/jobs/weekly-digest.ts):
 * it re-zones the instant to UTC, does start-of-day + weekday math in UTC, then
 * formats the UTC calendar date. For local dates whose midnight is an adjacent
 * UTC calendar day this returns the WRONG Monday. Kept here to prove the new
 * helper's tests actually detect the UTC-mixing bug.
 */
function legacyUtcMondayOfWeek(localDate: string, timezone: string): string {
	const dt = DateTime.fromISO(localDate, { zone: timezone });
	const startOfDay = dt.setZone("UTC").startOf("day");
	return startOfDay.minus({ days: startOfDay.weekday - 1 }).toFormat("yyyy-MM-dd");
}

describe("isCalendarDate", () => {
	test("accepts real calendar dates", () => {
		for (const d of ["2026-08-10", "2024-02-29", "2000-02-29", "1970-01-01", "9999-12-31"]) {
			expect(isCalendarDate(d)).toBe(true);
		}
	});

	test("rejects malformed, impossible, or non-date-only values", () => {
		for (const d of [
			"2026-02-30",
			"2023-02-29",
			"2026-13-01",
			"2026-1-1",
			"2026/08/10",
			"",
			"2026-08-10T00:00:00Z",
			"not-a-date",
			null as unknown as string,
			undefined as unknown as string,
		]) {
			expect(isCalendarDate(d)).toBe(false);
		}
	});
});

describe("mondayOfWeek", () => {
	test("returns Monday of the Monday–Sunday week for every day of a sample week", () => {
		for (const d of [
			"2026-08-10",
			"2026-08-11",
			"2026-08-12",
			"2026-08-13",
			"2026-08-14",
			"2026-08-15",
			"2026-08-16",
		]) {
			expect(mondayOfWeek(d)).toBe("2026-08-10");
		}
	});

	test("known anchors incl. month, year boundaries and leap day", () => {
		expect(mondayOfWeek("2026-08-16")).toBe("2026-08-10");
		expect(mondayOfWeek("2026-08-02")).toBe("2026-07-27");
		expect(mondayOfWeek("2026-01-01")).toBe("2025-12-29");
		expect(mondayOfWeek("2024-02-29")).toBe("2024-02-26");
		expect(mondayOfWeek("2026-03-08")).toBe("2026-03-02");
		expect(mondayOfWeek("2026-11-01")).toBe("2026-10-26");
	});

	test("agrees with the civil-date oracle across years, DST dates, and zone-skip dates", () => {
		const samples = [
			"2011-12-30", // skipped entirely in Pacific/Apia — a civil date, still has a Monday
			"2020-02-29",
			"2026-03-08", // US DST spring forward
			"2026-11-01", // US DST fall back
			"1999-12-31",
			"2024-12-30",
			"2026-01-05",
			"2027-12-31",
		];
		for (const d of samples) {
			expect(mondayOfWeek(d)).toBe(luxonMonday(d));
		}
	});

	test("DETECTS the old UTC-mixing bug for positive-offset zones near midnight", () => {
		// 2026-08-10 in Europe/Istanbul starts at 2026-08-09T21:00:00Z. The old
		// UTC-rezoning algorithm therefore treats it as part of the UTC week that
		// began 2026-08-03, one full week early (verified against the real
		// legacy implementation in server/jobs/weekly-digest.ts):
		expect(legacyUtcMondayOfWeek("2026-08-10", "Europe/Istanbul")).toBe("2026-08-03");
		// The shared helper must stay purely on civil dates and never drift:
		expect(mondayOfWeek("2026-08-10")).toBe("2026-08-10");
		expect(mondayOfWeek("2026-08-10")).not.toBe(
			legacyUtcMondayOfWeek("2026-08-10", "Europe/Istanbul"),
		);

		// A second positive-offset zone (Asia/Tokyo, UTC+9) diverges the same
		// way on a Monday whose local midnight is the previous UTC day:
		expect(legacyUtcMondayOfWeek("2026-08-10", "Asia/Tokyo")).toBe("2026-08-03");
		expect(mondayOfWeek("2026-08-10")).not.toBe(legacyUtcMondayOfWeek("2026-08-10", "Asia/Tokyo"));

		// The shared helper is zone-independent: the same civil date always maps
		// to the same Monday no matter what zone you pass to the legacy fn.
		expect(mondayOfWeek("2026-08-10")).toBe("2026-08-10");
	});

	test("throws on malformed input", () => {
		for (const d of ["2026-13-01", "", "2026-8-10", "2026-02-30"]) {
			expect(() => mondayOfWeek(d)).toThrow();
		}
	});
});

describe("weekDates", () => {
	test("returns Monday..Sunday for a Monday week start", () => {
		expect(weekDates("2026-08-10")).toEqual([
			"2026-08-10",
			"2026-08-11",
			"2026-08-12",
			"2026-08-13",
			"2026-08-14",
			"2026-08-15",
			"2026-08-16",
		]);
	});

	test("crosses month and year boundaries correctly", () => {
		expect(weekDates("2026-07-27")[6]).toBe("2026-08-02");
		expect(weekDates("2025-12-29")[6]).toBe("2026-01-04");
		expect(weekDates("2024-02-26")[2]).toBe("2024-02-28");
		expect(weekDates("2024-02-26")[3]).toBe("2024-02-29");
	});

	test("rejects a week start that is not a Monday", () => {
		expect(() => weekDates("2026-08-11")).toThrow();
		expect(() => weekDates("2026-08-16")).toThrow();
	});

	test("each returned date's mondayOfWeek is the input", () => {
		for (const date of weekDates("2026-08-10")) {
			expect(mondayOfWeek(date)).toBe("2026-08-10");
		}
	});
});

describe("addDays (calendar-day navigation)", () => {
	test("steps forward and backward across month/year boundaries", () => {
		expect(addDays("2026-08-10", 1)).toBe("2026-08-11");
		expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
		expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
		expect(addDays("2026-08-10", 7)).toBe("2026-08-17");
		expect(addDays("2026-08-10", -7)).toBe("2026-08-03");
		expect(addDays("2025-12-29", 7)).toBe("2026-01-05");
	});

	test("is leap-day aware", () => {
		expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
		expect(addDays("2024-02-29", 1)).toBe("2024-03-01");
		expect(addDays("2023-02-28", 1)).toBe("2023-03-01");
		expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
	});

	test("round-trips under inversion", () => {
		for (const [date, n] of [
			["2026-08-10", 1],
			["2026-08-10", 365],
			["2024-02-29", 366],
			["2026-01-01", 1000],
			["1999-12-31", -5],
		] as const) {
			expect(addDays(addDays(date, n), -n)).toBe(date);
		}
	});

	test("equals luxon oracle for a sweep of dates", () => {
		for (const date of ["2026-08-10", "2026-03-08", "2026-11-01", "2024-02-29", "2025-12-29"]) {
			for (const n of [-400, -1, 0, 1, 400]) {
				const expected = DateTime.fromISO(date, { zone: "UTC" })
					.plus({ days: n })
					.toFormat("yyyy-MM-dd");
				expect(addDays(date, n)).toBe(expected);
			}
		}
	});

	test("throws on malformed input", () => {
		expect(() => addDays("2026-13-01", 1)).toThrow();
		expect(() => addDays("2026-02-30", -1)).toThrow();
	});

	test("pads years below 1000 to four digits", () => {
		expect(addDays("0001-01-01", -1)).toBe("0000-12-31");
		expect(addDays("0000-01-01", 1)).toBe("0000-01-02");
		expect(isCalendarDate(addDays("0001-01-01", -1))).toBe(true);
	});

	test("throws when civil arithmetic leaves the 0000..9999 year range", () => {
		// Underflow: year -1.
		expect(() => addDays("0000-01-01", -1)).toThrow(RangeError);
		expect(() => mondayOfWeek("0000-01-01")).toThrow(RangeError); // Monday is -0001-12-27
		// Overflow: year 10000.
		expect(() => addDays("9999-12-31", 1)).toThrow(RangeError);
		expect(() => addDays("9999-12-25", 7)).toThrow(RangeError);
		expect(() => weekDates("9999-12-27")).toThrow(RangeError); // week runs into 10000-01-02
	});

	test("rejects NaN, ±Infinity and fractional day counts", () => {
		for (const days of [NaN, Infinity, -Infinity, 1.5, -0.5]) {
			expect(() => addDays("2026-08-10", days)).toThrow(RangeError);
		}
	});

	test("rejects huge-but-safe day counts that overflow the year range", () => {
		// Number.MAX_SAFE_INTEGER passes the safe-integer guard but the summed
		// day number lands far outside 0000..9999 — the format guard must throw.
		expect(() => addDays("2026-08-10", Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
	});
});

describe("formatDay", () => {
	test("formats a civil date as 'Weekday · Month d, yyyy'", () => {
		expect(formatDay("2026-08-10")).toBe("Monday · August 10, 2026");
		expect(formatDay("2026-08-16")).toBe("Sunday · August 16, 2026");
		expect(formatDay("2026-01-01")).toBe("Thursday · January 1, 2026");
	});

	test("an optional timezone argument never changes the civil result", () => {
		expect(formatDay("2026-08-10", "Europe/Istanbul")).toBe("Monday · August 10, 2026");
		expect(formatDay("2026-08-10", "America/New_York")).toBe("Monday · August 10, 2026");
	});

	test("invalid input is returned unchanged (legacy wrapper behavior)", () => {
		expect(formatDay("not-a-date")).toBe("not-a-date");
		expect(formatDay("2026-02-30")).toBe("2026-02-30");
	});

	test("pads years below 1000 to four digits (legacy yyyy)", () => {
		expect(formatDay("0001-01-01")).toBe("Monday · January 1, 0001");
	});
});

describe("formatWeekRange", () => {
	test("formats 'Month d — Month d, yyyy' from a Monday", () => {
		expect(formatWeekRange("2026-08-10")).toBe("August 10 — August 16, 2026");
		expect(formatWeekRange("2026-07-27")).toBe("July 27 — August 2, 2026");
		expect(formatWeekRange("2025-12-29")).toBe("December 29 — January 4, 2026");
	});

	test("throws when the input is not a Monday", () => {
		expect(() => formatWeekRange("2026-08-11")).toThrow();
	});

	test("pads years below 1000 to four digits", () => {
		expect(formatWeekRange("0001-01-01")).toBe("January 1 — January 7, 0001");
		expect(formatWeekRange("0000-12-25")).toBe("December 25 — December 31, 0000");
	});
});

describe("weekdayNumber", () => {
	test("is Monday=1 … Sunday=7 for a known week", () => {
		expect(weekdayNumber("2026-08-10")).toBe(1); // Monday
		expect(weekdayNumber("2026-08-11")).toBe(2); // Tuesday
		expect(weekdayNumber("2026-08-14")).toBe(5); // Friday
		expect(weekdayNumber("2026-08-16")).toBe(7); // Sunday
	});

	test("agrees with the luxon civil weekday oracle", () => {
		for (const d of [
			"2026-08-10",
			"2026-01-01",
			"2024-02-29",
			"2026-11-01",
			"2020-02-29",
			"1999-12-31",
		]) {
			expect(weekdayNumber(d)).toBe(DateTime.fromISO(d, { zone: "UTC" }).weekday);
		}
	});

	test("boundary Sundays: 0000-01-02 and 9999-12-26 are weekday 7", () => {
		expect(weekdayNumber("0000-01-02")).toBe(7);
		expect(weekdayNumber("9999-12-26")).toBe(7);
		expect(weekdayNumber("9999-12-27")).toBe(1);
	});

	test("throws on malformed input", () => {
		for (const bad of ["2026-13-01", "2026-02-30", "", "2026-8-10"]) {
			expect(() => weekdayNumber(bad)).toThrow(RangeError);
		}
	});
});
