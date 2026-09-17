import { describe, expect, it, vi } from "vitest";
import { type JournalEntry, JournalService } from "./journal";
import { applyMigrations } from "./migrations";
import { createTestDb } from "./test-helper";
import type { SQLValue } from "./types";

const T0 = "2026-08-01T00:00:00.000Z";
const T1 = "2026-08-01T12:00:00.000Z";

/** Deterministic clock sequence: each service call returns the next instant. */
function clock(instants: string[]) {
	let i = 0;
	return () => instants[Math.min(i++, instants.length - 1)];
}

async function setup() {
	const db = createTestDb();
	await applyMigrations(db);
	return db;
}

describe("journal: fresh install round-trip", () => {
	it("writes and reads an entry offline through real SQLite", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		await svc.upsert("2026-08-10", "hello world");
		const entry = await svc.get("2026-08-10");
		expect(entry).toEqual<JournalEntry>({
			date: "2026-08-10",
			content: "hello world",
			createdAt: T0,
			updatedAt: T0,
		});
	});
});

describe("journal: overwrite uniqueness and timestamps", () => {
	it("keeps one row per date; preserves created_at and changes updated_at", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0, T1]));
		await svc.upsert("2026-08-10", "first");
		await svc.upsert("2026-08-10", "second");

		const rows = await db.query<{ date: string }>(
			"SELECT date FROM journal_entries WHERE date = ?",
			["2026-08-10"],
		);
		expect(rows).toHaveLength(1);

		const entry = await svc.get("2026-08-10");
		expect(entry?.content).toBe("second");
		expect(entry?.createdAt).toBe(T0);
		expect(entry?.updatedAt).toBe(T1);
	});
});

describe("journal: empty content deletes at the service boundary", () => {
	it("upserting an empty string removes an existing entry", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0, T1]));
		await svc.upsert("2026-08-10", "to be removed");
		await svc.upsert("2026-08-10", "");
		expect(await svc.get("2026-08-10")).toBeNull();

		const rows = await db.query<{ date: string }>(
			"SELECT date FROM journal_entries WHERE date = ?",
			["2026-08-10"],
		);
		expect(rows).toHaveLength(0);
	});

	it("upserting an empty string on a missing date is a no-op delete", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		await svc.upsert("2026-08-11", "");
		expect(await svc.get("2026-08-11")).toBeNull();
	});
});

describe("journal: exact whitespace and Unicode preservation", () => {
	it("preserves leading/trailing whitespace and newlines byte-for-byte", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		const tricky = "  \n\t  padded  \n  ";
		await svc.upsert("2026-08-10", tricky);
		expect((await svc.get("2026-08-10"))?.content).toBe(tricky);
	});

	it("preserves emoji and non-Latin Unicode exactly", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		const unicode = "😀👍 日本語 🎌 café — naïve „quotes“ \u0000\u00a0";
		await svc.upsert("2026-08-10", unicode);
		expect((await svc.get("2026-08-10"))?.content).toBe(unicode);
	});
});

describe("journal: sorted inclusive date ranges", () => {
	it("lists a single date when no bounds are given (sorted ascending)", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		await svc.upsert("2026-08-12", "c");
		await svc.upsert("2026-08-10", "a");
		await svc.upsert("2026-08-11", "b");
		// Insert intentionally out of order; list must sort ascending.
		const entries = await svc.list();
		expect(entries.map((e) => e.date)).toEqual(["2026-08-10", "2026-08-11", "2026-08-12"]);
		expect(entries.map((e) => e.content)).toEqual(["a", "b", "c"]);
	});

	it("applies inclusive from/to bounds", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		await svc.upsert("2026-08-10", "a");
		await svc.upsert("2026-08-11", "b");
		await svc.upsert("2026-08-12", "c");
		await svc.upsert("2026-08-13", "d");

		const middle = await svc.list("2026-08-11", "2026-08-12");
		expect(middle.map((e) => e.date)).toEqual(["2026-08-11", "2026-08-12"]);

		const single = await svc.list("2026-08-12", "2026-08-12");
		expect(single.map((e) => e.date)).toEqual(["2026-08-12"]);

		const openLow = await svc.list(undefined, "2026-08-11");
		expect(openLow.map((e) => e.date)).toEqual(["2026-08-10", "2026-08-11"]);

		const openHigh = await svc.list("2026-08-12");
		expect(openHigh.map((e) => e.date)).toEqual(["2026-08-12", "2026-08-13"]);
	});

	it("returns unique dates only (one row per date)", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0, T1]));
		await svc.upsert("2026-08-10", "a");
		await svc.upsert("2026-08-10", "a2");
		const entries = await svc.list();
		expect(entries).toHaveLength(1);
		expect(entries[0].content).toBe("a2");
	});

	it("returns an empty list when no entries exist", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		expect(await svc.list()).toEqual([]);
	});
});

