import { describe, expect, it, vi } from "vitest";
import {
	applyMigrations,
	DEFAULT_MIGRATIONS,
	latestVersion,
	type Migration,
	SCHEMA_VERSION,
} from "./migrations";
import { validateAppSchema } from "./schema-validation";
import { createTestDb } from "./test-helper";

describe("migrator: latestVersion resolves by index arithmetic (no Array.at runtime dependency)", () => {
	it("returns the last version of the list without .at() on an older Android System WebView", () => {
		// Array.prototype.at is absent from older Android System WebView/Chromium
		// versions that an API-24-compatible app may encounter; latestVersion
		// must use plain index arithmetic. Probe with the method removed so an
		// `.at(-1)` regression throws instead of passing.
		const originalAt = Array.prototype.at;
		// @ts-expect-error deliberately removes a standard method for the probe
		delete Array.prototype.at;
		try {
			expect(latestVersion(DEFAULT_MIGRATIONS)).toBe(SCHEMA_VERSION);
			expect(latestVersion([])).toBe(0);
			expect(latestVersion([{ version: 1, label: "a", apply: async () => {} }])).toBe(1);
		} finally {
			Array.prototype.at = originalAt;
		}
	});
});

describe("migrator: fresh install 0 -> latest", () => {
	it("creates schema_metadata with the current version and round-trips offline", async () => {
		const db = createTestDb();
		const version = await applyMigrations(db);
		expect(version).toBe(SCHEMA_VERSION);

		const meta = await db.query<{ version: number }>("SELECT version FROM schema_metadata LIMIT 1");
		expect(meta).toHaveLength(1);
		expect(meta[0].version).toBe(SCHEMA_VERSION);

		const tables = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		);
		expect(tables.map((t) => t.name)).toEqual([
			"journal_entries",
			"local_auth",
			"schema_metadata",
			"settings",
		]);
	});
});

describe("migrator: existing v1 upgrades to latest without data loss", () => {
	it("preserves journal data across an N -> N+1 upgrade", async () => {
		const db = createTestDb();
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (1);" +
				" CREATE TABLE journal_entries (" +
				" date TEXT PRIMARY KEY," +
				" content TEXT NOT NULL," +
				" created_at TEXT NOT NULL," +
				" updated_at TEXT NOT NULL);",
		);
		await db.run("INSERT INTO journal_entries VALUES (?, ?, ?, ?)", [
			"2026-08-10",
			"kept across upgrade",
			"2026-08-01T00:00:00.000Z",
			"2026-08-01T00:00:00.000Z",
		]);

		const version = await applyMigrations(db);
		expect(version).toBe(SCHEMA_VERSION);

		const rows = await db.query<{ content: string }>(
			"SELECT content FROM journal_entries WHERE date = ?",
			["2026-08-10"],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].content).toBe("kept across upgrade");
	});
});

describe("migrator: forced failure rolls back and fails closed", () => {
	it("rolls back schema/data/version and rejects init when a migration fails", async () => {
		const db = createTestDb();
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (1);" +
				" CREATE TABLE journal_entries (" +
				" date TEXT PRIMARY KEY," +
				" content TEXT NOT NULL," +
				" created_at TEXT NOT NULL," +
				" updated_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
		);
		await db.run("INSERT INTO journal_entries VALUES (?, ?, ?, ?)", [
			"2026-08-10",
			"preserved",
			"2026-08-01T00:00:00.000Z",
			"2026-08-01T00:00:00.000Z",
		]);
		// Migration 2's plain CREATE TABLE settings collides with the
		// pre-existing table of a different shape -> the step must fail and
		// roll back atomically.
		await expect(applyMigrations(db)).rejects.toThrow();

		// Prior version and data preserved; nothing was committed.
		const meta = await db.query<{ version: number }>("SELECT version FROM schema_metadata");
		expect(meta[0].version).toBe(1);
		const j = await db.query<{ content: string }>(
			"SELECT content FROM journal_entries WHERE date = ?",
			["2026-08-10"],
		);
		expect(j).toHaveLength(1);
		expect(j[0].content).toBe("preserved");
		const s = await db.query<{ key: string }>("SELECT key FROM settings");
		expect(s).toHaveLength(0); // v2 wrote nothing
	});
});

