import { describe, expect, test } from "bun:test";
import { DateTime } from "luxon";
import { isTimezoneSupported, timezoneSchema, todayInTimezone } from "./timezone";

const ISTANBUL = "Europe/Istanbul"; // UTC+3 (no DST)
const NEW_YORK = "America/New_York"; // UTC-4/-5 with DST

describe("timezone validation primitive", () => {
	test("accepts real IANA zones incl. UTC", () => {
		for (const tz of ["UTC", ISTANBUL, NEW_YORK, "Asia/Tokyo", "Australia/Lord_Howe"]) {
			expect(isTimezoneSupported(tz)).toBe(true);
			expect(timezoneSchema.safeParse(tz).success).toBe(true);
		}
	});

	test("rejects junk, empty, and non-canonical casing", () => {
		for (const tz of ["", "Mars/Olympus_Mons", "europe/istanbul", "America/New York", "utc"]) {
			expect(isTimezoneSupported(tz)).toBe(false);
			expect(timezoneSchema.safeParse(tz).success).toBe(false);
		}
	});

	test("is deterministic", () => {
		expect(isTimezoneSupported(ISTANBUL)).toBe(true);
		expect(isTimezoneSupported("UTC")).toBe(true);
		expect(isTimezoneSupported(NEW_YORK)).toBe(true);
		expect(isTimezoneSupported("UTC")).toBe(isTimezoneSupported("UTC"));
	});
});

describe("fallback when Intl.supportedValuesOf is absent (old WebView)", () => {
	test("module loads and validates via Intl.DateTimeFormat probe", async () => {
		const original = Intl.supportedValuesOf;
		try {
			// Simulate a runtime (old WebView) without the API. The query string
			// forces a FRESH module record, so the module-load guard re-runs
			// with the API absent — the static `./timezone` import above is
			// already instantiated with the real API and must stay untouched.
			(Intl as { supportedValuesOf?: unknown }).supportedValuesOf = undefined;
			// Variable specifier: a fresh module record (query string differs from
			// the cached `./timezone` instance), resolved dynamically at runtime.
			const specifier = "./timezone?no-supportedValuesOf";
			const mod = await import(specifier);

			expect([...mod.supportedTimeZones]).toEqual(["UTC"]);

			for (const tz of ["UTC", ISTANBUL, NEW_YORK]) {
				expect(mod.isTimezoneSupported(tz)).toBe(true);
				expect(mod.timezoneSchema.safeParse(tz).success).toBe(true);
			}

			for (const tz of ["", "Mars/Olympus_Mons", "europe/istanbul", "utc", "America/New York"]) {
				expect(mod.isTimezoneSupported(tz)).toBe(false);
				expect(mod.timezoneSchema.safeParse(tz).success).toBe(false);
			}

			// The fallback path validates through Intl.DateTimeFormat too.
			expect(mod.isTimezoneSupported(ISTANBUL)).toBe(true);
		} finally {
			(Intl as { supportedValuesOf?: unknown }).supportedValuesOf = original;
		}
	});
});

