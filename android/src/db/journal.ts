/**
 * Journal repository + service over the SQLite dialect.
 *
 * Semantics match the shared `@rememberme/core` journal schemas:
 * - dates are calendar dates `YYYY-MM-DD` (validated with the shared schema),
 * - content is never trimmed; whitespace/newlines/Unicode survive exactly,
 * - empty content means "no entry" and deletes at the service boundary,
 * - one row per date; overwriting preserves `created_at` and refreshes
 *   `updated_at` from the injected clock (deterministic under test).
 */

import {
	type CalendarDate,
	journalContentSchema,
	journalDateSchema,
	journalRangeSchema,
} from "@rememberme/core";
import type { SQLDialect, SQLRow, SQLValue } from "@/db/types";

export interface JournalEntry {
	date: CalendarDate;
	content: string;
	createdAt: string;
	updatedAt: string;
}

/** Row shape as stored in `journal_entries`. */
export interface JournalRow extends SQLRow {
	date: string;
	content: string;
	created_at: string;
	updated_at: string;
}

type Clock = () => string;

/**
 * Fail-closed stored-row decoder. A stored journal row must satisfy the
 * SHARED `@rememberme/core` schemas — calendar date + string content within
 * the 100,000-character maximum — plus stored `created_at`/`updated_at`
 * timestamps that are strings AND finite, parseable date strings (the
 * injected clock always emits a finite `Date.toISOString()`, so this rejects
 * non-strings and malformed/non-finite values while never rejecting anything
 * the clock produces). Any stored row that fails validation is corruption
 * and REJECTS instead of being surfaced to the UI. The wrapper names the
 * corruption generically (never echoing the stored content or timestamp,
 * which may be huge or binary) and preserves the original validation failure
 * as the cause.
 */
function corruptEntry(cause: unknown): Error {
	return new Error("Corrupt journal entry: stored row is invalid.", { cause });
}

/**
 * Narrow stored-timestamp decoder: must be a string that parses to a finite
 * date. Rejects non-string values (e.g. a BLOB or a number coerced to text
 * that is not a date) and malformed/non-finite date strings, keeping the same
 * fail-closed corruption discipline as date/content. The failure details
 * never echo the raw stored value — only its stored type is named.
 */
function decodeTimestamp(value: unknown): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new Error(`Stored timestamp is not a valid date string (stored type: ${typeof value}).`);
	}
	return value;
}

function decodeDate(value: unknown): CalendarDate {
	try {
		return journalDateSchema.parse(value) as CalendarDate;
	} catch (cause) {
		throw corruptEntry(cause);
	}
}

export function decodeJournalRow(row: JournalRow): JournalEntry {
	try {
		return {
			date: journalDateSchema.parse(row.date) as CalendarDate,
			content: journalContentSchema.parse(row.content),
			createdAt: decodeTimestamp(row.created_at),
			updatedAt: decodeTimestamp(row.updated_at),
		};
	} catch (cause) {
		throw corruptEntry(cause);
	}
}

/** Assert `date` is a valid shared calendar date, throwing otherwise. */
function assertDate(date: string): void {
	journalDateSchema.parse(date);
}

export class JournalService {
	constructor(
		private readonly db: SQLDialect,
		private readonly clock: Clock = () => new Date().toISOString(),
	) {}

	/** Fetch one entry; null when the date has no entry. */
	async get(date: string): Promise<JournalEntry | null> {
		assertDate(date);
		return this.db.withLock(() => this.getUnlocked(date));
	}

	/**
	 * Read one entry WITHOUT acquiring the queue lock. Only for callers that
	 * already hold it (upsert's read-after-write), so a nested withLock can
	 * never deadlock the queue.
	 */
	private async getUnlocked(date: string): Promise<JournalEntry | null> {
		const rows = await this.db.query<JournalRow>(
			"SELECT date, content, created_at, updated_at FROM journal_entries WHERE date = ?",
			[date],
		);
		return rows.length > 0 ? decodeJournalRow(rows[0]) : null;
	}

