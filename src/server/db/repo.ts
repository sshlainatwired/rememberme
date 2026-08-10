import { randomUUID } from "node:crypto";
import { and, count, eq, gte, lt } from "drizzle-orm";
import type { EncryptedJournal } from "../crypto/journal-encryption";
import type { Db } from "./client";
import { digestDeliveries, type JournalEntryRow, journalEntries, settings, user } from "./schema";

/**
 * Data access helpers shared by the API routes and Astro pages.
 * No business logic here; no encryption/decryption here (rows are returned
 * as stored, with ciphertext fields).
 */

// ---------------------------------------------------------------------------
// Auth / user
// ---------------------------------------------------------------------------

export async function getUserCount(db: Db): Promise<number> {
	const [row] = await db.select({ value: count() }).from(user);
	return row?.value ?? 0;
}

export async function getSoleUser(db: Db) {
	const rows = await db.select().from(user).limit(1);
	return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettingsByUserId(db: Db, userId: string) {
	const rows = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
	return rows[0] ?? null;
}

export type SettingsUpdate = {
	email?: string;
	timezone?: string;
	weeklyDigestEnabled?: boolean;
	weeklyDigestHour?: number;
};

/** Create settings for a new user (first launch). */
export async function createSettings(db: Db, userId: string, values: SettingsUpdate) {
	const now = new Date();
	const rows = await db
		.insert(settings)
		.values({
			id: randomUUID(),
			userId,
			email: values.email ?? "",
			timezone: values.timezone ?? "UTC",
			weeklyDigestEnabled: values.weeklyDigestEnabled ?? false,
			weeklyDigestHour: values.weeklyDigestHour ?? 20,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return rows[0];
}

export async function updateSettings(
	db: Db,
	userId: string,
	values: SettingsUpdate,
): Promise<void> {
	await db
		.update(settings)
		.set({ ...values, updatedAt: new Date() })
		.where(eq(settings.userId, userId));
}

/** Users with the weekly digest enabled, joined with their settings. */
export function listDigestSubscribers(db: Db) {
	return db
		.select({
			userId: user.id,
			email: settings.email,
			timezone: settings.timezone,
			weeklyDigestHour: settings.weeklyDigestHour,
		})
		.from(user)
		.innerJoin(settings, eq(settings.userId, user.id))
		.where(eq(settings.weeklyDigestEnabled, true));
}

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------

/** Fetch one entry (ciphertext) by user + calendar date, or null. */
export async function getEntry(
	db: Db,
	userId: string,
	entryDate: string,
): Promise<JournalEntryRow | null> {
	const rows = await db
		.select()
		.from(journalEntries)
		.where(and(eq(journalEntries.userId, userId), eq(journalEntries.entryDate, entryDate)))
		.limit(1);
	return rows[0] ?? null;
}

/** Insert or replace one entry. Returns the stored row. */
export async function upsertEntry(
	db: Db,
	userId: string,
	entryDate: string,
	encrypted: EncryptedJournal,
): Promise<JournalEntryRow> {
	const now = new Date();
	const rows = await db
		.insert(journalEntries)
		.values({
			id: randomUUID(),
			userId,
			entryDate,
			encryptedContent: encrypted.encryptedContent,
			iv: encrypted.iv,
			authTag: encrypted.authTag,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [journalEntries.userId, journalEntries.entryDate],
			set: {
				encryptedContent: encrypted.encryptedContent,
				iv: encrypted.iv,
				authTag: encrypted.authTag,
				updatedAt: now,
			},
		})
		.returning();
	return rows[0];
}

export async function deleteEntry(db: Db, userId: string, entryDate: string): Promise<void> {
	await db
		.delete(journalEntries)
		.where(and(eq(journalEntries.userId, userId), eq(journalEntries.entryDate, entryDate)));
}

/** Entry dates (YYYY-MM-DD) for a user, optionally within [from, to]. */
export async function listEntryDates(
	db: Db,
	userId: string,
	range: { from?: string; to?: string } = {},
): Promise<string[]> {
	const conditions = [eq(journalEntries.userId, userId)];
	if (range.from) conditions.push(gte(journalEntries.entryDate, range.from));
	if (range.to) conditions.push(lt(journalEntries.entryDate, nextDay(range.to)));

	const rows = await db
		.select({ entryDate: journalEntries.entryDate })
		.from(journalEntries)
		.where(and(...conditions))
		.orderBy(journalEntries.entryDate);
	return rows.map((r) => r.entryDate);
}

/** Full encrypted rows within a date range (used by the digest job). */
export async function listEntriesBetween(
	db: Db,
	userId: string,
	from: string,
	to: string,
): Promise<JournalEntryRow[]> {
	return db
		.select()
		.from(journalEntries)
		.where(
			and(
				eq(journalEntries.userId, userId),
				gte(journalEntries.entryDate, from),
				lt(journalEntries.entryDate, nextDay(to)),
			),
		)
		.orderBy(journalEntries.entryDate);
}

/** YYYY-MM-DD of the day after `date` (string arithmetic is safe here). */
function nextDay(date: string): string {
	const [y, m, d] = date.split("-").map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d + 1));
	return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Digest deliveries
// ---------------------------------------------------------------------------

/**
 * Record a delivery. Returns true when the row was inserted (i.e. this week
 * was not delivered yet), false when it already exists. The unique
 * constraint on (user_id, week_start, week_end) is what makes the digest
 * idempotent.
 */
export async function tryRecordDelivery(
	db: Db,
	userId: string,
	weekStart: string,
	weekEnd: string,
): Promise<boolean> {
	const rows = await db
		.insert(digestDeliveries)
		.values({
			id: randomUUID(),
			userId,
			weekStart,
			weekEnd,
			sentAt: new Date(),
		})
		.onConflictDoNothing()
		.returning({ id: digestDeliveries.id });
	return rows.length > 0;
}

/** Remove a failed delivery record so the job can retry. */
export async function deleteDelivery(
	db: Db,
	userId: string,
	weekStart: string,
	weekEnd: string,
): Promise<void> {
	await db
		.delete(digestDeliveries)
		.where(
			and(
				eq(digestDeliveries.userId, userId),
				eq(digestDeliveries.weekStart, weekStart),
				eq(digestDeliveries.weekEnd, weekEnd),
			),
		);
}
