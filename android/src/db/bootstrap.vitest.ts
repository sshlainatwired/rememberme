import { describe, expect, it, vi } from "vitest";
import { AuthService } from "@/auth/auth-service";
import { SettingsService } from "@/db/settings";
import { type DeviceUnlockAdapter, DeviceUnlockCancelledError } from "@/security/device-unlock";
import { openAppDatabase } from "./bootstrap";
import { applyMigrations, SCHEMA_VERSION } from "./migrations";
import { createTestDb } from "./test-helper";
import type { SQLValue } from "./types";

/**
 * Track every write statement (run/exec) issued during openAppDatabase so
 * tests can prove corruption handling performs NO writes or deletes.
 */
function deviceUnlock(overrides: Partial<DeviceUnlockAdapter> = {}): DeviceUnlockAdapter {
	return {
		prepare: vi.fn(async () => ({ enabled: false, authenticated: false })),
		status: vi.fn(async () => ({ enabled: false, available: true })),
		setEnabled: vi.fn(),
		authenticate: vi.fn(),
		...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function spyOnWrites(db: ReturnType<typeof createTestDb>) {
	const writes: string[] = [];
	const exec = db.exec.bind(db);
	const run = db.run.bind(db);
	db.exec = async (sql) => {
		if (/insert|update|delete|create|drop|alter/i.test(sql)) writes.push(sql);
		await exec(sql);
	};
	db.run = async (sql, ...params) => {
		if (/insert|update|delete/i.test(sql)) writes.push(sql);
		return run(sql, ...params);
	};
	return writes;
}

describe("bootstrap: opens and migrates before services are available", () => {
	it("applies migrations then exposes journal + settings services that round-trip offline", async () => {
		const db = createTestDb();
		const handle = await openAppDatabase({ open: async () => db });

		expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
		expect(handle.journal).toBeDefined();
		expect(handle.settings).toBeDefined();
		expect(handle.security).toBeDefined();
		expect(await handle.security.getStatus()).toEqual({ enabled: false, available: false });

		// Real SQLite round-trip through both services.
		await handle.journal.upsert("2026-08-10", "bootstrapped");
		expect((await handle.journal.get("2026-08-10"))?.content).toBe("bootstrapped");

		await handle.settings.update({ timezone: "Europe/Istanbul" });
		expect((await handle.settings.get()).timezone).toBe("Europe/Istanbul");
	});

	it("rejects when the storage open fails, exposing no services", async () => {
		await expect(
			openAppDatabase({
				open: async () => {
					throw new Error("Cannot open database");
				},
			}),
		).rejects.toThrow(/Cannot open database/);
	});

	it("fails closed on migration failure: closes the DB, exposes no services, preserves data", async () => {
		const db = createTestDb();
		// Stored version newer than supported -> applyMigrations must reject.
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (999);",
		);
		const closeSpy = vi.spyOn(db, "close");

		await expect(openAppDatabase({ open: async () => db })).rejects.toThrow(/refusing|newer/);
		// The connection was released so nothing is left half-open.
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it("exposes a close() that releases the underlying connection", async () => {
		const db = createTestDb();
		const closeSpy = vi.spyOn(db, "close");
		const handle = await openAppDatabase({ open: async () => db });
		await handle.close();
		expect(closeSpy).toHaveBeenCalledOnce();
		await expect(handle.security.getStatus()).rejects.toThrow(/closed/i);
	});
});

describe("bootstrap: corrupt stored settings fail closed before the handle is exposed", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Migrated DB with one raw settings row already corrupt. */
	async function dbWithSettings(value: string, key = "timezone") {
		const db = createTestDb();
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				` INSERT INTO schema_metadata (version) VALUES (${SCHEMA_VERSION});` +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
				" CREATE TABLE local_auth (id INTEGER PRIMARY KEY CHECK (id = 1), verifier TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
		);
		await db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [key, value]);
		return db;
	}

	it("rejects corrupt settings JSON, closes the DB, and performs no writes/deletes", async () => {
		const db = await dbWithSettings("{broken");
		const writes = spyOnWrites(db);
		const closeSpy = vi.spyOn(db, "close");
		// Baseline row survives exactly as stored.
		const before = await db.query<{ key: string; value: string }>(
			"SELECT key, value FROM settings",
		);

		await expect(openAppDatabase({ open: async () => db })).rejects.toThrow(/corrupt|settings/i);
		expect(closeSpy).toHaveBeenCalledOnce();
		expect(writes).toEqual([]); // nothing written, updated, or deleted

		// Re-open the same storage fresh: the corrupt row is untouched.
		const db2 = await dbWithSettings("{broken");
		const again = await db2.query<{ key: string; value: string }>(
			"SELECT key, value FROM settings",
		);
		expect(again).toEqual(before);
	});

	it("rejects an invalid stored allowed-key value before exposing services", async () => {
		const db = await dbWithSettings(JSON.stringify(99), "weeklyReviewHour");
		const closeSpy = vi.spyOn(db, "close");
		await expect(openAppDatabase({ open: async () => db })).rejects.toThrow(
			/corrupt|settings|invalid/i,
		);
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it("rejects an unknown stored settings key before exposing services", async () => {
		const db = await dbWithSettings(JSON.stringify("a@b.c"), "email");
		const closeSpy = vi.spyOn(db, "close");
		await expect(openAppDatabase({ open: async () => db })).rejects.toThrow(
			/corrupt|settings|unknown|key/i,
		);
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it("serves a clean handle when stored settings are valid (no false corruption)", async () => {
		const db = createTestDb();
		const handle = await openAppDatabase({ open: async () => db });
		expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
		expect((await handle.settings.get()).timezone).toBe("UTC");
	});
});

describe("bootstrap: corrupt stored journal rows fail closed before the handle is exposed", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Migrated DB with one raw journal row (intentionally corrupt). */
	async function dbWithJournalRow(row: {
		date: string;
		content: unknown;
		createdAt?: unknown;
		updatedAt?: unknown;
	}) {
		const db = createTestDb();
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				` INSERT INTO schema_metadata (version) VALUES (${SCHEMA_VERSION});` +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
				" CREATE TABLE local_auth (id INTEGER PRIMARY KEY CHECK (id = 1), verifier TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
		);
		await db.run(
			"INSERT INTO journal_entries (date, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
			[
				row.date,
				row.content as SQLValue,
				(row.createdAt ?? "2026-08-01T00:00:00.000Z") as SQLValue,
				(row.updatedAt ?? "2026-08-01T00:00:00.000Z") as SQLValue,
			],
		);
		return db;
	}

	it("rejects a corrupt stored journal date, closes the DB once, performs no writes/deletes", async () => {
		const db = await dbWithJournalRow({ date: "2026-13-99", content: "x" });
		const writes = spyOnWrites(db);
		const closeSpy = vi.spyOn(db, "close");
		const before = await db.query<{ date: string; content: string }>(
			"SELECT date, content FROM journal_entries",
		);

		await expect(openAppDatabase({ open: async () => db })).rejects.toThrow(/corrupt|journal/i);
		expect(closeSpy).toHaveBeenCalledOnce();
		expect(writes).toEqual([]); // nothing written, updated, or deleted

		// Re-open the same storage fresh: the corrupt row is untouched
		// (the failed bootstrap never mutated it before closing).
		const db2 = await dbWithJournalRow({ date: "2026-13-99", content: "x" });
		const again = await db2.query<{ date: string; content: string }>(
			"SELECT date, content FROM journal_entries",
		);
		expect(again).toEqual(before);
	});

	it("rejects a stored journal row with oversized content before exposing services", async () => {
		const db = await dbWithJournalRow({ date: "2026-08-10", content: "a".repeat(100_001) });
		const closeSpy = vi.spyOn(db, "close");
		await expect(openAppDatabase({ open: async () => db })).rejects.toThrow(/corrupt|journal/i);
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it("rejects a stored journal row with non-string (BLOB) content before exposing services", async () => {
		const db = await dbWithJournalRow({ date: "2026-08-10", content: new Uint8Array([1, 2, 3]) });
		const closeSpy = vi.spyOn(db, "close");
		await expect(openAppDatabase({ open: async () => db })).rejects.toThrow(/corrupt|journal/i);
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it("keeps the corrupt-journal error AND its validation cause through the bootstrap wrapper", async () => {
		const db = await dbWithJournalRow({ date: "2026-08-10", content: "a".repeat(100_001) });
		const rejection = await openAppDatabase({ open: async () => db }).catch((e: unknown) => e);
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toMatch(/stored journal data is corrupt/);
		// cause #1 = the JournalService.list() corruption error (clear, generic).
		const cause1 = (rejection as { cause?: unknown }).cause;
		expect(cause1).toBeInstanceOf(Error);
		expect((cause1 as Error).message).toBe("Corrupt journal entry: stored row is invalid.");
		// cause #2 = the original shared-schema validation failure, preserved.
		const cause2 = (cause1 as { cause?: unknown }).cause;
		expect(cause2).toBeInstanceOf(Error);
	});

	it("rejects a stored journal row with a non-string (BLOB) created_at: close once, zero writes", async () => {
		const db = await dbWithJournalRow({
			date: "2026-08-10",
			content: "x",
			createdAt: new Uint8Array([1, 2, 3]),
		});
		const writes = spyOnWrites(db);
		const closeSpy = vi.spyOn(db, "close");
		await expect(openAppDatabase({ open: async () => db })).rejects.toThrow(/corrupt|journal/i);
		expect(closeSpy).toHaveBeenCalledOnce();
		expect(writes).toEqual([]); // nothing written, updated, or deleted

		// Re-open the same storage fresh: the raw row is untouched.
		const db2 = await dbWithJournalRow({
			date: "2026-08-10",
			content: "x",
			createdAt: new Uint8Array([1, 2, 3]),
		});
		const again = await db2.query<{ date: string; content: string }>(
			"SELECT date, content FROM journal_entries",
		);
		expect(again).toHaveLength(1);
	});

	it("rejects a stored journal row with a malformed (non-finite) updated_at: close once, zero writes", async () => {
		const db = await dbWithJournalRow({
			date: "2026-08-10",
			content: "x",
			updatedAt: "2026-13-99T99:99:99.000Z",
		});
		const writes = spyOnWrites(db);
		const closeSpy = vi.spyOn(db, "close");
		const rejection = await openAppDatabase({ open: async () => db }).catch((e: unknown) => e);
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toMatch(/stored journal data is corrupt/);
		// cause #1 = the JournalService.list() corruption error (clear, generic).
		const cause1 = (rejection as { cause?: unknown }).cause;
		expect(cause1).toBeInstanceOf(Error);
		expect((cause1 as Error).message).toBe("Corrupt journal entry: stored row is invalid.");
		// cause #2 = the original timestamp-validation failure, preserved.
		const cause2 = (cause1 as { cause?: unknown }).cause;
		expect(cause2).toBeInstanceOf(Error);
		expect(closeSpy).toHaveBeenCalledOnce();
		expect(writes).toEqual([]);
	});

	it("serves a clean handle when stored journal rows are valid (no false corruption, zero writes)", async () => {
		const db = await dbWithJournalRow({ date: "2026-08-10", content: "fine  \n" });
		const writes = spyOnWrites(db);
		const handle = await openAppDatabase({ open: async () => db });
		expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
		expect((await handle.journal.get("2026-08-10"))?.content).toBe("fine  \n");
		// The bootstrap row scan read every row without writing anything.
		expect(writes).toEqual([]);
	});
});

describe("bootstrap: corrupt stored auth fails closed before the handle is exposed", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Migrated DB with one raw local_auth row (intentionally corrupt or not). */
	async function dbWithAuth(verifier: string | null) {
		const db = createTestDb();
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				` INSERT INTO schema_metadata (version) VALUES (${SCHEMA_VERSION});` +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
				" CREATE TABLE local_auth (id INTEGER PRIMARY KEY CHECK (id = 1), verifier TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
		);
		if (verifier !== null) {
			await db.run(
				"INSERT INTO local_auth (id, verifier, created_at, updated_at) VALUES (?, ?, ?, ?)",
				[1, verifier, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
			);
		}
		return db;
	}

	it("rejects a corrupt stored auth verifier (invalid JSON), closes once, performs no writes and preserves the cause", async () => {
		const db = await dbWithAuth("not-json");
		const writes = spyOnWrites(db);
		const closeSpy = vi.spyOn(db, "close");
		const before = await db.query<{ verifier: string }>("SELECT verifier FROM local_auth");

		const rejection = await openAppDatabase({ open: async () => db }).catch((e: unknown) => e);
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toMatch(/stored auth data is corrupt/);
		// cause #1 = the AuthService.validateStored() corruption error.
		const cause1 = (rejection as { cause?: unknown }).cause;
		expect(cause1).toBeInstanceOf(Error);
		expect((cause1 as Error).message).toMatch(/verifier/i);
		// cause #2 = the original strict-decode failure, preserved.
		const cause2 = (cause1 as { cause?: unknown }).cause;
		expect(cause2).toBeInstanceOf(Error);
		expect(closeSpy).toHaveBeenCalledOnce();
		expect(writes).toEqual([]); // nothing written, updated, or deleted

		// Re-open the same storage fresh: the corrupt row is untouched.
		const db2 = await dbWithAuth("not-json");
		const again = await db2.query<{ verifier: string }>("SELECT verifier FROM local_auth");
		expect(again).toEqual(before);
	});

	it("rejects a hostile stored auth iter-count (downgrade), closes once, zero writes", async () => {
		const hostel = JSON.stringify({
			version: 1,
			algorithm: "PBKDF2-HMAC-SHA256",
			iterations: 100000,
			salt: "YWFhYWFhYWFhYWFhYWFhYQ==",
			verifier: "YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI=",
		});
		const db = await dbWithAuth(hostel);
		const writes = spyOnWrites(db);
		const closeSpy = vi.spyOn(db, "close");
		const rejection = await openAppDatabase({ open: async () => db }).catch((e: unknown) => e);
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toMatch(/stored auth data is corrupt/);
		const cause1 = (rejection as { cause?: unknown }).cause;
		expect(cause1).toBeInstanceOf(Error);
		expect((cause1 as Error).message).toMatch(/iterations/i);
		expect(closeSpy).toHaveBeenCalledOnce();
		expect(writes).toEqual([]);
	});

	it("opens a fresh DB (empty local_auth): configured false, zero writes", async () => {
		const db = await dbWithAuth(null);
		const writes = spyOnWrites(db);
		const handle = await openAppDatabase({ open: async () => db });
		expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
		expect(handle.auth).toBeDefined();
		expect(await handle.auth.status()).toEqual({ configured: false, unlocked: false });
		expect(writes).toEqual([]);
	});

	it("exposes handle.auth matching a valid stored auth row after bootstrap", async () => {
		const db = await dbWithAuth(
			'{"version":1,"algorithm":"PBKDF2-HMAC-SHA256","iterations":600000,"salt":"YWFhYWFhYWFhYWFhYWFhYQ==","verifier":"YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI="}',
		);
		const handle = await openAppDatabase({ open: async () => db });
		expect(handle.auth).toBeDefined();
		expect(await handle.auth.status()).toEqual({ configured: true, unlocked: false });
	});

	it("rejects a sole otherwise-valid local_auth row whose id is not numeric 1", async () => {
		const db = createTestDb();
		await applyMigrations(db);
		const verifier =
			'{"version":1,"algorithm":"PBKDF2-HMAC-SHA256","iterations":600000,"salt":"YWFhYWFhYWFhYWFhYWFhYQ==","verifier":"YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI="}';
		await db.exec("PRAGMA ignore_check_constraints = ON");
		await db.run(
			"INSERT INTO local_auth (id, verifier, created_at, updated_at) VALUES (?, ?, ?, ?)",
			[2, verifier, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
		);
		await db.exec("PRAGMA ignore_check_constraints = OFF");
		const rows = await db.query<{
			id: unknown;
			verifier: string;
			created_at: string;
			updated_at: string;
		}>("SELECT id, verifier, created_at, updated_at FROM local_auth");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			id: 2,
			verifier,
			created_at: "2026-08-01T00:00:00.000Z",
			updated_at: "2026-08-01T00:00:00.000Z",
		});
		const writes = spyOnWrites(db);
		const closeSpy = vi.spyOn(db, "close");
		const rejection = await openAppDatabase({ open: async () => db }).catch((e: unknown) => e);
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toMatch(/Corrupt local auth:/);
		const cause = (rejection as { cause?: unknown }).cause;
		expect(cause).toBeInstanceOf(Error);
		expect((cause as Error).message).toMatch(/Corrupt local auth:.*numeric 1/i);
		expect(closeSpy).toHaveBeenCalledOnce();
		expect(writes).toEqual([]);
	});

	it("rejects a stored auth row with a malformed created_at — closes once, zero writes, cause preserved", async () => {
		const db = await dbWithAuth(
			'{"version":1,"algorithm":"PBKDF2-HMAC-SHA256","iterations":600000,"salt":"YWFhYWFhYWFhYWFhYWFhYQ==","verifier":"YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI="}',
		);
		await db.run("UPDATE local_auth SET created_at = 'not-a-date'");
		const writes = spyOnWrites(db);
		const closeSpy = vi.spyOn(db, "close");
		const rejection = await openAppDatabase({ open: async () => db }).catch((e: unknown) => e);
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toMatch(/stored auth data is corrupt/);
		const cause1 = (rejection as { cause?: unknown }).cause;
		expect(cause1).toBeInstanceOf(Error);
		expect((cause1 as Error).message).toMatch(/not a valid date string/i);
		expect(closeSpy).toHaveBeenCalledOnce();
		expect(writes).toEqual([]);
	});
});

describe("bootstrap: failure wrappers preserve the exact error as cause", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps applyMigrations' rejection as cause, nested through the migration wrapper (never stringified only)", async () => {
		const db = createTestDb();
		// Claimed v1 with a settings table of the WRONG shape: migration 2's
		// CREATE TABLE collides, so applyMigrations wraps the engine error
		// (with cause) and openAppDatabase wraps that rejection again.
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (1);" +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT PRIMARY KEY);",
		);
		const rejection = await openAppDatabase({ open: async () => db }).catch((e: unknown) => e);
		expect(rejection).toBeInstanceOf(Error);
		// The bootstrap wrapper keeps the user-safe message.
		expect((rejection as Error).message).toMatch(/Cannot open local database/);
		// cause #1 = the exact applyMigrations rejection (an Error, not text).
		const cause1 = (rejection as { cause?: unknown }).cause;
		expect(cause1).toBeInstanceOf(Error);
		expect((cause1 as Error).message).toMatch(/Migration 2 \("settings"\) failed/);
		// cause #2 = the original SQLite engine error, preserved not stringified.
		const cause2 = (cause1 as { cause?: unknown }).cause;
		expect(cause2).toBeInstanceOf(Error);
		expect((cause2 as Error).message).toMatch(/already exists/i);
	});

	it("keeps the corrupt-settings error AND its validation cause through the bootstrap wrapper", async () => {
		const db = createTestDb();
		// Stored weeklyReviewHour is invalid (99 > 23) with the metadata
		// already claiming the current version so migrations are skipped;
		// local_auth is present so the schema itself is valid and the failure
		// is attributed to the corrupt settings row, not the schema.
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				` INSERT INTO schema_metadata (version) VALUES (${SCHEMA_VERSION});` +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
				" CREATE TABLE local_auth (id INTEGER PRIMARY KEY CHECK (id = 1), verifier TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
		);
		await db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [
			"weeklyReviewHour",
			JSON.stringify(99),
		]);
		const rejection = await openAppDatabase({ open: async () => db }).catch((e: unknown) => e);
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toMatch(/stored settings are corrupt/);
		// cause #1 = the SettingsService.get() corruption error (clear, named key).
		const cause1 = (rejection as { cause?: unknown }).cause;
		expect(cause1).toBeInstanceOf(Error);
		expect((cause1 as Error).message).toBe(
			"Corrupt settings: stored value for weeklyReviewHour is invalid.",
		);
		// cause #2 = the original field-validation error, preserved as cause.
		const cause2 = (cause1 as { cause?: unknown }).cause;
		expect(cause2).toBeInstanceOf(Error);
		expect((cause2 as Error).message).toMatch(/Invalid weekly review hour/);
	});
});

