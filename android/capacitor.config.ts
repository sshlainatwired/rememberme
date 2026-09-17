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
			// SQLCipher encrypts the whole on-device database. The random
			// passphrase is generated and stored entirely in native code; it never
			// crosses the Capacitor bridge. `androidIsEncryption` rejects plaintext
			// opens of that database.
			androidIsEncryption: true,
			// Keep the plugin's obsolete constructor prompt disabled. Phase 8 uses
			// the native key-protection bridge for optional device authentication.
			androidBiometric: {
				biometricAuth: false,
			},
		},
	},
};

export default config;
