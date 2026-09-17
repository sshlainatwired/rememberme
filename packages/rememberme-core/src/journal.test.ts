import { describe, expect, test } from "bun:test";
import {
	journalContentSchema,
	journalDateSchema,
	journalRangeSchema,
	journalUpsertSchema,
} from "./journal";

describe("journal date schema", () => {
	test("accepts real YYYY-MM-DD calendar dates", () => {
		for (const d of ["2026-08-03", "2024-02-29", "1970-01-01", "2026-12-31", "2000-02-29"]) {
			expect(journalDateSchema.safeParse(d).success).toBe(true);
		}
	});

	test("rejects malformed or impossible dates", () => {
		for (const d of [
			"2026-13-01",
			"2026-00-10",
			"2026-1-1",
			"2026/08/03",
			"not-a-date",
			"",
			"2026-08-32",
			"2026-02-30",
			"2023-02-29",
			"2026-08-03T00:00:00Z",
		]) {
			expect(journalDateSchema.safeParse(d).success).toBe(false);
		}
	});
});

describe("journal content schema — 100k-character semantics", () => {
	test("max length is measured in characters (Unicode code points), never trimmed", () => {
		// Exactly 100_000 ASCII chars is allowed, 100_001 is not.
		expect(journalContentSchema.safeParse("a".repeat(100_000)).success).toBe(true);
		expect(journalContentSchema.safeParse("a".repeat(100_001)).success).toBe(false);
	});

	test("emoji count as single characters, not UTF-16 code units", () => {
		// 100_000 emoji = 100_000 code points but 200_000 UTF-16 units.
		expect(journalContentSchema.safeParse("😀".repeat(100_000)).success).toBe(true);
		expect(journalContentSchema.safeParse("😀".repeat(100_001)).success).toBe(false);
	});

	test("combining sequences count per code point", () => {
		// "e" + U+0301 combining acute = 2 code points, 1 grapheme.
		const seq = "e\u0301";
		expect(journalContentSchema.safeParse(seq.repeat(50_000)).success).toBe(true);
		expect(journalContentSchema.safeParse(seq.repeat(50_001)).success).toBe(false);
	});

	test("empty string is allowed (means 'no entry' upstream)", () => {
		expect(journalContentSchema.safeParse("").success).toBe(true);
	});

	test("whitespace-only content is allowed and preserved verbatim (no trimming)", () => {
		for (const ws of [" ", "   ", "\n", "\t\n  \r"]) {
			expect(journalContentSchema.safeParse(ws).success).toBe(true);
			expect(journalContentSchema.parse(ws)).toBe(ws);
		}
	});

	test("Unicode/newlines survive parsing exactly", () => {
		const sample = "  İstanbul günü ☀️\n\t— 'alıntı' & <işaretler>  \n";
		expect(journalContentSchema.safeParse(sample).success).toBe(true);
		expect(journalContentSchema.parse(sample)).toBe(sample);
	});

	test("rejects non-strings", () => {
		for (const v of [42, null, undefined, true, ["x"]]) {
			expect(journalContentSchema.safeParse(v).success).toBe(false);
		}
	});
});

describe("journal upsert schema", () => {
	test("requires only content (date is the route param); extra keys are stripped", () => {
		expect(journalUpsertSchema.safeParse({ content: "x" }).success).toBe(true);
		expect(journalUpsertSchema.safeParse({ date: "2026-08-03", content: "x" }).success).toBe(true);
		expect(journalUpsertSchema.safeParse({}).success).toBe(false);
		expect(journalUpsertSchema.safeParse({ content: 42 }).success).toBe(false);
	});
});

describe("journal range schema", () => {
	test("accepts valid ISO ranges and open ranges", () => {
		expect(journalRangeSchema.safeParse({ from: "2026-08-03", to: "2026-08-09" }).success).toBe(
			true,
		);
		expect(journalRangeSchema.safeParse({}).success).toBe(true);
		expect(journalRangeSchema.safeParse({ from: "2026-08-03" }).success).toBe(true);
		expect(journalRangeSchema.safeParse({ to: "2026-08-09" }).success).toBe(true);
	});

	test("from must not be after to", () => {
		expect(journalRangeSchema.safeParse({ from: "2026-08-09", to: "2026-08-03" }).success).toBe(
			false,
		);
		expect(journalRangeSchema.safeParse({ from: "bad", to: "2026-08-09" }).success).toBe(false);
	});

	test("equal from/to is a valid single-day range", () => {
		expect(journalRangeSchema.safeParse({ from: "2026-08-03", to: "2026-08-03" }).success).toBe(
			true,
		);
	});
});