describe("todayInTimezone — deterministic instant → local calendar date", () => {
	test("accepts a fixed instant and never touches the wall clock", () => {
		// 2026-08-09T21:30Z = 2026-08-10T00:30 in Istanbul (+03).
		expect(todayInTimezone(ISTANBUL, "2026-08-09T21:30:00Z")).toBe("2026-08-10");
		// Same instant, expressed with the zone's own offset:
		expect(todayInTimezone(ISTANBUL, "2026-08-10T00:30:00+03:00")).toBe("2026-08-10");
		// A naive UTC reading of the instant would say 2026-08-09 — the UTC-mixing bug.
	});

	test("negative-offset zones near local midnight stay on the local day", () => {
		// 2026-08-10T03:30Z = 2026-08-09T23:30 in New York (summer, UTC-4).
		expect(todayInTimezone(NEW_YORK, "2026-08-10T03:30:00Z")).toBe("2026-08-09");
	});

	test("UTC as a zone equals civil UTC date", () => {
		expect(todayInTimezone("UTC", "2026-08-10T23:59:59Z")).toBe("2026-08-10");
		expect(todayInTimezone("UTC", "2026-08-10T00:00:00Z")).toBe("2026-08-10");
	});

	test("accepts Date and epoch-millis instants identically", () => {
		const iso = "2026-08-09T21:30:00Z";
		const ms = DateTime.fromISO(iso).toMillis();
		const asDate = new Date(ms);
		const want = "2026-08-10";
		expect(todayInTimezone(ISTANBUL, ms)).toBe(want);
		expect(todayInTimezone(ISTANBUL, asDate)).toBe(want);
		expect(todayInTimezone(ISTANBUL, iso)).toBe(want);
	});

	test("DST start: the calendar day is stable across the spring-forward gap", () => {
		// 2026-03-08 in New York: 06:59Z = 01:59 EST, 07:01Z = 03:01 EDT.
		expect(todayInTimezone(NEW_YORK, "2026-03-08T06:59:00Z")).toBe("2026-03-08");
		expect(todayInTimezone(NEW_YORK, "2026-03-08T07:01:00Z")).toBe("2026-03-08");
	});

	test("DST end: the calendar day is stable across the fall-back fold", () => {
		// 2026-11-01 in New York: 05:30Z = 01:30 EDT, 06:30Z = 01:30 EST (after fold).
		expect(todayInTimezone(NEW_YORK, "2026-11-01T05:30:00Z")).toBe("2026-11-01");
		expect(todayInTimezone(NEW_YORK, "2026-11-01T06:30:00Z")).toBe("2026-11-01");
	});

	test("near-midnight DST-eve instant detects UTC mixing (local still previous day)", () => {
		// 2026-03-08T04:59Z = 2026-03-07T23:59 EST. UTC day is 2026-03-08;
		// the local calendar day is 2026-03-07.
		expect(todayInTimezone(NEW_YORK, "2026-03-08T04:59:00Z")).toBe("2026-03-07");
	});

	test("same instant yields the same result every call", () => {
		const now = "2026-08-09T21:30:00Z";
		expect(todayInTimezone(ISTANBUL, now)).toBe(todayInTimezone(ISTANBUL, now));
	});

	test("throws for an unsupported zone instead of returning garbage", () => {
		expect(() => todayInTimezone("Mars/Olympus_Mons", "2026-08-10T00:00:00Z")).toThrow();
		expect(() => todayInTimezone("", "2026-08-10T00:00:00Z")).toThrow();
	});

	test("throws for an unparseable instant", () => {
		expect(() => todayInTimezone(ISTANBUL, "not-an-instant")).toThrow();
	});

	test("rejects date-only and offsetless datetime strings (no explicit instant)", () => {
		for (const bad of ["2026-08-10", "2026-08-10T10:00:00", "2026-08-10 10:00:00"]) {
			expect(() => todayInTimezone(ISTANBUL, bad)).toThrow(RangeError);
		}
	});

	test("rejects offsets outside ±14:00 and rolled-over offset minutes", () => {
		for (const bad of [
			"2026-08-10T10:00:00+25:00", // hours beyond the tzdb range
			"2026-08-10T10:00:00-15:00",
			"2026-08-10T10:00:00+03:60", // luxon rolls this into +04:00; must still be rejected
			"2026-08-10T10:00:00-03:75",
		]) {
			expect(() => todayInTimezone(ISTANBUL, bad)).toThrow(RangeError);
		}
	});

	test("accepts Z and numeric offsets incl. the ±14:00 extremes", () => {
		expect(todayInTimezone("UTC", "2026-08-10T10:00:00Z")).toBe("2026-08-10");
		expect(todayInTimezone(ISTANBUL, "2026-08-10T10:00:00+03:00")).toBe("2026-08-10");
		// 2026-08-09T23:59-12:00 = 2026-08-10T11:59Z — still the 10th in UTC.
		expect(todayInTimezone("UTC", "2026-08-09T23:59:00-12:00")).toBe("2026-08-10");
		// 2026-08-10T10:00+14:00 = 2026-08-09T20:00Z — the UTC day is the 9th.
		expect(todayInTimezone("UTC", "2026-08-10T10:00:00+14:00")).toBe("2026-08-09");
	});
});

describe("formatDay timezone interplay", () => {
	test("formatDay keeps the optional timezone parameter (web wrapper contract)", async () => {
		const { formatDay } = await import("./calendar");
		expect(formatDay("2026-08-10", ISTANBUL)).toBe(formatDay("2026-08-10", NEW_YORK));
	});
});