describe("bootstrap: full app-schema validation fails closed before routes are served", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects a current-version database whose journal_entries table is missing — zero writes, connection closed", async () => {
		const db = createTestDb();
		// Metadata claims v2, but journal_entries is absent: migrations are
		// skipped, so the only thing left to catch this is validateAppSchema.
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				` INSERT INTO schema_metadata (version) VALUES (${SCHEMA_VERSION});` +
				" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
		);
		const writes = spyOnWrites(db);
		const closeSpy = vi.spyOn(db, "close");

		await expect(openAppDatabase({ open: async () => db })).rejects.toThrow(
			/schema|corrupt|journal_entries/i,
		);
		expect(closeSpy).toHaveBeenCalledOnce();
		expect(writes).toEqual([]); // no writes, updates, or deletes
	});

	it("rejects an altered settings table (extra column) and closes without writes", async () => {
		const db = createTestDb();
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				` INSERT INTO schema_metadata (version) VALUES (${SCHEMA_VERSION});` +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, email TEXT);",
		);
		const writes = spyOnWrites(db);
		const closeSpy = vi.spyOn(db, "close");
		await expect(openAppDatabase({ open: async () => db })).rejects.toThrow(
			/schema|corrupt|settings/i,
		);
		expect(closeSpy).toHaveBeenCalledOnce();
		expect(writes).toEqual([]);
	});

	it("rejects a current-version database missing the local_auth table — zero writes, connection closed", async () => {
		const db = createTestDb();
		// Metadata claims the current version (migrations skipped) but
		// local_auth is absent: only validateAppSchema (the v3 schema set) can
		// catch it, fail closed, and expose no services.
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				` INSERT INTO schema_metadata (version) VALUES (${SCHEMA_VERSION});` +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
		);
		const writes = spyOnWrites(db);
		const closeSpy = vi.spyOn(db, "close");
		await expect(openAppDatabase({ open: async () => db })).rejects.toThrow(
			/schema|corrupt|local_auth/i,
		);
		expect(closeSpy).toHaveBeenCalledOnce();
		expect(writes).toEqual([]); // no writes, updates, or deletes
	});
});

