import { describe, expect, it } from "vitest";
import { applyMigrations } from "./migrations";
import {
	APP_SCHEMA_TABLES,
	JOURNAL_ENTRIES_SPEC,
	LOCAL_AUTH_SPEC,
	SCHEMA_METADATA_SPEC,
	SETTINGS_SPEC,
	schemaSpecForVersion,
	validateAppSchema,
} from "./schema-validation";
import { createTestDb } from "./test-helper";
import type { SQLDialect, SQLRow, SQLValue } from "./types";

/** Migrated, clean v2 database (real node:sqlite). */
async function cleanDb() {
	const db = createTestDb();
	await applyMigrations(db);
	return db;
}

/** A v2-claiming (version already current) hand-built database. */
async function v2Db(extraDdl: string) {
	const db = createTestDb();
	await db.exec(
		"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
			" INSERT INTO schema_metadata (version) VALUES (2);" +
			" CREATE TABLE journal_entries (" +
			" date TEXT PRIMARY KEY," +
			" content TEXT NOT NULL," +
			" created_at TEXT NOT NULL," +
			" updated_at TEXT NOT NULL);" +
			" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
			extraDdl,
	);
	return db;
}

describe("validateAppSchema: clean schema passes", () => {
	it("accepts the migrated v3 schema", async () => {
		const db = await cleanDb();
		await expect(validateAppSchema(db)).resolves.toBeUndefined();
	});

	it("optionally runs PRAGMA quick_check on a clean database", async () => {
		const db = await cleanDb();
		await expect(validateAppSchema(db, { quickCheck: true })).resolves.toBeUndefined();
	});

	it("does not reject SQLite internal indexes or unrelated tables", async () => {
		const db = await cleanDb();
		// The TEXT primary keys already created sqlite_autoindex_* entries;
		// an explicit index and an unrelated user table must not break the
		// (expected-tables-only) validation.
		await db.exec(
			"CREATE INDEX idx_content ON journal_entries(content);" +
				" CREATE TABLE unrelated_future_table (x INTEGER);",
		);
		await expect(validateAppSchema(db)).resolves.toBeUndefined();
	});
});

describe("validateAppSchema: structural corruption fails closed", () => {
	it("rejects a missing journal_entries table", async () => {
		const db = await cleanDb();
		await db.exec("DROP TABLE journal_entries");
		await expect(validateAppSchema(db)).rejects.toThrow(/journal_entries|schema|missing/i);
	});

	it("rejects a missing settings table", async () => {
		const db = await cleanDb();
		await db.exec("DROP TABLE settings");
		await expect(validateAppSchema(db)).rejects.toThrow(/settings|schema|missing/i);
	});

	it("rejects a missing schema_metadata table", async () => {
		const db = await cleanDb();
		await db.exec("DROP TABLE schema_metadata");
		await expect(validateAppSchema(db)).rejects.toThrow(/schema_metadata|schema|missing/i);
	});

	it("rejects a table replaced by a view of the same name", async () => {
		const db = await cleanDb();
		await db.exec(
			"DROP TABLE journal_entries; CREATE VIEW journal_entries AS SELECT * FROM settings;",
		);
		await expect(validateAppSchema(db)).rejects.toThrow(/journal_entries|schema|missing/i);
	});

	it("rejects an extra unexpected column", async () => {
		const db = await v2Db(" ALTER TABLE settings ADD COLUMN email TEXT;");
		await expect(validateAppSchema(db)).rejects.toThrow(/settings|schema|column/i);
	});

	it("rejects an altered column (NOT NULL dropped)", async () => {
		const db = createTestDb();
		// content is nullable — deviates from the expected shape.
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (2);" +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
		);
		await expect(validateAppSchema(db)).rejects.toThrow(/content|schema|column/i);
	});

	it("rejects a column type change", async () => {
		const db = createTestDb();
		// created_at declared INTEGER instead of TEXT.
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (2);" +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
		);
		await expect(validateAppSchema(db)).rejects.toThrow(/created_at|schema|column/i);
	});

	it("rejects a primary-key change", async () => {
		const db = createTestDb();
		// settings key is no longer the primary key.
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (2);" +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT NOT NULL, value TEXT NOT NULL);",
		);
		await expect(validateAppSchema(db)).rejects.toThrow(/settings|schema|primary|key/i);
	});

	it("rejects a column-order change", async () => {
		const db = createTestDb();
		// created_at and updated_at swapped.
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (2);" +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL, created_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
		);
		await expect(validateAppSchema(db)).rejects.toThrow(/journal_entries|schema|column|order/i);
	});
});

