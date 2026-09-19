import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb } from "../src/server/db/client";
import { journalEntries, user } from "../src/server/db/schema";
import {
	createLegacyExportLoader,
	type LegacyExportInputRow,
	runLegacyExport,
	serializeLegacyExport,
} from "../src/server/legacy-export";

const EXPORTED_AT = new Date("2026-09-11T03:33:06.906Z");

function row(overrides: Partial<LegacyExportInputRow> = {}): LegacyExportInputRow {
	return {
		entryDate: "2026-09-10",
		encryptedContent: "ZW5jcnlwdGVk",
		iv: "AAAAAAAAAAAAAAAA",
		authTag: "AAAAAAAAAAAAAAAAAAAAAA==",
		createdAt: new Date("2026-09-10T01:02:03.004Z"),
		updatedAt: new Date("2026-09-10T05:06:07.008Z"),
		...overrides,
	};
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "rememberme-export-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("legacy export serialization", () => {
	test("emits the exact versioned ciphertext-only schema", () => {
		const output = serializeLegacyExport([row()], EXPORTED_AT);
		expect(JSON.parse(output)).toEqual({
			format: "rememberme-legacy-export",
			version: 1,
			exportedAt: "2026-09-11T03:33:06.906Z",
			entries: [
				{
					entryDate: "2026-09-10",
					encryptedContent: "ZW5jcnlwdGVk",
					iv: "AAAAAAAAAAAAAAAA",
					authTag: "AAAAAAAAAAAAAAAAAAAAAA==",
					createdAt: "2026-09-10T01:02:03.004Z",
					updatedAt: "2026-09-10T05:06:07.008Z",
				},
			],
		});
		expect(output.endsWith("\n")).toBe(true);
	});

	test("sorts entries by date and rejects duplicates or invalid values", () => {
		const sorted = serializeLegacyExport(
			[
				row({ entryDate: "2026-09-11", encryptedContent: "c2Vjb25k" }),
				row({ entryDate: "2026-09-09", encryptedContent: "Zmlyc3Q=" }),
			],
			EXPORTED_AT,
		);
		expect(
			JSON.parse(sorted).entries.map((entry: { entryDate: string }) => entry.entryDate),
		).toEqual(["2026-09-09", "2026-09-11"]);
		expect(() => serializeLegacyExport([row(), row()], EXPORTED_AT)).toThrow();
		expect(() => serializeLegacyExport([row({ entryDate: "2026-02-30" })], EXPORTED_AT)).toThrow();
		expect(() => serializeLegacyExport([row({ iv: "not base64!" })], EXPORTED_AT)).toThrow();
		expect(() =>
			serializeLegacyExport([row({ createdAt: new Date(Number.NaN) })], EXPORTED_AT),
		).toThrow();
	});

	test("rejects more than 10,000 rows", () => {
		const rows = Array.from({ length: 10_001 }, (_, index) =>
			row({ entryDate: `2${String(Math.floor(index / 365)).padStart(3, "0")}-01-01` }),
		);
		expect(() => serializeLegacyExport(rows, EXPORTED_AT)).toThrow();
	});

	test("never serializes plaintext, keys, user ids, or emails", () => {
		const secretPlaintext = "PLAINTEXT-MUST-NOT-APPEAR";
		const output = serializeLegacyExport([row()], EXPORTED_AT);
		for (const forbidden of [
			secretPlaintext,
			"JOURNAL_ENCRYPTION_KEY",
			"user-1234",
			"someone@example.com",
			"ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8=",
		]) {
			expect(output).not.toContain(forbidden);
		}
	});

	test("the production module never imports the journal cipher or key accessor", async () => {
		const source = await readFile("src/server/legacy-export.ts", "utf8");
		expect(source).not.toMatch(/import[^;]*journal-encryption/);
		expect(source).not.toMatch(/import[^;]*\.\/config/);
		expect(source).not.toMatch(/import[^;]*getDb/);
		expect(source).not.toContain("getCipher");
		expect(source).not.toContain("JOURNAL_ENCRYPTION_KEY");
	});
});

const writeLoader = { loadRows: async () => [row()] };

function writeDeps(): Parameters<typeof runLegacyExport>[1] {
	return { ...writeLoader };
}

describe("legacy export command", () => {
	test("requires --output and rejects unknown arguments", async () => {
		await expect(runLegacyExport([])).rejects.toThrow("--output");
		await expect(runLegacyExport(["--output", "/tmp/x.json", "--verbose"])).rejects.toThrow(
			"Unknown argument",
		);
		await expect(runLegacyExport(["--output"])).rejects.toThrow("--output");
		await expect(
			runLegacyExport(["--output", "/tmp/a.json", "--output", "/tmp/b.json"]),
		).rejects.toThrow("Duplicate");
	});

	test("writes exclusively with owner-only permissions and never overwrites", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "export.json");
		const message = await runLegacyExport(["--output", path], writeDeps());
		expect(message).toContain(path);
		expect(message).toContain("1");
		expect(message).not.toContain("ZW5jcnlwdGVk");
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(path, "utf8")).entries).toHaveLength(1);
		await expect(runLegacyExport(["--output", path], writeDeps())).rejects.toThrow();
	});

	test("propagates loader failures without writing", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "export.json");
		await expect(
			runLegacyExport(["--output", path], {
				loadRows: async () => {
					throw new Error("Legacy export requires exactly one configured user.");
				},
			}),
		).rejects.toThrow("exactly one configured user");
		await expect(stat(path)).rejects.toThrow();
	});

	test("writeExclusive refuses to replace an existing file", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "existing.json");
		await writeFile(path, "existing", { mode: 0o600 });
		await expect(runLegacyExport(["--output", path], writeDeps())).rejects.toThrow();
		expect(await readFile(path, "utf8")).toBe("existing");
	});
});

describe("legacy export loader (sole-user isolation)", () => {
	test("requires exactly one user and selects only encrypted fields", async () => {
		const db = createDb(":memory:");
		await migrate(db as never, { migrationsFolder: "./drizzle" });
		const loadRows = createLegacyExportLoader(db);
		await expect(loadRows()).rejects.toThrow("exactly one configured user");

		const now = new Date("2026-09-11T03:33:06.906Z");
		await db.insert(user).values({
			id: "user-a",
			name: "A",
			email: "a@example.com",
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(user).values({
			id: "user-b",
			name: "B",
			email: "b@example.com",
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		});
		await expect(loadRows()).rejects.toThrow("exactly one configured user");

		await db.delete(user).where(eq(user.id, "user-b"));
		await db.insert(journalEntries).values({
			id: "entry-a",
			userId: "user-a",
			entryDate: "2026-09-10",
			encryptedContent: "ZW5jcnlwdGVk",
			iv: "AAAAAAAAAAAAAAAA",
			authTag: "AAAAAAAAAAAAAAAAAAAAAA==",
			createdAt: now,
			updatedAt: now,
		});
		const rows = await loadRows();
		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0]).sort()).toEqual([
			"authTag",
			"createdAt",
			"encryptedContent",
			"entryDate",
			"iv",
			"updatedAt",
		]);
		expect(rows[0]).toMatchObject({ entryDate: "2026-09-10", encryptedContent: "ZW5jcnlwdGVk" });
	});
});
