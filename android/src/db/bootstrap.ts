/**
 * Native database bootstrap.
 *
 * `openAppDatabase` opens the single app-private database, runs migrations,
 * and exposes repositories — all BEFORE the React tree renders (see the
 * `AppBootstrap` gate). It fails closed with a clear error: no
 * browser/localStorage/IndexedDB fallback, and the database is never reset
 * or deleted. On a non-native platform (tests, browser dev) it rejects rather
 * than pretending to persist through a JS substitute.
 *
 * `initDatabase` is the process-wide singleton used by production: repeated
 * calls return the same initialized handle (and replay the same rejection
 * when initialization failed), avoiding duplicate plugin-connection errors.
 */

import { AuthService } from "@/auth/auth-service";
import { openNativeDatabase } from "@/db/capacitor-sqlite";
import { JournalService } from "@/db/journal";
import { applyMigrations, SCHEMA_VERSION } from "@/db/migrations";
import { validateAppSchema } from "@/db/schema-validation";
import { SettingsService } from "@/db/settings";
import { publishSettingsChanged } from "@/db/settings-events";
import type { SQLDialect } from "@/db/types";
import {
	createNativeDeviceUnlockAdapter,
	createUnavailableDeviceUnlockAdapter,
	type DeviceUnlockAdapter,
	DeviceUnlockService,
	isDeviceUnlockCancelled,
} from "@/security/device-unlock";
import type { BackupCodec } from "@/transfer/backup-codec";
import { DataTransferService } from "@/transfer/data-transfer";

/** The initialized database: repositories plus the schema version. */
export interface DatabaseHandle {
	/** Schema version in effect after migrations. */
	schemaVersion: number;
	journal: JournalService;
	settings: SettingsService;
	transfer: DataTransferService;
	auth: AuthService;
	security: DeviceUnlockService;
	/** Close the underlying connection (release native resources). */
	close(): Promise<void>;
}

export interface OpenDatabaseOptions {
	/**
	 * Alternative dialect factory. Production leaves this unset (native
	 * Capacitor plugin). Tests inject a `node:sqlite`-backed dialect so the
	 * same migrations/repositories run against real SQLite.
	 */
	open?: () => Promise<SQLDialect>;
	/**
	 * Native security seam. Production uses the CapacitorSQLite extension;
	 * test-injected dialects default to an honest unavailable adapter.
	 */
	deviceUnlockAdapter?: DeviceUnlockAdapter;
	/** Optional deterministic codec for storage integration tests. */
	backupCodec?: BackupCodec;
}

/** Default factory: app-private native SQLite (rejects off-platform). */
const defaultOpen = (): Promise<SQLDialect> => openNativeDatabase();

/**
 * Open the app database and migrate it to the latest schema.
 *
 * Fail-closed rules:
 * - on open failure the original error propagates (no services exposed);
 * - on migration failure the connection is released, the stored version and
 *   data are left untouched, and a clear fail-closed error is thrown
 *   (preserving the exact rejected error as cause);
 * - the full app schema is validated (validateAppSchema) AFTER migrations and
 *   BEFORE services/routes are exposed: a database claiming the current
 *   version must still carry exactly the expected table structures — corrupt
 *   structure rejects, closes the connection with zero writes/deletes;
 * - stored settings are validated BEFORE the handle/routes are exposed:
 *   corrupt settings (malformed JSON, invalid values, unknown keys) reject,
 *   the connection is closed WITHOUT writes/deletes, and nothing is served.
 */
