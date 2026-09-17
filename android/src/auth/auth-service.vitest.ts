import { describe, expect, it, vi } from "vitest";
import { AuthService } from "@/auth/auth-service";
import { __setCryptoSource } from "@/auth/passwords";
import { applyMigrations } from "@/db/migrations";
import { SettingsService } from "@/db/settings";
import { createTestDb } from "@/db/test-helper";

/**
 * Shared fixture: a real in-memory SQLite DB migrated to schema v3, plus a
 * settings service and an AuthService wired against it, mirroring how
 * bootstrap builds the production handle.
 */
const makeService = async () => {
	const db = createTestDb();
	await applyMigrations(db);
	const settings = new SettingsService(db);
	return { db, settings, auth: new AuthService(db, settings) };
};

describe("status/setup/login/logout", () => {
	it("starts unconfigured and unlocked", async () => {
		const { auth } = await makeService();
		expect(await auth.status()).toEqual({ configured: false, unlocked: false });
	});

	it("setup seeds timezone first, then inserts the singleton auth row", async () => {
		const { auth, settings } = await makeService();
		await auth.setup("a-secure-pass", "Europe/Istanbul");
		expect(await auth.status()).toEqual({ configured: true, unlocked: true });
		expect((await settings.get()).timezone).toBe("Europe/Istanbul");
	});

	it("setup rejects an invalid timezone before writing anything", async () => {
		const { auth } = await makeService();
		await expect(auth.setup("a-secure-pass", "Not/AZone")).rejects.toThrow(/timezone/i);
		expect((await auth.status()).configured).toBe(false);
	});

	it("setup refuses to overwrite an existing configuration", async () => {
		const { auth } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		await expect(auth.setup("another-pass", "UTC")).rejects.toThrow(/already configured/i);
	});

	it("rejects short/long passwords with a clear error", async () => {
		const { auth } = await makeService();
		await expect(auth.setup("1234567", "UTC")).rejects.toThrow(/8\.\.128/i);
		expect((await auth.status()).configured).toBe(false);
		await expect(auth.setup("a".repeat(129), "UTC")).rejects.toThrow(/8\.\.128/i);
		expect((await auth.status()).configured).toBe(false);
	});

	it("login with the correct password unlocks after setup", async () => {
		const { auth, db } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		// simulate a fresh process: in-memory session is gone
		const auth2 = new AuthService(db, new SettingsService(db));
		await auth2.login("a-secure-pass");
		expect((await auth2.status()).unlocked).toBe(true);
	});

	it("login with a wrong password fails with a GENERIC message (no oracle) and stays locked", async () => {
		const { auth, db } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		const auth2 = new AuthService(db, new SettingsService(db));
		await expect(auth2.login("wrong-pass")).rejects.toThrow("Invalid password.");
		expect((await auth2.status()).unlocked).toBe(false);
	});

	it("login before setup uses the same generic failure message", async () => {
		const { auth } = await makeService();
		await expect(auth.login("whatever-pass")).rejects.toThrow("Invalid password.");
	});

	it("logout clears the in-memory session only", async () => {
		const { auth } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		auth.logout();
		expect((await auth.status()).unlocked).toBe(false);
		expect((await auth.status()).configured).toBe(true); // row persists
	});
});

