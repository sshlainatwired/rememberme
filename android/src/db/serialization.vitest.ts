import { describe, expect, it } from "vitest";
import { JournalService } from "./journal";
import { applyMigrations } from "./migrations";
import { SettingsService } from "./settings";
import { createTestDb } from "./test-helper";
import { Serializer, type SQLDialect } from "./types";

/**
 * Operation-isolation tests against REAL `node:sqlite` concurrency.
 *
 * One dialect/connection backs both the JournalService and the SettingsService,
 * so their public operations are serialized through the dialect's queue.
 * Without that serialization the interleaving below reproduces SQLite's
 * "cannot start a transaction within a transaction" and a UNIQUE-constraint
 * double-INSERT — proven here by the assertions themselves.
 */

/** Inject the dialect behind a settings service for fault/raw access. */
function rawDb(svc: SettingsService): SQLDialect {
	// SAFETY: test-only invariant TypeScript can't check — the service keeps
	// its dialect in a private `db` field; the cast is confined to this test
	// file and only reads the backing store to install fault-injection triggers.
	return (svc as unknown as { db: SQLDialect }).db;
}

describe("operation isolation: concurrent settings updates both succeed", () => {
	it("two overlapping update() calls apply atomically instead of failing 'Already in transaction'", async () => {
		const db = createTestDb();
		await applyMigrations(db);
		const settings = new SettingsService(db);

		const results = await Promise.all([
			settings.update({ timezone: "Europe/Istanbul", weeklyReviewHour: 7 }),
			settings.update({ timezone: "America/New_York", weeklyReviewHour: 21 }),
		]);

		// Both calls resolved (no "cannot start a transaction within a transaction").
		expect(results).toHaveLength(2);
		// Both full transactions were applied one after the other (no half-state).
		const final = await settings.get();
		expect(["Europe/Istanbul", "America/New_York"]).toContain(final.timezone);
		expect([7, 21]).toContain(final.weeklyReviewHour);
		// Each transaction set BOTH its fields — no interleaving.
		if (final.timezone === "Europe/Istanbul") {
			expect(final.weeklyReviewHour).toBe(7);
		} else {
			expect(final.weeklyReviewHour).toBe(21);
		}
	});
});

describe("operation isolation: concurrent missing-date journal upserts", () => {
	it("do not double-INSERT (UNIQUE) and deterministically leave one valid row", async () => {
		const db = createTestDb();
		await applyMigrations(db);
		const journal = new JournalService(db);
		// The shared clock sequence yields distinct updated_at for each upsert.
		let tick = 0;
		const clock = () => `2026-08-01T00:00:0${tick++}.000Z`;

		await Promise.all([
			new JournalService(db, clock).upsert("2026-08-10", "aaa"),
			new JournalService(db, clock).upsert("2026-08-10", "bbb"),
		]);

		const rows = await db.query<{ date: string; content: string }>(
			"SELECT date, content FROM journal_entries WHERE date = '2026-08-10'",
		);
		expect(rows).toHaveLength(1);
		// The surviving row is one of the two provided values — a valid entry.
		expect(["aaa", "bbb"]).toContain(rows[0].content);
		expect(await journal.get("2026-08-10")).not.toBeNull();
	});
});

describe("operation isolation: a failing settings transaction cannot absorb/rollback a journal write", () => {
	it("a rejected update() rolls back only its own transaction; a concurrent journal upsert commits", async () => {
		const db = createTestDb();
		await applyMigrations(db);
		const settings = new SettingsService(db);
		const journal = new JournalService(db);
		// Both keys exist so the transaction is an UPDATE (not INSERT).
		await settings.update({ timezone: "UTC", weeklyReviewHour: 20 });
		// Abort any UPDATE of weeklyReviewHour so the settings transaction fails.
		await rawDb(settings).exec(
			"CREATE TRIGGER fail_hour BEFORE UPDATE ON settings " +
				"WHEN NEW.key = 'weeklyReviewHour' BEGIN " +
				"SELECT RAISE(ABORT, 'hour update rejected'); END;",
		);

		const settingsP = settings.update({ timezone: "America/New_York", weeklyReviewHour: 23 }).then(
			() => "resolved",
			(e: unknown) => `rejected: ${(e as Error).message}`,
		);
		const journalP = journal.upsert("2026-08-10", "concurrent-journal-write");

		const [settingsResult, journalEntry] = await Promise.all([settingsP, journalP]);

		// Journal write survives the concurrent failing settings transaction.
		expect((await journal.get("2026-08-10"))?.content).toBe("concurrent-journal-write");
		expect(journalEntry).not.toBeNull();
		// Settings rolled back entirely (both keys reverted to UTC/20).
		expect(settingsResult).toMatch(/rejected/);
		expect((await settings.get()).timezone).toBe("UTC");
		expect((await settings.get()).weeklyReviewHour).toBe(20);
	});
});

