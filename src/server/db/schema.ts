import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * RememberMe database schema.
 *
 * `user`, `session`, `account`, and `verification` are the tables Better Auth
 * expects (column names must match exactly). `journal_entries`, `settings`,
 * and `digest_deliveries` are application tables.
 */

export const user = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
	image: text("image"),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable("session", {
	id: text("id").primaryKey(),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	token: text("token").notNull().unique(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
	id: text("id").primaryKey(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: integer("access_token_expires_at"),
	refreshTokenExpiresAt: integer("refresh_token_expires_at"),
	scope: text("scope"),
	password: text("password"),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const verification = sqliteTable("verification", {
	id: text("id").primaryKey(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * A journal entry. Content is always stored encrypted (AES-256-GCM):
 * `encryptedContent` + `iv` + `authTag` are the ciphertext split into
 * three base64 columns. `entryDate` is a calendar date (YYYY-MM-DD)
 * interpreted in the user's configured timezone.
 */
export const journalEntries = sqliteTable(
	"journal_entries",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		entryDate: text("entry_date").notNull(),
		encryptedContent: text("encrypted_content").notNull(),
		iv: text("iv").notNull(),
		authTag: text("auth_tag").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		uniqueIndex("journal_entries_user_date_unique").on(t.userId, t.entryDate),
		index("journal_entries_date_idx").on(t.entryDate),
	],
);

export type JournalEntryRow = typeof journalEntries.$inferSelect;

/** Per-user application settings (digest recipient, timezone, schedule). */
export const settings = sqliteTable("settings", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.unique()
		.references(() => user.id, { onDelete: "cascade" }),
	email: text("email").notNull().default(""),
	timezone: text("timezone").notNull().default("UTC"),
	weeklyDigestEnabled: integer("weekly_digest_enabled", { mode: "boolean" })
		.notNull()
		.default(false),
	weeklyDigestHour: integer("weekly_digest_hour").notNull().default(20),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type SettingsRow = typeof settings.$inferSelect;

/** One row per successfully delivered weekly digest. Makes delivery idempotent. */
export const digestDeliveries = sqliteTable(
	"digest_deliveries",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		weekStart: text("week_start").notNull(), // YYYY-MM-DD (Monday)
		weekEnd: text("week_end").notNull(), // YYYY-MM-DD (Sunday)
		sentAt: integer("sent_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [uniqueIndex("digest_deliveries_user_week_unique").on(t.userId, t.weekStart, t.weekEnd)],
);
