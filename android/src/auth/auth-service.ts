/**
 * On-device auth service (single-owner, device-local).
 *
 * Persists ONE singleton local_auth row (id CHECK (id = 1)) containing a
 * PBKDF2-HMAC-SHA256 verifier envelope (Task 3's serialized format), plus an
 * in-memory "unlocked" session flag that survives only until logout.
 *
 * Fail-closed discipline:
 * - a stored row that violates the singleton invariant (≠ exactly one row) or
 *   fails the strict verifier decode is treated as corruption and REJECTS —
 *   never silently defaulted, downgraded, or skipped;
 * - a wrong password and an absent configuration return the SAME generic
 *   message ("Invalid password. Please try again.") so a caller cannot tell
 *   whether an account exists (no oracle);
 * - `setup` serializes the whole flow per AuthService instance (a JS queue, NOT
 *   the DB lock): fresh attempt = re-read + strict-validate auth, reject when
 *   already configured BEFORE any settings update or derivation, then seed the
 *   timezone FIRST (validated, persisted), then derive the verifier WITHOUT
 *   holding the DB lock (the 600k PBKDF2 is the sole hot path), then atomically
 *   insert the singleton row inside ONE queued section using an explicit
 *   begin/insert/commit with a checked rollback on any failure (derivation and
 *   the SettingsService.update stay outside that lock — never nested);
 * - `created_at`/`updated_at` — both in storage and from the injected clock —
 *   must be finite parseable date strings; a malformed timestamp is corruption
 *   and makes status/login/bootstrap fail closed (same discipline as the
 *   journal's stored-row decoder);
 * - the password NEVER derives/rotates/wraps the SQLCipher key: this service
 *   only ever reads/writes the `verifier` column (see Global Constraints).
 */

import {
	createVerifier,
	encodeStoredVerifier,
	parseStoredVerifier,
	type StoredVerifier,
	validatePassword,
	verifyPassword,
} from "@/auth/verifier";
import type { SettingsService } from "@/db/settings";
import type { SQLDialect, SQLRow } from "@/db/types";

/** Public auth state: configured (row present) + unlocked (session open). */
export interface AuthStatus {
	configured: boolean;
	unlocked: boolean;
}

/** The stored singleton auth row shape. */
interface AuthRow {
	id: number;
	verifier: string;
	createdAt: string;
	updatedAt: string;
}

/** Generic failure message for absent/wrong credentials (deliberately shared). */
export const AUTH_OK_MESSAGE = "Invalid password. Please try again.";