describe("migrator: idempotence / re-run applies nothing twice", () => {
	it("re-running startup applies no extra steps and preserves data", async () => {
		const db = createTestDb();
		await applyMigrations(db);
		await db.run("INSERT INTO journal_entries VALUES (?, ?, ?, ?)", [
			"2026-08-11",
			"hello",
			"2026-08-01T00:00:00.000Z",
			"2026-08-01T00:00:00.000Z",
		]);

		const version2 = await applyMigrations(db);
		expect(version2).toBe(SCHEMA_VERSION);
		const rows = await db.query<{ content: string }>(
			"SELECT content FROM journal_entries WHERE date = ?",
			["2026-08-11"],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].content).toBe("hello");
	});
});

describe("migrator: fresh vs migrated schema equivalence", () => {
	it("produces the same normalized sqlite_master on fresh and upgraded paths", async () => {
		const fresh = createTestDb();
		await applyMigrations(fresh);
		const freshSql = await fresh.query<{ sql: string | null }>(
			"SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
		);
		const migrated = createTestDb();
		await migrated.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (1);" +
				" CREATE TABLE journal_entries (" +
				" date TEXT PRIMARY KEY," +
				" content TEXT NOT NULL," +
				" created_at TEXT NOT NULL," +
				" updated_at TEXT NOT NULL);",
		);
		await applyMigrations(migrated);
		const migratedSql = await migrated.query<{ sql: string | null }>(
			"SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
		);

		// Structural equivalence: the fresh install and the upgraded path must
		// produce identical schema definitions. Whitespace is normalized so the
		// two byte-equivalent DDLs written in different styles count as equal.
		const normalize = (rows: Array<{ sql: string | null }>) =>
			rows.map((r) => ({ sql: r.sql === null ? null : r.sql.replace(/\s+/g, "") }));
		expect(normalize(migratedSql)).toEqual(normalize(freshSql));
	});
});

describe("migrator: failure wrappers preserve the exact error as cause", () => {
	it("keeps the original apply error object (and its own cause) through the migration wrapper", async () => {
		const db = createTestDb();
		const deepRoot = new Error("deep root cause");
		const original = new Error("boom: apply failed", { cause: deepRoot });
		const failing: Migration = {
			version: 1,
			label: "fails",
			apply: async () => {
				throw original;
			},
		};

		const rejection = await applyMigrations(db, [failing]).catch((e: unknown) => e);
		expect(rejection).toBeInstanceOf(Error);
		// User-safe message is preserved (version + label + rolled-back wording).
		expect((rejection as Error).message).toMatch(
			/Migration 1 \("fails"\) failed and was rolled back/,
		);
		// The exact underlying error survives as the wrapper's cause (not a
		// stringified copy), and ITS cause chain is preserved too (nested).
		expect((rejection as { cause?: unknown }).cause).toBe(original);
		expect((original as { cause?: unknown }).cause).toBe(deepRoot);
	});

	it("preserves the version-bump failure error as cause", async () => {
		const db = createTestDb();
		const bumpBreaker: Migration = {
			version: 1,
			label: "bump-breaker",
			apply: async () => {
				// Remove the metadata row so the version-bump UPDATE touches 0
				// rows — the migration fails AFTER apply, inside the same
				// transaction wrapper.
				await db.exec("DELETE FROM schema_metadata");
			},
		};
		const rejection = await applyMigrations(db, [bumpBreaker]).catch((e: unknown) => e);
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toMatch(
			/Migration 1 \("bump-breaker"\) failed and was rolled back/,
		);
		expect((rejection as { cause?: Error }).cause?.message).toMatch(/exactly 1/);
	});
});

