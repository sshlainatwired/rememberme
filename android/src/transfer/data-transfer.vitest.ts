// @vitest-environment node

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { openAppDatabase } from "@/db/bootstrap";
import { JournalService } from "@/db/journal";
import { applyMigrations } from "@/db/migrations";
import { createNodeDialect } from "@/db/node-sqlite";
import { createTestBackupCodec } from "@/db/test-codec";
import { createTestDb, createTestHandle } from "@/db/test-helper";
import type { SQLDialect } from "@/db/types";
import type { TransferEntry } from "./backup-codec";
import { DataTransferService } from "./data-transfer";

const ENTRY: TransferEntry = {
	date: "2026-09-10",
	content: "imported content",
	createdAt: "2026-09-10T01:02:03.004Z",
	updatedAt: "2026-09-10T05:06:07.008Z",
};

const TEST_CODEC = createTestBackupCodec();

const handles: Array<Awaited<ReturnType<typeof createTestHandle>>> = [];

async function handle() {
	const created = await createTestHandle(TEST_CODEC);
	handles.push(created);
	return created;
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(handles.splice(0).map((database) => database.close().catch(() => undefined)));
});

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "rememberme-transfer-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("DataTransferService close/reopen portability", () => {
	test("a backup applied to a fresh database survives close and reopen with auth intact", async () => {
		const directory = await temporaryDirectory();
		const sourcePath = join(directory, "source.sqlite");
		const destinationPath = join(directory, "destination.sqlite");

		const source = await openAppDatabase({
			open: async () => createNodeDialect(sourcePath),
			backupCodec: TEST_CODEC,
		});
		await source.auth.setup("source-password", "UTC");
		await source.journal.upsert("2026-09-10", "source date");
		await source.settings.update({ timezone: "Pacific/Chatham", appearance: "dark" });
		const archive = await source.transfer.createBackup("backup-password");
		await source.close();

		const destination = await openAppDatabase({
			open: async () => createNodeDialect(destinationPath),
			backupCodec: TEST_CODEC,
		});
		await destination.auth.setup("destination-password", "UTC");
		const preview = await destination.transfer.prepareBackup(archive, "backup-password");
		await destination.transfer.apply(preview.token);
		await destination.close();

		const reopened = await openAppDatabase({
			open: async () => createNodeDialect(destinationPath),
			backupCodec: TEST_CODEC,
		});
		expect(await reopened.journal.get("2026-09-10")).toMatchObject({ content: "source date" });
		expect(await reopened.settings.get()).toMatchObject({
			timezone: "Pacific/Chatham",
			appearance: "dark",
		});
		await expect(reopened.auth.login("destination-password")).resolves.toMatchObject({
			unlocked: true,
		});
		await reopened.close();
	});
});