export class AuthService {
	private unlocked = false;
	/**
	 * Per-service serialization queue for setup. The DB serializer alone cannot
	 * serialize the WHOLE setup flow because the 600k derivation and the
	 * SettingsService.update must not run inside the DB lock; this JS tail makes
	 * overlapping setup attempts on the same instance run end-to-end one at a
	 * time, so a repeated/concurrent loser performs its early already-configured
	 * check BEFORE it can overwrite the winner's timezone. Production exposes one
	 * AuthService via the DatabaseHandle singleton, so this covers the real
	 * race; separately-constructed instances would still serialize at the DB
	 * lock for the auth insert but could race the timezone (accepted, unsupported).
	 */
	private setupTail: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly db: SQLDialect,
		private readonly settings: SettingsService,
		private readonly clock: () => string = () => new Date().toISOString(),
	) {}

	/** Same message for a wrong password and a not-configured store (no oracle). */
	private genericFailure(): Error {
		return new Error(AUTH_OK_MESSAGE);
	}

	/**
	 * Narrow stored-timestamp decoder: must be a string that parses to a finite
	 * date. Rejects non-strings and malformed/non-finite date strings (the
	 * injected clock always emits a finite `Date.toISOString()`, so anything the
	 * clock produces passes). Used for BOTH stored rows (fail-closed corruption)
	 * and the injected clock output before it is persisted, matching the
	 * journal's stored-row timestamp discipline.
	 */
	private decodeTimestamp(value: unknown, field: string): string {
		if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
			throw new Error(
				`Corrupt local auth: stored ${field} is not a valid date string (stored type: ${typeof value}).`,
			);
		}
		return value;
	}

	/**
	 * Read the singleton row, re-checking shape invariants on every call. Any
	 * result that is not EXACTLY one row is corruption (the schema CHECK only
	 * guards direct inserts; a hand-built or migrated store could still carry
	 * multiple rows, so the service re-checks on read). A present row must also
	 * carry finite parseable created_at/updated_at timestamps (fail closed on
	 * malformed ones, like the journal decoder).
	 */
	private async readAuthRow(): Promise<AuthRow | null> {
		return this.db.withLock(async () => {
			const rows = await this.db.query<AuthRow & SQLRow>(
				"SELECT id, verifier, created_at, updated_at FROM local_auth",
			);
			if (rows.length > 1) {
				throw new Error(`Corrupt local auth: expected exactly one row, found ${rows.length}.`);
			}
			if (rows.length === 0) return null;
			const row = rows[0];
			if (typeof row.id !== "number" || row.id !== 1) {
				throw new Error(
					`Corrupt local auth: expected singleton row id to be numeric 1, found ${String(row.id)}.`,
				);
			}
			if (typeof row.verifier !== "string") {
				throw new Error(
					`Corrupt local auth: stored verifier is not a string (stored type: ${typeof row.verifier}).`,
				);
			}
			return {
				id: row.id,
				verifier: row.verifier,
				createdAt: this.decodeTimestamp(row.created_at, "created_at"),
				updatedAt: this.decodeTimestamp(row.updated_at, "updated_at"),
			};
		});
	}

	/**
	 * Strict-decode a stored verifier, always surfacing corruption as a
	 * "Corrupt local auth:" error (cause-preserving) so every public auth
	 * read can fail closed with the same clear corruption banner.
	 */
	private strictDecode(verifier: string): StoredVerifier {
		try {
			return parseStoredVerifier(verifier);
		} catch (cause) {
			throw new Error(`Corrupt local auth: ${String(cause)}`, { cause });
		}
	}

	/**
	 * Strict decode of the stored verifier envelope (may be absent). Throws
	 * corruption errors (cause-preserving) without ever touching the unlock
	 * state. Bootstrap calls this BEFORE exposing the handle.
	 */
	async validateStored(): Promise<void> {
		const row = await this.readAuthRow();
		if (row === null) return;
		this.strictDecode(row.verifier);
	}

	async status(): Promise<AuthStatus> {
		const row = await this.readAuthRow();
		// Fail closed: a present row must still strict-decode (hostile iterations,
		// malformed JSON, non-canonical base64), otherwise a caller could read
		// `configured: true` off a corrupt store. Decode-only, no KDF here.
		if (row !== null) {
			this.strictDecode(row.verifier);
		}
		return { configured: row !== null, unlocked: this.unlocked };
	}

	/**
	 * First-time setup. Serialized end-to-end per instance so a repeated or
	 * concurrent loser can never overwrite an already-configured store's
	 * timezone: each serialized attempt re-reads + strict-validates auth FIRST
	 * and rejects BEFORE any settings update or 600k derivation. On a fresh
	 * store, the timezone is seeded first (validated, persisted) so a later
	 * derive/insert failure leaves a recoverable store, then the verifier is
	 * derived WITHOUT the DB lock, and finally the singleton row is inserted
	 * inside ONE queued section with an explicit begin/insert/commit and a
	 * checked rollback on any failure. Derivation and SettingsService.update
	 * are never nested inside the DB lock.
	 */
	async setup(password: string, timezone: string): Promise<AuthStatus> {
		validatePassword(password);
		const run = this.setupTail.then(() => this.setupSerialized(password, timezone));
		// Keep the tail resolvable even when a setup rejects, so the next queued
		// setup still runs (same discipline as the DB Serializer).
		this.setupTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** The whole early-check → timezone seed → derive → insert flow, serialized per service. */
	private async setupSerialized(password: string, timezone: string): Promise<AuthStatus> {
		// Early check: read + strict-validate; reject BEFORE touching settings or
		// deriving. Both the verifier decode and the timestamp decode run here,
		// so a corrupt store fails closed instead of being overwritten.
		const existing = await this.readAuthRow();
		if (existing !== null) {
			this.strictDecode(existing.verifier);
			throw new Error("Local auth is already configured; refusing to overwrite it.");
		}
		// SettingsService validates + persists the timezone first, so an invalid
		// timezone rejects BEFORE any auth write (recoverable: a later derive or
		// insert failure leaves only a harmless timezone seed behind).
		await this.settings.update({ timezone });
		const stored = await createVerifier(password);
		const now = this.clock();
		// Fail closed on a broken injected clock: never persist a non-date as
		// created_at/updated_at (a later status/bootstrap would reject it).
		this.decodeTimestamp(now, "created_at");
		await this.db.withLock(async () => {
			const rows = await this.db.query<{ id: unknown }>("SELECT id FROM local_auth");
			if (rows.length > 0) {
				throw new Error("Local auth is already configured; refusing to overwrite it.");
			}
			// Explicit transaction for the singleton insert; a failure rolls the
			// whole insert back (checked: the rollback must not mask the original
			// error), so no partial row can survive.
			await this.db.begin();
			try {
				await this.db.run(
					"INSERT INTO local_auth (id, verifier, created_at, updated_at) VALUES (1, ?, ?, ?)",
					[encodeStoredVerifier(stored), now, now],
				);
				await this.db.commit();
			} catch (error) {
				try {
					await this.db.rollback();
				} catch {
					// keep the original error; a rollback failure must not mask it
				}
				throw error;
			}
		});
		this.unlocked = true;
		return { configured: true, unlocked: true };
	}

	/**
	 * Unlock with the correct password. Absent configuration and a wrong
	 * password BOTH use the generic message; a corrupt stored verifier throws
	 * corruption (fail-closed, never a wrong-password result). The single
	 * stored row is read and strict-decoded EXACTLY once — no second read.
	 */
	async login(password: string): Promise<AuthStatus> {
		const row = await this.readAuthRow();
		if (row === null) throw this.genericFailure();
		const ok = await verifyPassword(password, this.strictDecode(row.verifier));
		if (!ok) throw this.genericFailure();
		this.unlocked = true;
		return { configured: true, unlocked: true };
	}

	/**
	 * Open only the in-memory session after the native layer has already
	 * authenticated the device owner. The stored singleton and verifier are
	 * still read and strictly validated, but no password/KDF work or persistent
	 * mutation occurs here.
	 */
	async unlockWithDeviceCredential(): Promise<AuthStatus> {
		const row = await this.readAuthRow();
		if (row === null) {
			throw new Error("Cannot unlock with device authentication: local auth is not configured.");
		}
		this.strictDecode(row.verifier);
		this.unlocked = true;
		return { configured: true, unlocked: true };
	}

	/** Clear the in-memory session only; the stored row persists. */
	logout(): void {
		this.unlocked = false;
	}

	/** Whether the in-memory session is currently open. */
	isUnlocked(): boolean {
		return this.unlocked;
	}
}
