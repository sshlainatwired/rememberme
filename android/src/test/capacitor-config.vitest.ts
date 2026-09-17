import { describe, expect, it } from "vitest";
import config from "../../capacitor.config";

describe("capacitor.config: native SQLCipher encryption contract (Phase 4)", () => {
	it("declares androidIsEncryption: true so the SQLite plugin opens databases encrypted", () => {
		expect(config.plugins?.CapacitorSQLite?.androidIsEncryption).toBe(true);
	});

	it("keeps biometric authentication explicitly off for Phase 4", () => {
		// Phase 4 stores the random passphrase as an AES-256-GCM
		// EncryptedSharedPreferences value; it does not prompt for biometrics.
		expect(config.plugins?.CapacitorSQLite?.androidBiometric?.biometricAuth).toBe(false);
	});

	it("retains the HTTPS Android scheme with mixed content disallowed", () => {
		expect(config.server?.androidScheme).toBe("https");
		expect(config.android?.allowMixedContent).toBe(false);
	});
});
