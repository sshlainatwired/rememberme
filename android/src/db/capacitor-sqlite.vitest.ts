import { Capacitor } from "@capacitor/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CapacitorDialect,
	type NativeDatabaseManager,
	type NativeDbConnection,
	openNativeDatabase,
} from "./capacitor-sqlite";

/** Minimal in-memory fake of the owned NativeDbConnection boundary. */
function fakeConnection(overrides: Partial<NativeDbConnection> = {}): NativeDbConnection {
	return {
		open: () => Promise.resolve(),
		execute: () => Promise.resolve({}),
		run: () => Promise.resolve({ changes: { changes: 0 } }),
		query: () => Promise.resolve({ values: [] }),
		beginTransaction: () => Promise.resolve({}),
		commitTransaction: () => Promise.resolve({}),
		rollbackTransaction: () => Promise.resolve({}),
		...overrides,
	};
}

/**
 * Minimal fake manager recording calls against the SQLiteConnection slice,
 * including the encryption/secret/state probes the open path drives. Default
 * to a coherent unencrypted-peek state: encryption configured, no stored
 * secret, no database yet — matching a fresh install.
 */
function fakeManager(connection: NativeDbConnection = fakeConnection()): {
	closeConnection: ReturnType<typeof vi.fn>;
	createConnection: ReturnType<typeof vi.fn>;
	checkConnectionsConsistency: ReturnType<typeof vi.fn>;
	isInConfigEncryption: ReturnType<typeof vi.fn>;
	isSecretStored: ReturnType<typeof vi.fn>;
	isDatabase: ReturnType<typeof vi.fn>;
	isDatabaseEncrypted: ReturnType<typeof vi.fn>;
	ensureEncryptionSecret: ReturnType<typeof vi.fn>;
	manager: NativeDatabaseManager;
} {
	const closeConnection = vi.fn().mockResolvedValue(undefined);
	const createConnection = vi.fn().mockResolvedValue(connection);
	const checkConnectionsConsistency = vi.fn().mockResolvedValue({ result: true });
	const isInConfigEncryption = vi.fn().mockResolvedValue({ result: true });
	const isSecretStored = vi.fn().mockResolvedValue({ result: false });
	const isDatabase = vi.fn().mockResolvedValue({ result: false });
	const isDatabaseEncrypted = vi.fn().mockResolvedValue({ result: false });
	const ensureEncryptionSecret = vi.fn().mockResolvedValue(undefined);
	return {
		closeConnection,
		createConnection,
		checkConnectionsConsistency,
		isInConfigEncryption,
		isSecretStored,
		isDatabase,
		isDatabaseEncrypted,
		ensureEncryptionSecret,
		manager: {
			createConnection,
			closeConnection,
			checkConnectionsConsistency,
			isInConfigEncryption,
			isSecretStored,
			isDatabase,
			isDatabaseEncrypted,
			ensureEncryptionSecret,
		},
	};
}

describe("capacitor-sqlite: production adapter is native-only", () => {
	it("refuses to open in a non-native (web/test) runtime instead of substituting JS storage", async () => {
		// This Vitest (jsdom) run is explicitly a non-native platform.
		expect(Capacitor.isNativePlatform()).toBe(false);
		await expect(openNativeDatabase("rememberme")).rejects.toThrow(/native/i);
	});

	it("is the production adapter class consumed by the native open path", () => {
		// The compile contract (CapacitorDialect implements SQLDialect) is
		// enforced where openNativeDatabase constructs it and declares its
		// return type `Promise<SQLDialect>`; TypeScript checks full
		// assignability at that construction site.
		expect(typeof CapacitorDialect).toBe("function");
	});
});

