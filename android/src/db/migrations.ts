/**
 * Own version tracking via `schema_metadata`, independent of any
 * plugin-managed `PRAGMA user_version`.
 *
 * Migrations are ordered, transactional, forward-only. Each step runs inside
 * an explicit transaction together with its version bump so the two commit
 * atomically; a failed SQL statement rolls everything back and preserves the
 * prior version and data. Fail-closed rules:
 *
 * - stored version newer than the highest supported migration -> reject
 * - migration list non-contiguous or duplicated -> reject before running
 * - any SQL failure -> roll back and reject
 *
 * `applyMigrations(dialect, migrations = DEFAULT_MIGRATIONS)` takes an
 * optional list so tests can exercise gap/duplicate detection directly.
 */

import {
	JOURNAL_ENTRIES_SPEC,
	SCHEMA_METADATA_SPEC,
	SETTINGS_SPEC,
	type TableSpec,
	validateSchemaSpec,
} from "@/db/schema-validation";
import type { SQLDialect } from "@/db/types";

export interface Migration {
	/** Target schema version this migration produces (1-based, contiguous). */
	version: number;
	/** Short human label (reported in errors). */
	label: string;
	/**
	 * Migration-owned existing-schema contract: the {@link TableSpec} list the
	 * PRIOR version's schema must already satisfy before this migration runs.
	 * Reuses the shared per-version specs from schema-validation so the
	 * pre-migration check and the post-migration full validation cannot drift.
	 * Optional and explicit — only DEFAULT_MIGRATIONS carry it, so custom
	 * migration-list tests inject their own steps without tripping app-schema
	 * validation.
	 */
	expectedPriorSchema?: readonly TableSpec[];
	/** Apply the step's DDL/DML. Runs inside an explicit transaction. */
	apply(dialect: SQLDialect): Promise<void>;
}

/** Latest supported schema version. */
export function latestVersion(migrations: readonly Migration[]): number {
	// Index arithmetic deliberately: Array.prototype.at is absent from older
	// Android System WebView/Chromium versions that an API-24-compatible app
	// may encounter; plain index arithmetic avoids that runtime dependency.
	return migrations.length > 0 ? migrations[migrations.length - 1].version : 0;
}

/**
 * Validate the migration list: versions must be exactly 1..N with no gaps and
 * no duplicates. Rejects a corrupted/edited list before anything runs.
 */
function assertContiguous(migrations: readonly Migration[]): void {
	for (let i = 0; i < migrations.length; i++) {
		const expected = i + 1;
		if (migrations[i].version !== expected) {
			throw new Error(
				`Non-contiguous migrations: expected version ${expected}, found ${migrations[i].version} ("${migrations[i].label}")`,
			);
		}
	}
}

/**
 * Read and validate `schema_metadata`: it must hold exactly one version row
 * with a non-negative integer version. Corrupt metadata (zero rows, multiple
 * rows, or a non-integer/non-number/negative version) rejected before any
 * migration runs — SQLite's dynamic typing means a TEXT value can sit in an
 * INTEGER column, so the shape is checked here, not trusted to the schema.
 */
async function readSchemaVersion(dialect: SQLDialect): Promise<number> {
	const meta = await dialect.query<{ version: unknown }>("SELECT version FROM schema_metadata");
	if (meta.length === 0) {
		throw new Error("Corrupt schema_metadata: table exists but holds no version row.");
	}
	if (meta.length > 1) {
		throw new Error(
			`Corrupt schema_metadata: expected exactly one version row, found ${meta.length}.`,
		);
	}
	const version = meta[0].version;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
		throw new Error(
			`Corrupt schema_metadata: version must be a non-negative integer, found ${JSON.stringify(version)}.`,
		);
	}
	return version;
}

