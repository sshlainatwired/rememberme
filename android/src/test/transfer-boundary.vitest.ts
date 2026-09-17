// @vitest-environment node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * Closed named-input boundary for Phase 7.
 *
 * Every Phase 7 canonical implementation/config file is read through the
 * audited `readInput` helper, which rejects any unlisted path. An after-all
 * assertion requires the whole allowlist to have been read, so both untracked
 * additions and unread omissions fail. The helper never enumerates
 * directories and cannot discover `.env`, untracked specs, protected
 * migrations, keystores, vendor/generated artifacts, or source outside the
 * list.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const ALLOWED = new Set([
	"android/src/transfer/base64.ts",
	"android/src/transfer/backup-codec.ts",
	"android/src/transfer/legacy-import.ts",
	"android/src/transfer/data-transfer.ts",
	"android/src/transfer/document-transfer.ts",
	"android/src/crypto/legacy-journal.ts",
	"android/src/db/journal.ts",
	"android/src/db/settings.ts",
	"android/src/db/settings-events.ts",
	"android/src/db/use-settings.ts",
	"android/src/db/bootstrap.ts",
	"android/src/components/settings/DataTransferCard.tsx",
	"android/src/components/settings/SecurityCard.tsx",
	"android/src/components/settings/SettingsForm.tsx",
	"packages/rememberme-core/src/transfer-timestamp.ts",
	"packages/rememberme-core/src/index.ts",
	"src/server/legacy-export.ts",
	"scripts/export-android.ts",
	"android/android/app/src/main/java/app/rememberme/journal/transfer/BoundedDocumentIO.java",
	"android/android/app/src/main/java/app/rememberme/journal/transfer/DocumentTransferPlugin.java",
	"android/android/app/src/main/java/app/rememberme/journal/MainActivity.java",
	"android/android/app/src/main/AndroidManifest.xml",
	"android/android/app/build.gradle",
	"android/android/variables.gradle",
	"android/capacitor.config.ts",
	"android/vite.config.ts",
	"android/scripts/verify-legacy-build.mjs",
	"android/scripts/verify-legacy-css.mjs",
	"android/package.json",
	"package.json",
	"bun.lock",
]);

const readInputs = new Set<string>();

async function source(path: string): Promise<string> {
	if (!ALLOWED.has(path)) {
		throw new Error(`unlisted static-boundary input: ${path}`);
	}
	readInputs.add(path);
	return readFile(resolve(ROOT, path), "utf8");
}

afterAll(() => {
	const unread = [...ALLOWED].filter((path) => !readInputs.has(path));
	expect(unread).toEqual([]);
});

function assertContains(sourceText: string, needles: string[]): void {
	for (const needle of needles) {
		expect(sourceText).toContain(needle);
	}
}