describe("journal: listDates returns sorted calendar dates only", () => {
	it("returns every date sorted ascending when no bounds are given (no content)", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		await svc.upsert("2026-08-12", "c");
		await svc.upsert("2026-08-10", "a");
		await svc.upsert("2026-08-11", "b");
		// Insert intentionally out of order; the list must sort ascending.
		const dates = await svc.listDates();
		expect(dates).toEqual(["2026-08-10", "2026-08-11", "2026-08-12"]);
		// CalendarDate[] only — every element is a plain YYYY-MM-DD string.
		expect(dates.every((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
	});

	it("applies inclusive from/to bounds (from-only, to-only, bounded, single)", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		await svc.upsert("2026-08-10", "a");
		await svc.upsert("2026-08-11", "b");
		await svc.upsert("2026-08-12", "c");
		await svc.upsert("2026-08-13", "d");

		expect(await svc.listDates("2026-08-11", "2026-08-12")).toEqual(["2026-08-11", "2026-08-12"]);
		expect(await svc.listDates("2026-08-12", "2026-08-12")).toEqual(["2026-08-12"]);
		expect(await svc.listDates(undefined, "2026-08-11")).toEqual(["2026-08-10", "2026-08-11"]);
		expect(await svc.listDates("2026-08-12")).toEqual(["2026-08-12", "2026-08-13"]);
	});

	it("returns dates only — never entry content or objects", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		await svc.upsert("2026-08-10", "secret content");
		const dates = await svc.listDates();
		expect(dates).toEqual(["2026-08-10"]);
		expect(dates[0]).not.toBeInstanceOf(Object);
	});

	it("returns an empty list when no entries exist", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		expect(await svc.listDates()).toEqual([]);
	});

	it("rejects a reversed range before executing any SQL", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		const querySpy = vi.spyOn(db, "query");
		await expect(svc.listDates("2026-08-20", "2026-08-10")).rejects.toThrow();
		expect(querySpy).not.toHaveBeenCalled();
	});

	it("rejects invalid date bounds before executing any SQL", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		const querySpy = vi.spyOn(db, "query");
		await expect(svc.listDates("not-a-date")).rejects.toThrow();
		await expect(svc.listDates(undefined, "2026-13-99")).rejects.toThrow();
		expect(querySpy).not.toHaveBeenCalled();
	});
});

describe("journal: invalid inputs fail before SQL", () => {
	it("rejects a non-date key", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		await expect(svc.get("not-a-date")).rejects.toThrow();
		await expect(svc.upsert("2026-13-99", "x")).rejects.toThrow();
	});

	it("rejects a reversed range before touching the database", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		await expect(svc.list("2026-08-20", "2026-08-10")).rejects.toThrow();
	});

	it("rejects content beyond the shared maximum", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		const tooLong = "a".repeat(100_001);
		await expect(svc.upsert("2026-08-10", tooLong)).rejects.toThrow();
		const ok = "a".repeat(100_000);
		await svc.upsert("2026-08-10", ok);
		expect((await svc.get("2026-08-10"))?.content).toBe(ok);
	});

	it("rejects non-string content values", async () => {
		const db = await setup();
		const svc = new JournalService(db, clock([T0]));
		// @ts-expect-error intentionally invalid runtime value
		await expect(svc.upsert("2026-08-10", 42)).rejects.toThrow();
	});
});