/**
 * The exact app-reserved object names that the unversioned-DB preflight
 * matches against ANY sqlite_master object type: every name the app schema
 * owns — the `schema_metadata` version table plus the `journal_entries`,
 * `settings`, and `local_auth` tables {@link DEFAULT_MIGRATIONS} create.
 * `schema_metadata` itself is included because this preflight only runs once
 * its absence as a TABLE is confirmed, so a hit there is a non-table object
 * (e.g. a view) squatting on the version table's reserved name — prior state
 * to refuse, not a clean install.
 */
const APP_MANAGED_OBJECT_NAMES = [
	"schema_metadata",
	"journal_entries",
	"settings",
	"local_auth",
] as const;

/**
 * Apply pending migrations transactionally. Returns the resulting schema
 * version. Rejects (throwing) on any failure without leaving partial state.
 *
 * Preflight: if the database has no `schema_metadata` table but any
 * `sqlite_master` object owns an app-reserved name (including a non-table
 * object named `schema_metadata`), reject BEFORE any transaction, write, or
 * metadata creation. Otherwise the migrator could mutate prior state before
 * colliding with that object. Plugin/system/internal objects with unrelated
 * names remain allowed, so a truly fresh install still migrates normally.
 */
export async function applyMigrations(
	dialect: SQLDialect,
	migrations: readonly Migration[] = DEFAULT_MIGRATIONS,
): Promise<number> {
	assertContiguous(migrations);
	const max = latestVersion(migrations);

	// Fresh install: create the metadata table first, atomically with nothing
	// else (there is no prior state to preserve).
	const tables = await dialect.query<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_metadata'",
	);
	if (tables.length === 0) {
		// Preflight an unversioned DB: if any app-reserved-name object already
		// exists in sqlite_master (a prior app store that lost its
		// schema_metadata version table, or prior/foreign state squatting on an
		// app-reserved name such as a schema_metadata VIEW), reject BEFORE any
		// write so we never mutate that state. We match ANY sqlite_master
		// object type (table, view, …) — a reserved-name VIEW (or any
		// same-named object) is just as real a collision for a later CREATE
		// TABLE and must also trip the preflight instead of bypassing it via
		// type='table'. schema_metadata is in the matched set: with its
		// absence-as-a-TABLE already confirmed above, an unversioned DB
		// holding any other same-named object would otherwise look like a
		// clean install and be written over. Only exact app-reserved names are
		// considered — plugin/system/internal objects and unrelated
		// tables/views are not app-managed and must not turn a clean install
		// into a rejection.
		const placeholders = APP_MANAGED_OBJECT_NAMES.map(() => "?").join(", ");
		const managed = await dialect.query<{ name: string }>(
			`SELECT name FROM sqlite_master WHERE name IN (${placeholders})`,
			[...APP_MANAGED_OBJECT_NAMES],
		);
		if (managed.length > 0) {
			const found = managed
				.map((r) => r.name)
				.sort()
				.join(", ");
			throw new Error(
				`Cannot open database: managed app object(s) ${found} exist but the schema is unversioned (no schema_metadata version table is present). Refusing to modify prior state; nothing was written or reset.`,
			);
		}
		await dialect.begin();
		try {
			await dialect.exec("CREATE TABLE schema_metadata (version INTEGER NOT NULL);");
			await dialect.exec("INSERT INTO schema_metadata (version) VALUES (0);");
			await dialect.commit();
		} catch (e) {
			// Rollback failure must not mask the original error.
			try {
				await dialect.rollback();
			} catch {
				// keep the original error
			}
			throw e;
		}
	}

	const current = await readSchemaVersion(dialect);
	if (current > max) {
		throw new Error(
			`Database schema version ${current} is newer than this app supports (${max}); refusing to open.`,
		);
	}

	let version = current;
	for (const migration of migrations) {
		if (migration.version <= version) continue;
		if (migration.version !== version + 1) {
			throw new Error(
				`Schema gap: at version ${version}, expected migration ${version + 1} but found ${migration.version} ("${migration.label}").`,
			);
		}
		// Version-aware existing-schema validation BEFORE the pending production
		// migration runs (and BEFORE any begin/write): the stored prior-version
		// schema must be structurally intact before we build the next version on
		// top of it. Only migrations that declare `expectedPriorSchema` (the
		// DEFAULT_MIGRATIONS production set) validate here; custom lists without
		// a schema contract skip this, so gap/duplicate/forced-failure tests stay
		// about the migrator, not app-schema shape. A malformed prior schema
		// rejects with zero writes, leaving v0/v1/version/data unchanged.
		if (migration.expectedPriorSchema) {
			await validateSchemaSpec(dialect, migration.expectedPriorSchema);
		}
		await dialect.begin();
		try {
			await migration.apply(dialect);
			const bump = await dialect.run("UPDATE schema_metadata SET version = ?", [migration.version]);
			// The version bump must land on exactly the one metadata row.
			if (bump.changes !== 1) {
				throw new Error(
					`Schema metadata update touched ${bump.changes} rows — expected exactly 1; refusing to continue.`,
				);
			}
			await dialect.commit();
			version = migration.version;
		} catch (e) {
			// Rollback failure must not mask the original migration error.
			try {
				await dialect.rollback();
			} catch {
				// keep the original error
			}
			// Keep the user-safe message, but preserve the EXACT underlying
			// error object as cause — the stringified text alone loses identity.
			throw new Error(
				`Migration ${migration.version} ("${migration.label}") failed and was rolled back: ${String(e)}`,
				{ cause: e },
			);
		}
	}
	return version;
}

