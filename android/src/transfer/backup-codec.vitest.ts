// @vitest-environment node
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { describe, expect, test, vi } from "vitest";
import {
	type BackupPayload,
	createBackupCodec,
	createBackupCodecForTest,
	type ScryptDeriver,
} from "./backup-codec.ts";
import { decodeBase64, encodeBase64, encodeUtf8 } from "./base64";

const PAYLOAD: BackupPayload = {
	format: "rememberme-backup-content",
	version: 1,
	exportedAt: "2026-09-11T03:33:06.906Z",
	entries: [
		{
			date: "2026-09-10",
			content: "first 📖",
			createdAt: "2026-09-10T01:02:03.004Z",
			updatedAt: "2026-09-10T05:06:07.008Z",
		},
	],
	settings: {
		timezone: "UTC",
		weeklyReviewEnabled: true,
		weeklyReviewHour: 18,
		appearance: "dark",
	},
};

const fakeDerive: ScryptDeriver = async (
	password: Uint8Array,
	salt: Uint8Array,
): Promise<Uint8Array> => {
	const seed = [...password, ...salt].reduce((total, value) => (total + value) & 255, 0);
	return Uint8Array.from({ length: 64 }, (_, index) => (seed + index) & 255);
};

function deterministicCodec(derive: ScryptDeriver = fakeDerive) {
	let call = 0;
	return createBackupCodecForTest({
		derive,
		randomBytes(length: number) {
			const start = call++ * 32;
			return Uint8Array.from({ length }, (_, index) => (start + index + 1) & 255);
		},
	});
}

function mutateBase64(value: string): string {
	const bytes = decodeBase64(value, "fixture");
	const last = bytes.length - 1;
	bytes[last] ^= 1;
	return encodeBase64(bytes);
}

interface MutableEnvelope extends Record<string, unknown> {
	kdf: Record<string, unknown>;
	cipher: Record<string, unknown> & { iv: string };
	verifier: string;
	ciphertext: string;
}

async function authenticatedArchive(rawPayload: unknown, password: string): Promise<string> {
	const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
	const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 33);
	const header = {
		format: "rememberme-backup",
		version: 1,
		kdf: {
			algorithm: "scrypt",
			N: 32768,
			r: 8,
			p: 3,
			dkLen: 64,
			salt: encodeBase64(salt),
		},
		cipher: { algorithm: "AES-256-GCM", iv: encodeBase64(iv), tagLength: 128 },
	};
	const headerBytes = encodeUtf8(JSON.stringify(header));
	const derived = await fakeDerive(encodeUtf8(password), salt);
	const hmacKey = await crypto.subtle.importKey(
		"raw",
		derived.slice(32),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const verifier = new Uint8Array(
		(await crypto.subtle.sign("HMAC", hmacKey, headerBytes)).slice(0, 16),
	);
	const additionalData = new Uint8Array(headerBytes.length + verifier.length);
	additionalData.set(headerBytes);
	additionalData.set(verifier, headerBytes.length);
	const aesKey = await crypto.subtle.importKey("raw", derived.slice(0, 32), "AES-GCM", false, [
		"encrypt",
	]);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData, tagLength: 128 },
			aesKey,
			encodeUtf8(JSON.stringify(rawPayload)),
		),
	);
	return JSON.stringify({
		...header,
		verifier: encodeBase64(verifier),
		ciphertext: encodeBase64(ciphertext),
	});
}

function parseArchive(archive: string): MutableEnvelope {
	try {
		const value: unknown = JSON.parse(archive);
		if (typeof value !== "object" || value === null) throw new Error();
		const envelope = value as Record<string, unknown>;
		if (
			typeof envelope.kdf !== "object" ||
			envelope.kdf === null ||
			typeof envelope.cipher !== "object" ||
			envelope.cipher === null ||
			typeof (envelope.cipher as Record<string, unknown>).iv !== "string" ||
			typeof envelope.verifier !== "string" ||
			typeof envelope.ciphertext !== "string"
		) {
			throw new Error();
		}
		return envelope as MutableEnvelope;
	} catch {
		throw new Error("test fixture must be valid JSON");
	}
}

