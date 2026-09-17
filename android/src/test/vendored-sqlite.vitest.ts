import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static/provenance contract for the app-owned vendored
 * `@capacitor-community/sqlite@8.1.1` Android module (Phase 4
 * plaintext-conversion crash-recovery fix).
 *
 * This is a file-level contract only: it reads committed Java/Gradle sources
 * and asserts the vendored provenance, the settings override position, and
 * the deterministic crash-recovery protocol markers. It does NOT run Gradle,
 * a JDK, an emulator, or the native plugin — no native execution is claimed
 * (see ADR-0005 "Native verification limitation").
 *
 * The vendor tree is the upstream npm `android/` module byte-for-byte except
 * for the five documented patched files and five app-owned helpers/tests used
 * by the Phase 4 conversion and Phase 8 key-protection protocols. That equality
 * is asserted below so an accidental edit of any other upstream file fails.
 */

// `android/src/test/` → `android/` workspace root → native project.
const androidRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nativeRoot = join(androidRoot, "android");
const vendorDir = join(nativeRoot, "vendor", "capacitor-community-sqlite");
const vendorModule = join(vendorDir, "android");
// Installed upstream npm module (gitignored; must be present for the diff check).
const upstreamModule = join(
	androidRoot,
	"node_modules",
	"@capacitor-community",
	"sqlite",
	"android",
);

function read(rel: string): string {
	const abs = join(vendorDir, rel);
	expect(existsSync(abs), `vendored file exists: ${rel}`).toBe(true);
	return readFileSync(abs, "utf8");
}

function upstreamRead(rel: string): string {
	return readFileSync(join(upstreamModule, rel), "utf8");
}

/** Recursive relative file listing (directories only where files exist). */
function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (rel: string) => {
		const abs = join(dir, rel);
		for (const entry of readdirSync(abs, { withFileTypes: true })) {
			// Compare source trees, not Gradle output created when the vendored
			// module's host-JVM/native compilation gates run locally or in CI.
			if (entry.isDirectory() && (entry.name === "build" || entry.name === ".gradle")) {
				continue;
			}
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(childRel);
			else out.push(childRel);
		}
	};
	walk("");
	return out.sort();
}

