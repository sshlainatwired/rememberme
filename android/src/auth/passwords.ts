/**
 * Password validation and byte primitives for auth.
 *
 * Dependency-free. `randomBytes`/the optional crypto override use only
 * `crypto.getRandomValues` (WebView-safe, present since long before WebView60);
 * the AES/PBKDF2 WebCrypto that `verifier.ts` exercises is injected so an
 * environment can be force-close-tested.
 */

/** Inclusive lower bound on password length. */
export const PASSWORD_MIN = 8;
/** Inclusive upper bound on password length. */
export const PASSWORD_MAX = 128;

/**
 * The crypto capability this module needs: getRandomValues for randomness and
 * subtle for key derivation. `subtle` may be absent (e.g. an environment that
 * only exposes an RNG), in which case the check below fails closed for the
 * derive path.
 */
export interface CryptoSource {
	getRandomValues: Crypto["getRandomValues"];
	subtle?: SubtleCrypto;
}

/**
 * The crypto object used for randomness/derivation. Defaults to the global
 * one. Tests replace it (via {@link __setCryptoSource}) to prove the capability
 * checks fail closed, so this is a mutable module field only for the test seam.
 */
// `undefined` = no override installed (use the global); `null` = explicitly no
// WebCrypto (fail-closed test seam); a real source = use it.
let cryptoSource: CryptoSource | null | undefined;

/**
 * Test-only seam: install a custom crypto source (or null to simulate an
 * environment without WebCrypto). Never called by production code.
 */
export function __setCryptoSource(source: CryptoSource | null | undefined): void {
	cryptoSource = source;
}

/** Resolve the active crypto source, or throw if none is usable. */
function cryptoOrThrow(): CryptoSource {
	const candidate: CryptoSource | null =
		cryptoSource === null ? null : (cryptoSource ?? (globalThis.crypto as CryptoSource));
	if (!candidate?.getRandomValues) {
		throw new Error("WebCrypto is not available in this runtime.");
	}
	return candidate;
}

/** The active crypto source for callers that also need `subtle`. */
export function cryptoSourceOrThrow(): CryptoSource {
	return cryptoOrThrow();
}

/** Throw unless `password` is a string of length in [PASSWORD_MIN, PASSWORD_MAX]. */
export function validatePassword(password: string): void {
	if (typeof password !== "string") {
		throw new Error("Password must be a string.");
	}
	if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
		throw new Error(`Password must be ${PASSWORD_MIN}..${PASSWORD_MAX} characters.`);
	}
}

/** Return `n` cryptographically secure random bytes (throws if WebCrypto is absent). */
export function randomBytes(n: number): Uint8Array {
	const bytes = new Uint8Array(n);
	cryptoOrThrow().getRandomValues(bytes);
	return bytes;
}

/** Zero the buffer in place (no return; caller owns the buffer). */
export function zeroBytes(bytes: Uint8Array): void {
	bytes.fill(0);
}

/**
 * Constant-time equality over whole byte arrays. Early-returns on length
 * mismatch before any byte comparison (lengths are public, never secret).
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
	return diff === 0;
}
