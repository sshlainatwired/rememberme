import { open } from "node:fs/promises";
import { formatTransferInstant, isCalendarDate } from "@rememberme/core";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { journalEntries, user } from "./db/schema";

/**
 * Offline legacy export for Android migration.
 *
 * Emits the SAME encrypted rows the web server stores (AES-256-GCM ciphertext
 * split into `encryptedContent`/`iv`/`authTag`) plus timestamps. It never
 * decrypts, never imports the journal cipher, and never reads or serializes
 * the environment encryption key, account data, or plaintext.
 */

/** Inclusive maximum number of exported rows. */
export const MAX_LEGACY_EXPORT_ROWS = 10_000;

const MAX_CIPHERTEXT_BYTES = 100_000 * 4;

export interface LegacyExportInputRow {
	entryDate: string;
	encryptedContent: string;
	iv: string;
	authTag: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface LegacyExportDeps {
	/** Production wiring lives in `scripts/export-android.ts`. */
	loadRows?(): Promise<LegacyExportInputRow[]>;
	writeExclusive?(path: string, body: string): Promise<void>;
	now?(): Date;
}

function assertCanonicalBase64(value: unknown, label: string, length?: number): string {
	if (typeof value !== "string" || value.length % 4 !== 0) {
		throw new Error(`${label} must be canonical standard base64.`);
	}
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value) {
		throw new Error(`${label} must be canonical standard base64.`);
	}
	if (length !== undefined && bytes.length !== length) {
		throw new Error(`${label} must decode to exactly ${length} bytes.`);
	}
	if (label === "Legacy ciphertext" && bytes.length > MAX_CIPHERTEXT_BYTES) {
		throw new Error("Legacy ciphertext exceeds the supported journal size.");
	}
	return value;
}

/** Serialize the versioned ciphertext-only export. */
export function serializeLegacyExport(rows: LegacyExportInputRow[], exportedAt: Date): string {
	if (!Array.isArray(rows) || rows.length > MAX_LEGACY_EXPORT_ROWS) {
		throw new Error(`Legacy export supports at most ${MAX_LEGACY_EXPORT_ROWS} rows.`);
	}
	const exportedAtInstant = formatTransferInstant(exportedAt, "exportedAt");
	let previousDate: string | null = null;
	const entries = [...rows]
		.sort((left, right) => left.entryDate.localeCompare(right.entryDate))
		.map((row) => {
			if (typeof row.entryDate !== "string" || !isCalendarDate(row.entryDate)) {
				throw new Error("Legacy export entry date is invalid.");
			}
			if (previousDate !== null && row.entryDate <= previousDate) {
				throw new Error("Legacy export contains a duplicate entry date.");
			}
			const createdAt = formatTransferInstant(row.createdAt, "createdAt");
			const updatedAt = formatTransferInstant(row.updatedAt, "updatedAt");
			if (createdAt > updatedAt) throw new Error("Legacy export timestamps are invalid.");
			previousDate = row.entryDate;
			return {
				entryDate: row.entryDate,
				encryptedContent: assertCanonicalBase64(row.encryptedContent, "Legacy ciphertext"),
				iv: assertCanonicalBase64(row.iv, "Legacy IV", 12),
				authTag: assertCanonicalBase64(row.authTag, "Legacy auth tag", 16),
				createdAt,
				updatedAt,
			};
		});
	return `${JSON.stringify(
		{ format: "rememberme-legacy-export", version: 1, exportedAt: exportedAtInstant, entries },
		null,
		2,
	)}\n`;
}

/** Sole-user loader selecting only the encrypted journal columns. */
export function createLegacyExportLoader(db: Db): () => Promise<LegacyExportInputRow[]> {
	return async () => {
		const users = await db.select({ id: user.id }).from(user).limit(2);
		if (users.length !== 1) {
			throw new Error(
				`Legacy export requires exactly one configured user; found ${String(users.length)}.`,
			);
		}
		return db
			.select({
				entryDate: journalEntries.entryDate,
				encryptedContent: journalEntries.encryptedContent,
				iv: journalEntries.iv,
				authTag: journalEntries.authTag,
				createdAt: journalEntries.createdAt,
				updatedAt: journalEntries.updatedAt,
			})
			.from(journalEntries)
			.where(eq(journalEntries.userId, users[0].id))
			.orderBy(journalEntries.entryDate);
	};
}

function parseOutputArgument(args: string[]): string {
	let output: string | null = null;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument !== "--output") throw new Error(`Unknown argument: ${argument}`);
		if (output !== null) throw new Error("Duplicate --output argument.");
		output = args[index + 1] ?? null;
		if (output === null || output.startsWith("--")) throw new Error("Missing value for --output.");
		index += 1;
	}
	if (output === null) throw new Error("Missing required --output <path>.");
	return output;
}

async function writeExclusiveFile(path: string, body: string): Promise<void> {
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(body, "utf8");
	} finally {
		await file.close();
	}
}

/**
 * Run the export command. Production callers (`scripts/export-android.ts`)
 * inject the DB-backed loader; the remaining defaults are real filesystem
 * and clock behavior.
 */
export async function runLegacyExport(
	args: string[],
	deps: LegacyExportDeps = {},
): Promise<string> {
	const outputPath = parseOutputArgument(args);
	const loadRows = deps.loadRows;
	if (loadRows === undefined) {
		throw new Error("No legacy row source is configured for this export.");
	}
	const writeExclusive = deps.writeExclusive ?? writeExclusiveFile;
	const now = deps.now ?? (() => new Date());
	const rows = await loadRows();
	const body = serializeLegacyExport(rows, now());
	await writeExclusive(outputPath, body);
	return `Wrote ${rows.length} encrypted journal entries to ${outputPath}`;
}
