// @vitest-environment node
// Real globalThis.crypto.subtle (no polyfill) — the PBKDF2 verifier is
// dependency-free WebCrypto and must run against the platform implementation.
import { beforeEach, describe, expect, it } from "vitest";
import {
	__setCryptoSource,
	type CryptoSource,
	constantTimeEqual,
	randomBytes,
} from "@/auth/passwords";
import {
	AUTH_ALGORITHM,
	AUTH_VERSION,
	createVerifier,
	deriveVerifier,
	encodeStoredVerifier,
	PBKDF2_ITERATIONS,
	parseStoredVerifier,
	type StoredVerifier,
	VERIFIER_BYTES,
	verifyPassword,
} from "@/auth/verifier";

let fixture: StoredVerifier;
beforeEach(async () => {
	fixture = await createVerifier("correct horse battery staple");
});

describe("create/verify round-trip", () => {
	it("verifies the correct password", async () => {
		expect(await verifyPassword("correct horse battery staple", fixture)).toBe(true);
	});

	it("rejects a wrong password (returns false, never throws)", async () => {
		expect(await verifyPassword("wrong password", fixture)).toBe(false);
	});

	it("stores the exact KDF parameters and canonical base64 lengths", () => {
		expect(fixture).toMatchObject({
			version: AUTH_VERSION,
			algorithm: AUTH_ALGORITHM,
			iterations: PBKDF2_ITERATIONS,
		});
		expect(fixture.salt.length).toBe(24); // 16 bytes, standard base64
		expect(fixture.verifier.length).toBe(44); // 32 bytes, standard base64
	});
});

describe("createVerifier password validation", () => {
	it("rejects an out-of-range password before any derivation", async () => {
		await expect(createVerifier("short")).rejects.toThrow(/8\.\.128/);
		await expect(createVerifier("x".repeat(129))).rejects.toThrow(/8\.\.128/);
	});
});

