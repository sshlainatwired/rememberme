// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { createJournalCipher, type JournalCipher } from "@/crypto/legacy-journal";
import { createTestHandle } from "@/db/test-helper";
import { encodeBase64 } from "./base64";
import {
	decryptLegacyExport,
	decryptLegacyExportForTest,
	type LegacyExportRow,
} from "./legacy-import";

const KEY = "ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8=";
const OTHER_KEY = Buffer.alloc(32, 7).toString("base64");
const WEB_FIXTURE = {
	encryptedContent:
		"9o7QblLxhLPFLQWt8X5WeAKmkU0FmCEeu47Kvbt5nhsZMMxJUxJcoVb0rj9yPVcLHoc1ycVJxVYjtOumQsOqsonKIGqUDGyLrA==",
	iv: "Clm1mcXGvU5sDyLC",
	authTag: "hGsAjdnKCwEUXAzjG74Gxg==",
};
const WEB_PLAINTEXT = "legacy-web-fixture-01: 日本語の日記 📖 café — trust but verify";
const TIME = "2026-09-11T03:33:06.906Z";

function source(entries: LegacyExportRow[], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		format: "rememberme-legacy-export",
		version: 1,
		exportedAt: TIME,
		entries,
		...extra,
	});
}

function row(overrides: Partial<LegacyExportRow> = {}): LegacyExportRow {
	return {
		entryDate: "2026-09-10",
		...WEB_FIXTURE,
		createdAt: TIME,
		updatedAt: TIME,
		...overrides,
	};
}

const handles: Array<Awaited<ReturnType<typeof createTestHandle>>> = [];
afterEach(async () => {
	await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => undefined)));
});

describe("legacy web export import", () => {
	test("decrypts the literal web cipher fixture", async () => {
		expect(await decryptLegacyExport(source([row()]), KEY)).toEqual([
			{
				date: "2026-09-10",
				content: WEB_PLAINTEXT,
				createdAt: TIME,
				updatedAt: TIME,
			},
		]);
	});

	test("validates the complete outer file before creating a cipher", async () => {
		const factory = vi.fn(async () => await createJournalCipher(KEY));
		const malformed = [
			"not json",
			source([], {}),
			source([row()], { extra: true }),
			source([row({ entryDate: "2026-02-30" })]),
			source([row({ createdAt: "2026-09-11" })]),
			source([row({ updatedAt: "2026-09-10T00:00:00.000Z" })]),
			source([row({ iv: encodeBase64(new Uint8Array(11)) })]),
			source([row({ authTag: encodeBase64(new Uint8Array(15)) })]),
			source([row(), row()]),
		];
		for (const input of malformed) {
			await expect(decryptLegacyExportForTest(input, KEY, factory)).rejects.toThrow();
		}
		expect(factory).not.toHaveBeenCalled();
	});

	test("rejects wrong keys and corruption in the first or later row", async () => {
		await expect(decryptLegacyExport(source([row()]), OTHER_KEY)).rejects.toThrow(
			"Could not decrypt legacy journal.",
		);
		const cipher = await createJournalCipher(KEY);
		const second = await cipher.encrypt("second row");
		cipher.dispose();
		const corrupted = { ...second, authTag: encodeBase64(new Uint8Array(16)) };
		await expect(
			decryptLegacyExport(source([row(), row({ entryDate: "2026-09-11", ...corrupted })]), KEY),
		).rejects.toThrow("Could not decrypt legacy journal.");
	});

	test("decrypts sequentially and always disposes the cipher", async () => {
		const order: string[] = [];
		const dispose = vi.fn();
		const fake: JournalCipher = {
			async encrypt() {
				throw new Error("unused");
			},
			async decrypt(payload) {
				order.push(payload.encryptedContent);
				if (order.length === 2) throw new Error("later failure");
				return "first";
			},
			dispose,
		};
		const first = row({ encryptedContent: "AA==" });
		const second = row({ entryDate: "2026-09-11", encryptedContent: "AQ==" });
		await expect(
			decryptLegacyExportForTest(source([first, second]), KEY, async () => fake),
		).rejects.toThrow("Could not decrypt legacy journal.");
		expect(order).toEqual(["AA==", "AQ=="]);
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("dispose failures never mask decrypt failures and fail closed after success", async () => {
		const throwingDispose = (): void => {
			throw new Error("dispose detail");
		};
		const decryptFailure: JournalCipher = {
			async encrypt() {
				throw new Error("unused");
			},
			async decrypt() {
				throw new Error("primary decrypt detail");
			},
			dispose: throwingDispose,
		};
		await expect(
			decryptLegacyExportForTest(source([row()]), KEY, async () => decryptFailure),
		).rejects.toThrow("Could not decrypt legacy journal.");

		const successThenDisposeFailure: JournalCipher = {
			async encrypt() {
				throw new Error("unused");
			},
			async decrypt() {
				return "valid content";
			},
			dispose: throwingDispose,
		};
		await expect(
			decryptLegacyExportForTest(source([row()]), KEY, async () => successThenDisposeFailure),
		).rejects.toThrow("Could not decrypt legacy journal.");
	});

	test("prepares with zero writes, then applies through the shared transaction path", async () => {
		const handle = await createTestHandle();
		handles.push(handle);
		await handle.journal.upsert("2026-09-09", "unrelated");
		const preview = await handle.transfer.prepareLegacy(source([row()]), KEY);
		expect(preview).toMatchObject({ kind: "legacy", additions: 1, conflicts: 0 });
		expect(await handle.journal.get("2026-09-10")).toBeNull();
		await handle.transfer.apply(preview.token);
		expect(await handle.journal.list()).toMatchObject([
			{ date: "2026-09-09", content: "unrelated" },
			{ date: "2026-09-10", content: WEB_PLAINTEXT },
		]);
	});

	test("enforces row and file limits before cipher creation", async () => {
		const factory = vi.fn(async () => await createJournalCipher(KEY));
		const tooMany = Array.from({ length: 10_001 }, (_, index) =>
			row({ entryDate: `${String(2000 + Math.floor(index / 365)).padStart(4, "0")}-01-01` }),
		);
		await expect(decryptLegacyExportForTest(source(tooMany), KEY, factory)).rejects.toThrow();
		await expect(
			decryptLegacyExportForTest("x".repeat(16 * 1024 * 1024 + 1), KEY, factory),
		).rejects.toThrow("too large");
		expect(factory).not.toHaveBeenCalled();
	});
});