describe("capacitor-sqlite: exec/run keep transaction=false", () => {
	it("exec forwards its SQL with transaction=false so the plugin does not nest transactions", async () => {
		const execute = vi.fn().mockResolvedValue({});
		const dialect = new CapacitorDialect(fakeConnection({ execute }), fakeManager().manager, "db");
		await dialect.exec("CREATE TABLE t (id INTEGER)");
		expect(execute).toHaveBeenCalledWith("CREATE TABLE t (id INTEGER)", false);
	});

	it("run forwards its SQL and params with transaction=false", async () => {
		const run = vi.fn().mockResolvedValue({ changes: { changes: 3 } });
		const dialect = new CapacitorDialect(fakeConnection({ run }), fakeManager().manager, "db");
		expect(await dialect.run("INSERT INTO t (v) VALUES (?)", ["x"])).toEqual({ changes: 3 });
		expect(run).toHaveBeenCalledWith("INSERT INTO t (v) VALUES (?)", ["x"], false);
	});
});

describe("capacitor-sqlite: close goes through the owning connection manager", () => {
	it("close() calls closeConnection(database,false) — the owned interface has no conn.close to leak registrations", async () => {
		const { closeConnection, manager } = fakeManager();
		const dialect = new CapacitorDialect(fakeConnection(), manager, "rememberme");
		await dialect.close();
		expect(closeConnection).toHaveBeenCalledTimes(1);
		expect(closeConnection).toHaveBeenCalledWith("rememberme", false);
	});

	it("close() is idempotent: a second close does not remove the registration again", async () => {
		const { closeConnection, manager } = fakeManager();
		const dialect = new CapacitorDialect(fakeConnection(), manager, "rememberme");
		await dialect.close();
		await dialect.close();
		expect(closeConnection).toHaveBeenCalledTimes(1);
	});

	it("memoizes a rejected close: later close() calls reject with the original failure and closeConnection is called once", async () => {
		const closeError = new Error("close failed");
		const { closeConnection, manager } = fakeManager();
		closeConnection.mockRejectedValue(closeError);
		const dialect = new CapacitorDialect(fakeConnection(), manager, "rememberme");

		await expect(dialect.close()).rejects.toBe(closeError);
		// The boolean-flag bug: `closed = true` is set before the manager
		// await resolves, so a later close silently resolves even though the
		// underlying close never happened. The memoized close must replay the
		// original rejection to every later caller.
		await expect(dialect.close()).rejects.toBe(closeError);
		expect(closeConnection).toHaveBeenCalledTimes(1);
	});

	it("concurrent close() calls share one closeConnection and all observe the same outcome", async () => {
		const closeError = new Error("close failed");
		const { closeConnection, manager } = fakeManager();
		let rejectClose: (err: Error) => void = () => {};
		closeConnection.mockReturnValue(
			new Promise<void>((_resolve, reject) => {
				rejectClose = reject;
			}),
		);
		const dialect = new CapacitorDialect(fakeConnection(), manager, "rememberme");

		const first = dialect.close();
		const second = dialect.close();
		rejectClose(closeError);

		// The boolean-flag bug: the second (concurrent) caller sees `closed`
		// already true and resolves silently while the first rejects. Every
		// caller must observe the single shared close operation's outcome.
		await expect(first).rejects.toBe(closeError);
		await expect(second).rejects.toBe(closeError);
		expect(closeConnection).toHaveBeenCalledTimes(1);
	});

	it("close() waits for an in-flight locked operation before calling the manager", async () => {
		const { closeConnection, manager } = fakeManager();
		const dialect = new CapacitorDialect(fakeConnection(), manager, "rememberme");

		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		let opRan = false;
		const op = dialect.withLock(async () => {
			opRan = true;
			await gate;
		});
		const closing = dialect.close();
		await Promise.resolve();
		expect(opRan).toBe(true);
		expect(closeConnection).not.toHaveBeenCalled(); // queued behind the lock
		release();
		await op;
		await closing;
		expect(closeConnection).toHaveBeenCalledTimes(1);
		expect(closeConnection).toHaveBeenCalledWith("rememberme", false);
	});

	it("new locked operations after close() reject immediately without touching the connection", async () => {
		const connection = fakeConnection();
		const { manager } = fakeManager(connection);
		const dialect = new CapacitorDialect(connection, manager, "rememberme");
		await dialect.close();

		let executed = false;
		await expect(
			dialect.withLock(async () => {
				executed = true;
			}),
		).rejects.toThrow(/closed/i);
		expect(executed).toBe(false);
	});
});

