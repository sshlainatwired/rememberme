import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	appId: "app.rememberme.journal",
	appName: "RememberMe",
	webDir: "dist",
	server: {
		androidScheme: "https",
	},
	android: {
		allowMixedContent: false,
	},
	plugins: {
		CapacitorSQLite: {
			// Phase 4: SQLCipher encrypts the whole on-device database. The
			// random passphrase is generated once in JS and stored in Android
			// EncryptedSharedPreferences (Keystore MasterKey); the plugin reads
			// `androidIsEncryption` to reject a plaintext open of that database.
			androidIsEncryption: true,
			// Biometric/device-credential gating is Phase 8; explicitly false
			// now so no prompt can appear during Phase 4/5 startup.
			androidBiometric: {
				biometricAuth: false,
			},
		},
	},
};

export default config;
