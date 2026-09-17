// @vitest-environment node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/** Closed named-input boundary for Phase 8 key protection and session unlock. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// The allowlist grows task-by-task. Task 1 closes the pure state/config
// boundary; later RED tests add the native store/authenticator and TS/UI files
// before those files are implemented.
const ALLOWED = new Set([
	"android/src/security/device-unlock.ts",
	"android/src/auth/auth-context.tsx",
	"android/src/auth/auth-service.ts",
	"android/src/components/auth/LoginForm.tsx",
	"android/src/components/layout/AppBootstrap.tsx",
	"android/src/components/settings/SecurityCard.tsx",
	"android/src/components/settings/SettingsForm.tsx",
	"android/src/db/bootstrap.ts",
	"android/src/db/capacitor-sqlite.ts",
	"android/src/db/settings-events.ts",
	"android/capacitor.config.ts",
	"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLite.java",
	"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLitePlugin.java",
	"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSecret.java",
	"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/KeyProtectionState.java",
	"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/KeyProtectionStore.java",
	"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/DeviceAuthenticator.java",
]);

const readInputs = new Set<string>();

async function source(path: string): Promise<string> {
	if (!ALLOWED.has(path)) throw new Error(`unlisted Phase 8 boundary input: ${path}`);
	readInputs.add(path);
	return readFile(resolve(ROOT, path), "utf8");
}

afterAll(() => {
	expect([...ALLOWED].filter((path) => !readInputs.has(path))).toEqual([]);
});

