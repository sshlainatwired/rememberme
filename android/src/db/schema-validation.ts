/**
 * Full app-schema validation (Phase 3 Terra rerun).
 *
 * Runs AFTER migrations and BEFORE any service is exposed (see
 * `bootstrap.ts`): a database whose recorded version is current must still
 * carry the exact expected table structures, otherwise routes could serve
 * from a store whose tables were dropped/altered behind the version number's
 * back (or a hand-crafted DB simply claiming a higher version). Corruption
 * rejects fail-closed — the caller closes the connection with zero writes.
 *
 * Checks are semantic `PRAGMA table_info` comparisons (portable across the
 * node:sqlite test adapter and the native Capacitor adapter): each expected
 * table must exist as a real table and carry exactly its expected columns,
 * in order, with the expected declared type / NOT NULL / PRIMARY KEY. Only
 * the expected app tables are checked — SQLite internal tables/indexes
 * (sqlite_* / sqlite_autoindex_*) and any future unrelated tables are not
 * rejected.
 *
 * An optional `PRAGMA quick_check` integrity scan is supported but OFF by
 * default: table_info proves the structural contract deterministically on
 * both adapters, whereas quick_check's native-plugin portability has not yet
 * been verified on a device, so it is available as an opt-in rather than a
 * silent device fail-closed risk.
 */

import type { SQLDialect, SQLRow } from "@/db/types";

export interface ColumnSpec {
	name: string;
	/** Declared type exactly as SQLite reports it (e.g. "TEXT", "INTEGER"). */
	type: string;
	notnull: boolean;
	pk: boolean;
}

export interface TableSpec {
	name: string;
	columns: readonly ColumnSpec[];
}

/** schema_metadata — owns the version, always present at every version >= 0. */
export const SCHEMA_METADATA_SPEC: TableSpec = {
	name: "schema_metadata",
	columns: [{ name: "version", type: "INTEGER", notnull: true, pk: false }],
};

/** v1 journal_entries — one row per calendar date. */
export const JOURNAL_ENTRIES_SPEC: TableSpec = {
	name: "journal_entries",
	columns: [
		{ name: "date", type: "TEXT", notnull: false, pk: true },
		{ name: "content", type: "TEXT", notnull: true, pk: false },
		{ name: "created_at", type: "TEXT", notnull: true, pk: false },
		{ name: "updated_at", type: "TEXT", notnull: true, pk: false },
	],
};

/** v2 settings — key/value pairs, JSON-encoded values. */
export const SETTINGS_SPEC: TableSpec = {
	name: "settings",
	columns: [
		{ name: "key", type: "TEXT", notnull: false, pk: true },
		{ name: "value", type: "TEXT", notnull: true, pk: false },
	],
};

/**
 * v3 local_auth — singleton on-device auth verifier (id CHECK = 1). The
 * singleton constraint lives in the CREATE TABLE DDL (`CHECK (id = 1)`), which
 * `PRAGMA table_info` cannot observe; the migration DDL text is therefore part
 * of the contract and is pinned by the migrations parity test via normalized
 * sqlite_master DDL. `id` is an INTEGER PRIMARY KEY (rowid alias), which
 * SQLite reports via table_info as pk=1 / notnull=0.
 */
export const LOCAL_AUTH_SPEC: TableSpec = {
	name: "local_auth",
	columns: [
		{ name: "id", type: "INTEGER", notnull: false, pk: true },
		{ name: "verifier", type: "TEXT", notnull: true, pk: false },
		{ name: "created_at", type: "TEXT", notnull: true, pk: false },
		{ name: "updated_at", type: "TEXT", notnull: true, pk: false },
	],
};

/**
 * Expected schema for each schema version, defined ONCE here and reused by
 * both the pre-migration version-aware validation and the post-migration full
 * validation. Specs are composed from the shared per-table constants so the
 * two checks cannot drift apart.
 *
 * - v0: only `schema_metadata` exists (no user table yet).
 * - v1: `schema_metadata` + `journal_entries` (migration1's target).
 * - v2: `schema_metadata` + `journal_entries` + `settings` (migration2's target).
 * - v3 (current): + `local_auth` (migration3's target).
 */
