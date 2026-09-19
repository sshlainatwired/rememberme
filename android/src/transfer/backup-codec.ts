import { scryptAsync } from "@noble/hashes/scrypt.js";
import {
	isCalendarDate,
	isTimezoneSupported,
	journalContentSchema,
	parseTransferInstant,
} from "@rememberme/core";
import { decodeBase64, decodeUtf8, encodeBase64, encodeUtf8, wipe } from "./base64";

export const MAX_TRANSFER_BYTES = 16 * 1024 * 1024;
export const MAX_TRANSFER_ROWS = 10_000;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 3, dkLen: 64, maxmem: 41_943_040 } as const;

const UNSUPPORTED = "This backup file is not supported.";
const UNLOCK_FAILED = "Could not unlock this backup.";
const INVALID_CONTENT = "Backup content is invalid.";
const DAMAGED_CONTENT = "This backup is damaged or incompatible.";
const TOO_LARGE = "Backup file is too large.";

export interface PortableSettings {
	timezone: string;
	weeklyReviewEnabled: boolean;
	weeklyReviewHour: number;
	appearance: "system" | "light" | "dark";
}

export interface TransferEntry {
	date: string;
	content: string;
	createdAt: string;
	updatedAt: string;
}

export interface BackupPayload {
	format: "rememberme-backup-content";
	version: 1;
	exportedAt: string;
	entries: TransferEntry[];
	settings: PortableSettings;
}

export interface BackupCodec {
	encrypt(payload: BackupPayload, password: string): Promise<string>;
	decrypt(archive: string, password: string): Promise<BackupPayload>;
}

export type ScryptDeriver = (password: Uint8Array, salt: Uint8Array) => Promise<Uint8Array>;

interface BackupCodecDependencies {
	derive: ScryptDeriver;
	randomBytes(length: number): Uint8Array;
}

interface ParsedEnvelope {
	header: BackupHeader;
	headerBytes: Uint8Array<ArrayBuffer>;
	salt: Uint8Array<ArrayBuffer>;
	iv: Uint8Array<ArrayBuffer>;
	verifier: Uint8Array<ArrayBuffer>;
	ciphertext: Uint8Array<ArrayBuffer>;
}