describe("capacitor-sqlite: plugin availability guard uses the registered plugin identifier", () => {
	it("checks 'CapacitorSQLite' — the identifier the plugin registers via registerPlugin", async () => {
		const isNative = vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
		const isAvailable = vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
		const { manager } = fakeManager();
		const createConnection = manager.createConnection as ReturnType<typeof vi.fn>;

		await openNativeDatabase("db", manager);

		expect(isAvailable).toHaveBeenCalledWith("CapacitorSQLite");
		expect(createConnection).toHaveBeenCalledTimes(1);
		isNative.mockRestore();
		isAvailable.mockRestore();
	});
});

describe("capacitor-sqlite: stale-connection reconciliation before create", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("calls checkConnectionsConsistency() before createConnection on every open", async () => {
		vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
		vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
		const { checkConnectionsConsistency, createConnection, manager } = fakeManager();

		await openNativeDatabase("db", manager);

		// The consistency check runs first; it must precede any create.
		expect(checkConnectionsConsistency.mock.invocationCallOrder[0]).toBeLessThan(
			createConnection.mock.invocationCallOrder[0],
		);
	});

	it("proceeds to create when the check reports stale/inconsistent connections were closed (false)", async () => {
		vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
		vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
		// A brand-new manager has an empty JS dict; false means native
		// inconsistencies were closed/reset, so we proceed to create.
		const { checkConnectionsConsistency, createConnection, manager } = fakeManager();
		checkConnectionsConsistency.mockResolvedValue({ result: false });

		const dialect = await openNativeDatabase("db", manager);

		expect(checkConnectionsConsistency).toHaveBeenCalledTimes(1);
		expect(createConnection).toHaveBeenCalledTimes(1);
		expect(dialect).toBeDefined();
	});

	it("proceeds when the check reports a consistent bridge (true)", async () => {
		vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
		vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
		const { checkConnectionsConsistency, createConnection, manager } = fakeManager();
		checkConnectionsConsistency.mockResolvedValue({ result: true });

		const dialect = await openNativeDatabase("db", manager);

		expect(checkConnectionsConsistency).toHaveBeenCalledTimes(1);
		expect(createConnection).toHaveBeenCalledTimes(1);
		expect(dialect).toBeDefined();
	});

	it("rejects before any further probe or create when the consistency result is missing", async () => {
		vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
		vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
		const open = vi.fn().mockResolvedValue(undefined);
		const m = fakeManager(fakeConnection({ open }));
		m.checkConnectionsConsistency.mockResolvedValue({});

		await expect(openNativeDatabase("db", m.manager)).rejects.toThrow(/boolean/i);
		expect(m.isInConfigEncryption).not.toHaveBeenCalled();
		expect(m.isSecretStored).not.toHaveBeenCalled();
		expect(m.isDatabase).not.toHaveBeenCalled();
		expect(m.createConnection).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
	});

	it("rejects before any further probe or create when the consistency result is not a boolean", async () => {
		vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
		vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
		const open = vi.fn().mockResolvedValue(undefined);
		const m = fakeManager(fakeConnection({ open }));
		m.checkConnectionsConsistency.mockResolvedValue({ result: 1 });

		await expect(openNativeDatabase("db", m.manager)).rejects.toThrow(/boolean/i);
		expect(m.isInConfigEncryption).not.toHaveBeenCalled();
		expect(m.isSecretStored).not.toHaveBeenCalled();
		expect(m.isDatabase).not.toHaveBeenCalled();
		expect(m.createConnection).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
	});

	it("fails closed before create when the consistency check itself throws", async () => {
		vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
		vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
		const consistencyError = new Error("consistency check failed");
		const { checkConnectionsConsistency, createConnection, manager } = fakeManager();
		checkConnectionsConsistency.mockRejectedValue(consistencyError);

		await expect(openNativeDatabase("db", manager)).rejects.toBe(consistencyError);
		// The stale-bridge failure must happen BEFORE createConnection.
		expect(createConnection).not.toHaveBeenCalled();
	});
});

