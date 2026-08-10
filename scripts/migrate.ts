/**
 * Apply Drizzle migrations to the database.
 *
 * Used by `bun run db:migrate`. This intentionally reads only the database
 * connection variables (via a small Zod schema) so migrations can run even
 * when the rest of the app configuration (encryption key, SMTP, …) is not
 * present — for example in a minimal migration container.
 *
 * The application itself never mutates the schema at runtime.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { z } from "zod";

const dbEnvSchema = z.object({
	DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
	DATABASE_AUTH_TOKEN: z.string().optional().default(""),
});

const env = dbEnvSchema.parse(process.env);

// Local `file:` databases need an existing parent directory (SQLite
// returns SQLITE_CANTOPEN otherwise). No-op for Turso URLs and `:memory:`.
if (env.DATABASE_URL.startsWith("file:")) {
	const path = env.DATABASE_URL.slice("file:".length);
	if (path && path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}
}

const client = createClient({
	url: env.DATABASE_URL,
	authToken: env.DATABASE_AUTH_TOKEN || undefined,
});

await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
console.log("Migrations applied");
client.close();