describe("DataTransferService", () => {
	test("backs up and restores entries plus portable settings while preserving auth, biometrics, and unrelated dates", async () => {
		const source = await handle();
		await source.journal.upsert("2026-09-10", "source conflict");
		await source.journal.upsert("2026-09-11", "source addition");
		await source.settings.update({
			timezone: "Pacific/Chatham",
			weeklyReviewEnabled: true,
			weeklyReviewHour: 7,
			appearance: "dark",
			biometricEnabled: false,
		});
		const archive = await source.transfer.createBackup("backup-password");

		const destination = await handle();
		await destination.auth.setup("destination-password", "UTC");
		await destination.journal.upsert("2026-09-09", "keep unrelated");
		await destination.journal.upsert("2026-09-10", "replace me");
		await destination.settings.update({ biometricEnabled: true, appearance: "light" });

		const preview = await destination.transfer.prepareBackup(archive, "backup-password");
		expect(preview).toMatchObject({
			kind: "backup",
			additions: 1,
			conflicts: 1,
			settingsChanged: true,
		});
		expect(Object.keys(preview).sort()).toEqual(
			["additions", "conflicts", "expiresAt", "kind", "settingsChanged", "token"].sort(),
		);
		expect(JSON.stringify(preview)).not.toContain("source conflict");
		expect(await destination.journal.get("2026-09-10")).toMatchObject({ content: "replace me" });
		expect(await destination.transfer.apply(preview.token)).toEqual({ imported: 2 });
		expect(await destination.journal.list()).toMatchObject([
			{ date: "2026-09-09", content: "keep unrelated" },
			{ date: "2026-09-10", content: "source conflict" },
			{ date: "2026-09-11", content: "source addition" },
		]);
		expect(await destination.settings.get()).toEqual({
			timezone: "Pacific/Chatham",
			weeklyReviewEnabled: true,
			weeklyReviewHour: 7,
			appearance: "dark",
			biometricEnabled: true,
		});
		destination.auth.logout();
		await expect(destination.auth.login("destination-password")).resolves.toEqual({
			configured: true,
			unlocked: true,
		});
		await expect(destination.transfer.apply(preview.token)).rejects.toThrow("preview");
	});

	test("rejects changed imported dates and changed raw portable settings before writing", async () => {
		const database = await handle();
		await database.journal.upsert(ENTRY.date, "local");
		const preview = await database.transfer.prepareEntries("legacy", [ENTRY]);
		await database.journal.upsert(ENTRY.date, "changed after preview");
		await expect(database.transfer.apply(preview.token)).rejects.toThrow("preview again");
		expect(await database.journal.get(ENTRY.date)).toMatchObject({
			content: "changed after preview",
		});

		const source = await handle();
		const archive = await source.transfer.createBackup("backup-password");
		const settingsPreview = await database.transfer.prepareBackup(archive, "backup-password");
		await database.settings.update({ appearance: "system" });
		await expect(database.transfer.apply(settingsPreview.token)).rejects.toThrow("preview again");
	});

	test("cancel, replacement, expiry, and dispose invalidate single-use previews", async () => {
		const database = await handle();
		const cancelled = await database.transfer.prepareEntries("legacy", [ENTRY]);
		database.transfer.cancel(cancelled.token);
		await expect(database.transfer.apply(cancelled.token)).rejects.toThrow("preview");

		const replaced = await database.transfer.prepareEntries("legacy", [ENTRY]);
		const current = await database.transfer.prepareEntries("legacy", [ENTRY]);
		await expect(database.transfer.apply(replaced.token)).rejects.toThrow("preview");
		database.transfer.cancel(current.token);

		vi.useFakeTimers();
		const expiring = await database.transfer.prepareEntries("legacy", [ENTRY]);
		expect(expiring.expiresAt).toBe(Date.now() + 5 * 60_000);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		await expect(database.transfer.apply(expiring.token)).rejects.toThrow("expired");
		vi.useRealTimers();

		database.transfer.dispose();
		await expect(database.transfer.prepareEntries("legacy", [ENTRY])).rejects.toThrow("disposed");
	});

	test("rolls back transaction failures, preserves the original cause, and publishes nothing", async () => {
		const base = createTestDb();
		await applyMigrations(base);
		const writeFailure = new Error("injected write failure");
		const publish = vi.fn();
		let failWrites = false;
		const fault: SQLDialect = {
			exec: (sql) => base.exec(sql),
			run: async (sql, params) => {
				if (failWrites && sql.startsWith("UPDATE journal_entries")) throw writeFailure;
				return base.run(sql, params);
			},
			query: (sql, params) => base.query(sql, params),
			begin: () => base.begin(),
			commit: () => base.commit(),
			rollback: async () => {
				await base.rollback();
				throw new Error("injected rollback failure");
			},
			withLock: (operation) => base.withLock(operation),
			close: () => base.close(),
		};
		const journal = new JournalService(base, () => "2026-09-11T00:00:00.000Z");
		await journal.upsert(ENTRY.date, "local before failure");
		const transfer = new DataTransferService(fault, publish);
		const preview = await transfer.prepareEntries("legacy", [ENTRY]);
		failWrites = true;
		await expect(transfer.apply(preview.token)).rejects.toBe(writeFailure);
		expect(await journal.get(ENTRY.date)).toMatchObject({ content: "local before failure" });
		expect(publish).not.toHaveBeenCalled();
		transfer.dispose();
		await base.close();
	});

	test("publishes after a successful committed apply and never for stale failure", async () => {
		const database = await handle();
		const listener = vi.fn();
		const { subscribeSettingsChanged } = await import("@/db/settings-events");
		const unsubscribe = subscribeSettingsChanged(database, listener);
		const success = await database.transfer.prepareEntries("legacy", [ENTRY]);
		await database.transfer.apply(success.token);
		expect(listener).toHaveBeenCalledOnce();

		const stale = await database.transfer.prepareEntries("legacy", [ENTRY]);
		await database.journal.upsert(ENTRY.date, "changed");
		await expect(database.transfer.apply(stale.token)).rejects.toThrow();
		expect(listener).toHaveBeenCalledOnce();
		unsubscribe();
	});
});