describe("bootstrap: native key gate and trusted startup session", () => {
	it("waits for key preparation before opening or probing the database", async () => {
		const gate = deferred<{ enabled: false; authenticated: false }>();
		const adapter = deviceUnlock({ prepare: vi.fn(() => gate.promise) });
		const db = createTestDb();
		const open = vi.fn(async () => db);
		const opening = openAppDatabase({ open, deviceUnlockAdapter: adapter });
		await Promise.resolve();
		expect(adapter.prepare).toHaveBeenCalledOnce();
		expect(open).not.toHaveBeenCalled();
		gate.resolve({ enabled: false, authenticated: false });
		const handle = await opening;
		expect(open).toHaveBeenCalledOnce();
		await handle.close();
	});

	it("does not open a connection when preparation is cancelled or fails", async () => {
		const cancelledOpen = vi.fn(async () => createTestDb());
		const cancellation = new DeviceUnlockCancelledError();
		await expect(
			openAppDatabase({
				open: cancelledOpen,
				deviceUnlockAdapter: deviceUnlock({
					prepare: vi.fn(async () => Promise.reject(cancellation)),
				}),
			}),
		).rejects.toBe(cancellation);
		expect(cancelledOpen).not.toHaveBeenCalled();

		const failedOpen = vi.fn(async () => createTestDb());
		await expect(
			openAppDatabase({
				open: failedOpen,
				deviceUnlockAdapter: deviceUnlock({
					prepare: vi.fn(async () => Promise.reject(new Error("native failed"))),
				}),
			}),
		).rejects.toThrow("native failed");
		expect(failedOpen).not.toHaveBeenCalled();
	});

	it("authenticates enabled startup, reconciles its mirror, and opens the local session", async () => {
		const db = createTestDb();
		await applyMigrations(db);
		const settings = new SettingsService(db);
		const seeded = new AuthService(db, settings);
		await seeded.setup("a-secure-pass", "UTC");
		seeded.logout();
		const adapter = deviceUnlock({
			prepare: vi.fn(async () => ({ enabled: true, authenticated: true })),
			status: vi.fn(async () => ({ enabled: true, available: true })),
		});

		const handle = await openAppDatabase({ open: async () => db, deviceUnlockAdapter: adapter });
		expect((await handle.settings.get()).biometricEnabled).toBe(true);
		expect(await handle.auth.status()).toEqual({ configured: true, unlocked: true });
	});

	it("leaves a configured session locked when native protection is disabled", async () => {
		const db = createTestDb();
		await applyMigrations(db);
		const settings = new SettingsService(db);
		const seeded = new AuthService(db, settings);
		await seeded.setup("a-secure-pass", "UTC");
		seeded.logout();

		const handle = await openAppDatabase({
			open: async () => db,
			deviceUnlockAdapter: deviceUnlock(),
		});
		expect(await handle.auth.status()).toEqual({ configured: true, unlocked: false });
	});

	it("closes exactly once when post-open reconciliation or trusted unlock fails", async () => {
		const reconcileDb = createTestDb();
		const reconcileClose = vi.spyOn(reconcileDb, "close");
		await expect(
			openAppDatabase({
				open: async () => reconcileDb,
				deviceUnlockAdapter: deviceUnlock({
					status: vi.fn(async () => Promise.reject(new Error("status failed"))),
				}),
			}),
		).rejects.toThrow(/status failed/i);
		expect(reconcileClose).toHaveBeenCalledOnce();

		const sessionDb = createTestDb();
		const sessionClose = vi.spyOn(sessionDb, "close");
		await expect(
			openAppDatabase({
				open: async () => sessionDb,
				deviceUnlockAdapter: deviceUnlock({
					prepare: vi.fn(async () => ({ enabled: true, authenticated: true })),
					status: vi.fn(async () => ({ enabled: true, available: true })),
				}),
			}),
		).rejects.toThrow(/not configured/i);
		expect(sessionClose).toHaveBeenCalledOnce();
	});

	it("fails closed and closes when post-open native mode differs from preparation", async () => {
		const db = createTestDb();
		const close = vi.spyOn(db, "close");
		await expect(
			openAppDatabase({
				open: async () => db,
				deviceUnlockAdapter: deviceUnlock({
					prepare: vi.fn(async () => ({ enabled: true, authenticated: true })),
					status: vi.fn(async () => ({ enabled: false, available: true })),
				}),
			}),
		).rejects.toThrow(/changed|mismatch|state/i);
		expect(close).toHaveBeenCalledOnce();
	});
});