describe("migrator: preflight — unversioned DB containing managed app tables rejects before any write", () => {
	it.each(["journal_entries", "settings"] as const)(
		"rejects a %s table without creating schema_metadata or touching prior state",
		async (table) => {
			const db = createTestDb();
			// A leftover app DB that lost its schema_metadata: the managed app
			// table exists (with a pre-arm marker row) but schema_metadata does
			// not. The migrator must reject BEFORE any write/metadata creation.
			if (table === "journal_entries") {
				await db.exec(
					"CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
				);
				await db.run("INSERT INTO journal_entries VALUES (?,?,?,?)", [
					"2026-08-10",
					"must survive",
					"2026-08-01T00:00:00.000Z",
					"2026-08-01T00:00:00.000Z",
				]);
			} else {
				await db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
				await db.run("INSERT INTO settings VALUES (?,?)", ["timezone", "UTC"]);
			}

			// Rejection BEFORE any write: schema_metadata must not be created.
			await expect(applyMigrations(db)).rejects.toThrow();
			const meta = await db.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name = 'schema_metadata'",
			);
			expect(meta).toHaveLength(0); // no metadata write happened

			// Prior state untouched: the managed table and its data are intact,
			// and no other app tables were created (no partial migration).
			const names = await db.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			);
			expect(names.map((r) => r.name)).toEqual([table]);
			if (table === "journal_entries") {
				const rows = await db.query<{ content: string }>(
					"SELECT content FROM journal_entries WHERE date = ?",
					["2026-08-10"],
				);
				expect(rows).toHaveLength(1);
				expect(rows[0].content).toBe("must survive");
			} else {
				const rows = await db.query<{ value: string }>("SELECT value FROM settings WHERE key = ?", [
					"timezone",
				]);
				expect(rows).toHaveLength(1);
				expect(rows[0].value).toBe("UTC");
			}
		},
	);

	it("rejects when BOTH managed app tables exist and the DB is unversioned", async () => {
		const db = createTestDb();
		await db.exec(
			"CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
				" CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
				" INSERT INTO journal_entries VALUES ('2026-08-10','kept','2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z');" +
				" INSERT INTO settings VALUES ('appearance','system');",
		);
		await expect(applyMigrations(db)).rejects.toThrow(/unversioned|metadata|version|managed/i);
		const meta = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name = 'schema_metadata'",
		);
		expect(meta).toHaveLength(0); // nothing was written
	});

	it("does not mistake plugin/system or unrelated tables for app-managed tables", async () => {
		const db = createTestDb();
		// A plugin/other table (e.g. capacitor-sqlite or a foreign table) must
		// NOT trip the managed-app-table preflight: a truly fresh DB that
		// happens to carry an unrelated table is still a clean install.
		await db.exec("CREATE TABLE plugin_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
		await db.run("INSERT INTO plugin_state VALUES (?,?)", ["k", "v"]);

		const version = await applyMigrations(db);
		expect(version).toBe(SCHEMA_VERSION);
		const tables = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		);
		expect(tables.map((t) => t.name)).toEqual([
			"journal_entries",
			"local_auth",
			"plugin_state",
			"schema_metadata",
			"settings",
		]);
	});

	it("a fresh truly-empty install still works (no false preflight rejection)", async () => {
		const db = createTestDb();
		const version = await applyMigrations(db);
		expect(version).toBe(SCHEMA_VERSION);
	});
});