describe("trusted device-credential session unlock", () => {
	it("unlocks a configured valid row without KDF work or stored mutation", async () => {
		const { db, auth } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		auth.logout();
		const restarted = new AuthService(db, new SettingsService(db));
		const before = await db.query<{ verifier: string }>("SELECT verifier FROM local_auth");
		const real = globalThis.crypto;
		let randomCalls = 0;
		const getRandomValues: Crypto["getRandomValues"] = (array) => {
			randomCalls += 1;
			return real.getRandomValues(array);
		};
		const importKey = vi.fn(real.subtle.importKey.bind(real.subtle));
		const subtle = new Proxy(real.subtle, {
			get: (target, property) =>
				property === "importKey" ? importKey : target[property as keyof SubtleCrypto],
		});
		__setCryptoSource({ getRandomValues, subtle });
		try {
			expect(await restarted.unlockWithDeviceCredential()).toEqual({
				configured: true,
				unlocked: true,
			});
			expect(restarted.isUnlocked()).toBe(true);
			expect(randomCalls).toBe(0);
			expect(importKey).not.toHaveBeenCalled();
			expect(await db.query("SELECT verifier FROM local_auth")).toEqual(before);
		} finally {
			__setCryptoSource(real);
		}
	});

	it("fails closed when local auth is not configured", async () => {
		const { auth } = await makeService();
		await expect(auth.unlockWithDeviceCredential()).rejects.toThrow(/not configured/i);
		expect(auth.isUnlocked()).toBe(false);
	});

	it("fails closed on malformed verifier, timestamp, and duplicate rows", async () => {
		const malformed = await makeService();
		await malformed.auth.setup("a-secure-pass", "UTC");
		malformed.auth.logout();
		await malformed.db.run("UPDATE local_auth SET verifier = 'not-json'");
		await expect(malformed.auth.unlockWithDeviceCredential()).rejects.toThrow(/corrupt/i);
		expect(malformed.auth.isUnlocked()).toBe(false);

		const timestamp = await makeService();
		await timestamp.auth.setup("a-secure-pass", "UTC");
		timestamp.auth.logout();
		await timestamp.db.run("UPDATE local_auth SET updated_at = 'not-a-date'");
		await expect(timestamp.auth.unlockWithDeviceCredential()).rejects.toThrow(/valid date/i);
		expect(timestamp.auth.isUnlocked()).toBe(false);

		const duplicate = await makeService();
		await duplicate.auth.setup("a-secure-pass", "UTC");
		duplicate.auth.logout();
		await duplicate.db.exec("PRAGMA ignore_check_constraints = ON");
		await duplicate.db.run(
			"INSERT INTO local_auth (id, verifier, created_at, updated_at) VALUES (?, ?, ?, ?)",
			[2, "not-a-verifier", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
		);
		await duplicate.db.exec("PRAGMA ignore_check_constraints = OFF");
		await expect(duplicate.auth.unlockWithDeviceCredential()).rejects.toThrow(
			/expected exactly one row/i,
		);
		expect(duplicate.auth.isUnlocked()).toBe(false);
	});

	it("logout clears a trusted device-credential session", async () => {
		const { db, auth } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		auth.logout();
		const restarted = new AuthService(db, new SettingsService(db));
		await restarted.unlockWithDeviceCredential();
		restarted.logout();
		expect(restarted.isUnlocked()).toBe(false);
	});
});

describe("stored-data fail-closed", () => {
	it("rejects a corrupt stored verifier row", async () => {
		const { db, auth } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		await db.run("UPDATE local_auth SET verifier = 'not-json'");
		await expect(auth.status()).rejects.toThrow(/corrupt/i);
		await expect(auth.login("a-secure-pass")).rejects.toThrow(/corrupt/i);
	});

	it("setup strict-decodes corruption before settings or KDF work", async () => {
		const { db, settings, auth } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		await db.run("UPDATE local_auth SET verifier = 'not-json'");
		const update = vi.spyOn(settings, "update");
		const real = globalThis.crypto;
		let randomCalls = 0;
		const getRandomValues: Crypto["getRandomValues"] = (array) => {
			randomCalls += 1;
			return real.getRandomValues(array);
		};
		const importKey = vi.fn(real.subtle.importKey.bind(real.subtle));
		const subtle = new Proxy(real.subtle, {
			get: (target, property) =>
				property === "importKey" ? importKey : target[property as keyof SubtleCrypto],
		});
		__setCryptoSource({ getRandomValues, subtle });
		try {
			const restarted = new AuthService(db, settings);
			await expect(restarted.setup("another-pass", "Europe/Istanbul")).rejects.toThrow(
				/corrupt local auth/i,
			);
			expect(update).not.toHaveBeenCalled();
			expect(randomCalls).toBe(0);
			expect(importKey).not.toHaveBeenCalled();
		} finally {
			update.mockRestore();
			__setCryptoSource(real);
		}
	});

	it("rejects two rows (singleton invariant recheck)", async () => {
		const { db, auth } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		// CHECK(id = 1) forbids a normal second INSERT, so temporarily disable
		// constraint enforcement to construct an illegal two-row store (C-R4:
		// prove the service re-reads and rejects any result that is not exactly
		// one row).
		await db.exec("PRAGMA ignore_check_constraints = ON");
		await db.run(
			"INSERT INTO local_auth (id, verifier, created_at, updated_at) VALUES (?, ?, ?, ?)",
			[2, "not-a-real-verifier", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
		);
		await db.exec("PRAGMA ignore_check_constraints = OFF");
		await expect(auth.status()).rejects.toThrow(/expected exactly one row/i);
		await expect(auth.login("a-secure-pass")).rejects.toThrow(/expected exactly one row/i);
	});

	it("validateStored decodes strictly and throws on hostile iteration count", async () => {
		const { db, auth } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		const hostel = JSON.stringify({
			version: 1,
			algorithm: "PBKDF2-HMAC-SHA256",
			iterations: 100000, // hostile downgrade
			salt: "YWFhYWFhYWFhYWFhYWFhYQ==", // canonical 16-byte base64
			verifier: "YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI=", // canonical 32-byte base64
		});
		await db.run("UPDATE local_auth SET verifier = ?", [hostel]);
		await expect(auth.validateStored()).rejects.toThrow(/iterations/i);
		await expect(auth.status()).rejects.toThrow(/iterations/i);
	});
});

describe("setup serialization & transaction ordering (fix round 1)", () => {
	it("repeated setup with a different timezone rejects and leaves the original timezone unchanged", async () => {
		const { auth, settings } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		await expect(auth.setup("another-pass", "Europe/Istanbul")).rejects.toThrow(
			/already configured/i,
		);
		expect((await settings.get()).timezone).toBe("UTC");
	});

	it("concurrent setup with different zones: the winner's zone is preserved, the loser rejects and cannot clobber it", async () => {
		const { auth, settings } = await makeService();
		const first = auth.setup("a-secure-pass-A", "Asia/Seoul");
		const second = auth.setup("a-secure-pass-B", "Pacific/Auckland");
		const [a, b] = await Promise.allSettled([first, second]);
		expect(a.status).toBe("fulfilled");
		expect(b.status).toBe("rejected");
		if (b.status === "rejected") {
			expect(String((b as PromiseRejectedResult).reason)).toMatch(/already configured/i);
		}
		// The enqueued-first setup wins; its zone must survive the loser.
		expect((await settings.get()).timezone).toBe("Asia/Seoul");
	});

	it("inserts the auth row inside one explicit transaction: begin immediately before the insert, commit immediately after, no rollback", async () => {
		const { db, auth } = await makeService();
		const order: string[] = [];
		const begin = db.begin.bind(db);
		const commit = db.commit.bind(db);
		const rollback = db.rollback.bind(db);
		const run = db.run.bind(db);
		db.begin = async () => {
			order.push("begin");
			await begin();
		};
		db.commit = async () => {
			order.push("commit");
			await commit();
		};
		db.rollback = async () => {
			order.push("rollback");
			await rollback();
		};
		db.run = async (sql, ...params) => {
			if (/INSERT INTO local_auth/i.test(sql)) order.push("insert");
			return run(sql, ...params);
		};
		await auth.setup("a-secure-pass", "UTC");
		const insertAt = order.indexOf("insert");
		expect(insertAt).toBeGreaterThan(0);
		expect(order[insertAt - 1]).toBe("begin");
		expect(order[insertAt + 1]).toBe("commit");
		expect(order).not.toContain("rollback");
	});

	it("rolls back the transaction when the insert fails, preserving the original error", async () => {
		const { db, auth } = await makeService();
		const rollback = vi.fn(db.rollback.bind(db));
		db.rollback = rollback;
		const run = db.run.bind(db);
		db.run = async (sql, ...params) => {
			if (/INSERT INTO local_auth/i.test(sql)) throw new Error("insert boom");
			return run(sql, ...params);
		};
		await expect(auth.setup("a-secure-pass", "UTC")).rejects.toThrow("insert boom");
		// Checked rollback ran once and the ORIGINAL error propagated (not masked).
		expect(rollback).toHaveBeenCalledOnce();
		expect((await auth.status()).configured).toBe(false);
	});

	it("fails closed on a malformed stored created_at (status/login/validateStored)", async () => {
		const { db, auth } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		await db.run("UPDATE local_auth SET created_at = 'not-a-date'");
		await expect(auth.status()).rejects.toThrow(/not a valid date string/i);
		await expect(auth.login("a-secure-pass")).rejects.toThrow(/not a valid date string/i);
		await expect(auth.validateStored()).rejects.toThrow(/not a valid date string/i);
	});

	it("fails closed on a malformed stored updated_at (status)", async () => {
		const { db, auth } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		await db.run("UPDATE local_auth SET updated_at = 'garbage'");
		await expect(auth.status()).rejects.toThrow(/not a valid date string/i);
	});

	it("an injected clock emitting a non-date rejects setup and writes no auth row", async () => {
		const db = createTestDb();
		await applyMigrations(db);
		const settings = new SettingsService(db);
		const auth = new AuthService(db, settings, () => "not-a-date");
		await expect(auth.setup("a-secure-pass", "UTC")).rejects.toThrow(/not a valid date string/i);
		expect((await auth.status()).configured).toBe(false);
		expect(await db.query("SELECT id FROM local_auth")).toEqual([]);
	});

	it("login reads and decodes the stored row exactly once (no double read)", async () => {
		const { db, auth } = await makeService();
		await auth.setup("a-secure-pass", "UTC");
		const auth2 = new AuthService(db, new SettingsService(db));
		const query = db.query.bind(db);
		let authReads = 0;
		db.query = async (sql, ...params) => {
			if (/FROM local_auth/i.test(sql)) authReads++;
			return query(sql, ...params);
		};
		await auth2.login("a-secure-pass");
		// isUnlocked() is pure JS (no DB read); assert BEFORE any status() so the
		// counter only reflects login's own reads.
		expect(auth2.isUnlocked()).toBe(true);
		expect(authReads).toBe(1);
	});
});