describe("journal: stored-row decoder rejects corrupt rows (finding B)", () => {
	/** Insert a raw row directly (bypasses service validation) and return db. */
	async function dbWithRow(
		date: string,
		content: unknown,
		createdAt: unknown = T0,
		updatedAt: unknown = T0,
	) {
		const db = await setup();
		await db.run(
			"INSERT INTO journal_entries (date, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
			[date, content as SQLValue, createdAt as SQLValue, updatedAt as SQLValue],
		);
		return db;
	}

	it("rejects a stored row with an invalid date via list() (all-rows scan)", async () => {
		const db = await dbWithRow("2026-13-99", "x");
		const svc = new JournalService(db, clock([T0]));
		await expect(svc.list()).rejects.toThrow("Corrupt journal entry");
	});

	it("rejects a stored row with oversized content via get() and list()", async () => {
		const db = await dbWithRow("2026-08-10", "a".repeat(100_001));
		const svc = new JournalService(db, clock([T0]));
		await expect(svc.get("2026-08-10")).rejects.toThrow("Corrupt journal entry");
		await expect(svc.list()).rejects.toThrow("Corrupt journal entry");
	});

	it("rejects a stored row with non-string (BLOB) content via get() and list()", async () => {
		const db = await dbWithRow("2026-08-10", new Uint8Array([1, 2, 3]));
		const svc = new JournalService(db, clock([T0]));
		await expect(svc.get("2026-08-10")).rejects.toThrow("Corrupt journal entry");
		await expect(svc.list()).rejects.toThrow("Corrupt journal entry");
	});

	it("rejects a corrupt stored date via listDates()", async () => {
		const db = await dbWithRow("2026-08-10", "x");
		// Corrupt the stored date AFTER insert (TEXT PK accepts any string).
		await db.run("UPDATE journal_entries SET date = '2026-13-99' WHERE date = '2026-08-10'");
		const svc = new JournalService(db, clock([T0]));
		await expect(svc.listDates()).rejects.toThrow("Corrupt journal entry");
	});

	it("wraps corruption in a clear error preserving the cause and echoing NO content", async () => {
		const db = await dbWithRow("2026-08-10", "a".repeat(100_001));
		const svc = new JournalService(db, clock([T0]));
		const big = "a".repeat(100_001);
		const rejection = await svc.get("2026-08-10").catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(Error);
		const err = rejection as Error & { cause?: unknown };
		expect(err.message).toBe("Corrupt journal entry: stored row is invalid.");
		// The message must NOT echo the stored content (huge or binary).
		expect(err.message).not.toContain(big);
		expect(err.message).not.toContain("aaaaa");
		// The original validation failure survives as the cause.
		expect(err.cause).toBeInstanceOf(Error);
	});

	it("rejects a stored row with a non-string (BLOB) created_at via get() and list()", async () => {
		const db = await dbWithRow("2026-08-10", "x", new Uint8Array([1, 2, 3]));
		const svc = new JournalService(db, clock([T0]));
		const message = "Corrupt journal entry: stored row is invalid.";
		await expect(svc.get("2026-08-10")).rejects.toThrow(message);
		await expect(svc.list()).rejects.toThrow(message);
		// Same safe wrapper/cause discipline as content/date corruption, and the
		// message never echoes the raw binary value.
		const rejection = await svc.get("2026-08-10").catch((error: unknown) => error);
		const err = rejection as Error & { cause?: unknown };
		expect(err.message).toBe(message);
		expect(err.message).not.toContain("1,2,3");
		expect(err.cause).toBeInstanceOf(Error);
	});

	it("rejects a stored row with a non-string (BLOB) updated_at via get() and list()", async () => {
		const db = await dbWithRow("2026-08-10", "x", T0, new Uint8Array([9, 9]));
		const svc = new JournalService(db, clock([T0]));
		await expect(svc.get("2026-08-10")).rejects.toThrow("Corrupt journal entry");
		await expect(svc.list()).rejects.toThrow("Corrupt journal entry");
	});

	it("rejects a stored row with a malformed (non-finite) created_at date string", async () => {
		// Text column coerced a numeric store to a string that is not a finite
		// date, and a hand-written malformed date string — both must reject.
		// SAFETY: the numeric literal is an intentionally invalid runtime value
		// that only a raw row can carry; the type system cannot express it, so
		// the test casts to the SQLValue binding type.
		const numericCreatedAt = 123 as unknown as SQLValue;
		const svcNumeric = new JournalService(
			await dbWithRow("2026-08-10", "x", numericCreatedAt),
			clock([T0]),
		);
		await expect(svcNumeric.get("2026-08-10")).rejects.toThrow("Corrupt journal entry");
		const svcMalformed = new JournalService(
			await dbWithRow("2026-08-10", "x", "not-a-timestamp"),
			clock([T0]),
		);
		await expect(svcMalformed.get("2026-08-10")).rejects.toThrow("Corrupt journal entry");
		await expect(svcMalformed.list()).rejects.toThrow("Corrupt journal entry");
	});

	it("rejects a stored row with a malformed (non-finite) updated_at date string", async () => {
		const db = await dbWithRow("2026-08-10", "x", T0, "2026-13-99T99:99:99.000Z");
		const svc = new JournalService(db, clock([T0]));
		await expect(svc.get("2026-08-10")).rejects.toThrow("Corrupt journal entry");
		await expect(svc.list()).rejects.toThrow("Corrupt journal entry");
	});

	it("keeps valid stored rows byte-for-byte unchanged through the decoder", async () => {
		const db = await dbWithRow("2026-08-10", "  padded  \n\t");
		const svc = new JournalService(db, clock([T0]));
		const entry = await svc.get("2026-08-10");
		expect(entry).toEqual<JournalEntry>({
			date: "2026-08-10",
			content: "  padded  \n\t",
			createdAt: T0,
			updatedAt: T0,
		});
		const listed = await svc.list();
		expect(listed).toHaveLength(1);
		expect(listed[0]?.content).toBe("  padded  \n\t");
		expect(await svc.listDates()).toEqual(["2026-08-10"]);
	});
});