describe("migrator: corrupt schema_metadata fails closed without writing", () => {
	const noUserTables = async (db: Awaited<ReturnType<typeof createTestDb>>) => {
		const created = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('journal_entries','settings')",
		);
		expect(created).toHaveLength(0);
	};

	it("rejects zero rows (metadata exists but is empty) with no writes", async () => {
		const db = createTestDb();
		await db.exec("CREATE TABLE schema_metadata (version INTEGER NOT NULL);");
		await expect(applyMigrations(db)).rejects.toThrow(/schema_metadata|corrupt|version/i);
		await noUserTables(db);
	});

	it("rejects multiple rows (duplicate metadata) with no writes", async () => {
		const db = createTestDb();
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (0);" +
				" INSERT INTO schema_metadata (version) VALUES (0);",
		);
		await expect(applyMigrations(db)).rejects.toThrow(/schema_metadata|corrupt|version/i);
		await noUserTables(db);
	});

	it.each([
		["non-integer text", "abc"],
		["decimal", 7.5],
		["negative", -1],
	] as const)("rejects %s version with no writes", async (_label: string, value: unknown) => {
		const db = createTestDb();
		await db.exec("CREATE TABLE schema_metadata (version INTEGER NOT NULL);");
		await db.run("INSERT INTO schema_metadata (version) VALUES (?)", [value as never]);
		await expect(applyMigrations(db)).rejects.toThrow(/schema_metadata|corrupt|version/i);
		await noUserTables(db);
	});

	it("bumps each version with an UPDATE that changes exactly one row", async () => {
		const db = createTestDb();
		// Wrap run so we can record how many rows every schema_metadata
		// UPDATE reports changing. Each migration + its version bump share a
		// single transaction over exactly one metadata row.
		const seen: number[] = [];
		const run = db.run.bind(db);
		db.run = async (sql, params) => {
			const result = await run(sql, params);
			if (/UPDATE schema_metadata/i.test(String(sql))) seen.push(result.changes);
			return result;
		};
		await applyMigrations(db);
		expect(seen).toEqual([1, 1, 1]);
	});
});

describe("migrator: preflight — unversioned DB whose managed-name object is a VIEW rejects before any write", () => {
	it.each(["journal_entries", "settings"] as const)(
		"rejects an unversioned DB holding a %s VIEW (same-named sqlite_master object); view remains, metadata absent",
		async (viewName) => {
			const db = createTestDb();
			// A non-table object (VIEW) named after a managed app table must be
			// caught by the unversioned preflight — it is an sqlite_master object
			// that a future CREATE TABLE would collide with, so creating
			// schema_metadata would still mutate prior state before failing.
			// Allowlist of the only names used here (test-only invariant).
			const allowed = new Set(["journal_entries", "settings"]);
			if (!allowed.has(viewName)) {
				throw new Error(`unexpected managed view name in test: ${viewName}`);
			}
			await db.exec(`CREATE VIEW ${viewName} AS SELECT '2026-08-10' AS date;`);

			// Rejection BEFORE any write: schema_metadata must not be created.
			await expect(applyMigrations(db)).rejects.toThrow(/unversioned|metadata|managed/i);
			const meta = await db.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name = 'schema_metadata'",
			);
			expect(meta).toHaveLength(0); // no metadata write happened

			// The view itself is untouched.
			const views = await db.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='view' AND name = ?",
				[viewName],
			);
			expect(views).toHaveLength(1);
		},
	);

	it("rejects an unversioned DB holding a schema_metadata VIEW before any begin/write; view remains, no app tables created", async () => {
		const db = createTestDb();
		// schema_metadata exists only as a VIEW (no version TABLE), so the
		// unversioned detection finds no metadata table and the migrator would
		// otherwise treat this as a clean install and attempt CREATE TABLE
		// schema_metadata over the same-named prior object. The preflight must
		// treat schema_metadata as a managed name too and reject BEFORE any
		// transaction/write, leaving the prior state byte-identical.
		await db.exec("CREATE VIEW schema_metadata AS SELECT 1 AS version;");
		const beginSpy = vi.spyOn(db, "begin");

		await expect(applyMigrations(db)).rejects.toThrow(/unversioned|metadata|managed/i);
		expect(beginSpy).not.toHaveBeenCalled(); // rejected before any transaction/write

		// No schema_metadata/journal_entries/settings TABLES were created.
		const tables = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('schema_metadata','journal_entries','settings')",
		);
		expect(tables).toHaveLength(0);

		// The view itself is untouched.
		const views = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='view' AND name = 'schema_metadata'",
		);
		expect(views).toHaveLength(1);
	});

	it("does not mistake an unrelated VIEW for a managed-name object (fresh install still migrates)", async () => {
		const db = createTestDb();
		await db.exec("CREATE VIEW unrelated_view AS SELECT 1 AS x;");
		const version = await applyMigrations(db);
		expect(version).toBe(SCHEMA_VERSION);
		const views = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='view' AND name = 'unrelated_view'",
		);
		expect(views).toHaveLength(1);
	});
});