describe("strict decode", () => {
	it("round-trips through encodeStoredVerifier/parseStoredVerifier", () => {
		expect(parseStoredVerifier(encodeStoredVerifier(fixture))).toEqual(fixture);
	});

	it("wipes decoded salt and partial verifier bytes when verifier decoding fails", () => {
		const fill = vi.spyOn(Uint8Array.prototype, "fill");
		try {
			expect(() =>
				parseStoredVerifier(JSON.stringify({ ...fixture, verifier: `${"!".repeat(43)}=` })),
			).toThrow();
			const zeroedLengths = fill.mock.instances
				.filter(
					(bytes, index): bytes is Uint8Array =>
						bytes instanceof Uint8Array && fill.mock.calls[index]?.[0] === 0,
				)
				.map((bytes) => bytes.length);
			expect(zeroedLengths).toEqual(expect.arrayContaining([16, 32]));
		} finally {
			fill.mockRestore();
		}
	});

	it("rejects a downgraded iteration count (hostile-iteration DoS)", () => {
		const downgraded = { ...fixture, iterations: 100_000 };
		expect(() => parseStoredVerifier(JSON.stringify(downgraded))).toThrow(/600000/);
	});

	it("rejects any unknown key (strict envelope: v1 accepts exactly version/algorithm/iterations/salt/verifier)", () => {
		// The envelope is strict: every key is validated against an exact allow-list,
		// so a foreign key (any name) is a structural error, never silently ignored.
		const extra = { ...fixture, unexpected: "nope" };
		expect(() => parseStoredVerifier(JSON.stringify(extra))).toThrow(/unexpected/);
	});

	it("rejects an unsupported version", () => {
		const wrong = { ...fixture, version: 2 };
		expect(() => parseStoredVerifier(JSON.stringify(wrong))).toThrow(/version/);
	});

	it("rejects an unsupported algorithm", () => {
		const wrong = { ...fixture, algorithm: "PBKDF2-HMAC-SHA1" };
		expect(() => parseStoredVerifier(JSON.stringify(wrong))).toThrow(/algorithm/);
	});

	it("rejects non-canonical salt base64 (wrong alphabet and nonzero unused bits)", () => {
		// 24 '!' chars: characters outside the RFC 4648 alphabet.
		expect(() =>
			parseStoredVerifier(JSON.stringify({ ...fixture, salt: "!!!!".repeat(6) })),
		).toThrow();
		// "A".repeat(21) + "B==" decodes to 16 zero bytes (same bytes as the canonical
		// "A".repeat(22) + "==") but leaves the last group's unused bits set, so only a
		// strict canonicality check can reject it; a bare atob+length check would accept.
		const sameBytesAlternate = `${"A".repeat(21)}B==`;
		expect(() =>
			parseStoredVerifier(JSON.stringify({ ...fixture, salt: sameBytesAlternate })),
		).toThrow();
	});

	it("rejects non-canonical verifier base64 (nonzero unused bits and bad padding length)", () => {
		// "A".repeat(42) + "B=" decodes to the same 32 zero bytes as the canonical
		// "A".repeat(43) + "=" but with nonzero unused bits in the final group.
		const sameBytesAlternate = `${"A".repeat(42)}B=`;
		expect(() =>
			parseStoredVerifier(JSON.stringify({ ...fixture, verifier: sameBytesAlternate })),
		).toThrow();
		// Truncating one padding char makes the length not a multiple of four.
		expect(() =>
			parseStoredVerifier(JSON.stringify({ ...fixture, verifier: fixture.verifier.slice(0, -1) })),
		).toThrow();
	});

	it("rejects a salt that decodes to the wrong byte length", () => {
		// 16 chars of 'A' decode to 12 bytes (not 16): canonical base64, wrong size.
		expect(() =>
			parseStoredVerifier(JSON.stringify({ ...fixture, salt: "A".repeat(16) })),
		).toThrow();
	});

	it("rejects a verifier that decodes to the wrong byte length", () => {
		// 44 chars of 'A' decode to 33 bytes (not 32).
		expect(() =>
			parseStoredVerifier(JSON.stringify({ ...fixture, verifier: "A".repeat(44) })),
		).toThrow();
	});

	it("rejects non-JSON text with a cause-preserving error", () => {
		let error: unknown;
		try {
			parseStoredVerifier("not json");
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/invalid JSON/);
		expect((error as Error).cause).toBeInstanceOf(SyntaxError);
	});

	it("rejects JSON that is not a plain object", () => {
		for (const value of ["null", "[]", "42", '"text"']) {
			expect(() => parseStoredVerifier(value)).toThrow(/must be a JSON object/);
		}
	});

	it("rejects missing or non-string salt/verifier fields", () => {
		const noSalt = {
			version: 1,
			algorithm: "PBKDF2-HMAC-SHA256",
			iterations: 600_000,
			verifier: fixture.verifier,
		};
		expect(() => parseStoredVerifier(JSON.stringify(noSalt))).toThrow(/salt/);
		expect(() => parseStoredVerifier(JSON.stringify({ ...fixture, salt: 42 }))).toThrow(
			/salt and verifier/,
		);
	});

	it("never echoes the stored verifier/salt value in decode errors (no secret material)", () => {
		const secret = "S3cr3t!".repeat(24); // obviously non-base64; must never appear in a message
		for (const tampered of [
			{ ...fixture, verifier: secret },
			{ ...fixture, salt: secret },
		]) {
			let error: unknown;
			try {
				parseStoredVerifier(JSON.stringify(tampered));
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			expect(message).not.toContain(secret);
		}
	});
});

describe("derive", () => {
	it("wipes createVerifier's random salt when derivation rejects", async () => {
		const real = globalThis.crypto;
		let salt: Uint8Array | undefined;
		const importKey = vi.fn().mockRejectedValue(new Error("derive boom"));
		const subtle = new Proxy(real.subtle, {
			get: (target, property) =>
				property === "importKey" ? importKey : target[property as keyof SubtleCrypto],
		});
		const source: CryptoSource = {
			getRandomValues: ((bytes: Uint8Array) => {
				bytes.fill(0x5a);
				salt = bytes;
				return bytes;
			}) as Crypto["getRandomValues"],
			subtle,
		};
		__setCryptoSource(source);
		try {
			await expect(createVerifier("correct horse battery staple")).rejects.toThrow("derive boom");
			expect(salt).toBeDefined();
			expect(salt).toEqual(new Uint8Array(16));
		} finally {
			__setCryptoSource(real);
		}
	});

	it("derives exactly 32 bytes from a 16-byte salt", async () => {
		const salt = randomBytes(16);
		expect((await deriveVerifier("pw", salt)).length).toBe(VERIFIER_BYTES);
	});

	it("is deterministic for the same salt and password", async () => {
		const salt = randomBytes(16);
		const first = await deriveVerifier("correct horse battery staple", salt);
		const second = await deriveVerifier("correct horse battery staple", salt);
		expect(constantTimeEqual(first, second)).toBe(true);
	});

	it("fails closed when WebCrypto is unavailable instead of misbehaving", async () => {
		const real = globalThis.crypto;
		__setCryptoSource(null);
		try {
			await expect(createVerifier("correct horse battery staple")).rejects.toThrow(
				/WebCrypto is not available/,
			);
			await expect(verifyPassword("correct horse battery staple", fixture)).rejects.toThrow(
				/WebCrypto is not available/,
			);
			await expect(deriveVerifier("pw", new Uint8Array(16))).rejects.toThrow(
				/WebCrypto is not available/,
			);
			expect(() => randomBytes(16)).toThrow(/WebCrypto is not available/);
		} finally {
			__setCryptoSource(real);
		}
	});

	it("fails closed for derive/create/verify under an RNG-only source (getRandomValues present, subtle absent)", async () => {
		// An RNG-only source exposes randomness but no key-derivation interface. The
		// derive family must fail closed rather than degrade; randomBytes still works.
		// WebCrypto methods are this-branded: an unbound reference fails with
		// ERR_INVALID_THIS, so the RNG-only source must bind getRandomValues to the
		// real Crypto instance (that is the correctly shaped CryptoSource).
		const real = globalThis.crypto;
		const rngOnly: CryptoSource = { getRandomValues: real.getRandomValues.bind(real) };
		__setCryptoSource(rngOnly);
		try {
			expect(() => randomBytes(16)).not.toThrow();
			expect(randomBytes(16)).toHaveLength(16);
			await expect(createVerifier("correct horse battery staple")).rejects.toThrow(
				/WebCrypto is not available/,
			);
			await expect(deriveVerifier("pw", new Uint8Array(16))).rejects.toThrow(
				/WebCrypto is not available/,
			);
			await expect(verifyPassword("correct horse battery staple", fixture)).rejects.toThrow(
				/WebCrypto is not available/,
			);
		} finally {
			__setCryptoSource(real);
		}
	});
});

describe("verifyPassword failure semantics", () => {
	it("wipes decoded salt and partial expected bytes when expected decoding fails", async () => {
		const fill = vi.spyOn(Uint8Array.prototype, "fill");
		try {
			await expect(
				verifyPassword("correct horse battery staple", {
					...fixture,
					verifier: `${"!".repeat(43)}=`,
				}),
			).rejects.toThrow();
			const zeroedLengths = fill.mock.instances
				.filter(
					(bytes, index): bytes is Uint8Array =>
						bytes instanceof Uint8Array && fill.mock.calls[index]?.[0] === 0,
				)
				.map((bytes) => bytes.length);
			expect(zeroedLengths).toEqual(expect.arrayContaining([16, 32]));
		} finally {
			fill.mockRestore();
		}
	});

	it("wipes decoded salt and expected bytes when derivation rejects", async () => {
		const real = globalThis.crypto;
		const fill = vi.spyOn(Uint8Array.prototype, "fill");
		const importKey = vi.fn().mockRejectedValue(new Error("derive boom"));
		const subtle = new Proxy(real.subtle, {
			get: (target, property) =>
				property === "importKey" ? importKey : target[property as keyof SubtleCrypto],
		});
		__setCryptoSource({
			getRandomValues: real.getRandomValues.bind(real),
			subtle,
		});
		try {
			await expect(verifyPassword("correct horse battery staple", fixture)).rejects.toThrow(
				"derive boom",
			);
			const zeroedLengths = fill.mock.instances
				.filter(
					(bytes, index): bytes is Uint8Array =>
						bytes instanceof Uint8Array && fill.mock.calls[index]?.[0] === 0,
				)
				.map((bytes) => bytes.length);
			expect(zeroedLengths).toEqual(expect.arrayContaining([16, 32]));
		} finally {
			fill.mockRestore();
			__setCryptoSource(real);
		}
	});

	it("throws on a corrupt stored envelope rather than returning false", async () => {
		const corruptSalt = { ...fixture, salt: "not-base64!" };
		await expect(verifyPassword("correct horse battery staple", corruptSalt)).rejects.toThrow();
		const truncatedVerifier = { ...fixture, verifier: fixture.verifier.slice(0, 40) };
		await expect(
			verifyPassword("correct horse battery staple", truncatedVerifier),
		).rejects.toThrow();
	});

	it("never mutates the caller's salt buffer (zeroing applies only to internal temporaries)", async () => {
		const salt = randomBytes(16);
		const snapshot = new Uint8Array(salt);
		await deriveVerifier("correct horse battery staple", salt);
		expect(constantTimeEqual(salt, snapshot)).toBe(true);
	});

	it("matches an independent PBKDF2-HMAC-SHA256 vector at exactly 600000 iterations", async () => {
		// Vector cross-checked at authoring time between `openssl kdf ... PBKDF2`
		// and Node `crypto.pbkdf2Sync` (hex 6c4a646aad10d067add5fb79d9078a16da83d5
		// 0f81670a8e7593b249e6d94936, base64 bEpkaq0Q0Get1ft52QeKFtqD1Q+BZwqOdZOySebZSTY=)
		// for password "correct horse battery staple", ASCII salt "0123456789abcdef",
		// SHA-256, 600000 iterations, 32 bytes.
		const salt = new TextEncoder().encode("0123456789abcdef");
		const actual = await deriveVerifier("correct horse battery staple", salt);
		const expected = new Uint8Array([
			0x6c, 0x4a, 0x64, 0x6a, 0xad, 0x10, 0xd0, 0x67, 0xad, 0xd5, 0xfb, 0x79, 0xd9, 0x07, 0x8a,
			0x16, 0xda, 0x83, 0xd5, 0x0f, 0x81, 0x67, 0x0a, 0x8e, 0x75, 0x93, 0xb2, 0x49, 0xe6, 0xd9,
			0x49, 0x36,
		]);
		expect(constantTimeEqual(actual, expected)).toBe(true);
	});
});