describe("capacitor-sqlite: open resolves encryption state", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function native(): void {
		vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
		vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
	}

	it("fresh install (no db, no stored secret) uses mode 'secret' and provisions natively before create", async () => {
		native();
		const m = fakeManager();
		// defaults: config true, secret false, db false
		await openNativeDatabase("db", m.manager);
		expect(m.createConnection).toHaveBeenCalledWith("db", true, "secret", 1, false);
		expect(m.ensureEncryptionSecret).toHaveBeenCalledTimes(1);
		expect(m.ensureEncryptionSecret.mock.invocationCallOrder[0]).toBeLessThan(
			m.createConnection.mock.invocationCallOrder[0],
		);
	});

	it("fresh install with a stored secret reuses it in mode 'secret'", async () => {
		native();
		const m = fakeManager();
		m.isSecretStored.mockResolvedValue({ result: true });
		await openNativeDatabase("db", m.manager);
		expect(m.isDatabaseEncrypted).not.toHaveBeenCalled();
		expect(m.ensureEncryptionSecret).not.toHaveBeenCalled();
		expect(m.createConnection).toHaveBeenCalledWith("db", true, "secret", 1, false);
	});

	it("existing unencrypted db with no secret uses mode 'encryption' and sets the secret before create", async () => {
		native();
		const m = fakeManager();
		m.isDatabase.mockResolvedValue({ result: true });
		m.isDatabaseEncrypted.mockResolvedValue({ result: false });
		await openNativeDatabase("db", m.manager);
		expect(m.createConnection).toHaveBeenCalledWith("db", true, "encryption", 1, false);
		expect(m.ensureEncryptionSecret).toHaveBeenCalledTimes(1);
	});

	it("existing unencrypted db with a stored secret converts without replacing it", async () => {
		native();
		const m = fakeManager();
		m.isDatabase.mockResolvedValue({ result: true });
		m.isDatabaseEncrypted.mockResolvedValue({ result: false });
		m.isSecretStored.mockResolvedValue({ result: true });
		await openNativeDatabase("db", m.manager);
		expect(m.ensureEncryptionSecret).not.toHaveBeenCalled();
		expect(m.createConnection).toHaveBeenCalledWith("db", true, "encryption", 1, false);
	});

	it("existing encrypted db with a stored secret uses mode 'secret' and sets no new secret", async () => {
		native();
		const m = fakeManager();
		m.isDatabase.mockResolvedValue({ result: true });
		m.isDatabaseEncrypted.mockResolvedValue({ result: true });
		m.isSecretStored.mockResolvedValue({ result: true });
		await openNativeDatabase("db", m.manager);
		expect(m.createConnection).toHaveBeenCalledWith("db", true, "secret", 1, false);
		expect(m.ensureEncryptionSecret).not.toHaveBeenCalled();
	});

	it("encrypted db with no stored secret throws a key-loss error before randomness/set/create", async () => {
		native();
		const m = fakeManager();
		m.isDatabase.mockResolvedValue({ result: true });
		m.isDatabaseEncrypted.mockResolvedValue({ result: true });
		m.isSecretStored.mockResolvedValue({ result: false });
		const getRandomValues = vi.spyOn(crypto, "getRandomValues");
		const btoaSpy = vi.spyOn(globalThis, "btoa");
		await expect(openNativeDatabase("db", m.manager)).rejects.toThrow(/key|lost|secret/i);
		expect(m.ensureEncryptionSecret).not.toHaveBeenCalled();
		expect(m.createConnection).not.toHaveBeenCalled();
		expect(getRandomValues).not.toHaveBeenCalled();
		expect(btoaSpy).not.toHaveBeenCalled();
	});

	it("a real-plugin unknown encryption state without a stored secret reports key loss", async () => {
		native();
		const m = fakeManager();
		const probeError = new Error("Database unknown");
		m.isDatabase.mockResolvedValue({ result: true });
		m.isSecretStored.mockResolvedValue({ result: false });
		m.isDatabaseEncrypted.mockRejectedValue(probeError);
		let caught: unknown;
		try {
			await openNativeDatabase("db", m.manager);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toMatch(/key|secret|encryption state/i);
		expect((caught as Error).cause).toBe(probeError);
		expect(m.ensureEncryptionSecret).not.toHaveBeenCalled();
		expect(m.createConnection).not.toHaveBeenCalled();
	});

	it("config probe returning false throws before any secret/db probe or create", async () => {
		native();
		const m = fakeManager();
		m.isInConfigEncryption.mockResolvedValue({ result: false });
		await expect(openNativeDatabase("db", m.manager)).rejects.toThrow();
		expect(m.isSecretStored).not.toHaveBeenCalled();
		expect(m.createConnection).not.toHaveBeenCalled();
	});

	it("config probe returning a malformed object (no result) throws — probes parse strictly", async () => {
		native();
		const m = fakeManager();
		m.isInConfigEncryption.mockResolvedValue({});
		await expect(openNativeDatabase("db", m.manager)).rejects.toThrow();
		expect(m.isSecretStored).not.toHaveBeenCalled();
		expect(m.createConnection).not.toHaveBeenCalled();
	});

	it("missing boolean results from every database-state probe reject before create", async () => {
		native();
		const cases: Array<(manager: ReturnType<typeof fakeManager>) => void> = [
			(manager) => manager.isSecretStored.mockResolvedValue({}),
			(manager) => manager.isDatabase.mockResolvedValue({}),
			(manager) => {
				manager.isDatabase.mockResolvedValue({ result: true });
				manager.isDatabaseEncrypted.mockResolvedValue({});
			},
		];
		for (const configure of cases) {
			const m = fakeManager();
			configure(m);
			await expect(openNativeDatabase("db", m.manager)).rejects.toThrow(/boolean/i);
			expect(m.createConnection).not.toHaveBeenCalled();
		}
	});

	it("never generates, encodes, or transports the passphrase in JavaScript", async () => {
		native();
		const m = fakeManager();
		const getRandomValues = vi.spyOn(crypto, "getRandomValues");
		const btoaSpy = vi.spyOn(globalThis, "btoa");
		await openNativeDatabase("db", m.manager);
		expect(m.ensureEncryptionSecret).toHaveBeenCalledOnce();
		expect(getRandomValues).not.toHaveBeenCalled();
		expect(btoaSpy).not.toHaveBeenCalled();
	});

	it("native secret provisioning rejection never creates a connection", async () => {
		native();
		const m = fakeManager();
		m.ensureEncryptionSecret.mockRejectedValue(new Error("secure store unavailable"));
		await expect(openNativeDatabase("db", m.manager)).rejects.toThrow("secure store unavailable");
		expect(m.createConnection).not.toHaveBeenCalled();
	});
});

describe("capacitor-sqlite: open failure performs best-effort cleanup", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rethrows the original open error after attempting to closeConnection/remove the registration", async () => {
		// Bypass the platform guard with narrow local stubs so the open path
		// reaches the injectable manager; production keeps no test-only seam.
		vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
		vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
		const openError = new Error("boom: cannot open");
		const conn = fakeConnection({ open: () => Promise.reject(openError) });
		const { closeConnection, createConnection, manager } = fakeManager(conn);
		await expect(openNativeDatabase("db", manager)).rejects.toBe(openError);
		expect(createConnection).toHaveBeenCalledWith("db", true, "secret", 1, false);
		expect(closeConnection).toHaveBeenCalledWith("db", false);
	});

	it("does not mask the original open error even when cleanup itself throws", async () => {
		vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
		vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
		const openError = new Error("boom: cannot open");
		const conn = fakeConnection({ open: () => Promise.reject(openError) });
		const { manager } = fakeManager(conn);
		manager.closeConnection = vi.fn().mockRejectedValue(new Error("cleanup failed"));
		await expect(openNativeDatabase("db", manager)).rejects.toBe(openError);
	});
});