describe("operation isolation: queue continues after a rejection", () => {
	it("a later write still succeeds after a prior queued operation rejected", async () => {
		const db = createTestDb();
		await applyMigrations(db);
		const settings = new SettingsService(db);
		await settings.update({ timezone: "UTC", weeklyReviewHour: 20 });
		await rawDb(settings).exec(
			"CREATE TRIGGER fail_hour BEFORE UPDATE ON settings " +
				"WHEN NEW.key = 'weeklyReviewHour' BEGIN " +
				"SELECT RAISE(ABORT, 'fail'); END;",
		);

		await expect(
			settings.update({ timezone: "America/New_York", weeklyReviewHour: 22 }),
		).rejects.toThrow();

		// The queue was not poisoned: a valid single-field update still works.
		await settings.update({ timezone: "Asia/Tokyo" });
		expect((await settings.get()).timezone).toBe("Asia/Tokyo");
	});
});

describe("close isolation: close drains queued work, then new work rejects (real node:sqlite)", () => {
	it("close() waits for an in-flight locked operation to settle before closing the engine", async () => {
		const db = createTestDb();
		await applyMigrations(db);

		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let opRan = false;
		const op = db.withLock(async () => {
			opRan = true;
			await gate;
			return "op-done";
		});
		const closing = db.close();
		// Let the queued op start; close is enqueued behind it.
		await Promise.resolve();
		expect(opRan).toBe(true);
		let closed = false;
		closing.then(() => (closed = true));
		await Promise.resolve();
		// Close must not have run while the locked op is still in flight.
		expect(closed).toBe(false);

		release();
		expect(await op).toBe("op-done");
		await closing;
		expect(closed).toBe(true);
	});

	it("a new operation after close() rejects immediately and never executes", async () => {
		const db = createTestDb();
		await applyMigrations(db);
		const journal = new JournalService(db, () => "2026-08-01T00:00:00.000Z");
		const settings = new SettingsService(db);

		await db.close();

		let executed = false;
		await expect(
			db.withLock(async () => {
				executed = true;
			}),
		).rejects.toThrow(/closed/i);
		expect(executed).toBe(false);

		// Service-level operations are gated the same way.
		await expect(journal.get("2026-08-10")).rejects.toThrow(/closed/i);
		await expect(journal.upsert("2026-08-10", "x")).rejects.toThrow(/closed/i);
		await expect(journal.listDates()).rejects.toThrow(/closed/i);
		await expect(settings.get()).rejects.toThrow(/closed/i);
		await expect(settings.update({ appearance: "dark" })).rejects.toThrow(/closed/i);
	});

	it("a completed close is memoized: repeat/concurrent callers share one promise and never re-close", async () => {
		const db = createTestDb();
		await applyMigrations(db);

		const first = db.close();
		const second = db.close();
		expect(first).toBe(second); // identity, not just equality
		await first;
		await second; // resolves — the engine was closed exactly once

		let executed = false;
		await expect(
			db.withLock(async () => {
				executed = true;
			}),
		).rejects.toThrow(/closed/i);
		expect(executed).toBe(false);
	});

	it("a failed close replays its rejection to every later caller", async () => {
		// Real DB + real Serializer; only the ultimate close action is faked
		// to fail deterministically (an engine close on this platform can be
		// faked into failing by overriding the adapter's close action).
		const db = createTestDb();
		await applyMigrations(db);
		const serializer = new Serializer();
		const dialect: SQLDialect = {
			exec: (sql: string) => db.exec(sql),
			run: (sql: string, params) => db.run(sql, params),
			query: (sql: string, params) => db.query(sql, params),
			begin: () => db.begin(),
			commit: () => db.commit(),
			rollback: () => db.rollback(),
			withLock: <T>(fn: () => Promise<T>) => serializer.run(fn),
			close: () =>
				serializer.close(async () => {
					throw new Error("engine close failed");
				}),
		};

		const first = dialect.close();
		const second = dialect.close();
		expect(first).toBe(second);
		await expect(first).rejects.toThrow("engine close failed");
		await expect(second).rejects.toThrow("engine close failed");
	});
});