/* ------------------------------------------------------------------ */
/* Schema                                                                 */
/* ------------------------------------------------------------------ */

/** v1: journal entries, one row per calendar date. */
const migration1: Migration = {
	version: 1,
	label: "journal_entries",
	// v0's schema is just the metadata table; validate it before building v1.
	expectedPriorSchema: [SCHEMA_METADATA_SPEC],
	async apply(dialect) {
		// Keep this DDL byte-identical to the hand-built v1 used in the
		// migrate/equivalence tests — sqlite_master stores the CREATE text
		// verbatim, so stray whitespace would break fresh-vs-migrated equality.
		await dialect.exec(
			"CREATE TABLE journal_entries ( date TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
		);
	},
};

/** v2: on-device Android settings (single-owner, no web-only fields). */
const migration2: Migration = {
	version: 2,
	label: "settings",
	// v1's schema is metadata + journal_entries; validate before building v2.
	expectedPriorSchema: [SCHEMA_METADATA_SPEC, JOURNAL_ENTRIES_SPEC],
	async apply(dialect) {
		await dialect.exec(
			"CREATE TABLE settings (" + "key TEXT PRIMARY KEY," + "value TEXT NOT NULL);",
		);
	},
};

/**
 * v3: on-device auth verifier — a single row (id CHECK (id = 1)). The DDL
 * string below is the canonical contract text: `PRAGMA table_info` cannot see
 * table CHECK constraints, so the singleton is enforced by this exact CREATE
 * TABLE (byte-identical on the fresh 0->3 and upgraded 2->3 paths) and pinned
 * by the parity test's normalizeDdl comparison of sqlite_master DDL.
 */
const migration3: Migration = {
	version: 3,
	label: "local_auth",
	// v2's schema is metadata + journal_entries + settings; validate before
	// building v3 so a malformed prior schema rejects BEFORE this step runs.
	expectedPriorSchema: [SCHEMA_METADATA_SPEC, JOURNAL_ENTRIES_SPEC, SETTINGS_SPEC],
	async apply(dialect) {
		await dialect.exec(
			"CREATE TABLE local_auth (id INTEGER PRIMARY KEY CHECK (id = 1), verifier TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
		);
	},
};

/** Ordered forward-only migration set: version 1, 2, then 3. */
export const DEFAULT_MIGRATIONS: readonly Migration[] = [migration1, migration2, migration3];

/** Latest supported schema version for production. */
export const SCHEMA_VERSION = latestVersion(DEFAULT_MIGRATIONS);
