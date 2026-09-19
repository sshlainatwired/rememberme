import { describe, expect, it } from "vitest";
import { daysInMonth, isLeapYear, monthDates, monthLabel, shiftMonth } from "@/lib/month-grid";

describe("isLeapYear", () => {
	it("recognizes the leap-year matrix (2024 yes, 2025 no, 1900 no, 2000 yes)", () => {
		expect(isLeapYear(2024)).toBe(true);
		expect(isLeapYear(2025)).toBe(false);
		// century year NOT divisible by 400 is common
		expect(isLeapYear(1900)).toBe(false);
		// century year divisible by 400 IS a leap year
		expect(isLeapYear(2000)).toBe(true);
	});
});

describe("daysInMonth", () => {
	it("returns 31 for the long months, 30 for the short ones, across a common year", () => {
		const long = [1, 3, 5, 7, 8, 10, 12];
		const short = [4, 6, 9, 11];
		for (const m of long) expect(daysInMonth(2026, m)).toBe(31);
		for (const m of short) expect(daysInMonth(2026, m)).toBe(30);
	});

	it("returns 29 for February in a leap year and 28 in a common year", () => {
		expect(daysInMonth(2024, 2)).toBe(29);
		expect(daysInMonth(2026, 2)).toBe(28);
		// century non-leap
		expect(daysInMonth(1900, 2)).toBe(28);
		// century leap
		expect(daysInMonth(2000, 2)).toBe(29);
	});

	it("throws a RangeError for invalid months (0, 13, non-integer)", () => {
		for (const month of [0, 13, -1, 2.5, Number.NaN]) {
			expect(() => daysInMonth(2026, month as number)).toThrow(RangeError);
		}
	});
});

describe("monthDates", () => {
	it("returns every day of February 2026 with exact first/last values", () => {
		const dates = monthDates(2026, 2);
		expect(dates).toHaveLength(28);
		expect(dates[0]).toBe("2026-02-01");
		expect(dates[dates.length - 1]).toBe("2026-02-28");
	});

	it("returns 29 days for the leap February 0000 and 31 for December 9999", () => {
		expect(monthDates(0, 2)).toHaveLength(29);
		expect(monthDates(0, 2)[0]).toBe("0000-02-01");
		expect(monthDates(0, 2)[28]).toBe("0000-02-29");
		expect(monthDates(9999, 12)).toHaveLength(31);
		expect(monthDates(9999, 12)[0]).toBe("9999-12-01");
		expect(monthDates(9999, 12)[30]).toBe("9999-12-31");
	});

	it("pads every date component to four/two digits", () => {
		expect(monthDates(26, 3)[0]).toBe("0026-03-01");
	});
});

describe("monthLabel", () => {
	it('labels August 2026 as "August 2026"', () => {
		expect(monthLabel(2026, 8)).toBe("August 2026");
	});

	it("pads low years to four digits in the label", () => {
		expect(monthLabel(26, 1)).toBe("January 0026");
		expect(monthLabel(0, 12)).toBe("December 0000");
	});
});

describe("shiftMonth", () => {
	it("advances forward across a year boundary (2025-12 -> 2026-01)", () => {
		expect(shiftMonth(2025, 12, 1)).toEqual({ year: 2026, month: 1 });
	});

	it("moves backward across a year boundary (2026-01 -> 2025-12)", () => {
		expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
	});

	it("stays within a single year (2026-08 +1 -> 2026-09, -1 -> 2026-07)", () => {
		expect(shiftMonth(2026, 8, 1)).toEqual({ year: 2026, month: 9 });
		expect(shiftMonth(2026, 8, -1)).toEqual({ year: 2026, month: 7 });
	});

	it("returns null at the representable boundaries (0000-01 backward, 9999-12 forward)", () => {
		expect(shiftMonth(0, 1, -1)).toBeNull();
		expect(shiftMonth(9999, 12, 1)).toBeNull();
	});
});

describe("leader blank math (composed in the component, sourced here)", () => {
	it("August 2026 starts on a Saturday, so its leading blanks are 5 (Mon-Fri before Aug 1)", () => {
		// weekdayNumber is Mon=1..Sun=7; leading blanks = weekdayNumber(first) - 1.
		const first = monthDates(2026, 8)[0];
		const blanks = weekdayNumberOf(first) - 1;
		expect(blanks).toBe(5);
	});
});

/** Local import mirror of the shared core helper so the math is explicit. */
import { weekdayNumber as weekdayNumberOf } from "@rememberme/core";