describe(".rmbak v1 codec", () => {
	test("matches RFC 7914 scrypt test vector 1", async () => {
		const derived = await scryptAsync(new Uint8Array(), new Uint8Array(), {
			N: 16,
			r: 1,
			p: 1,
			dkLen: 64,
			maxmem: 1_048_576,
		});
		expect(Buffer.from(derived).toString("hex")).toBe(
			"77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442" +
				"fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906",
		);
	});

	test("deterministically encrypts a strict self-describing envelope and round-trips", async () => {
		const codec = deterministicCodec();
		const archive = await codec.encrypt(PAYLOAD, "correct horse battery staple");
		const envelope = parseArchive(archive);
		expect(envelope.format).toBe("rememberme-backup");
		expect(envelope.version).toBe(1);
		expect(envelope.kdf).toEqual({
			algorithm: "scrypt",
			N: 32768,
			r: 8,
			p: 3,
			dkLen: 64,
			salt: "AQIDBAUGBwgJCgsMDQ4PEA==",
		});
		expect(envelope.cipher).toEqual({
			algorithm: "AES-256-GCM",
			iv: "ISIjJCUmJygpKiss",
			tagLength: 128,
		});
		expect(archive).not.toContain("first 📖");
		expect(await codec.decrypt(archive, "correct horse battery staple")).toEqual(PAYLOAD);
	});

	test("round-trips with the real production scrypt options", async () => {
		const codec = createBackupCodec();
		const archive = await codec.encrypt(PAYLOAD, "production password");
		expect(await codec.decrypt(archive, "production password")).toEqual(PAYLOAD);
	}, 60_000);

	test("fresh salt and IV make equal backups differ", async () => {
		const codec = createBackupCodecForTest({ derive: fakeDerive });
		expect(await codec.encrypt(PAYLOAD, "same password")).not.toBe(
			await codec.encrypt(PAYLOAD, "same password"),
		);
	});

	test("wrong password and verifier/ciphertext/header tampering use the masked unlock error", async () => {
		const codec = deterministicCodec();
		const archive = await codec.encrypt(PAYLOAD, "right password");
		await expect(codec.decrypt(archive, "wrong password")).rejects.toThrow(
			"Could not unlock this backup.",
		);
		for (const field of ["verifier", "ciphertext"] as const) {
			const envelope = parseArchive(archive);
			envelope[field] = mutateBase64(envelope[field]);
			await expect(codec.decrypt(JSON.stringify(envelope), "right password")).rejects.toThrow(
				"Could not unlock this backup.",
			);
		}
		const header = parseArchive(archive);
		header.cipher.iv = mutateBase64(header.cipher.iv);
		await expect(codec.decrypt(JSON.stringify(header), "right password")).rejects.toThrow(
			"Could not unlock this backup.",
		);
	});

	test("rejects attacker-selected KDF work and unknown envelope fields before deriving", async () => {
		const derive = vi.fn(fakeDerive);
		const codec = deterministicCodec(derive);
		const archive = await codec.encrypt(PAYLOAD, "right password");
		derive.mockClear();
		const expensive = parseArchive(archive);
		expensive.kdf.N = 2 ** 20;
		await expect(codec.decrypt(JSON.stringify(expensive), "right password")).rejects.toThrow(
			"This backup file is not supported.",
		);
		expect(derive).not.toHaveBeenCalled();
		const unknown = parseArchive(archive);
		unknown.extra = true;
		await expect(codec.decrypt(JSON.stringify(unknown), "right password")).rejects.toThrow(
			"This backup file is not supported.",
		);
		expect(derive).not.toHaveBeenCalled();
	});

	test("rejects malformed envelopes and oversize input before KDF work", async () => {
		const derive = vi.fn(fakeDerive);
		const codec = deterministicCodec(derive);
		await expect(codec.decrypt("not json", "right password")).rejects.toThrow(
			"This backup file is not supported.",
		);
		await expect(codec.decrypt("x".repeat(16 * 1024 * 1024 + 1), "right password")).rejects.toThrow(
			"Backup file is too large.",
		);
		expect(derive).not.toHaveBeenCalled();
	});

	test.each([
		[{ ...PAYLOAD, exportedAt: "2026-09-11" }, "exportedAt"],
		[{ ...PAYLOAD, entries: [{ ...PAYLOAD.entries[0], date: "2026-02-30" }] }, "date"],
		[
			{ ...PAYLOAD, entries: [{ ...PAYLOAD.entries[0], updatedAt: "2026-09-09T00:00:00.000Z" }] },
			"timestamps",
		],
		[{ ...PAYLOAD, settings: { ...PAYLOAD.settings, weeklyReviewHour: 24 } }, "settings"],
		[{ ...PAYLOAD, settings: { ...PAYLOAD.settings, timezone: "Not/AZone" } }, "settings"],
	])("rejects invalid payload %# before deriving", async (payload, _label) => {
		const derive = vi.fn(fakeDerive);
		const codec = deterministicCodec(derive);
		await expect(codec.encrypt(payload as BackupPayload, "right password")).rejects.toThrow(
			"Backup content is invalid.",
		);
		expect(derive).not.toHaveBeenCalled();
	});

	test("rejects authenticated but invalid or device-bound backup content after decrypt", async () => {
		const codec = deterministicCodec();
		for (const payload of [
			{ ...PAYLOAD, unexpected: true },
			{ ...PAYLOAD, settings: { ...PAYLOAD.settings, biometricEnabled: true } },
		]) {
			const archive = await authenticatedArchive(payload, "right password");
			await expect(codec.decrypt(archive, "right password")).rejects.toThrow(
				"This backup is damaged or incompatible.",
			);
		}
	});

	test("requires sorted unique dates", async () => {
		const codec = deterministicCodec();
		const duplicate = { ...PAYLOAD, entries: [PAYLOAD.entries[0], PAYLOAD.entries[0]] };
		await expect(codec.encrypt(duplicate, "right password")).rejects.toThrow(
			"Backup content is invalid.",
		);
		const later = { ...PAYLOAD.entries[0], date: "2026-09-11" };
		const unsorted = { ...PAYLOAD, entries: [later, PAYLOAD.entries[0]] };
		await expect(codec.encrypt(unsorted, "right password")).rejects.toThrow(
			"Backup content is invalid.",
		);
	});

	test("enforces password and row limits before deriving", async () => {
		const derive = vi.fn(fakeDerive);
		const codec = deterministicCodec(derive);
		await expect(codec.encrypt(PAYLOAD, "short")).rejects.toThrow("8..128 characters");
		const entries = Array.from({ length: 10_001 }, (_, index) => ({
			...PAYLOAD.entries[0],
			date: `20${String(Math.floor(index / 365)).padStart(2, "0")}-01-01`,
		}));
		await expect(codec.encrypt({ ...PAYLOAD, entries }, "right password")).rejects.toThrow(
			"Backup content is invalid.",
		);
		expect(derive).not.toHaveBeenCalled();
	});
});