/** Slice a method body from its signature line to the next 4-space-indented closing brace. */
function methodBody(source: string, signature: string): string {
	const start = source.indexOf(signature);
	expect(start, `method signature present: ${signature}`).toBeGreaterThanOrEqual(0);
	const end = source.indexOf("\n    }", start);
	expect(end, `method closing brace after: ${signature}`).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("vendored @capacitor-community/sqlite@8.1.1 module provenance", () => {
	it("vendors the native Android module with upstream README, LICENSE, and PROVENANCE", () => {
		expect(existsSync(vendorModule)).toBe(true);
		expect(existsSync(join(vendorDir, "README.md"))).toBe(true);
		expect(existsSync(join(vendorDir, "LICENSE"))).toBe(true);
		expect(existsSync(join(vendorDir, "PROVENANCE.md"))).toBe(true);
		// The module's own build file must be present and untouched.
		expect(readFileSync(join(vendorModule, "build.gradle"), "utf8")).toContain(
			"com.android.library",
		);
	});

	it("PROVENANCE.md pins @capacitor-community/sqlite@8.1.1 and names the upstream source", () => {
		const provenance = read("PROVENANCE.md");
		expect(provenance).toContain("@capacitor-community/sqlite");
		expect(provenance).toContain("8.1.1");
		expect(provenance.toLowerCase()).toContain("github.com/capacitor-community/sqlite");
	});

	it("LICENSE is the upstream MIT license", () => {
		const license = read("LICENSE");
		expect(license).toContain("MIT License");
	});

	it("vendored module file set equals upstream plus the documented app-owned helpers", () => {
		const upstream = listFiles(upstreamModule);
		const vendored = listFiles(vendorModule);
		const extra = vendored.filter((f) => !upstream.includes(f));
		const missing = upstream.filter((f) => !vendored.includes(f));
		expect(missing, "no upstream file dropped").toEqual([]);
		expect(extra, "only documented app-owned helpers/tests are added").toEqual([
			"src/main/java/com/getcapacitor/community/database/sqlite/SQLite/DeviceAuthenticator.java",
			"src/main/java/com/getcapacitor/community/database/sqlite/SQLite/EncryptionFileSwap.java",
			"src/main/java/com/getcapacitor/community/database/sqlite/SQLite/KeyProtectionState.java",
			"src/main/java/com/getcapacitor/community/database/sqlite/SQLite/KeyProtectionStore.java",
			"src/test/java/com/getcapacitor/community/database/sqlite/SQLite/KeyProtectionStateTest.java",
		]);
	});

	it("every shared upstream file is byte-identical except the five documented patches", () => {
		const patched = new Set([
			"src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSQLCipher.java",
			"src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLite.java",
			"src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLitePlugin.java",
			"src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSecret.java",
			"src/main/java/com/getcapacitor/community/database/sqlite/SQLite/Database.java",
		]);
		// The file-set test above proves the exact app-owned extras; skip files
		// absent upstream here so this scan stays byte-for-byte.
		const upstreamFiles = listFiles(upstreamModule);
		const shared = listFiles(vendorModule).filter(
			(f) => !patched.has(f) && upstreamFiles.includes(f),
		);
		for (const file of shared) {
			const vendored = readFileSync(join(vendorModule, file), "utf8");
			const upstream = upstreamRead(file);
			expect(vendored, `unpatched file identical to upstream: ${file}`).toBe(upstream);
		}
		// The five patched files exist and differ from upstream (the patch is real).
		for (const file of [...patched]) {
			expect(readFileSync(join(vendorModule, file), "utf8")).not.toBe(upstreamRead(file));
		}
	});
});

describe("vendored-projects settings override (survives cap sync)", () => {
	it("overrides :capacitor-community-sqlite after apply from capacitor.settings.gradle", () => {
		const settings = readFileSync(join(nativeRoot, "settings.gradle"), "utf8");
		const applyIdx = settings.indexOf("apply from: 'capacitor.settings.gradle'");
		const override =
			"project(':capacitor-community-sqlite').projectDir = new File('./vendor/capacitor-community-sqlite/android')";
		const overrideIdx = settings.indexOf(override);
		expect(applyIdx, "cap-generated include is applied").toBeGreaterThanOrEqual(0);
		expect(overrideIdx, "app-owned override present").toBeGreaterThan(applyIdx);
	});

	it("never edits the generated capacitor.settings.gradle", () => {
		const generated = readFileSync(join(nativeRoot, "capacitor.settings.gradle"), "utf8");
		expect(generated).not.toContain("vendor");
	});
});

describe("deterministic conversion protocol markers (static)", () => {
	const utilSQLCipher = read(
		"android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSQLCipher.java",
	);

	it("encrypt() page-fsyncs the candidate inside the swap commit (ops.fsync before rename), not in encrypt itself", () => {
		const encrypt = methodBody(utilSQLCipher, "public void encrypt(");
		expect(encrypt).toContain("EncryptionFileSwap");
		expect(encrypt).toContain("swap.recover(");
		expect(encrypt).toContain("swap.commit(");
		// fsync-ordering hardening: the candidate fsync is owned by commit(),
		// so no direct EncryptionFileSwap.fsyncNoTruncate(...) bypass survives
		// inside the conversion (a conversion that fsyncs only in encrypt()
		// could lose the durable page flush if commit() is ever reached by
		// another caller).
		expect(encrypt).not.toContain("fsyncNoTruncate(");
		expect(encrypt).not.toContain("getCacheDir");
		expect(encrypt).not.toContain("createTempFile");
		expect(encrypt).not.toContain("originalFile.delete()");

		// The candidate fsync runs inside commit() through the injected ops
		// seam, before ANY sidecar deletion or rename (which happen inside the
		// promote helpers commit() calls), so a forced fsync failure aborts
		// without a swap.
		const helperSource = read(
			"android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/EncryptionFileSwap.java",
		);
		const commit = methodBody(
			helperSource,
			"public void commit(Verifier verifier) throws IOException",
		);
		expect(commit, "commit fsyncs the candidate via the ops seam").toMatch(/ops\.fsync\(tmp\)/);
		const fsyncIdx = commit.indexOf("ops.fsync(");
		const promoteBackupIdx = commit.indexOf("promoteWithBackup(");
		const promoteAbsentIdx = commit.indexOf("promoteIntoAbsentMain(");
		expect(fsyncIdx, "candidate fsync present in commit").toBeGreaterThanOrEqual(0);
		expect(promoteBackupIdx, "promote-with-backup (rename path) present in commit").toBeGreaterThan(
			fsyncIdx,
		);
		expect(
			promoteAbsentIdx,
			"promote-into-absent-main (rename path) present in commit",
		).toBeGreaterThan(fsyncIdx);

		// Every recovery promotion (tmp→main) is preceded by ops.fsync(tmp) as
		// well: a crash can leave an .encrypting candidate that was never
		// flushed (process death before commit()'s fsync), so recover() must
		// make it durable before renaming it to main. All three recovery
		// branches (tmp-only, bak+tmp, tmp+plaintext-main) route through ONE
		// private fsync-then-promote helper and recover() never calls the
		// promote helpers directly, so no future recovery path can skip the
		// fsync; a failing fsync throws before anything is deleted or renamed.
		const recover = methodBody(
			helperSource,
			"public void recover(Verifier verifier) throws IOException",
		);
		expect(recover, "recover() routes every promotion through the fsync helper").toContain(
			"promoteRecoveryCandidate(",
		);
		expect(
			recover,
			"recover() never promotes directly (recovery fsync cannot be skipped)",
		).not.toContain("promoteIntoAbsentMain(");
		expect(
			recover,
			"recover() never promotes-with-backup directly (recovery fsync cannot be skipped)",
		).not.toContain("promoteWithBackup(");
		const promote = methodBody(
			helperSource,
			"private void promoteRecoveryCandidate(Verifier verifier) throws IOException",
		);
		const recoveryFsyncIdx = promote.indexOf("ops.fsync(");
		const promoteBackupIdx2 = promote.indexOf("promoteWithBackup(");
		const promoteAbsentIdx2 = promote.indexOf("promoteIntoAbsentMain(");
		expect(
			recoveryFsyncIdx,
			"recovery promotion helper fsyncs the candidate first",
		).toBeGreaterThanOrEqual(0);
		expect(
			promoteBackupIdx2,
			"recovery helper promote-with-backup comes after the fsync",
		).toBeGreaterThan(recoveryFsyncIdx);
		expect(
			promoteAbsentIdx2,
			"recovery helper promote-into-absent-main comes after the fsync",
		).toBeGreaterThan(recoveryFsyncIdx);

		// Named same-package JUnit forced-fsync failure tests exist: the
		// original commit-candidate case stays, plus a forced recovery-
		// promotion fsync case (artifacts preserved, no rename).
		const faultFile = join(
			nativeRoot,
			"app",
			"src",
			"test",
			"java",
			"com",
			"getcapacitor",
			"community",
			"database",
			"sqlite",
			"SQLite",
			"EncryptionFileSwapFaultsTest.java",
		);
		expect(existsSync(faultFile), "fault JUnit file exists").toBe(true);
		const faultSource = readFileSync(faultFile, "utf8");
		expect(faultSource, "forced-fsync failure case named").toContain("fsyncFails_");
		expect(faultSource, "forced recovery-promotion fsync failure case named").toContain(
			"recoveryFsyncFails_",
		);
	});

	it("the checked swap renames main→.plain.bak before .encrypting→main and verifies before releasing the backup", () => {
		const helperSource = read(
			"android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/EncryptionFileSwap.java",
		);
		const mainToBackup = helperSource.indexOf('renameChecked(main, bak, "main -> .plain.bak")');
		const tmpToMain = helperSource.indexOf('renameChecked(tmp, main, ".encrypting -> main")');
		expect(mainToBackup, "checked main→.plain.bak rename exists").toBeGreaterThanOrEqual(0);
		expect(tmpToMain, "checked .encrypting→main rename exists").toBeGreaterThan(mainToBackup);
	});

	it("EncryptionFileSwap is a java.io-only public helper with nontruncating fsync and sidecar handling", () => {
		const helperSource = read(
			"android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/EncryptionFileSwap.java",
		);
		expect(helperSource).toContain("public class EncryptionFileSwap");
		expect(helperSource).toContain("public interface Verifier");
		// Nontruncating fsync: append-mode FileOutputStream + getFD().sync().
		expect(helperSource).toContain("new FileOutputStream(file, true)");
		expect(helperSource).toContain("getFD().sync()");
		// Deterministic artifact names + SQLite sidecar suffixes.
		expect(helperSource).toContain('".encrypting"');
		expect(helperSource).toContain('".plain.bak"');
		expect(helperSource).toContain('"-journal"');
		expect(helperSource).toContain('"-wal"');
		expect(helperSource).toContain('"-shm"');
		// API-24: no java.nio.file, no Files.move, no cache-dir temp anywhere.
		expect(helperSource).not.toContain("java.nio.file");
		expect(helperSource).not.toContain("Files.move");
		expect(helperSource).not.toContain("getCacheDir");
		expect(helperSource).not.toContain("createTempFile");
	});

	it("the whole vendored module avoids java.nio.file (API-24 java.io-only)", () => {
		for (const file of listFiles(vendorModule)) {
			if (!file.endsWith(".java")) continue;
			const source = readFileSync(join(vendorModule, file), "utf8");
			expect(source, `no java.nio.file import/use in ${file}`).not.toContain("java.nio.file");
		}
	});
});

describe("deterministic recovery runs before the public probes", () => {
	const capacitorSQLite = read(
		"android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLite.java",
	);

	it("isDatabase runs recovery before returning existence", () => {
		const body = methodBody(capacitorSQLite, "public Boolean isDatabase(String dbName)");
		expect(body.indexOf("recoverDatabase(")).toBeLessThan(body.indexOf("isFileExists("));
	});

	it("isDatabaseEncrypted runs recovery defensively before state detection", () => {
		const body = methodBody(capacitorSQLite, "public Boolean isDatabaseEncrypted(String dbName)");
		expect(body.indexOf("recoverDatabase(")).toBeLessThan(body.indexOf("getDatabaseState("));
	});

	it("recoverDatabase constructs the EncryptionFileSwap helper over the real database path", () => {
		const body = methodBody(capacitorSQLite, "private void recoverDatabase(String dbName)");
		expect(body).toContain("new EncryptionFileSwap(");
		expect(body).toContain("context.getDatabasePath(");
		expect(body).toContain(".recover(");
	});
});

describe("app JVM JUnit4 coverage for recovery decisions exists", () => {
	it("EncryptionFileSwapTest.java exercises the recoverable existence/state decisions", () => {
		const testFile = join(
			nativeRoot,
			"app",
			"src",
			"test",
			"java",
			"app",
			"rememberme",
			"journal",
			"EncryptionFileSwapTest.java",
		);
		expect(existsSync(testFile), "JUnit test file exists").toBe(true);
		const source = readFileSync(testFile, "utf8");
		expect(source).toContain("import org.junit.Test;");
		expect(source).toContain("EncryptionFileSwap");
		// Cover every recoverable decision branch with at least the named cases.
		for (const marker of [
			"tmpOnly",
			"tmpAndPlaintextMain",
			"tmpAndEncryptedMain",
			"bakOnly_mainAbsent",
			"mainAndBak",
			"tmpBakNoMain",
			"tmpMainBak",
			"fsyncNoTruncate",
		]) {
			expect(source, `decision case covered: ${marker}`).toContain(marker);
		}
	});

	it("the exchange helper keeps the plugin package/class names and build config", () => {
		const build = readFileSync(join(vendorModule, "build.gradle"), "utf8");
		expect(build).toContain("com.getcapacitor.community.database.sqlite");
		expect(build).toContain("net.zetetic:sqlcipher-android");
		expect(build).toContain("androidx.security:security-crypto");
	});
});

describe("EncryptionFileSwap package-private FileOps injection seam (static)", () => {
	const helperSource = read(
		"android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/EncryptionFileSwap.java",
	);

	it("declares a package-private FileOps seam with rename/delete/fsync and is java.io-only", () => {
		expect(helperSource).toContain("interface FileOps");
		// rename / delete / fsync are each part of the seam so mutation points
		// can be forced to fail deterministically in host-JVM tests.
		expect(helperSource).toMatch(/boolean rename\(File from, File to\)/);
		expect(helperSource).toMatch(/boolean delete\(File f\)/);
		expect(helperSource).toMatch(/void fsync\(File f\)/);
		expect(helperSource).toMatch(/boolean exists\(File f\)/);
		// No java.nio on the helper (API-24 java.io-only).
		expect(helperSource).not.toContain("java.nio.file");
		expect(helperSource).not.toContain("Files.move");
	});

	it("exposes a package-private FileOps-parameter constructor while keeping the public one", () => {
		expect(helperSource).toContain("public EncryptionFileSwap(File mainFile)");
		expect(helperSource).toContain("EncryptionFileSwap(File mainFile, FileOps ops)");
		expect(helperSource).toContain("this(mainFile, REAL)");
	});

	it("routes every internal mutation (rename/delete/sidecar/fsync/exists) through the ops seam", () => {
		// Instance rename/delete helpers delegate to ops, not raw File calls.
		expect(helperSource).toContain("if (!ops.rename(from, to))");
		expect(helperSource).toContain("&& !ops.delete(file)");
		expect(helperSource).toContain("ops.exists(");
		// The public static helpers keep REAL java.io semantics for external callers.
		expect(helperSource).toContain("public static File[] sidecars(File dbFile)");
		expect(helperSource).toContain("public static void fsyncNoTruncate(File file)");
		expect(helperSource).toContain("new FileOutputStream(file, true)");
		expect(helperSource).toContain("getFD().sync()");
	});
});

describe("app JVM JUnit4 forced-failure coverage for the swap protocol (static)", () => {
	it("same-package JUnit file exercises the injectable FileOps rename/delete/fsync faults", () => {
		// Same package as the production helper so the package-private FileOps
		// constructor is reachable; deterministic fake ops, no OS permission quirks.
		const faultFile = join(
			nativeRoot,
			"app",
			"src",
			"test",
			"java",
			"com",
			"getcapacitor",
			"community",
			"database",
			"sqlite",
			"SQLite",
			"EncryptionFileSwapFaultsTest.java",
		);
		expect(existsSync(faultFile), "same-package fault JUnit file exists").toBe(true);
		const source = readFileSync(faultFile, "utf8");
		const helperSource = read(
			"android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/EncryptionFileSwap.java",
		);
		expect(source).toContain("import org.junit.Test;");
		expect(source).toContain("package com.getcapacitor.community.database.sqlite.SQLite;");
		expect(source).toContain("new EncryptionFileSwap(");
		// All forced-failure / recovery cases must be exercised explicitly.
		for (const marker of [
			"secondRenameFails_rollbackSucceeds",
			"secondRenameFails_rollbackFails",
			"sidecarDeleteFails_beforeSwap",
			"backupDeleteFails_afterVerifiedPromotion",
			"recoveryIdempotent_fromLeftoverArtifacts",
			"corruptBakAndTmp_failsClosed",
		]) {
			expect(source, `forced-failure case covered: ${marker}`).toContain(marker);
		}
		// The restore-the-backup path must positively verify the backup's
		// plaintext content BEFORE any rename/delete: a corrupt or foreign
		// .plain.bak is preserved untouched and restore fails closed rather
		// than promoting unverifiable bytes over main.
		expect(helperSource).toContain("private void restoreBackup(Verifier verifier)");
		const restoreBody = methodBody(helperSource, "private void restoreBackup(Verifier verifier)");
		const plaintextCheck = restoreBody.indexOf("verifier.opensPlaintext(bak)");
		expect(
			plaintextCheck,
			"restoreBackup verifies the backup opens as plaintext",
		).toBeGreaterThanOrEqual(0);
		const firstMutation = ["deleteSidecarsViaOps", "renameChecked", "deleteChecked"]
			.map((snippet) => restoreBody.indexOf(snippet))
			.filter((at) => at >= 0)
			.sort((a, b) => a - b)[0];
		expect(
			firstMutation,
			"plaintext verification precedes every rename/delete in restoreBackup",
		).toBeGreaterThan(plaintextCheck);
	});
});

describe("durable secret storage and disabled decryption mode", () => {
	const utilsSecret = read(
		"android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSecret.java",
	);
	const database = read(
		"android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/Database.java",
	);
	const utilSQLCipher = read(
		"android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSQLCipher.java",
	);

	it("setPassphrase persists synchronously with a checked commit() and no async apply()", () => {
		const setPassphrase = methodBody(utilsSecret, "public void setPassphrase(String passphrase)");
		expect(setPassphrase).toContain(".commit()");
		expect(setPassphrase).not.toContain(".apply()");
		// The boolean result is checked; a false commit throws fail-closed so
		// setEncryptionSecret rejects before any native conversion runs.
		expect(setPassphrase).toContain("if (!committed)");
		expect(setPassphrase).toContain("throw new IllegalStateException");
	});

	it("decrypt() is fail-closed: unconditional clear exception, no file mutation or default charset", () => {
		const decrypt = methodBody(utilSQLCipher, "public void decrypt(");
		expect(decrypt).toContain("throw new UnsupportedOperationException");
		expect(decrypt).not.toContain("createTempFile");
		expect(decrypt).not.toContain("getCacheDir");
		expect(decrypt).not.toContain(".delete()");
		expect(decrypt).not.toContain("renameTo");
		expect(decrypt).not.toContain("getBytes");
		expect(decrypt).not.toContain("new String(passphrase");
		expect(decrypt).not.toContain("openDatabase");
	});

	it("Database.open rejects decryption mode before any file mutation and never calls decrypt", () => {
		const openBody = methodBody(database, "public void open() throws Exception");
		expect(openBody).not.toContain("_uCipher.decrypt(");
		expect(openBody).not.toContain(".getBytes()");
		// Fail-closed: the decryption refusal precedes the real open, the first
		// file-mutating step in open().
		const refusal = openBody.indexOf("decryption mode is disabled");
		const realOpen = openBody.indexOf("openOrCreateDatabase");
		expect(refusal, "refusal present").toBeGreaterThanOrEqual(0);
		expect(realOpen, "real open present").toBeGreaterThan(refusal);
	});
});
