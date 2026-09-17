/**
 * Node adapter: real SQLite via `node:sqlite` (DatabaseSync), wrapped in the
 * async {@link SQLDialect} seam. Used ONLY by Vitest behavior tests in this
 * workspace — it is never imported by production Android code, so it is never
 * bundled into the app.
 */

import { DatabaseSync } from "node:sqlite";
import {
	Serializer,
	type SQLDialect,
	type SQLRow,
	type SQLRunResult,
	type SQLValue,
} from "@/db/types";

export class NodeDialect implements SQLDialect {
	private db: DatabaseSync;
	private readonly serializer = new Serializer();

	constructor(location: string) {
		this.db = new DatabaseSync(location);
	}

	async exec(sql: string): Promise<void> {
		this.db.exec(sql);
	}

	async run(sql: string, params: SQLValue[] = []): Promise<SQLRunResult> {
		const stmt = this.db.prepare(sql);
		const result = stmt.run(...params);
		return { changes: Number(result.changes) };
	}

	async query<T extends SQLRow = SQLRow>(sql: string, params: SQLValue[] = []): Promise<T[]> {
		const stmt = this.db.prepare(sql);
		return (stmt.all(...params) as T[]).map((row) => ({ ...row }));
	}

	async begin(): Promise<void> {
		this.db.exec("BEGIN");
	}

	async commit(): Promise<void> {
		this.db.exec("COMMIT");
	}

	async rollback(): Promise<void> {
		this.db.exec("ROLLBACK");
	}

	close(): Promise<void> {
		// Close through the serializer: queued behind every in-flight lock, one
		// memoized operation shared by all callers; new withLock ops reject.
		// Deliberately NOT async, so the memoized close promise is returned
		// by identity to every caller.
		return this.serializer.close(async () => {
			this.db.close();
		});
	}

	async withLock<T>(fn: () => Promise<T>): Promise<T> {
		return this.serializer.run(fn);
	}
}

/** Open a real SQLite database through the dialect seam (tests only). */
export function createNodeDialect(location = ":memory:"): NodeDialect {
	return new NodeDialect(location);
}

export type { SQLValue };
