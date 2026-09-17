/**
 * Production adapter: `@capacitor-community/sqlite` on native Android.
 *
 * Wraps a `SQLiteDBConnection` in the async {@link SQLDialect} seam. The
 * plugin auto-wraps `execute`/`run` in its own transaction, which would nest
 * inside our explicit `beginTransaction`/`commitTransaction` — so every
 * write passes `transaction = false` and transaction control stays with the
 * migrator/repositories.
 *
 * This module is native-only: it must never run in a browser or a test
 * environment pretending to persist. `openNativeDatabase` throws when the
 * plugin is not available on the current platform, and the app fails closed.
 */

import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import {
	Serializer,
	type SQLDialect,
	type SQLRow,
	type SQLRunResult,
	type SQLValue,
} from "@/db/types";

/** App-private on-device database name (one connection per app). */
export const DATABASE_NAME = "rememberme";

/**
 * Narrow plugin-boundary slice of a SQLite DB connection: the subset the
 * dialect and the open path actually call. The real `SQLiteDBConnection`
 * satisfies it structurally, and tests can conform small fakes without
 * unsafe casts of the full plugin classes. Result fields are typed loosely on
 * purpose — the dialect only reads the field it consumes.
 */
export interface NativeDbConnection {
	open(): Promise<void>;
	execute(statements: string, transaction?: boolean): Promise<unknown>;
	run(
		statement: string,
		values?: unknown[],
		transaction?: boolean,
	): Promise<{ changes?: { changes?: number } }>;
	query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
	beginTransaction(): Promise<unknown>;
	commitTransaction(): Promise<unknown>;
	rollbackTransaction(): Promise<unknown>;
}

/**
 * Narrow plugin-boundary slice of the connection manager (`SQLiteConnection`).
 * `closeConnection(name, readonly)` closes the database AND removes its
 * registration from the plugin's native dict + JS manager map, while the raw
 * `conn.close()` only closes the DB and leaks stale registrations behind. The
 * dialect closes through its owning manager so a `close()` leaves nothing
 * registered. `checkConnectionsConsistency()` reconciles stale native
 * connections before a new one is created.
 */
export interface NativeDatabaseManager {
	/**
	 * Reconcile plugin-native vs JS-side connection registrations. A resolved
	 * promise (result `true` = consistent, `false` = stale native
	 * inconsistencies were closed/reset) allows proceeding to create a fresh
	 * connection; the call rejects when reconciliation itself fails — callers
	 * must fail closed before creating anything.
	 */
	checkConnectionsConsistency(): Promise<{ result?: boolean }>;
	isInConfigEncryption(): Promise<{ result?: boolean }>;
	isSecretStored(): Promise<{ result?: boolean }>;
	isDatabase(database: string): Promise<{ result?: boolean }>;
	isDatabaseEncrypted(database: string): Promise<{ result?: boolean }>;
	/** Generate and persist the SQLCipher secret entirely inside native code. */
	ensureEncryptionSecret(): Promise<void>;
	createConnection(
		database: string,
		encrypted: boolean,
		mode: string,
		version: number,
		readonly: boolean,
	): Promise<NativeDbConnection>;
	closeConnection(database: string, readonly: boolean): Promise<void>;
}

interface NativeSecretProvisioner {
	ensureEncryptionSecret(): Promise<unknown>;
}

class MalformedProbeResultError extends Error {}

function nativeDatabaseManager(): NativeDatabaseManager {
	const sqlite = new SQLiteConnection(CapacitorSQLite);
	// SAFETY: the pinned Java plugin implements this app-owned method and the
	// Capacitor proxy dispatches names dynamically; upstream package types stay
	// untouched and the plugin identifier is not registered a second time.
	const provisioner = CapacitorSQLite as unknown as NativeSecretProvisioner;
	return {
		checkConnectionsConsistency: () => sqlite.checkConnectionsConsistency(),
		isInConfigEncryption: () => sqlite.isInConfigEncryption(),
		isSecretStored: () => sqlite.isSecretStored(),
		isDatabase: (database) => sqlite.isDatabase(database),
		isDatabaseEncrypted: (database) => sqlite.isDatabaseEncrypted(database),
		async ensureEncryptionSecret() {
			const result = await provisioner.ensureEncryptionSecret();
			if (
				result === null ||
				typeof result !== "object" ||
				Array.isArray(result) ||
				Object.keys(result).length !== 1 ||
				(result as { created?: unknown }).created !== true
			) {
				throw new Error("SQLite plugin returned an invalid secret-provisioning result.");
			}
		},
		createConnection: (database, encrypted, mode, version, readonly) =>
			sqlite.createConnection(database, encrypted, mode, version, readonly),
		closeConnection: (database, readonly) => sqlite.closeConnection(database, readonly),
	};
}

