/**
 * PBKDF2-HMAC-SHA256 password verifier (dependency-free WebCrypto).
 *
 * The stored verifier is a small JSON envelope of a fixed, exact KDF
 * parameterization plus canonical standard (RFC 4648) base64 salt/verifier:
 *
 *   { version: 1, algorithm: "PBKDF2-HMAC-SHA256", iterations: 600000,
 *     salt: "<16 bytes>", verifier: "<32 bytes>" }
 *
 * Guarantees:
 * - exact 600000 iterations, 16-byte salt, 32-byte hash; no downgrade path.
 * - strict canonical base64: rejects non-alphabet characters, misplaced or
 *   missing padding, non-multiple-of-4 lengths, AND any alternate encoding
 *   that decodes to the same bytes with nonzero unused trailing bits (a bare
 *   atob + byte-length check would accept those; we reject them).
 * - password bytes and derived-hash temporaries are zeroed in `finally`
 *   wherever production code holds them (caller-supplied salt buffers are
 *   never mutated).
 * - fail-closed: if WebCrypto (`crypto.subtle`) is missing, every derive path
 *   throws a clear "WebCrypto is not available" error instead of degrading.
 * - corrupt stored envelopes throw a cause-preserving error; a *wrong
 *   password* against a *valid* envelope only ever returns `false`.
 */
import {
	constantTimeEqual,
	cryptoSourceOrThrow,
	randomBytes,
	validatePassword,
	zeroBytes,
} from "@/auth/passwords";

/** Version of the envelope format this module reads and writes. */
export const AUTH_VERSION = 1 as const;
/** Fixed KDF algorithm. */
export const AUTH_ALGORITHM = "PBKDF2-HMAC-SHA256" as const;
/** PBKDF2 iteration count (exact; hostile downgrades are rejected). */
export const PBKDF2_ITERATIONS = 600_000;
/** Salt length in bytes. */
export const SALT_BYTES = 16;
/** Derived verifier length in bytes (SHA-256 output). */
export const VERIFIER_BYTES = 32;

/** Standard RFC 4648 base64 alphabet. */
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Exact key set a v1 envelope may carry. Envelopes are strict: any key outside
 * this set is rejected, never silently ignored (see {@link parseStoredVerifier}).
 */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
	"version",
	"algorithm",
	"iterations",
	"salt",
	"verifier",
]);

/** A stored verifier envelope (salt/verifier are canonical standard base64). */
export interface StoredVerifier {
	version: typeof AUTH_VERSION;
	algorithm: typeof AUTH_ALGORITHM;
	iterations: number;
	salt: string;
	verifier: string;
}

/** Encode bytes as canonical standard (RFC 4648) base64 with '=' padding. */
function base64Encode(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i];
		const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
		const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
		out += BASE64_ALPHABET[b0 >> 2];
		out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
		out += i + 1 < bytes.length ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
		out += i + 2 < bytes.length ? BASE64_ALPHABET[b2 & 0x3f] : "=";
	}
	return out;
}

/** Map one base64 alphabet character to its 6-bit value; throws otherwise. */
function base64Value(code: number): number {
	if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z
	if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26; // a-z
	if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52; // 0-9
	if (code === 0x2b) return 62; // '+'
	if (code === 0x2f) return 63; // '/'
	throw new Error("Value must be canonical standard base64.");
}

/**
 * Decode canonical standard base64 and require exactly `expected` bytes.
 * Rejects non-alphabet characters, misplaced/excess padding, lengths that are
 * not a multiple of four, any same-byte alternate encoding with nonzero unused
 * trailing bits, and any decoded length other than `expected`.
 */