interface BackupHeader {
	format: "rememberme-backup";
	version: 1;
	kdf: {
		algorithm: "scrypt";
		N: 32768;
		r: 8;
		p: 3;
		dkLen: 64;
		salt: string;
	};
	cipher: {
		algorithm: "AES-256-GCM";
		iv: string;
		tagLength: 128;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
	const wanted = [...expected].sort((left, right) => left.localeCompare(right));
	return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validatePassword(password: string): Uint8Array<ArrayBuffer> {
	if (
		typeof password !== "string" ||
		password.length < PASSWORD_MIN ||
		password.length > PASSWORD_MAX
	) {
		throw new Error(`Backup password must be ${PASSWORD_MIN}..${PASSWORD_MAX} characters.`);
	}
	return encodeUtf8(password);
}

function validatePayload(value: unknown): BackupPayload {
	try {
		if (
			!isRecord(value) ||
			!hasExactKeys(value, ["format", "version", "exportedAt", "entries", "settings"])
		) {
			throw new Error();
		}
		if (value.format !== "rememberme-backup-content" || value.version !== 1) throw new Error();
		const exportedAt = parseTransferInstant(value.exportedAt, "exportedAt");
		if (!Array.isArray(value.entries) || value.entries.length > MAX_TRANSFER_ROWS)
			throw new Error();
		const entries: TransferEntry[] = [];
		let previousDate: string | null = null;
		for (const candidate of value.entries) {
			if (
				!isRecord(candidate) ||
				!hasExactKeys(candidate, ["date", "content", "createdAt", "updatedAt"])
			) {
				throw new Error();
			}
			if (typeof candidate.date !== "string" || !isCalendarDate(candidate.date)) throw new Error();
			if (previousDate !== null && candidate.date <= previousDate) throw new Error();
			const parsedContent = journalContentSchema.safeParse(candidate.content);
			if (!parsedContent.success) throw new Error();
			const createdAt = parseTransferInstant(candidate.createdAt, "createdAt");
			const updatedAt = parseTransferInstant(candidate.updatedAt, "updatedAt");
			if (createdAt > updatedAt) throw new Error();
			entries.push({ date: candidate.date, content: parsedContent.data, createdAt, updatedAt });
			previousDate = candidate.date;
		}
		if (
			!isRecord(value.settings) ||
			!hasExactKeys(value.settings, [
				"timezone",
				"weeklyReviewEnabled",
				"weeklyReviewHour",
				"appearance",
			])
		) {
			throw new Error();
		}
		const { timezone, weeklyReviewEnabled, weeklyReviewHour, appearance } = value.settings;
		if (typeof timezone !== "string" || !isTimezoneSupported(timezone)) throw new Error();
		if (typeof weeklyReviewEnabled !== "boolean") throw new Error();
		if (
			typeof weeklyReviewHour !== "number" ||
			!Number.isInteger(weeklyReviewHour) ||
			weeklyReviewHour < 0 ||
			weeklyReviewHour > 23
		) {
			throw new Error();
		}
		if (appearance !== "system" && appearance !== "light" && appearance !== "dark")
			throw new Error();
		return {
			format: "rememberme-backup-content",
			version: 1,
			exportedAt,
			entries,
			settings: { timezone, weeklyReviewEnabled, weeklyReviewHour, appearance },
		};
	} catch {
		throw new Error(INVALID_CONTENT);
	}
}

function canonicalHeader(salt: string, iv: string): BackupHeader {
	return {
		format: "rememberme-backup",
		version: 1,
		kdf: {
			algorithm: "scrypt",
			N: SCRYPT_OPTIONS.N,
			r: SCRYPT_OPTIONS.r,
			p: SCRYPT_OPTIONS.p,
			dkLen: SCRYPT_OPTIONS.dkLen,
			salt,
		},
		cipher: { algorithm: "AES-256-GCM", iv, tagLength: 128 },
	};
}

function concatenate(first: Uint8Array, second: Uint8Array): Uint8Array<ArrayBuffer> {
	const result = new Uint8Array(first.length + second.length);
	result.set(first);
	result.set(second, first.length);
	return result;
}

function constantTimeEqual(first: Uint8Array, second: Uint8Array): boolean {
	if (first.length !== second.length) return false;
	let difference = 0;
	for (let index = 0; index < first.length; index += 1) difference |= first[index] ^ second[index];
	return difference === 0;
}

function assertArchiveSize(archive: string): void {
	const bytes = encodeUtf8(archive);
	try {
		if (bytes.length > MAX_TRANSFER_BYTES) throw new Error(TOO_LARGE);
	} finally {
		wipe(bytes);
	}
}

function parseEnvelope(archive: string): ParsedEnvelope {
	assertArchiveSize(archive);
	let value: unknown;
	try {
		value = JSON.parse(archive);
	} catch {
		throw new Error(UNSUPPORTED);
	}
	try {
		if (
			!isRecord(value) ||
			!hasExactKeys(value, ["format", "version", "kdf", "cipher", "verifier", "ciphertext"])
		)
			throw new Error();
		if (value.format !== "rememberme-backup" || value.version !== 1) throw new Error();
		if (
			!isRecord(value.kdf) ||
			!hasExactKeys(value.kdf, ["algorithm", "N", "r", "p", "dkLen", "salt"])
		)
			throw new Error();
		if (
			value.kdf.algorithm !== "scrypt" ||
			value.kdf.N !== SCRYPT_OPTIONS.N ||
			value.kdf.r !== SCRYPT_OPTIONS.r ||
			value.kdf.p !== SCRYPT_OPTIONS.p ||
			value.kdf.dkLen !== SCRYPT_OPTIONS.dkLen
		)
			throw new Error();
		if (!isRecord(value.cipher) || !hasExactKeys(value.cipher, ["algorithm", "iv", "tagLength"]))
			throw new Error();
		if (value.cipher.algorithm !== "AES-256-GCM" || value.cipher.tagLength !== 128)
			throw new Error();
		const salt = decodeBase64(value.kdf.salt, "Backup salt");
		const iv = decodeBase64(value.cipher.iv, "Backup IV");
		const verifier = decodeBase64(value.verifier, "Backup verifier");
		const ciphertext = decodeBase64(value.ciphertext, "Backup ciphertext");
		if (
			salt.length !== 16 ||
			iv.length !== 12 ||
			verifier.length !== 16 ||
			ciphertext.length < 16
		) {
			wipe(salt, iv, verifier, ciphertext);
			throw new Error();
		}
		const header = canonicalHeader(value.kdf.salt as string, value.cipher.iv as string);
		return {
			header,
			headerBytes: encodeUtf8(JSON.stringify(header)),
			salt,
			iv,
			verifier,
			ciphertext,
		};
	} catch {
		throw new Error(UNSUPPORTED);
	}
}

async function verifierFor(
	subtle: SubtleCrypto,
	keyBytes: Uint8Array<ArrayBuffer>,
	headerBytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	const key = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const signature = await subtle.sign("HMAC", key, headerBytes);
	return new Uint8Array(signature.slice(0, 16));
}

function codec(dependencies: BackupCodecDependencies): BackupCodec {
	return {
		async encrypt(payload: BackupPayload, password: string): Promise<string> {
			const checkedPayload = validatePayload(payload);
			const passwordBytes = validatePassword(password);
			const salt = new Uint8Array(dependencies.randomBytes(16));
			const iv = new Uint8Array(dependencies.randomBytes(12));
			let derived: Uint8Array<ArrayBuffer> | undefined;
			let aesBytes: Uint8Array<ArrayBuffer> | undefined;
			let verifierBytes: Uint8Array<ArrayBuffer> | undefined;
			let plaintext: Uint8Array<ArrayBuffer> | undefined;
			let ciphertext: Uint8Array<ArrayBuffer> | undefined;
			let verifier: Uint8Array<ArrayBuffer> | undefined;
			let additionalData: Uint8Array<ArrayBuffer> | undefined;
			let aesKey: CryptoKey | null = null;
			try {
				if (salt.length !== 16 || iv.length !== 12) throw new Error("Secure randomness failed.");
				const header = canonicalHeader(encodeBase64(salt), encodeBase64(iv));
				const headerBytes = encodeUtf8(JSON.stringify(header));
				try {
					derived = new Uint8Array(await dependencies.derive(passwordBytes, salt));
					if (derived.length !== 64) throw new Error("Key derivation failed.");
					aesBytes = derived.slice(0, 32);
					verifierBytes = derived.slice(32);
					verifier = await verifierFor(globalThis.crypto.subtle, verifierBytes, headerBytes);
					aesKey = await globalThis.crypto.subtle.importKey("raw", aesBytes, "AES-GCM", false, [
						"encrypt",
					]);
					plaintext = encodeUtf8(JSON.stringify(checkedPayload));
					additionalData = concatenate(headerBytes, verifier);
					ciphertext = new Uint8Array(
						await globalThis.crypto.subtle.encrypt(
							{ name: "AES-GCM", iv, additionalData, tagLength: 128 },
							aesKey,
							plaintext,
						),
					);
					const archive = JSON.stringify({
						...header,
						verifier: encodeBase64(verifier),
						ciphertext: encodeBase64(ciphertext),
					});
					assertArchiveSize(archive);
					return archive;
				} finally {
					wipe(headerBytes);
				}
			} finally {
				aesKey = null;
				wipe(
					passwordBytes,
					salt,
					iv,
					derived,
					aesBytes,
					verifierBytes,
					plaintext,
					ciphertext,
					verifier,
					additionalData,
				);
			}
		},

		async decrypt(archive: string, password: string): Promise<BackupPayload> {
			const passwordBytes = validatePassword(password);
			const parsed = parseEnvelope(archive);
			let derived: Uint8Array<ArrayBuffer> | undefined;
			let aesBytes: Uint8Array<ArrayBuffer> | undefined;
			let verifierBytes: Uint8Array<ArrayBuffer> | undefined;
			let expectedVerifier: Uint8Array<ArrayBuffer> | undefined;
			let additionalData: Uint8Array<ArrayBuffer> | undefined;
			let plaintext: Uint8Array<ArrayBuffer> | undefined;
			let aesKey: CryptoKey | null = null;
			try {
				derived = new Uint8Array(await dependencies.derive(passwordBytes, parsed.salt));
				if (derived.length !== 64) throw new Error(UNLOCK_FAILED);
				aesBytes = derived.slice(0, 32);
				verifierBytes = derived.slice(32);
				expectedVerifier = await verifierFor(
					globalThis.crypto.subtle,
					verifierBytes,
					parsed.headerBytes,
				);
				if (!constantTimeEqual(expectedVerifier, parsed.verifier)) throw new Error(UNLOCK_FAILED);
				aesKey = await globalThis.crypto.subtle.importKey("raw", aesBytes, "AES-GCM", false, [
					"decrypt",
				]);
				additionalData = concatenate(parsed.headerBytes, parsed.verifier);
				try {
					plaintext = new Uint8Array(
						await globalThis.crypto.subtle.decrypt(
							{ name: "AES-GCM", iv: parsed.iv, additionalData, tagLength: 128 },
							aesKey,
							parsed.ciphertext,
						),
					);
				} catch {
					throw new Error(UNLOCK_FAILED);
				}
				let decoded: unknown;
				try {
					decoded = JSON.parse(decodeUtf8(plaintext, "Backup content"));
					return validatePayload(decoded);
				} catch {
					throw new Error(DAMAGED_CONTENT);
				}
			} finally {
				aesKey = null;
				wipe(
					passwordBytes,
					parsed.salt,
					parsed.iv,
					parsed.verifier,
					parsed.ciphertext,
					parsed.headerBytes,
					derived,
					aesBytes,
					verifierBytes,
					expectedVerifier,
					additionalData,
					plaintext,
				);
			}
		},
	};
}

const productionDependencies: BackupCodecDependencies = {
	derive: async (password, salt) =>
		new Uint8Array(await scryptAsync(password, salt, SCRYPT_OPTIONS)),
	randomBytes(length) {
		const bytes = new Uint8Array(length);
		globalThis.crypto.getRandomValues(bytes);
		return bytes;
	},
};

export function createBackupCodec(): BackupCodec {
	return codec(productionDependencies);
}

/** Internal deterministic seam for codec tests; not re-exported by an index. */
export function createBackupCodecForTest(overrides: Partial<BackupCodecDependencies>): BackupCodec {
	return codec({ ...productionDependencies, ...overrides });
}
