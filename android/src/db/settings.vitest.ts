import { describe, expect, it, vi } from "vitest";
import { applyMigrations } from "./migrations";
import { type AppSettings, DEFAULT_SETTINGS, SettingsService } from "./settings";
import { createTestDb } from "./test-helper";
import { Serializer, type SQLDialect } from "./types";

async function setup() {
	const db = createTestDb();
	await applyMigrations(db);
	return new SettingsService(db);
}

/**
 * Access the raw dialect behind a service (allows fault injection).
 */
function rawDb(svc: SettingsService): SQLDialect {
	// SAFETY: test-only invariant TypeScript can't check — the service keeps
	// its dialect in a private `db` field; the cast is confined to this test
	// file and only reads the backing store to install fault-injection triggers.
	return (svc as unknown as { db: SQLDialect }).db;
}

describe("settings: defaults on first read", () => {
	it("returns documented safe defaults when nothing is stored", async () => {
		const svc = await setup();
		expect(await svc.get()).toEqual<AppSettings>({
			timezone: "UTC",
			weeklyReviewEnabled: false,
			weeklyReviewHour: 20,
			biometricEnabled: false,
			appearance: "system",
		});
		// defaults mirror the exported constant
		expect(DEFAULT_SETTINGS.weeklyReviewHour).toBe(20);
		expect(DEFAULT_SETTINGS.weeklyReviewEnabled).toBe(false);
	});
});

describe("settings: validated partial updates without clobber", () => {
	it("updates only the provided fields and keeps the rest", async () => {
		const svc = await setup();
		const updated = await svc.update({ weeklyReviewEnabled: true });
		expect(updated.weeklyReviewEnabled).toBe(true);
		expect(updated.timezone).toBe("UTC"); // untouched
		expect(updated.weeklyReviewHour).toBe(20); // untouched
		expect(updated.biometricEnabled).toBe(false); // untouched
		expect(updated.appearance).toBe("system"); // untouched
	});

	it("persists across a fresh read", async () => {
		const svc = await setup();
		await svc.update({ timezone: "Europe/Istanbul", weeklyReviewHour: 7 });
		const again = await svc.get();
		expect(again.timezone).toBe("Europe/Istanbul");
		expect(again.weeklyReviewHour).toBe(7);
		expect(again.weeklyReviewEnabled).toBe(false);
	});

	it("updates all fields in one call", async () => {
		const svc = await setup();
		const all = await svc.update({
			timezone: "America/New_York",
			weeklyReviewEnabled: true,
			weeklyReviewHour: 21,
			biometricEnabled: true,
			appearance: "dark",
		});
		expect(all).toEqual<AppSettings>({
			timezone: "America/New_York",
			weeklyReviewEnabled: true,
			weeklyReviewHour: 21,
			biometricEnabled: true,
			appearance: "dark",
		});
	});
});

describe("settings: validation rejects bad values", () => {
	it("rejects an invalid timezone", async () => {
		const svc = await setup();
		await expect(svc.update({ timezone: "Mars/Olympus" })).rejects.toThrow();
		// nothing changed
		expect((await svc.get()).timezone).toBe("UTC");
	});

	it("rejects an invalid weekly review hour", async () => {
		const svc = await setup();
		// Hour is type-valid (number) but runtime-invalid; the service must validate.
		await expect(svc.update({ weeklyReviewHour: 24 })).rejects.toThrow();
		await expect(svc.update({ weeklyReviewHour: -1 })).rejects.toThrow();
		await expect(svc.update({ weeklyReviewHour: 7.5 })).rejects.toThrow();
		expect((await svc.get()).weeklyReviewHour).toBe(20);
	});

	it("rejects non-boolean flags", async () => {
		const svc = await setup();
		// @ts-expect-error intentionally invalid runtime value
		await expect(svc.update({ biometricEnabled: "yes" })).rejects.toThrow();
		// @ts-expect-error intentionally invalid runtime value
		await expect(svc.update({ weeklyReviewEnabled: 1 })).rejects.toThrow();
	});

	it("rejects an unknown appearance value", async () => {
		const svc = await setup();
		// @ts-expect-error intentionally invalid runtime value
		await expect(svc.update({ appearance: "neon" })).rejects.toThrow();
	});

	it("rejects unknown keys entirely (no silent extension)", async () => {
		const svc = await setup();
		// @ts-expect-error intentionally invalid runtime value
		await expect(svc.update({ email: "a@b.c" })).rejects.toThrow();
		// @ts-expect-error intentionally invalid runtime value
		await expect(svc.update({ smtpPassword: "hunter2" })).rejects.toThrow();
	});
});

