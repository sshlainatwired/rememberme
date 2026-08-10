import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { getConfig } from "../config";
import * as schema from "./schema";

export type Db = LibSQLDatabase<typeof schema>;

/**
 * For local `file:` databases the parent directory must exist before libSQL
 * opens the file (SQLite returns SQLITE_CANTOPEN otherwise). No-op for
 * remote (Turso) URLs and `:memory:`.
 */
function ensureLocalDbDirectory(url: string): void {
	if (url.startsWith("file:")) {
		const path = url.slice("file:".length);
		if (path && path !== ":memory:") {
			mkdirSync(dirname(path), { recursive: true });
		}
	}
}

/** Create a drizzle DB over a libSQL client (file:, :memory:, or Turso URL). */
export function createDb(url: string, authToken = ""): Db {
	ensureLocalDbDirectory(url);
	const client: Client = createClient({
		url,
		authToken: authToken || undefined,
	});
	return drizzle(client, { schema });
}

let dbInstance: Db | null = null;

/** Singleton DB bound to the validated environment configuration. */
export function getDb(): Db {
	if (!dbInstance) {
		const config = getConfig();
		dbInstance = createDb(config.DATABASE_URL, config.DATABASE_AUTH_TOKEN);
	}
	return dbInstance;
}