describe("migrator: version-aware existing-schema validation before pending production migrations", () => {
	it("rejects a v0 DB with malformed schema_metadata shape BEFORE migration1; version/schema unchanged", async () => {
		const db = createTestDb();
		// schema_metadata carries an unexpected extra column but still holds a
		// valid version=0, so readSchemaVersion passes; the malformed shape must
		// be rejected BEFORE migration1 runs.
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL, junk TEXT);" +
				" INSERT INTO schema_metadata (version, junk) VALUES (0, 'j');",
		);
		const beginSpy = vi.spyOn(db, "begin");

		await expect(applyMigrations(db)).rejects.toThrow(/schema|corrupt|deviates|schema_metadata/i);
		expect(beginSpy).not.toHaveBeenCalled(); // rejected before any transaction/write
		const ver = await db.query<{ version: number }>("SELECT version FROM schema_metadata");
		expect(ver[0].version).toBe(0);
		const journal = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='journal_entries'",
		);
		expect(journal).toHaveLength(0); // migration1 never ran
	});

	it("rejects a v1 DB with malformed schema_metadata shape BEFORE migration2; version/version/data unchanged", async () => {
		const db = createTestDb();
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL, extra TEXT);" +
				" INSERT INTO schema_metadata (version, extra) VALUES (1, 'x');" +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
		);
		const beginSpy = vi.spyOn(db, "begin");

		await expect(applyMigrations(db)).rejects.toThrow(/schema|corrupt|deviates|schema_metadata/i);
		expect(beginSpy).not.toHaveBeenCalled(); // rejected before any transaction/write
		const ver = await db.query<{ version: number }>("SELECT version FROM schema_metadata");
		expect(ver[0].version).toBe(1); // version untouched
		const settings = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='settings'",
		);
		expect(settings).toHaveLength(0); // migration2 never ran
	});

	it("rejects a v1 DB with malformed journal_entries shape BEFORE migration2; data/version unchanged", async () => {
		const db = createTestDb();
		// v1 journal_entries missing its content/created_at/updated_at columns;
		// the DB claims v1 so migration1 is skipped, and migration2 must NOT
		// commit settings over a malformed prior schema.
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (1);" +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY);",
		);
		await db.run("INSERT INTO journal_entries (date) VALUES (?)", ["2026-08-10"]);
		const beginSpy = vi.spyOn(db, "begin");

		await expect(applyMigrations(db)).rejects.toThrow(/schema|corrupt|deviates|journal_entries/i);
		expect(beginSpy).not.toHaveBeenCalled(); // rejected before any transaction/write
		const ver = await db.query<{ version: number }>("SELECT version FROM schema_metadata");
		expect(ver[0].version).toBe(1); // version untouched
		const settings = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='settings'",
		);
		expect(settings).toHaveLength(0); // migration2 never ran
		const rows = await db.query<{ date: string }>(
			"SELECT date FROM journal_entries WHERE date = ?",
			["2026-08-10"],
		);
		expect(rows).toHaveLength(1); // prior data preserved
	});
});

/* ------------------------------------------------------------------ */
/* v3: local_auth singleton migration (task 2)                         */
/* ------------------------------------------------------------------ */

/**
 * Test-local helper (Ruling C-R2, plan-call refinement): return the stored
 * schema version straight from `schema_metadata`. The task brief calls a
 * `schemaVersion(db)` that no production export provides, so the test file
 * owns it — it reads the same single version row the migrator maintains.
 */