export async function openAppDatabase(options: OpenDatabaseOptions = {}): Promise<DatabaseHandle> {
	const open = options.open ?? defaultOpen;
	const deviceUnlockAdapter =
		options.deviceUnlockAdapter ??
		(options.open === undefined
			? createNativeDeviceUnlockAdapter()
			: createUnavailableDeviceUnlockAdapter());
	// Native mode metadata is authoritative and the protected preference key
	// must be authenticated BEFORE openNativeDatabase performs even its first
	// consistency/encryption/secret/database probe. Cancellation rejects here,
	// with no connection created, so initDatabase can safely allow a retry.
	const preparation = await deviceUnlockAdapter.prepare();
	if (preparation.enabled !== preparation.authenticated) {
		throw new Error("Device security returned an invalid startup state.");
	}
	const dialect = await open();
	let schemaVersion: number;
	try {
		schemaVersion = await applyMigrations(dialect);
	} catch (error) {
		await dialect.rollback().catch(() => {});
		await dialect.close().catch(() => {});
		// Keep the user-safe fail-closed message, but preserve the EXACT
		// rejected error object as cause (nested — the migration wrapper
		// itself keeps its own engine error as cause).
		throw new Error(
			`Cannot open local database: ${String(error)}. Nothing was reset or deleted; restart the app to retry.`,
			{ cause: error },
		);
	}

	// Full app-schema validation AFTER migrations, BEFORE any service/routes
	// are exposed: a database whose recorded version is current must still
	// carry the exact expected table structures. Corruption rejects, closes
	// the connection (no writes/deletes), and fails closed.
	try {
		await validateAppSchema(dialect);
	} catch (error) {
		await dialect.close().catch(() => {});
		throw new Error(
			`Cannot open local database: the stored schema is corrupt (${String(error)}). Nothing was reset or deleted; restart the app to retry.`,
			{ cause: error },
		);
	}
	const settings = new SettingsService(dialect);
	let handle: DatabaseHandle;
	const transfer = new DataTransferService(
		dialect,
		() => publishSettingsChanged(handle),
		options.backupCodec,
	);
	const auth = new AuthService(dialect, settings);
	const security = new DeviceUnlockService(deviceUnlockAdapter, settings, () =>
		publishSettingsChanged(handle),
	);
	handle = {
		schemaVersion,
		journal: new JournalService(dialect),
		settings,
		transfer,
		auth,
		security,
		close: async () => {
			security.dispose();
			transfer.dispose();
			await dialect.close();
		},
	};
	// Validate stored settings before exposing the handle/routes. get() rejects
	// on corruption; close the connection (no writes/deletes) and fail closed.
	try {
		await handle.settings.get();
	} catch (error) {
		await dialect.close().catch(() => {});
		throw new Error(
			`Cannot open local database: stored settings are corrupt (${String(error)}). Nothing was reset or deleted; restart the app to retry.`,
			{ cause: error },
		);
	}
	// Validate ALL existing journal rows before exposing the handle/routes. The
	// public list() (no bounds) reads every row and runs each through the same
	// shared-schema stored-row decoder, so any invalid date or content rejects
	// BEFORE the app can serve it. list() acquires the queue lock at the top
	// level (not nested inside another service call), so it cannot deadlock;
	// bootstrap performs zero writes. On corruption, close exactly once and
	// fail closed, preserving the corruption error as cause.
	try {
		await handle.journal.list();
	} catch (error) {
		await dialect.close().catch(() => {});
		throw new Error(
			`Cannot open local database: stored journal data is corrupt (${String(error)}). Nothing was reset or deleted; restart the app to retry.`,
			{ cause: error },
		);
	}
	// Validate the stored auth row (strict verifier decode + singleton shape)
	// BEFORE exposing the handle/routes: a hostile/malformed stored verifier
	// rejects here, the connection is closed exactly once with zero writes, and
	// the corruption error is preserved as cause. The password is never
	// derived, rotated, or used to wrap the SQLCipher key at open time.
	try {
		await handle.auth.validateStored();
	} catch (error) {
		await dialect.close().catch(() => {});
		throw new Error(
			`Cannot open local database: stored auth data is corrupt (${String(error)}). Nothing was reset or deleted; restart the app to retry.`,
			{ cause: error },
		);
	}

	// Existing data has now passed every fail-closed validation. Re-read native
	// authority, repair only the SQLite UI mirror, then open the in-memory app
	// session when this startup already authenticated the enabled key. Any
	// failure releases the one opened handle exactly once and preserves its cause.
	try {
		const status = await security.reconcile();
		if (status.enabled !== preparation.enabled) {
			throw new Error("Native key-protection state changed during database startup.");
		}
		if (preparation.authenticated) {
			await auth.unlockWithDeviceCredential();
		}
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
	return handle;
}

let instance: Promise<DatabaseHandle> | null = null;

/**
 * Initialize (or reuse) the single app-wide database handle.
 *
 * The returned promise resolves once and then replays the same result on
 * subsequent calls, so callers can await it repeatedly without triggering a
 * second open.
 */
export function initDatabase(options: OpenDatabaseOptions = {}): Promise<DatabaseHandle> {
	if (instance === null) {
		let attempt: Promise<DatabaseHandle>;
		attempt = openAppDatabase(options).catch((error) => {
			// Cancellation happened before any connection was opened. Clear only
			// this still-current attempt so the startup screen can retry; concurrent
			// callers continue sharing the same rejected promise. Every permanent
			// failure stays memoized exactly as before.
			if (isDeviceUnlockCancelled(error) && instance === attempt) {
				instance = null;
			}
			throw error;
		});
		instance = attempt;
	}
	return instance;
}

/** Exposed for the UI's fail-closed screen to describe what is supported. */
export function supportedSchemaVersion(): number {
	return SCHEMA_VERSION;
}
