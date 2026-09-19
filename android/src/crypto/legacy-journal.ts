import { decodeBase64, decodeUtf8, encodeBase64, encodeUtf8, wipe } from "../transfer/base64";

/**
 * Legacy web AES-256-GCM journal layout — import-only compatibility seam.
 *
 * Reads and writes exactly the web cipher layout (root
 * `src/server/crypto/journal-encryption.ts`) for Phase 7 imports:
 * canonical base64 `{ encryptedContent, iv, authTag }`, AES-256-GCM with a
 * fresh random 12-byte IV and the 16-byte GCM tag split from the ciphertext.
 *
 * This is NOT Android's at-rest format (SQLCipher owns that) and must never
 * be promoted to one. It is dependency-free and uses only WebCrypto
 * (`globalThis.crypto.subtle`).
 *
 * Guarantees:
 * - standard canonical base64 only; the source key decodes to exactly 32 bytes
 * - the imported `CryptoKey` is non-extractable
 * - decoded raw key bytes are zeroed in `finally` after `subtle.importKey`
 * - field types/base64 and exact IV (12) and tag (16) lengths validate before
 *   any decrypt attempt
 * - authenticated-decryption failures are generic: they never echo the key,
 *   plaintext, or payload
 * - UTF-8 decoding is fatal and fails closed on malformed bytes
 */
export interface EncryptedJournal {
	/** base64 ciphertext (without the 16-byte GCM tag) */
	encryptedContent: string;
	/** base64 12-byte random initialization vector */
	iv: string;
	/** base64 16-byte GCM authentication tag */
	authTag: string;
}

export interface JournalCipher {
	encrypt(content: string): Promise<EncryptedJournal>;
	decrypt(payload: EncryptedJournal): Promise<string>;
	dispose(): void;
}

/** Read one string field off a hostile payload; throws generic, echoes no value. */
function readField(payload: unknown, field: keyof EncryptedJournal): string {
	if (typeof payload !== "object" || payload === null) {
		throw new Error("Journal payload must be an object.");
	}
	const value = (payload as Record<string, unknown>)[field];
	if (typeof value !== "string") {
		throw new Error(`Journal payload field "${field}" must be a base64 string.`);
	}
	return value;
}

/**
 * Create a cipher bound to a standard-base64 256-bit key, mirroring the web
 * `createJournalCipher` contract so Phase 7 can import web rows unchanged.
 */
export async function createJournalCipher(keyBase64: string): Promise<JournalCipher> {
	const keyBytes = decodeBase64(keyBase64, "Journal key");
	try {
		if (keyBytes.length !== 32) {
			throw new Error("Journal key must decode to exactly 32 bytes (AES-256-GCM).");
		}
		const cryptoApi = globalThis.crypto;
		if (!cryptoApi?.subtle) throw new Error("WebCrypto is not available in this runtime.");
		const subtle = cryptoApi.subtle;
		let key: CryptoKey | null = await subtle.importKey(
			"raw",
			keyBytes,
			{ name: "AES-GCM" },
			false,
			["encrypt", "decrypt"],
		);
		const activeKey = (): CryptoKey => {
			if (key === null) throw new Error("Journal cipher has been disposed.");
			return key;
		};

		return {
			async encrypt(content: string): Promise<EncryptedJournal> {
				const iv = new Uint8Array(12);
				const plaintext = encodeUtf8(content);
				let ciphertext: Uint8Array<ArrayBuffer> | undefined;
				let authTag: Uint8Array<ArrayBuffer> | undefined;
				let encryptedContent: Uint8Array<ArrayBuffer> | undefined;
				try {
					cryptoApi.getRandomValues(iv);
					ciphertext = new Uint8Array(
						await subtle.encrypt({ name: "AES-GCM", iv }, activeKey(), plaintext),
					);
					authTag = ciphertext.slice(ciphertext.length - 16);
					encryptedContent = ciphertext.slice(0, ciphertext.length - 16);
					return {
						encryptedContent: encodeBase64(encryptedContent),
						iv: encodeBase64(iv),
						authTag: encodeBase64(authTag),
					};
				} finally {
					wipe(iv, plaintext, ciphertext, authTag, encryptedContent);
				}
			},

			async decrypt(payload: EncryptedJournal): Promise<string> {
				let iv: Uint8Array<ArrayBuffer> | undefined;
				let authTag: Uint8Array<ArrayBuffer> | undefined;
				let encryptedContent: Uint8Array<ArrayBuffer> | undefined;
				let combined: Uint8Array<ArrayBuffer> | undefined;
				let plaintext: Uint8Array<ArrayBuffer> | undefined;
				try {
					const keyForOperation = activeKey();
					iv = decodeBase64(readField(payload, "iv"), "Journal payload IV");
					if (iv.length !== 12) {
						throw new Error("Journal payload IV must decode to exactly 12 bytes.");
					}
					authTag = decodeBase64(readField(payload, "authTag"), "Journal payload auth tag");
					if (authTag.length !== 16) {
						throw new Error("Journal payload auth tag must decode to exactly 16 bytes.");
					}
					encryptedContent = decodeBase64(
						readField(payload, "encryptedContent"),
						"Journal payload content",
					);
					combined = new Uint8Array(encryptedContent.length + authTag.length);
					combined.set(encryptedContent, 0);
					combined.set(authTag, encryptedContent.length);
					try {
						plaintext = new Uint8Array(
							await subtle.decrypt({ name: "AES-GCM", iv }, keyForOperation, combined),
						);
					} catch {
						throw new Error("Failed to authenticate journal content.");
					}
					return decodeUtf8(plaintext, "Journal content");
				} finally {
					wipe(iv, authTag, encryptedContent, combined, plaintext);
				}
			},

			dispose(): void {
				key = null;
			},
		};
	} finally {
		wipe(keyBytes);
	}
}