/** Require a real boolean from every native state probe; never coerce missing bridge data. */
async function probeResult(probe: () => Promise<{ result?: boolean }>): Promise<boolean> {
	const { result } = await probe();
	if (result !== true && result !== false) {
		throw new MalformedProbeResultError("SQLite plugin probe did not return a boolean result.");
	}
	return result;
}

export class CapacitorDialect implements SQLDialect {
	private readonly serializer = new Serializer();

	constructor(
		private readonly conn: NativeDbConnection,
		private readonly manager: NativeDatabaseManager,
		private readonly database: string,
	) {}

	async exec(sql: string): Promise<void> {
		await this.conn.execute(sql, false);
	}

	async run(sql: string, params: SQLValue[] = []): Promise<SQLRunResult> {
		const result = await this.conn.run(sql, params, false);
		return { changes: Number(result.changes?.changes ?? 0) };
	}

	async query<T extends SQLRow = SQLRow>(sql: string, params: SQLValue[] = []): Promise<T[]> {
		const values = await this.conn.query(sql, params);
		return (values.values ?? []) as T[];
	}

	async begin(): Promise<void> {
		await this.conn.beginTransaction();
	}

	async commit(): Promise<void> {
		await this.conn.commitTransaction();
	}

	async rollback(): Promise<void> {
		await this.conn.rollbackTransaction();
	}

	async withLock<T>(fn: () => Promise<T>): Promise<T> {
		return this.serializer.run(fn);
	}

	close(): Promise<void> {
		// Close through the owning manager, serialized like every other
		// operation: the single memoized close is enqueued BEHIND all already
		// queued work (so an in-flight lock drains first), new withLock
		// operations reject without executing once it starts, and every
		// sequential/concurrent caller shares the same resolution or
		// rejection (a failed close replays, never retries the manager call).
		return this.serializer.close(() => this.manager.closeConnection(this.database, false));
	}
}

/**
 * Open the single app-private database through the production adapter.
 *
 * SQLCipher encrypts the entire database. When no secret exists, native code
 * generates and stores it in Keystore-backed encrypted preferences; the
 * passphrase never enters JavaScript or crosses the bridge. Existing Phase 3 plaintext stores
 * are converted through mode `encryption`; normal/fresh encrypted opens use
 * mode `secret`. Key loss and malformed native probe results fail closed.
 * Throws when the plugin is unavailable; there is no browser/in-memory fallback.
 *
 * `manager` is injectable for tests; production wraps the real
 * `SQLiteConnection` plus the app-owned native-only secret provisioner.
 */
export async function openNativeDatabase(
	database: string = DATABASE_NAME,
	manager: NativeDatabaseManager = nativeDatabaseManager(),
): Promise<CapacitorDialect> {
	if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("CapacitorSQLite")) {
		throw new Error(
			"SQLite storage is unavailable outside the native Android app; no browser or in-memory fallback is used.",
		);
	}
	// Reconcile stale native connections BEFORE creating ours. `true` means
	// the bridge is consistent; `false` means native inconsistencies were
	// closed/reset, so creating a fresh connection is safe. Parse strictly
	// like every other probe: a missing/non-boolean result, or a throwing
	// check, fails closed before createConnection registers anything.
	await probeResult(() => manager.checkConnectionsConsistency());

	if (!(await probeResult(() => manager.isInConfigEncryption()))) {
		throw new Error("Database encryption is disabled in Capacitor configuration; open aborted.");
	}
	const secretStored = await probeResult(() => manager.isSecretStored());
	const existing = await probeResult(() => manager.isDatabase(database));
	let encrypted = false;
	if (existing) {
		try {
			encrypted = await probeResult(() => manager.isDatabaseEncrypted(database));
		} catch (error) {
			if (error instanceof MalformedProbeResultError) {
				throw error;
			}
			if (!secretStored) {
				throw new Error(
					"Database encryption state is unknown and its secret is missing; refusing to replace the lost key or modify the database.",
					{ cause: error },
				);
			}
			throw error;
		}
	}

	if (encrypted && !secretStored) {
		throw new Error(
			"Database is encrypted but its secret is missing; refusing to replace the lost key or modify the database.",
		);
	}

	if (!secretStored) {
		await manager.ensureEncryptionSecret();
	}

	const mode = existing && !encrypted ? "encryption" : "secret";
	const conn = await manager.createConnection(
		database,
		true,
		mode,
		1, // version (our own version lives in schema_metadata)
		false, // readonly
	);
	try {
		await conn.open();
	} catch (err) {
		// Best-effort cleanup: `createConnection` may have registered a
		// connection; remove it so a failed open leaves nothing behind. Never
		// mask the original open error.
		await manager.closeConnection(database, false).catch(() => {});
		throw err;
	}
	return new CapacitorDialect(conn, manager, database);
}