async function schemaVersion(db: Awaited<ReturnType<typeof createTestDb>>): Promise<number> {
	const rows = await db.query<{ version: number }>("SELECT version FROM schema_metadata");
	return rows[0]?.version ?? -1;
}

/**
 * Test-local DDL normalizer (Ruling C-R2): collapse whitespace and strip
 * identifier quotes so byte-different-but-equivalent CREATE statements
 * compare equal. `PRAGMA table_info` cannot observe CHECK/UNIQUE table
 * constraints, so schema parity is pinned on the normalized sqlite_master
 * DDL text instead of the semantic column comparison.
 */
function normalizeDdl(rows: Array<{ sql: string | null }>): string {
	return rows.map((row) => (row.sql ?? "").replace(/"|`/g, "").replace(/\s+/g, "")).join("\n");
}

describe("migrator: v3 — local_auth singleton migration", () => {
	const LOCAL_AUTH_DDL =
		"CREATE TABLE local_auth (id INTEGER PRIMARY KEY CHECK (id = 1), verifier TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);";

	it("fresh install migrates 0 -> 3 and creates the local_auth singleton table", async () => {
		const db = createTestDb();
		await applyMigrations(db);
		expect(await schemaVersion(db)).toBe(3);
		const meta = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_auth'",
		);
		expect(meta).toHaveLength(1);
	});

	it("v2 -> v3 upgrade preserves journal and settings rows and adds local_auth", async () => {
		const db = createTestDb();
		await applyMigrations(db, DEFAULT_MIGRATIONS.slice(0, 2)); // v2 world
		await db.run(
			"INSERT INTO journal_entries (date, content, created_at, updated_at) VALUES ('2026-08-10', 'x', 't', 't')",
		);
		await db.run("INSERT INTO settings (key, value) VALUES ('appearance', '\"dark\"')");
		await applyMigrations(db); // upgrade to v3
		expect((await db.query("SELECT COUNT(*) AS c FROM journal_entries"))[0].c).toBe(1);
		expect((await db.query("SELECT COUNT(*) AS c FROM settings"))[0].c).toBe(1);
		expect(await schemaVersion(db)).toBe(3);
	});

	it("fresh vs upgraded v3 schemas are structurally identical (parity)", async () => {
		const fresh = createTestDb();
		await applyMigrations(fresh);
		const upgraded = createTestDb();
		await applyMigrations(upgraded, DEFAULT_MIGRATIONS.slice(0, 2));
		await applyMigrations(upgraded);
		await validateAppSchema(fresh);
		await validateAppSchema(upgraded);
		const sql = (d: Awaited<ReturnType<typeof createTestDb>>) =>
			d.query<{ sql: string | null }>("SELECT sql FROM sqlite_master WHERE name = 'local_auth'");
		expect(normalizeDdl(await sql(fresh))).toBe(normalizeDdl(await sql(upgraded)));
	});

	it("the singleton CHECK rejects a second row (id = 2)", async () => {
		const db = createTestDb();
		await applyMigrations(db);
		await db.run(
			"INSERT INTO local_auth (id, verifier, created_at, updated_at) VALUES (1, '{}', 't', 't')",
		);
		await expect(
			db.run(
				"INSERT INTO local_auth (id, verifier, created_at, updated_at) VALUES (2, '{}', 't', 't')",
			),
		).rejects.toThrow();
	});

	it("an unversioned DB with a local_auth object is rejected by the reserved-name preflight before any write", async () => {
		const db = createTestDb();
		// A leftover app DB that lost its schema_metadata version table: the
		// local_auth table exists (with a pre-arm marker row) but the DB is
		// unversioned. The migrator must reject BEFORE any transaction/write
		// or metadata creation, leaving the prior state byte-identical.
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (3);" +
				` ${LOCAL_AUTH_DDL}` +
				" INSERT INTO local_auth (id, verifier, created_at, updated_at) VALUES (1, '{}', 't', 't');" +
				" DROP TABLE schema_metadata;",
		);
		const beginSpy = vi.spyOn(db, "begin");

		await expect(applyMigrations(db)).rejects.toThrow(/unversioned|metadata|managed|local_auth/i);
		expect(beginSpy).not.toHaveBeenCalled(); // rejected before any transaction/write

		// Nothing was written: schema_metadata was not (re)created, no other
		// app tables appeared, and the local_auth row is untouched.
		const meta = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name = 'schema_metadata'",
		);
		expect(meta).toHaveLength(0);
		const la = await db.query<{ verifier: string }>("SELECT verifier FROM local_auth WHERE id = 1");
		expect(la).toHaveLength(1);
		expect(la[0].verifier).toBe("{}");
	});

	it("a malformed prior v2 schema still rejects before the v3 migration begins", async () => {
		const db = createTestDb();
		// Stored version is 2 (so migration1/2 are skipped) but the settings
		// table is missing: migration3's expectedPriorSchema check must reject
		// BEFORE the v3 step runs, with zero writes.
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (2);" +
				" CREATE TABLE journal_entries (date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
		);
		await db.run("INSERT INTO journal_entries VALUES (?, ?, ?, ?)", [
			"2026-08-10",
			"kept",
			"2026-08-01T00:00:00.000Z",
			"2026-08-01T00:00:00.000Z",
		]);
		const beginSpy = vi.spyOn(db, "begin");

		await expect(applyMigrations(db)).rejects.toThrow(/schema|corrupt|deviates|settings/i);
		expect(beginSpy).not.toHaveBeenCalled(); // rejected before any transaction/write
		const ver = await db.query<{ version: number }>("SELECT version FROM schema_metadata");
		expect(ver[0].version).toBe(2); // version untouched
		const settings = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='settings'",
		);
		expect(settings).toHaveLength(0); // migration2 skipped (v2), migration3 never ran
		const la = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='local_auth'",
		);
		expect(la).toHaveLength(0); // no partial v3 state
		const rows = await db.query<{ content: string }>(
			"SELECT content FROM journal_entries WHERE date = ?",
			["2026-08-10"],
		);
		expect(rows).toHaveLength(1); // prior data preserved
	});
});

