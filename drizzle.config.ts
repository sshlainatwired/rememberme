import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration. `DATABASE_URL` is read from the environment
 * (Bun auto-loads .env); falls back to a local file for `db:generate`.
 */
export default defineConfig({
	dialect: "sqlite",
	schema: "./src/server/db/schema.ts",
	out: "./drizzle",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "file:./data/rememberme.db",
	},
});
