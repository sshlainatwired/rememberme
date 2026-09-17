import { type DatabaseHandle, openAppDatabase } from "@/db/bootstrap";
import { createNodeDialect } from "@/db/node-sqlite";
import type { BackupCodec } from "@/transfer/backup-codec";

/**
 * Shared test helper: build an in-memory real SQLite database (node:sqlite)
 * exposed through the same Dialect seam the production Capacitor adapter uses,
 * so repository/service behavior is exercised against real SQL, not mocks.
 */
export function createTestDb() {
	return createNodeDialect(":memory:");
}

/**
 * Create a fully-migrated in-memory DatabaseHandle (real SQLite via the same
 * `openAppDatabase` bootstrap seam production uses), so tests exercise real
 * Journal/Settings/Auth services against real SQL rather than mocks.
 *
 * `openAppDatabase` validates stored settings/journal/auth at open time; an
 * empty in-memory DB is unconfigured auth, which is exactly the state the
 * auth-gate UI tests start from.
 */
export async function createTestHandle(backupCodec?: BackupCodec): Promise<DatabaseHandle> {
	return openAppDatabase({ open: async () => createTestDb(), backupCodec });
}