describe("migrator: future / gap / corrupt versions fail closed", () => {
	it("rejects a stored version newer than supported without writing", async () => {
		const db = createTestDb();
		await db.exec(`
			CREATE TABLE schema_metadata (version INTEGER NOT NULL);
			INSERT INTO schema_metadata (version) VALUES (999);
		`);
		await expect(applyMigrations(db)).rejects.toThrow();
		const meta = await db.query<{ version: number }>("SELECT version FROM schema_metadata");
		expect(meta[0].version).toBe(999);
	});

	it("rejects a non-contiguous migration list (gap) before running anything", async () => {
		const db = createTestDb();
		await db.exec(
			"CREATE TABLE schema_metadata (version INTEGER NOT NULL);" +
				" INSERT INTO schema_metadata (version) VALUES (1);" +
				" CREATE TABLE journal_entries (" +
				" date TEXT PRIMARY KEY," +
				" content TEXT NOT NULL," +
				" created_at TEXT NOT NULL," +
				" updated_at TEXT NOT NULL);",
		);
		const gapped: Migration[] = [
			{
				version: 3,
				label: "jump-to-3",
				apply: async () => {
					await db.exec("CREATE TABLE nope (id INTEGER)");
				},
			},
		];
		await expect(applyMigrations(db, gapped)).rejects.toThrow(/contiguous|gap/i);
		// nothing from the bad list ran
		const nope = await db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE name = 'nope'",
		);
		expect(nope).toHaveLength(0);
	});

	it("rejects duplicate versions in the migration list", async () => {
		const db = createTestDb();
		const dupes: Migration[] = [
			{ version: 1, label: "a", apply: async () => {} },
			{ version: 1, label: "b", apply: async () => {} },
		];
		await expect(applyMigrations(db, dupes)).rejects.toThrow(/contiguous|duplicate|gap/i);
	});
});
