import {
	isCalendarDate,
	JOURNAL_CONTENT_MAX,
	journalContentSchema,
	parseTransferInstant,
} from "@rememberme/core";
import {
	createJournalCipher,
	type EncryptedJournal,
	type JournalCipher,
} from "@/crypto/legacy-journal";
import type { TransferEntry } from "./backup-codec";
import { MAX_TRANSFER_BYTES, MAX_TRANSFER_ROWS } from "./backup-codec";
import { decodeBase64, encodeUtf8, wipe } from "./base64";

const UNSUPPORTED = "This legacy export is not supported.";
const DECRYPT_FAILED = "Could not decrypt legacy journal.";
const MAX_CIPHERTEXT_BYTES = JOURNAL_CONTENT_MAX * 4;

export interface LegacyExportRow {
	entryDate: string;
	encryptedContent: string;
	iv: string;
	authTag: string;
	createdAt: string;
	updatedAt: string;
}

type CipherFactory = (keyBase64: string) => Promise<JournalCipher>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
	const expected = [...keys].sort((left, right) => left.localeCompare(right));
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function checkBase64(value: unknown, label: string, length?: number): string {
	const bytes = decodeBase64(value, label);
	try {
		if (length !== undefined && bytes.length !== length) throw new Error(UNSUPPORTED);
		if (label === "Legacy ciphertext" && bytes.length > MAX_CIPHERTEXT_BYTES) {
			throw new Error(UNSUPPORTED);
		}
		return value as string;
	} finally {
		wipe(bytes);
	}
}

function parseRows(source: string): LegacyExportRow[] {
	const sourceBytes = encodeUtf8(source);
	try {
		if (sourceBytes.length > MAX_TRANSFER_BYTES) throw new Error("Legacy export is too large.");
	} finally {
		wipe(sourceBytes);
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(source);
	} catch {
		throw new Error(UNSUPPORTED);
	}
	try {
		if (
			!isRecord(decoded) ||
			!hasExactKeys(decoded, ["format", "version", "exportedAt", "entries"])
		) {
			throw new Error();
		}
		if (decoded.format !== "rememberme-legacy-export" || decoded.version !== 1) throw new Error();
		parseTransferInstant(decoded.exportedAt, "exportedAt");
		if (!Array.isArray(decoded.entries) || decoded.entries.length > MAX_TRANSFER_ROWS)
			throw new Error();
		if (decoded.entries.length === 0) {
			throw new Error("Legacy export has no rows to authenticate.");
		}
		const rows: LegacyExportRow[] = [];
		let previousDate: string | null = null;
		for (const candidate of decoded.entries) {
			if (
				!isRecord(candidate) ||
				!hasExactKeys(candidate, [
					"entryDate",
					"encryptedContent",
					"iv",
					"authTag",
					"createdAt",
					"updatedAt",
				])
			) {
				throw new Error();
			}
			if (
				typeof candidate.entryDate !== "string" ||
				!isCalendarDate(candidate.entryDate) ||
				(previousDate !== null && candidate.entryDate <= previousDate)
			) {
				throw new Error();
			}
			const createdAt = parseTransferInstant(candidate.createdAt, "createdAt");
			const updatedAt = parseTransferInstant(candidate.updatedAt, "updatedAt");
			if (createdAt > updatedAt) throw new Error();
			rows.push({
				entryDate: candidate.entryDate,
				encryptedContent: checkBase64(candidate.encryptedContent, "Legacy ciphertext"),
				iv: checkBase64(candidate.iv, "Legacy IV", 12),
				authTag: checkBase64(candidate.authTag, "Legacy auth tag", 16),
				createdAt,
				updatedAt,
			});
			previousDate = candidate.entryDate;
		}
		return rows;
	} catch (cause) {
		if (cause instanceof Error && cause.message === "Legacy export has no rows to authenticate.") {
			throw cause;
		}
		throw new Error(UNSUPPORTED);
	}
}

export async function decryptLegacyExport(
	source: string,
	keyBase64: string,
): Promise<TransferEntry[]> {
	return decryptLegacyExportForTest(source, keyBase64, createJournalCipher);
}

/** Internal deterministic seam for sequential-decrypt and disposal tests. */
export async function decryptLegacyExportForTest(
	source: string,
	keyBase64: string,
	createCipher: CipherFactory,
): Promise<TransferEntry[]> {
	const rows = parseRows(source);
	let cipher: JournalCipher | null = null;
	let entries: TransferEntry[];
	try {
		cipher = await createCipher(keyBase64);
		entries = [];
		for (const row of rows) {
			const payload: EncryptedJournal = {
				encryptedContent: row.encryptedContent,
				iv: row.iv,
				authTag: row.authTag,
			};
			let content: string;
			try {
				content = await cipher.decrypt(payload);
			} catch {
				throw new Error(DECRYPT_FAILED);
			}
			const parsed = journalContentSchema.safeParse(content);
			if (!parsed.success) throw new Error(DECRYPT_FAILED);
			entries.push({
				date: row.entryDate,
				content: parsed.data,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
			});
		}
	} catch (cause) {
		const failure =
			cause instanceof Error && cause.message === DECRYPT_FAILED
				? cause
				: new Error(DECRYPT_FAILED);
		try {
			cipher?.dispose();
		} catch {
			// Preserve the primary create/decrypt/validation failure.
		}
		throw failure;
	}
	try {
		cipher.dispose();
	} catch {
		throw new Error(DECRYPT_FAILED);
	}
	return entries;
}