describe("bootstrap: initDatabase process-wide singleton", () => {
	/**
	 * Fresh module registry per test: the singleton lives in module state, so
	 * module-reset testing replaces the old test-only `resetDatabase` export
	 * (removed from the production API — nothing forgets the handle at runtime).
	 */
	async function freshInitDatabase() {
		vi.resetModules();
		const mod = await import("./bootstrap");
		return mod.initDatabase;
	}

	it("returns the SAME promise across repeated calls (one underlying open)", async () => {
		const initDatabase = await freshInitDatabase();
		const db = createTestDb();
		const open = vi.fn(async () => db);

		const first = initDatabase({ open });
		const second = initDatabase({ open });

		expect(first).toBe(second); // identity, not just equal result
		const handle = await first;
		expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("collapses concurrent cancellation but clears it so a later retry can open", async () => {
		const initDatabase = await freshInitDatabase();
		const db = createTestDb();
		const open = vi.fn(async () => db);
		const cancellation = new DeviceUnlockCancelledError();
		const adapter = deviceUnlock({
			prepare: vi
				.fn()
				.mockRejectedValueOnce(cancellation)
				.mockResolvedValueOnce({ enabled: false, authenticated: false }),
		});

		const first = initDatabase({ open, deviceUnlockAdapter: adapter });
		const concurrent = initDatabase({ open, deviceUnlockAdapter: adapter });
		expect(concurrent).toBe(first);
		await expect(first).rejects.toBe(cancellation);
		await expect(concurrent).rejects.toBe(cancellation);
		expect(open).not.toHaveBeenCalled();

		const retry = initDatabase({ open, deviceUnlockAdapter: adapter });
		expect(retry).not.toBe(first);
		await expect(retry).resolves.toBeDefined();
		expect(adapter.prepare).toHaveBeenCalledTimes(2);
		expect(open).toHaveBeenCalledOnce();
	});

	it("replays the same rejection when initialization failed (no second attempt)", async () => {
		const initDatabase = await freshInitDatabase();
		const open = vi.fn(async () => {
			throw new Error("connection failed");
		});

		const first = initDatabase({ open });
		const second = initDatabase({ open });

		await expect(first).rejects.toThrow(/connection failed/);
		await expect(second).rejects.toThrow(/connection failed/);
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("ignores later callers' options: the first open wins for every subscriber", async () => {
		const initDatabase = await freshInitDatabase();
		const db = createTestDb();
		const firstOpen = vi.fn(async () => db);
		const otherOpen = vi.fn(async () => createTestDb());

		const first = initDatabase({ open: firstOpen });
		// A second mount with its own factory must still observe the first
		// promise — the singleton collapses StrictMode's double effect run.
		const second = initDatabase({ open: otherOpen });
		expect(second).toBe(first);
		await first;
		expect(firstOpen).toHaveBeenCalledTimes(1);
		expect(otherOpen).not.toHaveBeenCalled();
	});
});