export const SCHEMA_BY_VERSION: readonly (readonly TableSpec[])[] = [
	[SCHEMA_METADATA_SPEC],
	[SCHEMA_METADATA_SPEC, JOURNAL_ENTRIES_SPEC],
	[SCHEMA_METADATA_SPEC, JOURNAL_ENTRIES_SPEC, SETTINGS_SPEC],
	[SCHEMA_METADATA_SPEC, JOURNAL_ENTRIES_SPEC, SETTINGS_SPEC, LOCAL_AUTH_SPEC],
];

/**
 * The concrete app-managed tables that {@link DEFAULT_MIGRATIONS} create for
 * the CURRENT v3 schema (a superset of every earlier version's spec). Used by
 * the post-migration full validation in bootstrap.
 */
export const APP_SCHEMA_TABLES: readonly TableSpec[] =
	SCHEMA_BY_VERSION[SCHEMA_BY_VERSION.length - 1];

/** The expected spec for a given stored schema version, or null if unsupported. */
export function schemaSpecForVersion(version: number): readonly TableSpec[] | null {
	if (version < 0 || version >= SCHEMA_BY_VERSION.length) return null;
	return SCHEMA_BY_VERSION[version];
}

/** Row shape returned by `PRAGMA table_info(<table>)`. */
interface TableInfoRow extends SQLRow {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	pk: number;
}

/**
 * Validate a real SQLite schema against an explicit {@link TableSpec} list.
 * Shared by BOTH the pre-migration version-aware validation (migrations) and
 * the post-migration full validation (bootstrap) so the checks cannot drift.
 * For each spec'd table, it must exist as a REAL table (not a view/other
 * object) carrying exactly the expected columns in order, with the expected
 * declared type / NOT NULL / PRIMARY KEY. Corrupt shape rejects non-
 * destructively; anything NOT in the spec (internal tables/indexes, unrelated
 * tables, views of unrelated names) is ignored.
 */
export async function validateSchemaSpec(
	dialect: SQLDialect,
	spec: readonly TableSpec[],
): Promise<void> {
	for (const table of spec) {
		// A real table, not a view/anything else with the same name.
		const exists = await dialect.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
			[table.name],
		);
		if (exists.length === 0) {
			throw new Error(
				`App schema is corrupt: expected table ${table.name} is missing or is not a real table.`,
			);
		}
		// SAFETY: `table.name` comes from the static spec constant above (or a
		// migration-owned contract), never from caller input, so interpolating it
		// into PRAGMA is safe (PRAGMA does not accept bound parameters for
		// identifiers).
		const columns = await dialect.query<TableInfoRow>(`PRAGMA table_info(${table.name})`);
		if (columns.length !== table.columns.length) {
			throw new Error(
				`App schema is corrupt: table ${table.name} has ${columns.length} columns, expected ${table.columns.length}.`,
			);
		}
		table.columns.forEach((expected, i) => {
			const actual = columns[i];
			const deviations: string[] = [];
			if (actual.name !== expected.name) deviations.push("name/order");
			if (actual.type.toUpperCase() !== expected.type.toUpperCase()) deviations.push("type");
			if (Boolean(actual.notnull) !== expected.notnull) deviations.push("not null");
			if (Boolean(actual.pk) !== expected.pk) deviations.push("primary key");
			if (deviations.length > 0) {
				throw new Error(
					`App schema is corrupt: table ${table.name} column ${expected.name} deviates (${deviations.join(", ")}).`,
				);
			}
		});
	}
}

/**
 * Validate the whole app schema against {@link APP_SCHEMA_TABLES}. Throws a
 * clear, non-destructive error when any expected table is missing, replaced
 * by a view, or deviates in column layout (name/order/type/notnull/pk).
 * When `quickCheck` is enabled, additionally rejects a non-"ok"
 * `PRAGMA quick_check` result.
 */
export async function validateAppSchema(
	dialect: SQLDialect,
	options: { quickCheck?: boolean } = {},
): Promise<void> {
	await validateSchemaSpec(dialect, APP_SCHEMA_TABLES);
	if (options.quickCheck === true) {
		const rows = await dialect.query<{ quick_check?: string | null }>("PRAGMA quick_check");
		const result = rows[0]?.quick_check ?? "(no result)";
		if (result !== "ok") {
			throw new Error(`App database integrity check failed: ${result}`);
		}
	}
}
