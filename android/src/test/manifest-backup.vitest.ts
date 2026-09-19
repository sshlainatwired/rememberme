import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static contract test: reads the committed Android manifest and backup/transfer
// XML resource and asserts the OS-level backup/transfer exclusions. This is a
// file-level contract check only — it does not run Gradle, an emulator, or the
// native plugin, and no native execution is claimed.
const nativeMain = resolve(dirname(fileURLToPath(import.meta.url)), "../../android/app/src/main");

const manifest = readFileSync(resolve(nativeMain, "AndroidManifest.xml"), "utf8");
const dataExtractionRules = readFileSync(
	resolve(nativeMain, "res/xml/data_extraction_rules.xml"),
	"utf8",
);

function block(xml: string, name: string): string {
	const open = `<${name}>`;
	const close = `</${name}>`;
	const start = xml.indexOf(open);
	const end = xml.indexOf(close);
	expect(start, `${name} block present`).toBeGreaterThanOrEqual(0);
	expect(end, `${name} closing tag present`).toBeGreaterThan(start);
	return xml.slice(start + open.length, end);
}

describe("Android backup/transfer hardening (static contract)", () => {
	it("keeps automatic OS backup disabled at the manifest level", () => {
		expect(manifest).toContain('android:allowBackup="false"');
	});

	it("declares fullBackupContent=false and dataExtractionRules exclusions", () => {
		// fullBackupContent=false disables Auto Backup on API 23–30;
		// dataExtractionRules covers cloud backup + device transfer on API 31+.
		expect(manifest).toContain('android:fullBackupContent="false"');
		expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
	});

	it("excludes database and shared-preference data from cloud backup (Android 12+)", () => {
		const cloud = block(dataExtractionRules, "cloud-backup");
		for (const domain of ["root", "database", "sharedpref", "external"]) {
			expect(cloud).toContain(`<exclude domain="${domain}"`);
		}
	});

	it("excludes database and shared-preference data from device transfer (Android 12+)", () => {
		const transfer = block(dataExtractionRules, "device-transfer");
		for (const domain of ["root", "database", "sharedpref", "external"]) {
			expect(transfer).toContain(`<exclude domain="${domain}"`);
		}
	});
});
