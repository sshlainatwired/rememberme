import { describe, expect, test } from "bun:test";
import { createJournalCipher } from "../src/server/crypto/journal-encryption";
import { base64ToBytes, bytesToBase64, OTHER_KEY_BASE64, TEST_KEY_BASE64 } from "./helpers";

describe("journal encryption (AES-256-GCM)", () => {
	test("encrypt/decrypt round-trip preserves content", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const content = "Dear diary: today I built a journal app.";
		const encrypted = await cipher.encrypt(content);
		const plaintext = await cipher.decrypt(encrypted);
		expect(plaintext).toBe(content);
	});

	test("each encryption uses a fresh IV", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const a = await cipher.encrypt("same content");
		const b = await cipher.encrypt("same content");
		expect(a.iv).not.toBe(b.iv);
		expect(a.encryptedContent).not.toBe(b.encryptedContent);
	});

	test("ciphertext is not the plaintext", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const encrypted = await cipher.encrypt("secret journal text");
		expect(encrypted.encryptedContent).not.toContain("secret");
		// base64 alphabet check: ciphertext must be fully encoded
		expect(encrypted.encryptedContent).toMatch(/^[A-Za-z0-9+/]+=*$/);
	});

	test("tampering with ciphertext fails decryption", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const encrypted = await cipher.encrypt("do not touch");
		const tampered = {
			...encrypted,
			encryptedContent: bytesToBase64(
				Uint8Array.from([...base64ToBytes(encrypted.encryptedContent).slice(0, -1), 0]),
			),
		};
		await expect(cipher.decrypt(tampered)).rejects.toThrow();
	});

	test("tampering with auth tag fails decryption", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const encrypted = await cipher.encrypt("authenticated");
		const tampered = {
			...encrypted,
			authTag: bytesToBase64(
				Uint8Array.from([...base64ToBytes(encrypted.authTag).slice(0, -1), 0]),
			),
		};
		await expect(cipher.decrypt(tampered)).rejects.toThrow();
	});

	test("tampering with IV fails decryption", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const encrypted = await cipher.encrypt("authenticated");
		const tampered = {
			...encrypted,
			iv: bytesToBase64(Uint8Array.from([...base64ToBytes(encrypted.iv).slice(0, -1), 0])),
		};
		await expect(cipher.decrypt(tampered)).rejects.toThrow();
	});

	test("decrypting with a wrong key fails", async () => {
		const cipherA = await createJournalCipher(TEST_KEY_BASE64);
		const cipherB = await createJournalCipher(OTHER_KEY_BASE64);
		const encrypted = await cipherA.encrypt("key-bound secret");
		await expect(cipherB.decrypt(encrypted)).rejects.toThrow();
	});

	test("empty content round-trips", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const encrypted = await cipher.encrypt("");
		expect(await cipher.decrypt(encrypted)).toBe("");
	});

	test("large content round-trips", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const big = "a".repeat(100_000);
		const encrypted = await cipher.encrypt(big);
		expect(await cipher.decrypt(encrypted)).toBe(big);
	});

	test("unicode content round-trips", async () => {
		const cipher = await createJournalCipher(TEST_KEY_BASE64);
		const content = "日本語の日記 📖 café — em dash";
		const encrypted = await cipher.encrypt(content);
		expect(await cipher.decrypt(encrypted)).toBe(content);
	});

	test("invalid key is rejected", async () => {
		await expect(createJournalCipher("not-base64-!!")).rejects.toThrow();
		await expect(createJournalCipher(Buffer.alloc(16).toString("base64"))).rejects.toThrow();
	});
});
