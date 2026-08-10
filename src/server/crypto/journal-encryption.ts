import { getConfig } from "../config";
import { base64ToBytes, bytesToBase64, decodeEncryptionKey } from "./key";

/**
 * Journal content encryption.
 *
 * AES-256-GCM via the runtime's WebCrypto API (Bun/Node). No cryptography is
 * implemented by hand. Each encryption uses a fresh random 12-byte IV; the
 * GCM authentication tag (16 bytes) is stored alongside the ciphertext.
 *
 * The rest of the application only ever sees `encryptJournal` /
 * `decryptJournal` — never the key, IVs, or ciphertext layout.
 */

export interface EncryptedJournal {
	/** base64 ciphertext (without the GCM tag) */
	encryptedContent: string;
	/** base64 12-byte initialization vector */
	iv: string;
	/** base64 16-byte GCM authentication tag */
	authTag: string;
}

export interface JournalCipher {
	encrypt(content: string): Promise<EncryptedJournal>;
	decrypt(payload: EncryptedJournal): Promise<string>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Create a cipher bound to a base64-encoded 256-bit key.
 * Throws when the key is invalid (wrong encoding or length).
 */
export async function createJournalCipher(keyBase64: string): Promise<JournalCipher> {
	const keyBytes = decodeEncryptionKey(keyBase64);
	const subtle = globalThis.crypto.subtle;
	const key = await subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, [
		"encrypt",
		"decrypt",
	]);

	return {
		async encrypt(content: string): Promise<EncryptedJournal> {
			const iv = new Uint8Array(12);
			crypto.getRandomValues(iv);
			const ciphertext = new Uint8Array(
				await subtle.encrypt(
					{ name: "AES-GCM", iv: iv as BufferSource },
					key,
					encoder.encode(content),
				),
			);
			// WebCrypto appends the 16-byte GCM tag to the ciphertext.
			const authTag = ciphertext.slice(ciphertext.length - 16);
			const data = ciphertext.slice(0, ciphertext.length - 16);
			return {
				encryptedContent: bytesToBase64(data),
				iv: bytesToBase64(iv),
				authTag: bytesToBase64(authTag),
			};
		},

		async decrypt(payload: EncryptedJournal): Promise<string> {
			const iv = base64ToBytes(payload.iv);
			const authTag = base64ToBytes(payload.authTag);
			const data = base64ToBytes(payload.encryptedContent);
			const combined = new Uint8Array(data.length + authTag.length);
			combined.set(data, 0);
			combined.set(authTag, data.length);
			const plaintext = await subtle.decrypt(
				{ name: "AES-GCM", iv: iv as BufferSource },
				key,
				combined as BufferSource,
			);
			return decoder.decode(plaintext);
		},
	};
}

let cipherPromise: Promise<JournalCipher> | null = null;

/**
 * Singleton cipher bound to the configured JOURNAL_ENCRYPTION_KEY.
 * Pass `config` in tests to use a custom key.
 */
export function getCipher(config = getConfig()): Promise<JournalCipher> {
	if (!cipherPromise) {
		cipherPromise = createJournalCipher(config.JOURNAL_ENCRYPTION_KEY);
	}
	return cipherPromise;
}
