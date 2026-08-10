// @ts-check

import { fileURLToPath } from "node:url";
import node from "@astrojs/node";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	integrations: [react()],
	// Astro's form-CSRF origin check drops the port from the Host header in
	// standalone mode (url.origin becomes http://localhost), so it rejects
	// every valid request. CSRF is instead mitigated by SameSite=Lax session
	// cookies (set by Better Auth) plus the JSON-only Hono API.
	security: {
		checkOrigin: false,
	},
	vite: {
		plugins: [tailwindcss()],
		resolve: {
			alias: {
				"@": fileURLToPath(new URL("./src", import.meta.url)),
			},
		},
	},
	server: {
		port: 4321,
	},
});