const FORBIDDEN_NATIVE_LEAKS: ReadonlyArray<{ label: string; pattern: RegExp; sample: string }> = [
	{ label: "Toast", pattern: /\bToast\b/, sample: "Toast.makeText(context, secret, 1).show();" },
	{
		label: "stack trace",
		pattern: /\.printStackTrace\s*\(/,
		sample: "exception.printStackTrace();",
	},
	{
		label: "secret bridge value",
		pattern: /(?:data|result)\.put\(\s*"(?:secret|passphrase)"/i,
		sample: 'data.put("secret", passphrase);',
	},
	{
		label: "asynchronous preference write",
		pattern: /\.apply\s*\(\s*\)/,
		sample: "preferences.edit().putString(key, value).apply();",
	},
	{
		label: "raw exception logging",
		pattern: /(?:Log\.\w+\([^;\n]*|loadMessage\s*=[^;\n]*)\.getMessage\s*\(\s*\)/,
		sample: 'Log.e(TAG, "native failure " + error.getMessage());',
	},
];

function expectNoNativeLeaks(text: string, path: string): void {
	for (const forbidden of FORBIDDEN_NATIVE_LEAKS) {
		expect(text, `${path}: ${forbidden.label}`).not.toMatch(forbidden.pattern);
	}
}

describe("Phase 8 closed security boundary", () => {
	test("reads every canonical input through the audited helper", async () => {
		for (const path of ALLOWED) await source(path);
	});

	test("the mutation guards detect every forbidden native leak", () => {
		for (const forbidden of FORBIDDEN_NATIVE_LEAKS) {
			expect(forbidden.sample, forbidden.label).toMatch(forbidden.pattern);
		}
	});

	test("the pure state machine has strict modes and no Android dependency", async () => {
		const state = await source(
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/KeyProtectionState.java",
		);
		for (const mode of ["DISABLED", "ENABLING", "ENABLED"]) expect(state).toContain(mode);
		expect(state).toContain("decodeMode");
		expect(state).toContain("recoverEnabling");
		expect(state).toContain("enable");
		expect(state).toContain("disable");
		expect(state).not.toMatch(/android\.|androidx\./);
	});

	test("Phase 8 native modules have no UI/stack/bridge secret leaks or async writes", async () => {
		for (const path of [
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLite.java",
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLitePlugin.java",
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSecret.java",
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/KeyProtectionState.java",
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/KeyProtectionStore.java",
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/DeviceAuthenticator.java",
		]) {
			expectNoNativeLeaks(await source(path), path);
		}
	});

	test("uses separate stores and an authentication-bound protected alias", async () => {
		const store = await source(
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/KeyProtectionStore.java",
		);
		for (const required of [
			"sqlite_encrypted_shared_prefs",
			"rememberme_biometric_sqlite_secret",
			"rememberme_biometric_sqlite_master_key",
			"setUserAuthenticationRequired(true",
			"KeyProtectionState.enable",
			"KeyProtectionState.recoverEnabling",
			"KeyProtectionState.disable",
			".commit()",
		]) {
			expect(store).toContain(required);
		}
	});

	test("branches authentication by API without an unsupported API 28-29 strong combination", async () => {
		const authenticator = await source(
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/DeviceAuthenticator.java",
		);
		expect(authenticator).toContain("Build.VERSION_CODES.R");
		expect(authenticator).toContain(
			"BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL",
		);
		expect(authenticator).toContain("createConfirmDeviceCredentialIntent");
		expect(authenticator).toContain("isDeviceSecure");
		expect(authenticator).not.toContain("setDeviceCredentialAllowed");
	});

	test("exposes only non-secret security bridge methods and removes constructor prompting", async () => {
		const implementation = await source(
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLite.java",
		);
		const plugin = await source(
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLitePlugin.java",
		);
		for (const method of [
			"prepareKeyAccess",
			"getKeyProtectionStatus",
			"setKeyProtection",
			"authenticateSession",
			"ensureEncryptionSecret",
		]) {
			expect(plugin).toContain(method);
		}
		for (const guard of ["isSecretStored", "setEncryptionSecret", "createConnection"]) {
			const region = implementation.slice(implementation.indexOf(guard));
			expect(region.slice(0, 1_500)).toContain("requireKeyAccessPrepared");
		}
		const constructorRegion = implementation.slice(
			implementation.indexOf("public CapacitorSQLite(Context context"),
			implementation.indexOf("private void activatePreferences"),
		);
		expect(constructorRegion).not.toContain("activatePreferences(");
		expect(implementation).not.toContain("UtilsBiometric");
		expect(implementation).not.toContain("notifyBiometricEvent");
		expect(implementation).not.toContain("if (biometricAuth)");
		expect(plugin).not.toMatch(/put\(\s*"(?:secret|passphrase)"/i);
	});

	test("serializes one native security call and clears it on every terminal callback", async () => {
		const plugin = await source(
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLitePlugin.java",
		);
		for (const required of [
			"if (activeSecurityCall != null)",
			"key_protection_busy",
			"@ActivityCallback",
			"credentialAuthenticationResult",
			"clearSecurityCall();",
			"key_protection_cancelled",
		]) {
			expect(plugin).toContain(required);
		}
		expect(plugin).not.toContain("biometricResults");
		expect(plugin).not.toContain("sqliteBiometricEvent");
	});

	test("a failed biometric match is nonterminal", async () => {
		const authenticator = await source(
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/DeviceAuthenticator.java",
		);
		const failed = authenticator.slice(
			authenticator.indexOf("void onAuthenticationFailed"),
			authenticator.indexOf("}", authenticator.indexOf("void onAuthenticationFailed")) + 1,
		);
		expect(failed).not.toContain("listener.");
	});

	test("fresh SQLCipher secret provisioning stays native and clears its temporary byte buffer", async () => {
		const implementation = await source(
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLite.java",
		);
		const plugin = await source(
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLitePlugin.java",
		);
		const secret = await source(
			"android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSecret.java",
		);
		const adapter = await source("android/src/db/capacitor-sqlite.ts");
		expect(implementation).toContain("ensureEncryptionSecret()");
		expect(plugin).toContain("public void ensureEncryptionSecret(PluginCall call)");
		for (const required of [
			"new SecureRandom()",
			"new byte[32]",
			"Base64.NO_WRAP",
			"Arrays.fill(bytes",
		]) {
			expect(secret).toContain(required);
		}
		expect(adapter).toContain("await manager.ensureEncryptionSecret()");
		expect(adapter).not.toMatch(/crypto\.getRandomValues|\bbtoa\s*\(|\.setEncryptionSecret\s*\(/);
	});

	test("the TypeScript adapter is strict, local, and publishes only after a committed mirror", async () => {
		const adapter = await source("android/src/security/device-unlock.ts");
		for (const required of [
			"CapacitorSQLite as unknown as NativeKeyProtectionPlugin",
			"Object.keys(value)",
			"key_protection_cancelled",
			"DeviceUnlockCancelledError",
			"await this.settings.update({ biometricEnabled: enabled })",
			"this.publishCommittedSettings()",
		]) {
			expect(adapter).toContain(required);
		}
		const updateIndex = adapter.indexOf(
			"await this.settings.update({ biometricEnabled: enabled })",
		);
		const publishIndex = adapter.indexOf("this.publishCommittedSettings()", updateIndex);
		expect(updateIndex).toBeGreaterThan(-1);
		expect(publishIndex).toBeGreaterThan(updateIndex);
		expect(adapter).not.toMatch(/console\.(?:log|debug|info|warn|error)/);
		expect(adapter).not.toMatch(/localStorage|indexedDB/);
	});

	test("bootstrap prepares before open, reconciles native authority, and unlocks only a validated session", async () => {
		const bootstrap = await source("android/src/db/bootstrap.ts");
		for (const required of [
			"security: DeviceUnlockService",
			"security.dispose()",
			"publishSettingsChanged(handle)",
			"await deviceUnlockAdapter.prepare()",
			"await security.reconcile()",
			"await auth.unlockWithDeviceCredential()",
			"isDeviceUnlockCancelled(error)",
		]) {
			expect(bootstrap).toContain(required);
		}
		expect(bootstrap.indexOf("await deviceUnlockAdapter.prepare()")).toBeLessThan(
			bootstrap.indexOf("await open()"),
		);
		expect(bootstrap.indexOf("await security.reconcile()")).toBeLessThan(
			bootstrap.indexOf("await auth.unlockWithDeviceCredential()"),
		);
	});

	test("trusted session unlock validates storage without password, KDF, or persistent mutation", async () => {
		const auth = await source("android/src/auth/auth-service.ts");
		const start = auth.indexOf("async unlockWithDeviceCredential()");
		const end = auth.indexOf("/** Clear the in-memory session", start);
		const trustedUnlock = auth.slice(start, end);
		expect(start).toBeGreaterThan(-1);
		expect(trustedUnlock).toContain("await this.readAuthRow()");
		expect(trustedUnlock).toContain("this.strictDecode(row.verifier)");
		expect(trustedUnlock).toContain("this.unlocked = true");
		expect(trustedUnlock).not.toMatch(
			/password|verifyPassword|createVerifier|settings\.update|db\.run/,
		);
	});

	test("startup retries only typed cancellation and lock-screen device unlock stays owner-scoped", async () => {
		const bootstrap = await source("android/src/components/layout/AppBootstrap.tsx");
		const context = await source("android/src/auth/auth-context.tsx");
		const login = await source("android/src/components/auth/LoginForm.tsx");
		for (const required of [
			"isDeviceUnlockCancelled(error)",
			' status: "cancelled"',
			"StartupUnlockCancelledScreen",
			"retryingRef.current",
		]) {
			expect(bootstrap).toContain(required);
		}
		for (const required of [
			"deviceUnlockAvailable",
			"loginWithDevice",
			"authenticateSession()",
			"unlockWithDeviceCredential()",
			"activeDeviceUnlockRef.current",
			"mountedRef.current",
			"AUTH_PROVIDER_ERROR_MESSAGE",
		]) {
			expect(context).toContain(required);
		}
		expect(login).toContain("deviceUnlockAvailable &&");
		expect(login).toContain("Use device unlock");
		expect(login).toContain('type="button"');
	});

	test("Settings uses the native-authoritative Security card without restoring portable protection", async () => {
		const card = await source("android/src/components/settings/SecurityCard.tsx");
		const form = await source("android/src/components/settings/SettingsForm.tsx");
		for (const required of [
			"captured.getStatus()",
			"captured.setEnabled(enabled)",
			"const authoritative = await captured.getStatus()",
			"Require device unlock",
			"encrypted .rmbak backup",
			"generationRef.current",
			"busyRef.current",
		]) {
			expect(card).toContain(required);
		}
		expect(form).toContain("<SecurityCard security={storage.security} />");
		expect(form).not.toMatch(/arrives in Phase 8/i);
		expect(card).not.toMatch(/console\.(?:log|debug|info|warn|error)|localStorage|indexedDB/);
	});

	test("the obsolete constructor biometric path stays disabled", async () => {
		const config = await source("android/capacitor.config.ts");
		expect(config).toContain("androidIsEncryption: true");
		expect(config).toContain("biometricAuth: false");
		expect(config).toContain("generated and stored entirely in native code");
		expect(config).not.toContain("generated once in JS");
	});
});