describe("Phase 7 closed named-input boundary", () => {
	test("reads every canonical Phase 7 allowlisted input through the audited helper", async () => {
		for (const path of ALLOWED) {
			await source(path);
		}
	});

	test("backup codec pins the fixed KDF profile and never accepts archive-selected work", async () => {
		const codec = await source("android/src/transfer/backup-codec.ts");
		assertContains(codec, ["N: 32768", "r: 8", "p: 3", "dkLen: 64", "maxmem: 41_943_040"]);
		// Restore must reject any non-fixed parameter before KDF work.
		expect(codec).toMatch(/value\.kdf\.N !== SCRYPT_OPTIONS\.N/);
		expect(codec).toMatch(/SCYPT|SCRYPT_OPTIONS/);
	});

	test("transfer sources contain no logging, localStorage, or IndexedDB", async () => {
		for (const path of [
			"android/src/transfer/base64.ts",
			"android/src/transfer/backup-codec.ts",
			"android/src/transfer/legacy-import.ts",
			"android/src/transfer/data-transfer.ts",
			"android/src/transfer/document-transfer.ts",
			"android/src/crypto/legacy-journal.ts",
			"android/src/components/settings/DataTransferCard.tsx",
		]) {
			const text = await source(path);
			expect(text).not.toMatch(/console\.(log|debug|info|warn)/);
			expect(text).not.toContain("localStorage");
			expect(text).not.toContain("indexedDB");
		}
	});

	test("the Android manifest and bridge add no network/storage/biometric permissions and no persisted URIs", async () => {
		const plugin = await source(
			"android/android/app/src/main/java/app/rememberme/journal/transfer/DocumentTransferPlugin.java",
		);
		const manifest = await source("android/android/app/src/main/AndroidManifest.xml");
		const gradle = await source("android/android/app/build.gradle");
		expect(plugin).not.toContain("takePersistableUriPermission");
		expect(plugin).not.toContain("Manifest.permission");
		expect(plugin).not.toContain("READ_EXTERNAL_STORAGE");
		expect(plugin).not.toContain("WRITE_EXTERNAL_STORAGE");
		expect(manifest).not.toMatch(/INTERNET|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE/);
		expect(gradle).not.toMatch(/INTERNET|storage|biometric/i);
	});

	test("the web exporter selects only ciphertext/date columns and needs no cipher or key", async () => {
		const exporter = await source("src/server/legacy-export.ts");
		const cli = await source("scripts/export-android.ts");
		assertContains(exporter, [
			"entryDate: journalEntries.entryDate",
			"encryptedContent: journalEntries.encryptedContent",
			"iv: journalEntries.iv",
			"authTag: journalEntries.authTag",
		]);
		expect(exporter).not.toContain("journal-encryption");
		expect(exporter).not.toContain("./config");
		expect(exporter).not.toContain("getCipher");
		expect(exporter).not.toContain("JOURNAL_ENCRYPTION_KEY");
		expect(cli).not.toContain("JOURNAL_ENCRYPTION_KEY");
		expect(cli).not.toContain("getCipher");
	});

	test("restore publishes settings only after commit inside apply", async () => {
		const transfer = await source("android/src/transfer/data-transfer.ts");
		const commitIndex = transfer.indexOf("this.db.commit()");
		const publishIndex = transfer.indexOf("this.publishCommittedSettings()");
		expect(commitIndex).toBeGreaterThan(-1);
		expect(publishIndex).toBeGreaterThan(commitIndex);
	});

	test("Phase 8 controls are live while device protection remains non-portable", async () => {
		const settingsForm = await source("android/src/components/settings/SettingsForm.tsx");
		const security = await source("android/src/components/settings/SecurityCard.tsx");
		const card = await source("android/src/components/settings/DataTransferCard.tsx");
		const transfer = await source("android/src/transfer/data-transfer.ts");
		expect(settingsForm).toContain("<SecurityCard");
		expect(security).toMatch(/Require device unlock/i);
		expect(card).toMatch(/Save encrypted backup/i);
		expect(card).not.toMatch(/biometric|device unlock/i);
		expect(transfer).not.toContain("biometricEnabled");
	});
});

describe("Phase 7 native document bridge static contract", () => {
	test("registration precedes super.onCreate and keeps the notification plugin", async () => {
		const activity = await source(
			"android/android/app/src/main/java/app/rememberme/journal/MainActivity.java",
		);
		expect(activity).toMatch(/registerPlugin\(DocumentTransferPlugin\.class\)/);
		expect(activity).toMatch(/registerPlugin\(WeeklyNotificationsPlugin\.class\)/);
		const onCreate = activity.slice(activity.indexOf("onCreate"));
		expect(onCreate.indexOf("registerPlugin(DocumentTransferPlugin.class)")).toBeLessThan(
			onCreate.indexOf("super.onCreate"),
		);
	});

	test("documents use the exact SAF actions with action-specific grant flags", async () => {
		const plugin = await source(
			"android/android/app/src/main/java/app/rememberme/journal/transfer/DocumentTransferPlugin.java",
		);
		assertContains(plugin, [
			"Intent.ACTION_OPEN_DOCUMENT",
			"Intent.ACTION_CREATE_DOCUMENT",
			"Intent.CATEGORY_OPENABLE",
			"Intent.FLAG_GRANT_READ_URI_PERMISSION",
			"Intent.FLAG_GRANT_WRITE_URI_PERMISSION",
			"Intent.EXTRA_TITLE",
		]);
		const readRegion = plugin.slice(plugin.indexOf("ACTION_OPEN_DOCUMENT"));
		expect(readRegion).toContain("FLAG_GRANT_READ_URI_PERMISSION");
		const writeRegion = plugin.slice(plugin.indexOf("ACTION_CREATE_DOCUMENT"));
		expect(writeRegion).toContain("FLAG_GRANT_WRITE_URI_PERMISSION");
	});

	test("one active call, callback cleanup, byte limits, and streaming", async () => {
		const plugin = await source(
			"android/android/app/src/main/java/app/rememberme/journal/transfer/DocumentTransferPlugin.java",
		);
		const io = await source(
			"android/android/app/src/main/java/app/rememberme/journal/transfer/BoundedDocumentIO.java",
		);
		assertContains(plugin, [
			"@ActivityCallback",
			'@CapacitorPlugin(name = "DocumentTransfer")',
			"if (activeCall == null)",
			"ERROR_BUSY",
			"BoundedDocumentIO.read(input, maxBytes)",
			"BoundedDocumentIO.write(output, bytes, maxBytes)",
		]);
		assertContains(io, ["total > maxBytes", "bytes.length > maxBytes", "maxBytes < 0"]);
		expect(plugin).toContain("activeCall = null");
		expect(plugin).toContain("try (InputStream input");
		expect(plugin).toContain("try (OutputStream output");
	});
});
