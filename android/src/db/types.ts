/**
 * SQLite storage seam (Android app).
 *
 * A tiny asynchronous dialect abstraction shared by the two real adapters:
 *
 * - `node-sqlite.ts` — `node:sqlite` `DatabaseSync` wrapped in promises, used
 *   only by Vitest behavior tests against real in-memory SQLite.
 * - `capacitor-sqlite.ts` — the production `@capacitor-community/sqlite`
 *   `SQLiteDBConnection`, used only on native Android.
 *
 * Repositories/migrations depend only on this interface, so the same
 * migrations and SQL run against both engines. Nothing here is a fake or an
 * in-JS storage substitute: every adapter talks to a real SQLite engine.
 */

/** A single row returned by a query: column name -> value. */
export type SQLRow = Record<string, unknown>;

/** Parameter values bound to a statement (mirrors SQLite's accepted inputs). */
export type SQLValue = null | number | bigint | string | Uint8Array;

/** Result of a write statement. */
export interface SQLRunResult {
	/** Number of rows affected by the last statement. */
	changes: number;
}

/**
 * Error thrown when an operation is queued after the database has closed.
 * Deterministic and non-retryable: the operation never executes.
 */
export class ClosedDatabaseError extends Error {
	constructor() {
		super("The database is closed; refusing new operations.");
		this.name = "ClosedDatabaseError";
	}
}

/**
 * Small database-level async serialization queue.
 *
 * One instance per dialect serializes all service operations that share the
 * connection: `withLock(fn)` callers are queued and each `fn` runs to
 * completion (success or rejection) before the next starts, so a whole
 * multi-statement operation — a settings transaction, or a journal
 * UPDATE→INSERT→read — is atomic with respect to other queued operations.
 * A rejected `fn` never poisons the queue: the chain continues with the next
 * queued operation. Unlock is implicit: settling `fn` releases the slot.
 *
 * Close semantics (adapter `close()` delegates here): once close starts, new
 * `run` callers reject immediately WITHOUT executing; the single memoized
 * close action is enqueued behind every already-queued operation (so it
 * waits for in-flight work) and every sequential or concurrent close caller
 * shares the same resolution/rejection, including replay after a failure.
 */
export class Serializer {
	/** Promise that resolves once every previously queued op has settled. */
	private tail: Promise<unknown> = Promise.resolve();

	/**
	 * The single memoized close operation. Set once when close() is first
	 * requested; null until then. Its presence gates new `run` callers.
	 */
	private closePromise: Promise<void> | null = null;

	run<T>(fn: () => Promise<T>): Promise<T> {
		// Once close has started, refuse new operations outright — they must
		// never execute against an engine that is closing/closed.
		if (this.closePromise !== null) {
			return Promise.reject(new ClosedDatabaseError());
		}
		const result = this.tail.then(fn);
		// Keep the tail resolvable even when fn rejects, so the next queued
		// operation still runs.
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/**
	 * Queue the single close action behind every already-queued operation and
	 * memoize it: sequential and concurrent callers all await this exact
	 * promise and observe the same resolution or rejection, and the action
	 * runs at most once — only after in-flight queued work has settled. A
	 * failed close replays its rejection to every later caller (no retry).
	 */
	close(fn: () => Promise<void>): Promise<void> {
		if (this.closePromise === null) {
			this.closePromise = this.tail.then(fn);
			// The tail stays resolvable even if the close rejects, so any
			// operation already queued still settles cleanly.
			this.tail = this.closePromise.then(
				() => undefined,
				() => undefined,
			);
		}
		return this.closePromise;
	}
}

/**
 * Asynchronous SQLite dialect. Explicit transaction control is part of the
 * seam so the migrator can commit each migration + version bump atomically
 * without relying on engine-specific nested-transaction behavior.
 *
 * `withLock` is the serialization primitive: services wrap each public
 * operation in it (with private unlocked helpers for operations that already
 * hold the lock) so overlapping settings/journal calls share one queue and
 * cannot interleave mid-transaction.
 */
export interface SQLDialect {
	/** Run one or more statements (DDL/DML batch, no parameters). */
	exec(sql: string): Promise<void>;
	/** Run a single parameterized statement. */
	run(sql: string, params?: SQLValue[]): Promise<SQLRunResult>;
	/** Run a parameterized SELECT and return all rows. */
	query<T extends SQLRow = SQLRow>(sql: string, params?: SQLValue[]): Promise<T[]>;
	/** Begin an explicit transaction. */
	begin(): Promise<void>;
	/** Commit the active transaction. */
	commit(): Promise<void>;
	/** Roll back the active transaction. */
	rollback(): Promise<void>;
	/**
	 * Run `fn` exclusively: queued on this dialect and executed one at a time
	 * until each settles. A whole multi-statement operation is atomic with
	 * respect to other queued operations; a rejected `fn` does not block the
	 * queue.
	 */
	withLock<T>(fn: () => Promise<T>): Promise<T>;
	/** Close the underlying database. */
	close(): Promise<void>;
}

export type { SQLRow as Row };