describe("settings: multi-field update is atomic under a second-key failure", () => {
	it("rolls back the first key's write when the second key fails (trigger fault injection)", async () => {
		const svc = await setup();
		// Both keys exist as UPDATE targets before the failing update.
		await svc.update({ timezone: "UTC", weeklyReviewHour: 20 });
		const db = rawDb(svc);
		// Real SQLite trigger aborts any UPDATE of weeklyReviewHour.
		await db.exec(
			"CREATE TRIGGER fail_second BEFORE UPDATE ON settings " +
				"WHEN NEW.key = 'weeklyReviewHour' BEGIN " +
				"SELECT RAISE(ABORT, 'second key failed'); END;",
		);

		await expect(
			svc.update({ timezone: "America/New_York", weeklyReviewHour: 23 }),
		).rejects.toThrow(/second key failed/);

		// The first key's write is gone: the whole update rolled back.
		const after = await svc.get();
		expect(after.timezone).toBe("UTC");
		expect(after.weeklyReviewHour).toBe(20);
	});

	it("preserves the original error when rollback itself throws", async () => {
		const db = createTestDb();
		await applyMigrations(db);
		const original = new Error("the real write failure");
		// Honest narrow fake: serialization via the REAL Serializer primitive,
		// so it behaves like both production adapters under withLock; only the
		// run/rollback fault injection is fake.
		const serializer = new Serializer();
		const failingUpdate: SQLDialect = {
			exec: (sql: string) => db.exec(sql),
			query: (sql: string, params) => db.query(sql, params),
			begin: () => db.begin(),
			commit: () => db.commit(),
			rollback: async () => {
				throw new Error("rollback broke too");
			},
			run: async (sql, params) => {
				if (params?.[1] === "weeklyReviewHour") throw original;
				return db.run(sql, params);
			},
			close: () => db.close(),
			withLock: <T>(fn: () => Promise<T>) => serializer.run(fn),
		};
		const svc = new SettingsService(failingUpdate);
		await expect(
			svc.update({ timezone: "America/New_York", weeklyReviewHour: 23 }),
		).rejects.toThrow(original);
	});
});

describe("settings: stored corruption fails closed instead of silently defaulting", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Insert one raw settings row directly (bypasses service validation). */
	async function storeRow(db: SQLDialect, key: string, value: string): Promise<void> {
		await db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [key, value]);
	}

	async function setupWithRow(key: string, value: string): Promise<SettingsService> {
		const db = createTestDb();
		await applyMigrations(db);
		await storeRow(db, key, value);
		return new SettingsService(db);
	}

	it("rejects malformed JSON in a stored value with a clear corruption error (no silent default)", async () => {
		const svc = await setupWithRow("timezone", "{not json");
		await expect(svc.get()).rejects.toThrow(/corrupt|settings|JSON/i);
		await expect(svc.get()).rejects.toThrow(/timezone/);
	});

	it("rejects a stored value that fails the allowed-key validation (no silent default)", async () => {
		const svc = await setupWithRow("weeklyReviewHour", JSON.stringify(99)); // 99 > 23
		await expect(svc.get()).rejects.toThrow(/corrupt|settings|invalid/i);
	});

	it("names the stored key in a corruption error and preserves the cause (not a generic Invalid error)", async () => {
		const svc = await setupWithRow("weeklyReviewHour", JSON.stringify(99)); // 99 > 23
		const rejection = await svc.get().catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toBe(
			"Corrupt settings: stored value for weeklyReviewHour is invalid.",
		);
		// The original validation failure survives as the wrapper's cause.
		const cause = (rejection as { cause?: unknown }).cause;
		expect(cause).toBeInstanceOf(Error);
		expect((cause as Error).message).toMatch(/Invalid weekly review hour/);
	});

	it("rejects an unknown stored key instead of silently ignoring it", async () => {
		const svc = await setupWithRow("email", JSON.stringify("a@b.c"));
		await expect(svc.get()).rejects.toThrow(/unknown|key/i);
	});

	it("still applies safe defaults when the key is simply absent (missing keys are not corruption)", async () => {
		const svc = await setup();
		expect(await svc.get()).toEqual<AppSettings>(DEFAULT_SETTINGS);
	});

	it("update() rejects when the stored state is already corrupt (validation is pre-write)", async () => {
		const svc = await setupWithRow("timezone", "{not json");
		await expect(svc.update({ weeklyReviewHour: 5 })).rejects.toThrow();
	});

	it("rejected update performs ZERO begin/run/write and leaves the attempted key unchanged", async () => {
		const svc = await setup();
		// Store a valid value for the attempted key, then inject corruption into
		// ANOTHER key (timezone) directly — bypassing service validation.
		await svc.update({ weeklyReviewHour: 7 });
		const db = rawDb(svc);
		await db.run("INSERT INTO settings (key, value) VALUES (?, ?)", ["timezone", "{not json"]);
		const beginSpy = vi.spyOn(db, "begin");
		const runSpy = vi.spyOn(db, "run");

		// Stored settings are corrupt (timezone is malformed JSON), so the
		// update must reject during pre-write validation — not after writing.
		await expect(svc.update({ weeklyReviewHour: 9 })).rejects.toThrow();

		// The rejected update performed ZERO transaction starts and ZERO
		// writes: the corruption check runs BEFORE begin().
		expect(beginSpy).not.toHaveBeenCalled();
		expect(runSpy).not.toHaveBeenCalled();

		// The attempted key is unchanged (still the value from the earlier
		// successful update, not 9 and not missing).
		const rows = await db.query<{ value: string }>(
			"SELECT value FROM settings WHERE key = 'weeklyReviewHour'",
		);
		expect(rows[0]?.value).toBe(JSON.stringify(7));
	});
});

describe("settings: no web-only / email fields stored", () => {
	it("stores exactly the planned Android fields", async () => {
		const svc = await setup();
		await svc.update({
			timezone: "UTC",
			weeklyReviewEnabled: true,
			weeklyReviewHour: 20,
			biometricEnabled: false,
			appearance: "light",
		});
		// SAFETY: test-only invariant the type system can't check — the service
		// keeps its dialect in a private `db` field; the cast is confined to this
		// test file and only reads the backing store.
		const db = (svc as unknown as { db: SQLDialect }).db;
		const keys = await db.query<{ key: string }>("SELECT key FROM settings ORDER BY key");
		expect(keys.map((k) => k.key)).toEqual([
			"appearance",
			"biometricEnabled",
			"timezone",
			"weeklyReviewEnabled",
			"weeklyReviewHour",
		]);
	});
});
