/**
 * JOURNAL_ENCRYPTION_KEY handling — a base64-encoded 256-bit (32 byte) key,
 * generated with `openssl rand -base64 32`. The key never leaves the server
 * environment and is never stored in the database.
 */

/** True when `key` is base64 that decodes to exactly 32 bytes. */
export function isBase64EncodedKey(key: string): boolean {
	if (!key) return false;
	try {
		return base64ToBytes(key).length === 32;
	} catch {
		return false;
	}
}

/** Decode a base64-encoded 32-byte key; throws on invalid input/length. */
export function decodeEncryptionKey(key: string): Uint8Array {
	const bytes = base64ToBytes(key);
	if (bytes.length !== 32) {
		throw new Error("JOURNAL_ENCRYPTION_KEY must decode to exactly 32 bytes (256-bit AES key).");
	}
	return bytes;
}

/** Decode a standard (non-URL-safe) base64 string to bytes. */
export function base64ToBytes(base64: string): Uint8Array {
	if (typeof atob !== "function") {
		throw new Error("base64 decoding requires atob (not available in this runtime)");
	}
	const binary = atob(base64);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/** Encode bytes as standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
	if (typeof btoa !== "function") {
		throw new Error("base64 encoding requires btoa (not available in this runtime)");
	}
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}
