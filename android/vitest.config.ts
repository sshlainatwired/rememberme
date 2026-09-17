import { fileURLToPath, URL } from "node:url";

export default {
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		globals: true,
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
		// `*.vitest.*` keeps this suite out of the root Bun test run.
		include: ["src/**/*.vitest.{ts,tsx}"],
	},
};
