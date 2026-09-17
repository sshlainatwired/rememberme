/**
 * On-device Android settings repository + service.
 *
 * Single-owner, device-local persistence. Stores ONLY the fields the plan has
 * committed for the Android app — no email, no digest/SMTP/server-password,
 * no web-only fields. Values are JSON-encoded per key so any future data
 * shape upgrades without a schema migration, but every read/write is
 * validated against the shared contracts below.
 *
 * Defaults follow the published spec: weekly review hour 20, disabled by
 * default; timezone "UTC"; biometrics off; appearance "system".
 */

import { isTimezoneSupported } from "@rememberme/core";
import type { SQLDialect, SQLRow } from "@/db/types";

export interface AppSettings {
	timezone: string;
	weeklyReviewEnabled: boolean;
	weeklyReviewHour: number;
	biometricEnabled: boolean;
	appearance: "system" | "light" | "dark";
}

export type Appearance = AppSettings["appearance"];

/** Safe defaults applied when a key (or all keys) are absent. */
export const DEFAULT_SETTINGS: AppSettings = {
	timezone: "UTC",
	weeklyReviewEnabled: false,
	weeklyReviewHour: 20,
	biometricEnabled: false,
	appearance: "system",
};

export const APPEARANCES: ReadonlySet<Appearance> = new Set(["system", "light", "dark"]);

const HOUR_MIN = 0;
const HOUR_MAX = 23;

export interface SettingRow extends SQLRow {
	key: string;
	value: string;
}

/** Keys that may be stored; guards against silent extension (e.g. web fields). */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
	"timezone",
	"weeklyReviewEnabled",
	"weeklyReviewHour",
	"biometricEnabled",
	"appearance",
]);

/** Validates a single field value against the Android settings contract. */
export function validateSetting(
	key: keyof AppSettings,
	value: unknown,
): asserts value is AppSettings[keyof AppSettings] {
	switch (key) {
		case "timezone":
			if (typeof value !== "string" || !isTimezoneSupported(value)) {
				throw new Error(`Invalid timezone: ${JSON.stringify(value)}`);
			}
			return;
		case "weeklyReviewEnabled":
		case "biometricEnabled":
			if (typeof value !== "boolean") {
				throw new Error(`Invalid boolean for ${key}: ${JSON.stringify(value)}`);
			}
			return;
		case "weeklyReviewHour":
			if (
				typeof value !== "number" ||
				!Number.isInteger(value) ||
				value < HOUR_MIN ||
				value > HOUR_MAX
			) {
				throw new Error(
					`Invalid weekly review hour: ${JSON.stringify(value)} (expected integer ${HOUR_MIN}..${HOUR_MAX})`,
				);
			}
			return;
		case "appearance":
			if (typeof value !== "string" || !APPEARANCES.has(value as Appearance)) {
				throw new Error(`Invalid appearance: ${JSON.stringify(value)}`);
			}
			return;
		default:
			throw new Error(`Unknown settings key: ${String(key)}`);
	}
}

export function decodeSettingsRows(rows: SettingRow[]): AppSettings {
	const stored: Partial<AppSettings> = {};
	for (const row of rows) {
		if (!ALLOWED_KEYS.has(row.key)) {
			throw new Error(
				`Corrupt settings: stored key ${JSON.stringify(row.key)} is not an allowed settings key.`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.value) as unknown;
		} catch {
			throw new Error(
				`Corrupt settings: stored value for ${row.key} is not valid JSON: ${JSON.stringify(row.value)}`,
			);
		}
		try {
			validateSetting(row.key as keyof AppSettings, parsed);
		} catch (cause) {
			throw new Error(`Corrupt settings: stored value for ${row.key} is invalid.`, { cause });
		}
		(stored as Record<string, unknown>)[row.key] = parsed;
	}
	return { ...DEFAULT_SETTINGS, ...stored };
}

export class SettingsService {
	constructor(private readonly db: SQLDialect) {}

	/** Read the merged settings: per-key stored values over safe defaults. */
	async get(): Promise<AppSettings> {
		return this.db.withLock(() => this.getUnlocked());
	}

	/**
	 * Read + validate stored settings WITHOUT acquiring the queue lock. Only
	 * for callers that already hold the lock (update()'s read-after-write), so
	 * a nested withLock can never deadlock the queue.
	 */
	private async getUnlocked(): Promise<AppSettings> {
		const rows = await this.db.query<SettingRow>("SELECT key, value FROM settings");
		return decodeSettingsRows(rows);
	}

	/**
	 * Validate a partial update, then write ONLY the provided keys
	 * (UPDATE-then-INSERT per key, portable, no clobber of other fields) inside
	 * ONE explicit transaction so a multi-key write is atomic: any key failure
	 * rolls back every earlier key in the same call. A rollback failure must not
	 * mask the original error. Returns the full merged settings after the write.
	 */
	async update(patch: Partial<AppSettings>): Promise<AppSettings> {
		const entries = Object.entries(patch);
		if (entries.length === 0) return this.get();

		// Validate every key/value BEFORE any write so a bad patch is atomic.
		for (const [key, value] of entries) {
			if (!ALLOWED_KEYS.has(key)) {
				throw new Error(`Unknown settings key: ${JSON.stringify(key)}`);
			}
			// SAFETY: key is known to be in AppSettings; the assertion narrows the
			// value before it is encoded.
			validateSetting(key as keyof AppSettings, value);
		}

		return this.db.withLock(async () => {
			// Validate ALL existing stored settings BEFORE any write. If the
			// stored state is already corrupt (bad JSON, bad value, unknown
			// key), the update must fail closed here — BEFORE begin() — so a
			// rejected update performs zero transaction start and zero writes
			// and cannot mutate some OTHER key that wasn't even being patched.
			await this.getUnlocked();
			await this.db.begin();
			try {
				for (const [key, value] of entries) {
					const encoded = JSON.stringify(value);
					const result = await this.db.run("UPDATE settings SET value = ? WHERE key = ?", [
						encoded,
						key,
					]);
					if (result.changes === 0) {
						await this.db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [key, encoded]);
					}
				}
				await this.db.commit();
			} catch (error) {
				// A rollback failure must not mask the original write error.
				try {
					await this.db.rollback();
				} catch {
					// keep the original error
				}
				throw error;
			}
			// Read-back inside the SAME lock to keep the whole transaction —
			// write + read — atomic with respect to other queued operations.
			return this.getUnlocked();
		});
	}
}