	/**
	 * Resolve the static WHERE clause + params for an inclusive calendar-date
	 * range, validated with the shared journal range schema BEFORE any SQL
	 * runs. Reversed ranges (from > to) and malformed dates reject here. The
	 * clause is chosen from a fixed set of static variants only — bounds are
	 * always parameterized, never interpolated.
	 */
	private rangeClause(
		from: string | undefined,
		to: string | undefined,
	): { where: string; params: SQLValue[] } {
		journalRangeSchema.parse({ from: from ?? undefined, to: to ?? undefined });
		const params: SQLValue[] = [];
		if (from !== undefined && to !== undefined) {
			assertDate(from);
			assertDate(to);
			params.push(from, to);
			return { where: "WHERE date >= ? AND date <= ?", params };
		}
		if (from !== undefined) {
			assertDate(from);
			params.push(from);
			return { where: "WHERE date >= ?", params };
		}
		if (to !== undefined) {
			assertDate(to);
			params.push(to);
			return { where: "WHERE date <= ?", params };
		}
		return { where: "", params };
	}

	/**
	 * List entries with inclusive optional bounds, sorted ascending by date.
	 * Reversed ranges (from > to) are rejected before touching the database.
	 */
	async list(from?: string, to?: string): Promise<JournalEntry[]> {
		const { where, params } = this.rangeClause(from, to);
		const sql = `SELECT date, content, created_at, updated_at FROM journal_entries ${where} ORDER BY date ASC`;
		return this.db.withLock(() =>
			this.db.query<JournalRow>(sql, params).then((rows) => rows.map(decodeJournalRow)),
		);
	}

	/**
	 * List the calendar dates that have entries, with inclusive optional
	 * bounds, sorted ascending — dates only, no content. Shares the exact
	 * same shared-schema range validation as list(); the whole query runs in
	 * ONE queue slot so overlapping list calls stay consistent.
	 */
	async listDates(from?: string, to?: string): Promise<CalendarDate[]> {
		const { where, params } = this.rangeClause(from, to);
		const sql = `SELECT date FROM journal_entries ${where} ORDER BY date ASC`;
		return this.db.withLock(() =>
			this.db
				.query<{ date: string }>(sql, params)
				.then((rows) => rows.map((row) => decodeDate(row.date))),
		);
	}

	/**
	 * Upsert one date's content. Empty content deletes the entry (no-op when
	 * absent). Overwrites keep the original `created_at`; `updated_at` is the
	 * injected clock. Uses portable UPDATE-then-INSERT (no UPSERT syntax).
	 * The whole UPDATE→INSERT→read sequence runs inside ONE queue slot so two
	 * concurrent upserts of a missing date cannot both INSERT (UNIQUE) — the
	 * second finds the row and updates it.
	 */
	async upsert(date: string, content: string): Promise<JournalEntry | null> {
		assertDate(date);
		journalContentSchema.parse(content);
		return this.db.withLock(() => this.upsertUnlocked(date, content));
	}

	/** Upsert body WITHOUT acquiring the queue lock (caller holds it). */
	private async upsertUnlocked(date: string, content: string): Promise<JournalEntry | null> {
		if (content === "") {
			await this.db.run("DELETE FROM journal_entries WHERE date = ?", [date]);
			return null;
		}

		const now = this.clock();
		const updated = await this.db.run(
			"UPDATE journal_entries SET content = ?, updated_at = ? WHERE date = ?",
			[content, now, date],
		);
		if (updated.changes > 0) {
			const entry = await this.getUnlocked(date);
			if (entry === null) {
				throw new Error(
					`Journal inconsistency: UPDATE reported ${updated.changes} change(s) but entry ${date} is missing`,
				);
			}
			return entry;
		}

		await this.db.run(
			"INSERT INTO journal_entries (date, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
			[date, content, now, now],
		);
		// Re-read so the returned entry matches what the database stores
		// exactly (e.g. column normalization) rather than reconstructing it.
		const entry = await this.getUnlocked(date);
		if (entry === null) {
			throw new Error(`Journal inconsistency: INSERT did not persist entry ${date}`);
		}
		return entry;
	}

	/** Delete one date's entry; no-op when absent. */
	async delete(date: string): Promise<void> {
		assertDate(date);
		await this.db.withLock(() =>
			this.db.run("DELETE FROM journal_entries WHERE date = ?", [date]).then(() => undefined),
		);
	}
}
