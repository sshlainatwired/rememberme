import { describe, expect, test } from "bun:test";
import * as core from "./index";

describe("@rememberme/core public surface", () => {
	test("re-exports journal schemas", () => {
		expect(typeof core.journalDateSchema).toBe("object");
		expect(typeof core.journalContentSchema).toBe("object");
		expect(typeof core.journalUpsertSchema).toBe("object");
		expect(typeof core.journalRangeSchema).toBe("object");
		expect(typeof core.JOURNAL_CONTENT_MAX).toBe("number");
	});

	test("re-exports timezone and transfer timestamp primitives", () => {
		expect(typeof core.timezoneSchema).toBe("object");
		expect(typeof core.isTimezoneSupported).toBe("function");
		expect(typeof core.todayInTimezone).toBe("function");
		expect(typeof core.parseTransferInstant).toBe("function");
		expect(typeof core.formatTransferInstant).toBe("function");
	});

	test("re-exports calendar/week helpers", () => {
		expect(typeof core.isCalendarDate).toBe("function");
		expect(typeof core.mondayOfWeek).toBe("function");
		expect(typeof core.weekDates).toBe("function");
		expect(typeof core.addDays).toBe("function");
		expect(typeof core.formatDay).toBe("function");
		expect(typeof core.formatWeekRange).toBe("function");
	});

	test("re-exports the weekly digest content model", () => {
		expect(typeof core.buildDigestWeek).toBe("function");
		expect(typeof core.mostRecentSunday).toBe("function");
	});

	test("weekly digest model behaves through the public surface", () => {
		const week = core.buildDigestWeek("2026-08-10", new Map([["2026-08-11", "tuesday"]]));
		expect(week).toHaveLength(7);
		expect(week[0].date).toBe("2026-08-10");
		expect(week[0].content).toBeNull();
		expect(week[1].content).toBe("tuesday");
		expect(week[6].date).toBe("2026-08-16");
		expect(core.mostRecentSunday("2026-08-10")).toBe("2026-08-09");
		expect(core.mostRecentSunday("2026-08-16")).toBe("2026-08-16");
	});
});
