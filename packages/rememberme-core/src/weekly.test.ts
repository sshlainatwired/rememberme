import { describe, expect, test } from "bun:test";
import { DateTime } from "luxon";
import { addDays, mondayOfWeek, weekDates } from "./calendar";
import type { DigestWeek } from "./weekly";
import { buildDigestWeek, mostRecentSunday } from "./weekly";

/**
 * Oracle for the web's `mostRecentSunday` (server/jobs/weekly-digest.ts):
 * it takes the local civil date, computes `weekday % 7` days back
 * (Luxon weekday Mon=1..Sun=7, so Sunday→0 … Saturday→6) and returns that
 * civil date. Pinned to UTC on a pure civil date never changes its y/m/d
 * fields, so this is exactly the legacy behavior on the civil calendar.
 */
function luxonMostRecentSunday(date: string): string {
	const dt = DateTime.fromISO(date, { zone: "UTC" });
	return dt.minus({ days: dt.weekday % 7 }).toFormat("yyyy-MM-dd");
}

describe("buildDigestWeek", () => {
	const START = "2026-08-10"; // Monday

	test("returns exactly the seven Monday–Sunday dates in order", () => {
		const byDate = new Map([
			["2026-08-10", "mon"],
			["2026-08-16", "sun"],
		]);
		const week = buildDigestWeek(START, byDate);
		expect(week.map((d) => d.date)).toEqual([...weekDates(START)]);
		expect(week[0].date).toBe("2026-08-10");
		expect(week[1].date).toBe("2026-08-11");
		expect(week[2].date).toBe("2026-08-12");
		expect(week[3].date).toBe("2026-08-13");
		expect(week[4].date).toBe("2026-08-14");
		expect(week[5].date).toBe("2026-08-15");
		expect(week[6].date).toBe("2026-08-16");
	});

	test("returns an exact seven-day readonly tuple (compile-time arity/length)", () => {
		const week = buildDigestWeek(START, new Map());
		const len: 7 = week.length; // only typechecks for an exact 7-tuple
		expect(len).toBe(7);
		const tuple: DigestWeek = week; // assignable to the exported tuple type
		expect(tuple).toBe(week);
		// Readonly at the type level: mutating a member would not compile.
		expect(week).toHaveLength(7);
	});

	test("maps missing dates to null content", () => {
		const week = buildDigestWeek(START, new Map());
		for (const day of week) {
			expect(day.content).toBeNull();
		}
	});

	test("maps present dates to their content, others to null", () => {
		const week = buildDigestWeek(
			START,
			new Map([
				["2026-08-11", "tuesday"],
				["2026-08-14", "friday"],
			]),
		);
		expect(week[0].content).toBeNull();
		expect(week[1].content).toBe("tuesday");
		expect(week[2].content).toBeNull();
		expect(week[3].content).toBeNull();
		expect(week[4].content).toBe("friday");
		expect(week[5].content).toBeNull();
		expect(week[6].content).toBeNull();
	});

	test("preserves empty-string content as empty, not null", () => {
		const week = buildDigestWeek(START, new Map([["2026-08-13", ""]]));
		expect(week[3].content).toBe("");
		expect(week[3].content).not.toBeNull();
	});

	test("preserves whitespace exactly", () => {
		const week = buildDigestWeek(
			START,
			new Map([
				["2026-08-10", "  "],
				["2026-08-12", "\t tabbed \n"],
				["2026-08-15", " \n "],
			]),
		);
		expect(week[0].content).toBe("  ");
		expect(week[2].content).toBe("\t tabbed \n");
		expect(week[5].content).toBe(" \n ");
	});

	test("preserves newlines exactly", () => {
		const content = "line one\nline two\r\nline three\n\nlast";
		const week = buildDigestWeek(START, new Map([["2026-08-11", content]]));
		expect(week[1].content).toBe(content);
		expect(week[1].content).toContain("\r\n");
	});

	test("preserves Unicode (accents, combining marks, CJK, emoji) exactly", () => {
		for (const content of ["héllo wörld", "e\u0301té", "世界", "🎉 🚀", "कर्म"]) {
			const week = buildDigestWeek(START, new Map([["2026-08-10", content]]));
			expect(week[0].content).toBe(content);
		}
	});

	test("ignores entries outside the Monday–Sunday window", () => {
		const week = buildDigestWeek(
			START,
			new Map([
				["2026-08-09", "previous sunday"],
				["2026-08-17", "next monday"],
				["2026-08-10", "inside"],
			]),
		);
		expect(week[0].content).toBe("inside");
		expect(week[6].content).toBeNull();
		for (const [i, day] of week.entries()) {
			if (i !== 0) expect(day.content).toBeNull();
		}
	});

	test("crosses month and year boundaries using weekDates", () => {
		expect(buildDigestWeek("2026-07-27", new Map()).map((d) => d.date)).toEqual([
			...weekDates("2026-07-27"),
		]);
		expect(buildDigestWeek("2025-12-29", new Map()).map((d) => d.date)).toEqual([
			...weekDates("2025-12-29"),
		]);
		expect(buildDigestWeek("2024-02-26", new Map()).map((d) => d.date)).toEqual([
			...weekDates("2024-02-26"),
		]);
	});

	test("maps content across a leap-week boundary", () => {
		const week = buildDigestWeek("2024-02-26", new Map([["2024-02-29", "leap day"]]));
		expect(week[3].date).toBe("2024-02-29");
		expect(week[3].content).toBe("leap day");
		expect(week[2].content).toBeNull();
	});

	test("is deterministic and accepts ReadonlyMap inputs", () => {
		const mutable = new Map([
			["2026-08-12", "wed"],
			["2026-08-16", "sun"],
		]);
		// A frozen Map is assignable to ReadonlyMap<string, string>.
		const readonlyInput: ReadonlyMap<string, string> = Object.freeze(mutable);
		const a = buildDigestWeek(START, readonlyInput);
		const b = buildDigestWeek(START, readonlyInput);
		expect(a).toEqual(b);
		expect(b[2].content).toBe("wed");
		expect(b[6].content).toBe("sun");
	});

	test("rejects a week start that is not a Monday", () => {
		expect(() => buildDigestWeek("2026-08-11", new Map())).toThrow(RangeError);
		expect(() => buildDigestWeek("2026-08-16", new Map())).toThrow(RangeError);
	});

	test("rejects malformed week starts", () => {
		for (const bad of ["2026-13-01", "2026-02-30", "", "2026-8-10", "not-a-date"]) {
			expect(() => buildDigestWeek(bad, new Map())).toThrow(RangeError);
		}
	});
});