describe("validateAppSchema: PRAGMA quick_check is honored when enabled", () => {
	it("rejects when quick_check reports non-ok (narrow boundary fake around a real DB)", async () => {
		const db = await cleanDb();
		const realQuery = db.query.bind(db);
		const corruptDialect: SQLDialect = {
			exec: (sql: string) => db.exec(sql),
			run: (sql: string, params) => db.run(sql, params),
			begin: () => db.begin(),
			commit: () => db.commit(),
			rollback: () => db.rollback(),
			close: () => db.close(),
			query: async <T extends SQLRow = SQLRow>(sql: string, params?: SQLValue[]) => {
				if (String(sql).includes("quick_check")) {
					// SAFETY: test-only invariant — the rows returned here are valid
					// SQLRow entries (one "quick_check" column), which is all the
					// generic caller consumes; the cast is confined to this file.
					return [{ quick_check: "row 5 missing from index idx_foo" }] as unknown as T[];
				}
				return realQuery(sql, params);
			},
			withLock: <T>(fn: () => Promise<T>) => db.withLock(fn),
		};
		await expect(validateAppSchema(corruptDialect, { quickCheck: true })).rejects.toThrow(
			/integrity|quick_check|corrupt/i,
		);
	});

	it("is skipped by default (quickCheck off), so a non-ok engine report is not queried", async () => {
		const db = await cleanDb();
		const realQuery = db.query.bind(db);
		const queried: string[] = [];
		const dialect: SQLDialect = {
			exec: (sql: string) => db.exec(sql),
			run: (sql: string, params) => db.run(sql, params),
			begin: () => db.begin(),
			commit: () => db.commit(),
			rollback: () => db.rollback(),
			close: () => db.close(),
			query: (sql: string, params?: SQLValue[]) => {
				queried.push(String(sql));
				return realQuery(sql, params);
			},
			withLock: <T>(fn: () => Promise<T>) => db.withLock(fn),
		};
		await expect(validateAppSchema(dialect)).resolves.toBeUndefined();
		expect(queried.some((sql) => sql.includes("quick_check"))).toBe(false);
	});
});

describe("validateAppSchema: v3 — local_auth is part of the app schema", () => {
	/** A v3-claiming database with the full v2 table set plus extra DDL (a
	 * local_auth variant or none). Version claim is metadata-only —
	 * validateAppSchema validates the full expected schema regardless. */
	async function v3Db(extraDdl: string) {
		const db = createTestDb();
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (3);" +
				" CREATE TABLE journal_entries (" +
				" date TEXT PRIMARY KEY," +
				" content TEXT NOT NULL," +
				" created_at TEXT NOT NULL," +
				" updated_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
				extraDdl,
		);
		return db;
	}

	it("rejects a current-schema database missing the local_auth table", async () => {
		const db = await v3Db("");
		await expect(validateAppSchema(db)).rejects.toThrow(/local_auth|schema|missing|corrupt/i);
	});

	it("rejects a deviating local_auth column order or type", async () => {
		// Column-order deviation: id is no longer the first column, so the
		// PRAGMA table_info rows disagree with the spec.
		const orderDb = await v3Db(
			" CREATE TABLE local_auth (verifier TEXT NOT NULL, id INTEGER PRIMARY KEY CHECK (id = 1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
		);
		await expect(validateAppSchema(orderDb)).rejects.toThrow(/local_auth|schema|column|order/i);
		// Column-type deviation: verifier is declared BLOB instead of TEXT.
		const typeDb = await v3Db(
			" CREATE TABLE local_auth (id INTEGER PRIMARY KEY CHECK (id = 1), verifier BLOB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
		);
		await expect(validateAppSchema(typeDb)).rejects.toThrow(/local_auth|schema|column|type/i);
	});

	it("rejects a local_auth VIEW (the real table is required)", async () => {
		const db = await v3Db("");
		await db.exec(
			"CREATE VIEW local_auth AS SELECT 1 AS id, '{}' AS verifier, 't' AS created_at, 't' AS updated_at;",
		);
		await expect(validateAppSchema(db)).rejects.toThrow(/local_auth|schema|missing|corrupt/i);
	});

	it("schemaSpecForVersion(3) returns the v3 spec including local_auth", () => {
		expect(schemaSpecForVersion(3)).toEqual([
			SCHEMA_METADATA_SPEC,
			JOURNAL_ENTRIES_SPEC,
			SETTINGS_SPEC,
			LOCAL_AUTH_SPEC,
		]);
	});

	it("APP_SCHEMA_TABLES includes the local_auth spec", () => {
		expect(APP_SCHEMA_TABLES).toContain(LOCAL_AUTH_SPEC);
	});
});