function base64Decode(input: string, expected: number): Uint8Array<ArrayBuffer> {
	const fail = () => {
		throw new Error("Value must be canonical standard base64.");
	};
	const length = input.length;
	if (length % 4 !== 0) fail();
	if (length === 0) {
		if (expected === 0) return new Uint8Array(0);
		fail();
	}
	let padding = 0;
	if (input.charCodeAt(length - 1) === 0x3d) padding = 1; // '='
	if (padding === 1 && input.charCodeAt(length - 2) === 0x3d) padding = 2;
	const validLength = length - padding;
	const remaining = validLength % 4; // 0, 2, or 3 data chars in the last group
	let byteCount = Math.floor(validLength / 4) * 3;
	if (remaining === 2) byteCount += 1;
	if (remaining === 3) byteCount += 2;
	if (byteCount !== expected) fail();
	const bytes = new Uint8Array(byteCount);
	try {
		let outIndex = 0;
		for (let i = 0; i < validLength; i += 4) {
			const c0 = base64Value(input.charCodeAt(i));
			const c1 = base64Value(input.charCodeAt(i + 1));
			bytes[outIndex++] = (c0 << 2) | (c1 >> 4);
			if (i + 2 < validLength) {
				const c2 = base64Value(input.charCodeAt(i + 2));
				bytes[outIndex++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
				if (i + 3 < validLength) {
					const c3 = base64Value(input.charCodeAt(i + 3));
					bytes[outIndex++] = ((c2 & 0x03) << 6) | c3;
				}
			}
		}
		// Canonicality check: the encoder emits exactly one padding layout and zero
		// unused bits, so any alternate encoding of the same bytes fails to re-encode
		// to the original string (catches nonzero unused trailing bits and padding
		// layout drift that a bare atob would accept).
		if (base64Encode(bytes) !== input) fail();
		return bytes;
	} catch (error) {
		zeroBytes(bytes);
		throw error;
	}
}

/** Parse a JSON object from `value`, preserving the SyntaxError as `cause`. */
function parseObject(value: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch (cause) {
		throw new Error("Stored auth verifier is invalid JSON.", { cause });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Stored auth verifier must be a JSON object.");
	}
	return parsed as Record<string, unknown>;
}

/**
 * Strictly parse a stored verifier envelope. Every structural problem throws a
 * clear error; decode-only validation zeroes its temporary bytes and never
 * retains a decoded salt/hash. Re-encodes the decoded salt/verifier to guarantee
 * canonicality (downgraded iterations, unsupported version/algorithm, wrong
 * byte lengths, and non-canonical base64 all fail here).
 */
export function parseStoredVerifier(value: string): StoredVerifier {
	const obj = parseObject(value);
	const fail = (msg: string): never => {
		throw new Error(`Stored auth verifier is invalid: ${msg}`);
	};
	if (obj.version !== AUTH_VERSION) fail(`unsupported version ${JSON.stringify(obj.version)}`);
	// Exact-key allowlist: v1 accepts precisely the five keys in ENVELOPE_KEYS and
	// no others. JSON.parse collapses duplicate spellings before we ever see the
	// object (the last one wins), so it cannot observe `{"version":1,"version":2}`
	// style duplicates -- rejecting every foreign key is the strongest check
	// available, and an unknown key is a structural error, never ignored.
	for (const key of Object.keys(obj)) {
		if (!ENVELOPE_KEYS.has(key)) {
			fail(
				`unexpected key ${JSON.stringify(key)}; v1 allows only version, algorithm, iterations, salt, verifier`,
			);
		}
	}
	if (obj.algorithm !== AUTH_ALGORITHM) {
		fail(`unsupported algorithm ${JSON.stringify(obj.algorithm)}`);
	}
	if (obj.iterations !== PBKDF2_ITERATIONS) {
		fail(`iterations must be exactly ${PBKDF2_ITERATIONS}`);
	}
	if (typeof obj.salt !== "string" || typeof obj.verifier !== "string") {
		fail("salt and verifier must be base64 strings");
	}
	// The typeof guard narrows the index-signature reads only within the condition;
	// re-reading the properties afterwards does not carry the narrowing, so capture
	// them through an explicit narrowing helper that returns definite strings.
	const getString = (key: string): string => {
		const value = obj[key];
		if (typeof value !== "string") {
			throw new Error(`Stored auth verifier is invalid: ${key} must be a string.`);
		}
		return value;
	};
	const saltText = getString("salt");
	const verifierText = getString("verifier");
	// Validate canonical base64 + exact byte lengths, then wipe each decoded
	// buffer at its allocation scope, including when a later decode fails.
	const salt = base64Decode(saltText, SALT_BYTES);
	try {
		const hash = base64Decode(verifierText, VERIFIER_BYTES);
		try {
			return {
				version: AUTH_VERSION,
				algorithm: AUTH_ALGORITHM,
				iterations: PBKDF2_ITERATIONS,
				salt: saltText,
				verifier: verifierText,
			};
		} finally {
			zeroBytes(hash);
		}
	} finally {
		zeroBytes(salt);
	}
}

/** Serialize a StoredVerifier back to its canonical JSON string. */
export function encodeStoredVerifier(verifier: StoredVerifier): string {
	return JSON.stringify(verifier);
}

/**
 * Derive exactly {@link VERIFIER_BYTES} of PBKDF2-HMAC-SHA256 material. The
 * caller-supplied salt is never zeroed (it is not our buffer); the password
 * bytes and any derived temporaries are wiped in `finally`.
 */
export async function deriveVerifier(
	password: string,
	salt: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
	// Use the single unified crypto seam from passwords.ts so an injected
	// RNG-only source (or an explicit `null`) fails closed before any derive.
	// The seam and guard run before TextEncoder allocates the password buffer, so
	// an unavailable WebCrypto never pulls password bytes into memory at all.
	const subtle = cryptoSourceOrThrow().subtle;
	if (!subtle) {
		throw new Error("WebCrypto is not available in this runtime.");
	}
	const secret = new TextEncoder().encode(password);
	try {
		const key = await subtle.importKey("raw", secret, "PBKDF2", false, ["deriveBits"]);
		const bits = await subtle.deriveBits(
			{
				name: "PBKDF2",
				hash: "SHA-256",
				salt: salt as BufferSource,
				iterations: PBKDF2_ITERATIONS,
			},
			key,
			VERIFIER_BYTES * 8,
		);
		return new Uint8Array(bits);
	} finally {
		zeroBytes(secret);
	}
}

/** Create a fresh stored verifier for `password` (random 16-byte salt). */
export async function createVerifier(password: string): Promise<StoredVerifier> {
	validatePassword(password);
	const salt = randomBytes(SALT_BYTES);
	try {
		const hash = await deriveVerifier(password, salt);
		try {
			return {
				version: AUTH_VERSION,
				algorithm: AUTH_ALGORITHM,
				iterations: PBKDF2_ITERATIONS,
				salt: base64Encode(salt),
				verifier: base64Encode(hash),
			};
		} finally {
			zeroBytes(hash);
		}
	} finally {
		zeroBytes(salt);
	}
}

/**
 * Verify `password` against a stored envelope. A *wrong password* against a
 * *valid* envelope returns `false`; a *corrupt* envelope throws. Derived
 * temporaries are wiped in `finally`; the decoded stored salt/hash are held
 * only long enough to compare and then wiped.
 */
export async function verifyPassword(password: string, stored: StoredVerifier): Promise<boolean> {
	const salt = base64Decode(stored.salt, SALT_BYTES);
	try {
		const expected = base64Decode(stored.verifier, VERIFIER_BYTES);
		try {
			const actual = await deriveVerifier(password, salt);
			try {
				return constantTimeEqual(actual, expected);
			} finally {
				zeroBytes(actual);
			}
		} finally {
			zeroBytes(expected);
		}
	} finally {
		zeroBytes(salt);
	}
}

// Re-export validation for Task 4 consumers that import from "@/auth/verifier"
// (ruling C3: passwords.ts is the canonical home; verifier.ts re-exports it).
export { validatePassword } from "@/auth/passwords";
