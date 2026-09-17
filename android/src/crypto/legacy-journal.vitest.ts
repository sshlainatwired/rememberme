// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { EncryptedJournal } from "./legacy-journal";
import { createJournalCipher } from "./legacy-journal";

/**
 * Hard-coded fixture produced by the ROOT web cipher, for cross-implementation
 * decrypt proof. This is not a reimplementation of the web layout; it is data.
 *
 * Provenance:
 * - Generated 2026-09-08 by the root web cipher
 *   `src/server/crypto/journal-encryption.ts` (`createJournalCipher`),
 *   executed under Bun 1.4.0 (Node-compatible WebCrypto) from the repo root.
 * - Key bytes are the root `tests/helpers.ts` TEST_KEY_BASE64: hex
 *   "0123456789abcdef" repeated 4x (32 bytes), standard base64
 *   "ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8=".
 * - Plaintext (below) was encrypted once with that web cipher and the returned
 *   `{ encryptedContent, iv, authTag }` was pasted here verbatim. The web
 *   cipher's own decrypt round-trip was asserted at generation time.
 */
const WEB_FIXTURE_KEY_BASE64 = "ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8=";
const WEB_FIXTURE_PLAINTEXT = "legacy-web-fixture-01: 日本語の日記 📖 café — trust but verify";
const WEB_FIXTURE: EncryptedJournal = {
	encryptedContent:
		"9o7QblLxhLPFLQWt8X5WeAKmkU0FmCEeu47Kvbt5nhsZMMxJUxJcoVb0rj9yPVcLHoc1ycVJxVYjtOumQsOqsonKIGqUDGyLrA==",
	iv: "Clm1mcXGvU5sDyLC",
	authTag: "hGsAjdnKCwEUXAzjG74Gxg==",
};

/** 32-byte key bytes shared with the root test helpers (hex 01 23 ... ef x4). */
const TEST_KEY_BASE64 = WEB_FIXTURE_KEY_BASE64;
/** A different, also-valid 32-byte key (hex "fedcba9876543210" x4). */
const OTHER_KEY_BASE64 = Buffer.from(
	"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
	"hex",
).toString("base64");
/** Valid base64 that decodes to only 16 bytes — must be rejected as a key. */
const SHORT_KEY_BASE64 = Buffer.from("0123456789abcdef", "hex").toString("base64");

const utf8Decoder = new TextDecoder("utf-8");
const utf8Encoder = new TextEncoder();