describe("mostRecentSunday", () => {
	test("is Sunday-inclusive", () => {
		expect(mostRecentSunday("2026-08-09")).toBe("2026-08-09"); // Sunday
		expect(mostRecentSunday("2024-02-25")).toBe("2024-02-25"); // Sunday, leap year
		expect(mostRecentSunday("2026-11-01")).toBe("2026-11-01"); // Sunday on the 1st
	});

	test("Monday maps to the previous Sunday", () => {
		expect(mostRecentSunday("2026-08-10")).toBe("2026-08-09");
		expect(mostRecentSunday("2026-08-03")).toBe("2026-08-02");
		expect(mostRecentSunday("2025-12-29")).toBe("2025-12-28");
		expect(mostRecentSunday("2024-02-26")).toBe("2024-02-25");
	});

	test("mid-week and Saturday map to the previous Sunday", () => {
		expect(mostRecentSunday("2026-08-06")).toBe("2026-08-02"); // Thursday
		expect(mostRecentSunday("2026-08-08")).toBe("2026-08-02"); // Saturday
		expect(mostRecentSunday("2024-02-29")).toBe("2024-02-25"); // Thursday, leap day
		expect(mostRecentSunday("2024-03-02")).toBe("2024-02-25"); // Saturday after leap day
	});

	test("month boundaries", () => {
		expect(mostRecentSunday("2026-08-03")).toBe("2026-08-02"); // previous Sunday in prior month
		expect(mostRecentSunday("2026-07-31")).toBe("2026-07-26"); // Friday
		expect(mostRecentSunday("2026-08-02")).toBe("2026-08-02"); // Sunday on the 2nd
	});

	test("year boundaries", () => {
		expect(mostRecentSunday("2026-01-01")).toBe("2025-12-28"); // Thursday, New Year's Day
		expect(mostRecentSunday("2026-01-04")).toBe("2026-01-04"); // Sunday in the new year
		expect(mostRecentSunday("2025-12-28")).toBe("2025-12-28"); // Sunday in the old year
	});

	test("agrees with the web mostRecentSunday oracle across boundaries", () => {
		for (const d of [
			"2026-08-09",
			"2026-08-10",
			"2026-08-06",
			"2026-08-03",
			"2026-08-02",
			"2026-07-31",
			"2026-01-01",
			"2026-01-04",
			"2025-12-29",
			"2025-12-28",
			"2024-02-29",
			"2024-02-26",
			"2024-02-25",
			"2024-03-02",
			"1999-12-31",
			"2020-02-29",
		]) {
			expect(mostRecentSunday(d)).toBe(luxonMostRecentSunday(d));
		}
	});

	test("returned Sunday always contains the input date within the same week window", () => {
		for (const d of [
			"2026-08-10",
			"2026-08-16",
			"2026-01-01",
			"2025-12-29",
			"2024-02-29",
			"2026-11-01",
			"2026-07-27",
			"2026-08-09",
		]) {
			const sunday = mostRecentSunday(d);
			// The result is a Sunday: it is the last day of its Monday–Sunday week.
			expect(weekDates(mondayOfWeek(sunday))[6]).toBe(sunday);
			// And it is the most recent one: within [d, d-6], never the week after.
			expect(d >= sunday).toBe(true);
			expect(d < addDays(sunday, 7)).toBe(true);
		}
	});

	test("throws on malformed input", () => {
		for (const bad of ["2026-13-01", "2026-02-30", "", "2026-8-10", "not-a-date"]) {
			expect(() => mostRecentSunday(bad)).toThrow(RangeError);
		}
	});
});

describe("mostRecentSunday representable-range boundaries", () => {
	test("0000-01-02 (the first representable Sunday) maps to itself", () => {
		expect(mostRecentSunday("0000-01-02")).toBe("0000-01-02");
	});

	test("the earliest representable week's Monday..Saturday map to 0000-01-02", () => {
		// 0000-01-02 is a Sunday; 0000-01-03 (Monday) … 0000-01-08 (Saturday)
		// all have 0000-01-02 as their most recent in-range Sunday.
		expect(mostRecentSunday("0000-01-03")).toBe("0000-01-02");
		expect(mostRecentSunday("0000-01-08")).toBe("0000-01-02");
	});

	test("9999-12-26 (the last representable Sunday) maps to itself", () => {
		expect(mostRecentSunday("9999-12-26")).toBe("9999-12-26");
	});

	test("every 9999-12-27..9999-12-31 maps to the last representable Sunday", () => {
		for (const d of ["9999-12-27", "9999-12-28", "9999-12-29", "9999-12-30", "9999-12-31"]) {
			expect(mostRecentSunday(d)).toBe("9999-12-26");
		}
	});

	test("0000-01-01 still throws: its prior Sunday is outside 0000..9999", () => {
		expect(() => mostRecentSunday("0000-01-01")).toThrow(RangeError);
	});
});
