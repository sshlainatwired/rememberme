/**
 * Export encrypted journal rows for Android migration.
 *
 * Usage: `bun run journal:export-android -- --output ./rememberme-legacy-export.json`
 *
 * Reads ONLY the database connection variables, so it runs without the
 * journal encryption key and never decrypts anything. The resulting file
 * holds ciphertext plus metadata; Android imports it with the legacy key
 * entered on the device.
 */
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { z } from "zod";
import * as schema from "../src/server/db/schema";
import { createLegacyExportLoader, runLegacyExport } from "../src/server/legacy-export";

const env = z
	.object({
		DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
		DATABASE_AUTH_TOKEN: z.string().optional().default(""),
	})
	.parse(process.env);

const client = createClient({
	url: env.DATABASE_URL,
	authToken: env.DATABASE_AUTH_TOKEN || undefined,
});

try {
	const db = drizzle(client, { schema });
	const message = await runLegacyExport(process.argv.slice(2), {
		loadRows: createLegacyExportLoader(db),
	});
	process.stdout.write(`${message}\n`);
} finally {
	client.close();
}