function b64toBytes(input: string): Uint8Array<ArrayBuffer> {
	const source = Buffer.from(input, "base64");
	const bytes = new Uint8Array(source.byteLength);
	bytes.set(source);
	return bytes;
}
function bytesToB64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}
/** Flip one bit in the decoded field so it stays valid base64 with a valid length. */
function tamper(input: string): string {
	const bytes = b64toBytes(input);
	const lastIndex = bytes.length - 1;
	bytes[lastIndex] ^= 0x01;
	return bytesToB64(bytes);
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Return a same-byte noncanonical standard-base64 encoding of `canonical`, or
 * null when the byte length is a multiple of three (no unused trailing bits
 * exist, so no alternate encoding does). The module encoder always zeroes the
 * unused trailing bits: a `=` final group leaves 2 unused bits (its last data
 * char is a multiple of 4), a `==` final group leaves 4 (a multiple of 16).
 * Bumping that final data char by one keeps it in the alphabet and leaves the
 * used bits untouched, so the bytes decode identically.
 */
function noncanonicalSameBytes(canonical: string): string | null {
	let pad = 0;
	if (canonical.endsWith("==")) pad = 2;
	else if (canonical.endsWith("=")) pad = 1;
	if (pad === 0) return null;
	const index = canonical.length - pad - 1;
	const bumped = BASE64_CHARS.indexOf(canonical[index]) + 1;
	return canonical.slice(0, index) + BASE64_CHARS[bumped] + canonical.slice(index + 1);
}

describe("legacy web AES-256-GCM journal cipher (Phase 7 import-only seam)", () => {
	test("empty content round-trips", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const encrypted = await cipher.encrypt("");
		expect(encrypted.encryptedContent).toBe("");
		expect(await cipher.decrypt(encrypted)).toBe("");
	});

	test("unicode content round-trips", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const content = "日本語の日記 📖 café — em dash";
		const encrypted = await cipher.encrypt(content);
		expect(await cipher.decrypt(encrypted)).toBe(content);
	});

	test("100k content round-trips", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const big = "a".repeat(100_000);
		const encrypted = await cipher.encrypt(big);
		expect(await cipher.decrypt(encrypted)).toBe(big);
	});

	test("emits the exact web layout: canonical base64, 12-byte IV, 16-byte tag", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const content = "layout proof";
		const encrypted = await cipher.encrypt(content);
		expect(encrypted.iv).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
		expect(encrypted.authTag).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
		expect(encrypted.encryptedContent).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
		expect(b64toBytes(encrypted.iv).length).toBe(12);
		expect(b64toBytes(encrypted.authTag).length).toBe(16);
		expect(encrypted.encryptedContent).not.toContain(content);
	});

	test("each encryption uses a fresh random IV and ciphertext", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const a = await cipher.encrypt("same content");
		const b = await cipher.encrypt("same content");
		expect(a.iv).not.toBe(b.iv);
		expect(a.encryptedContent).not.toBe(b.encryptedContent);
		expect(a.authTag).not.toBe(b.authTag);
	});

	test("tampering with ciphertext fails decryption", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const encrypted = await cipher.encrypt("do not touch");
		await expect(
			cipher.decrypt({ ...encrypted, encryptedContent: tamper(encrypted.encryptedContent) }),
		).rejects.toThrow();
	});

	test("tampering with the auth tag fails decryption", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const encrypted = await cipher.encrypt("authenticated");
		await expect(
			cipher.decrypt({ ...encrypted, authTag: tamper(encrypted.authTag) }),
		).rejects.toThrow();
	});

	test("tampering with the IV fails decryption", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const encrypted = await cipher.encrypt("authenticated");
		await expect(cipher.decrypt({ ...encrypted, iv: tamper(encrypted.iv) })).rejects.toThrow();
	});

	test("decrypting with a wrong 32-byte key fails", async () => {
		const cipherA = await createJournalCipher(TEST_KEY_BASE64);
		const cipherB = await createJournalCipher(OTHER_KEY_BASE64);
		const encrypted = await cipherA.encrypt("key-bound secret");
		await expect(cipherB.decrypt(encrypted)).rejects.toThrow();
	});

	test("failures are generic: never echo key, plaintext, or payload", async () => {
		const cipherA = await createJournalCipher(TEST_KEY_BASE64);
		const cipherB = await createJournalCipher(OTHER_KEY_BASE64);
		const plaintext = "echo-check secret diary line";
		const encrypted = await cipherA.encrypt(plaintext);

		for (const attempt of [
			() => cipherB.decrypt(encrypted),
			() => cipherA.decrypt({ ...encrypted, encryptedContent: tamper(encrypted.encryptedContent) }),
			() => cipherA.decrypt({ ...encrypted, authTag: tamper(encrypted.authTag) }),
			() => cipherA.decrypt({ ...encrypted, iv: tamper(encrypted.iv) }),
		]) {
			let message = "";
			try {
				await attempt();
				throw new Error("expected decryption to fail");
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).not.toContain(plaintext);
			expect(message).not.toContain(encrypted.encryptedContent);
			expect(message).not.toContain(encrypted.iv);
			expect(message).not.toContain(encrypted.authTag);
			expect(message).not.toContain(TEST_KEY_BASE64);
			expect(message).not.toContain(OTHER_KEY_BASE64);
		}
	});

	test("a fixture produced by the root web cipher decrypts", async () => {
		const cipher = await createJournalCipher(WEB_FIXTURE_KEY_BASE64);
		expect(await cipher.decrypt(WEB_FIXTURE)).toBe(WEB_FIXTURE_PLAINTEXT);
	});

	test("the web fixture fails with a different key", async () => {
		const wrong = await createJournalCipher(OTHER_KEY_BASE64);
		await expect(wrong.decrypt(WEB_FIXTURE)).rejects.toThrow();
	});

	test("the Android split layout decrypts with direct WebCrypto (data+tag recombined)", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const plaintext = "recombine proof: split ciphertext and tag must be real GCM";
		const encrypted = await cipher.encrypt(plaintext);

		const key = await globalThis.crypto.subtle.importKey(
			"raw",
			b64toBytes(TEST_KEY_BASE64),
			{ name: "AES-GCM" },
			false,
			["decrypt"],
		);
		const data = b64toBytes(encrypted.encryptedContent);
		const authTag = b64toBytes(encrypted.authTag);
		const combined = new Uint8Array(data.length + authTag.length);
		combined.set(data, 0);
		combined.set(authTag, data.length);
		const plain = await globalThis.crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: b64toBytes(encrypted.iv) },
			key,
			combined,
		);
		expect(utf8Decoder.decode(plain)).toBe(plaintext);
	});

	test("invalid keys are rejected before any crypto (non-base64, noncanonical, wrong length)", async () => {
		await expect(createJournalCipher("not-base64-!!")).rejects.toThrow();
		// SAFETY: hostile input exercising the non-string guard; the call must reject.
		const notAString: unknown = undefined;
		// URL-safe alphabet is not canonical standard base64.
		await expect(createJournalCipher(TEST_KEY_BASE64.replace("S", "-"))).rejects.toThrow();
		// Padding is required: dropping the trailing "=" leaves 43 chars.
		await expect(createJournalCipher(TEST_KEY_BASE64.slice(0, -1))).rejects.toThrow();
		// A base64 that decodes to 16 bytes is the wrong key length.
		await expect(createJournalCipher(SHORT_KEY_BASE64)).rejects.toThrow();
		await expect(createJournalCipher("")).rejects.toThrow();
		await expect(createJournalCipher(notAString as string)).rejects.toThrow();
	});

	test("a noncanonical key that decodes to the same 32 bytes rejects", async () => {
		// Canonical encoder emits zero unused trailing bits; bumping the key's
		// final data character flips only those unused bits, so the alternate
		// stays valid-shaped base64 yet decodes to the identical 32 bytes.
		const noncanonical = noncanonicalSameBytes(TEST_KEY_BASE64);
		if (noncanonical === null) throw new Error("expected a padded key fixture");
		expect(b64toBytes(noncanonical)).toEqual(b64toBytes(TEST_KEY_BASE64));
		await expect(createJournalCipher(noncanonical)).rejects.toThrow();
	});

	test("a noncanonical same-byte auth tag rejects before decrypt", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const encrypted = await cipher.encrypt("tag canonicality");
		const noncanonicalTag = noncanonicalSameBytes(encrypted.authTag);
		if (noncanonicalTag === null) throw new Error("expected a padded tag");
		// The alternate decodes to the same tag bytes, which would otherwise
		// authenticate — only the noncanonical encoding must fail, before any
		// decrypt attempt.
		expect(b64toBytes(noncanonicalTag)).toEqual(b64toBytes(encrypted.authTag));
		await expect(cipher.decrypt({ ...encrypted, authTag: noncanonicalTag })).rejects.toThrow();
	});

	test("malformed payloads reject before decrypt (missing/wrong-type fields, bad base64)", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const valid = await cipher.encrypt("payload validation");
		const missingIv = { encryptedContent: valid.encryptedContent, authTag: valid.authTag };
		const missingTag = { encryptedContent: valid.encryptedContent, iv: valid.iv };
		const missingContent = { iv: valid.iv, authTag: valid.authTag };
		const numberIv = { encryptedContent: valid.encryptedContent, iv: 12, authTag: valid.authTag };
		const objectContent = {
			encryptedContent: { not: "a string" },
			iv: valid.iv,
			authTag: valid.authTag,
		};
		const badBase64Content = {
			encryptedContent: "!!!not-base64!!!",
			iv: valid.iv,
			authTag: valid.authTag,
		};
		const badBase64Iv = { ...valid, iv: "not canonical!?" };
		const badBase64Tag = { ...valid, authTag: `!${valid.authTag.slice(1)}` };
		const shortIv = { ...valid, iv: bytesToB64(new Uint8Array(8)) };
		const shortTag = { ...valid, authTag: bytesToB64(new Uint8Array(15)) };
		const longTag = { ...valid, authTag: bytesToB64(new Uint8Array(17)) };
		const emptyIv = { ...valid, iv: "" };
		const emptyTag = { ...valid, authTag: "" };

		const cases: unknown[] = [
			null,
			"a string payload",
			missingIv,
			missingTag,
			missingContent,
			numberIv,
			objectContent,
			badBase64Content,
			badBase64Iv,
			badBase64Tag,
			shortIv,
			shortTag,
			longTag,
			emptyIv,
			emptyTag,
		];
		for (const payload of cases) {
			// SAFETY: test-only hostile payload; decrypt must reject it, never touch the key.
			await expect(cipher.decrypt(payload as EncryptedJournal)).rejects.toThrow();
		}
	});

	test("invalid UTF-8 plaintext fails closed with a generic error", async () => {
		// Build, with direct WebCrypto, a valid GCM ciphertext whose plaintext
		// bytes are not valid UTF-8 (0xc3 followed by a non-continuation byte).
		const key = await globalThis.crypto.subtle.importKey(
			"raw",
			b64toBytes(TEST_KEY_BASE64),
			{ name: "AES-GCM" },
			false,
			["encrypt"],
		);
		const iv = new Uint8Array(12);
		globalThis.crypto.getRandomValues(iv);
		const invalidUtf8 = new Uint8Array([0x63, 0xc3, 0x28, 0x61]);
		const combined = new Uint8Array(
			await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, invalidUtf8),
		);
		const payload: EncryptedJournal = {
			encryptedContent: bytesToB64(combined.slice(0, combined.length - 16)),
			iv: bytesToB64(iv),
			authTag: bytesToB64(combined.slice(combined.length - 16)),
		};

		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		let message = "";
		try {
			await cipher.decrypt(payload);
			throw new Error("expected UTF-8 decode to fail");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message.length).toBeGreaterThan(0);
		expect(message).not.toContain(payload.encryptedContent);
		expect(message).not.toContain(payload.authTag);
	});

	test("decrypt output of a direct-WebCrypto encryption round-trips", async () => {
		// Encrypt outside the module (raw AES-256-GCM, tag appended by WebCrypto),
		// then confirm the module decrypts the split {content, tag} layout.
		const key = await globalThis.crypto.subtle.importKey(
			"raw",
			b64toBytes(TEST_KEY_BASE64),
			{ name: "AES-GCM" },
			false,
			["encrypt"],
		);
		const plaintext = "reverse direction: direct ciphertext into the Android module";
		const iv = new Uint8Array(12);
		globalThis.crypto.getRandomValues(iv);
		const combined = new Uint8Array(
			await globalThis.crypto.subtle.encrypt(
				{ name: "AES-GCM", iv },
				key,
				utf8Encoder.encode(plaintext),
			),
		);
		const payload: EncryptedJournal = {
			encryptedContent: bytesToB64(combined.slice(0, combined.length - 16)),
			iv: bytesToB64(iv),
			authTag: bytesToB64(combined.slice(combined.length - 16)),
		};
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		expect(await cipher.decrypt(payload)).toBe(plaintext);
	});

	test("dispose is idempotent and invalidates retained key references", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const encrypted = await cipher.encrypt("dispose proof");
		cipher.dispose();
		cipher.dispose();
		await expect(cipher.encrypt("after dispose")).rejects.toThrow("disposed");
		await expect(cipher.decrypt(encrypted)).rejects.toThrow("disposed");
	});
});
