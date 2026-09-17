import { fileURLToPath, URL } from "node:url";
import legacy from "@vitejs/plugin-legacy";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		react(),
		/*
		 * Legacy non-module bundle (Phase 3 Terra rerun, API-24/WebView):
		 *
		 * Capacitor 8's DEFAULT_ANDROID_WEBVIEW_VERSION is 60 (Bridge.java;
		 * MINIMUM_ANDROID_WEBVIEW_VERSION is 55). A module-only Vite output
		 * uses `<script type="module">` plus modern syntax that Chrome/WebView
		 * 60 cannot parse, so the app would render nothing on that floor.
		 * plugin-legacy emits BOTH the modern module bundle AND a
		 * `<script nomodule>` legacy entry (core-js polyfills +
		 * regenerator-runtime + systemjs bootstrapping) transformed down to
		 * `chrome >= 60` — exactly the supported default floor. Nothing below
		 * the configurable Capacitor minimum (55) is claimed to work, and
		 * `verify-legacy-build.mjs` (part of the canonical `build` gate) fails
		 * the build if the nomodule entry/artifacts ever disappear.
		 *
		 * Phase 5 Task 1: the Tailwind v4 plugin is removed — the Android
		 * stylesheet is now plain dependency-free CSS, and `build.cssTarget:
		 * "chrome60"` makes Vite's CSS pipeline target the WebView floor.
		 */
		legacy({
			targets: ["chrome >= 60"],
		}),
	],
	base: "./",
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
		cssTarget: "chrome60",
	},
});
