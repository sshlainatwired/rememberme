import "dotenv/config";
import { z } from "zod";
import { isBase64EncodedKey } from "./crypto/key";

/**
 * Centralized, validated environment configuration.
 *
 * All environment variables pass through this Zod schema exactly once and are
 * then consumed via the typed `AppConfig` object. Nothing else in the
 * application reads `process.env` directly.
 *
 * `import "dotenv/config"` loads `.env` from the project root into
 * `process.env`. This is needed under `astro dev`, which does not populate
 * `process.env` from `.env` files (unlike `bun run start`, where Bun loads
 * them natively). It never overrides variables that are already set, so
 * shell exports, Docker `env_file`, and Turso tokens win.
 *
 * Validation is lazy: it runs on first access (server start / first request),
 * so Astro's build step does not require environment variables to be present.
 * Missing or invalid required variables fail fast with a clear message.
 */

const envSchema = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

	// Database (local SQLite/libSQL file, or Turso remote).
	DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
	DATABASE_AUTH_TOKEN: z.string().optional().default(""),

	// Authentication.
	BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
	BETTER_AUTH_URL: z.url("BETTER_AUTH_URL must be a valid URL").default("http://localhost:4321"),
	SESSION_EXPIRES_IN_DAYS: z.coerce.number().int().positive().default(7),

	// Journal encryption (base64-encoded 256-bit key, `openssl rand -base64 32`).
	JOURNAL_ENCRYPTION_KEY: z
		.string()
		.min(1, "JOURNAL_ENCRYPTION_KEY is required")
		.refine(isBase64EncodedKey, {
			message:
				"JOURNAL_ENCRYPTION_KEY must be a base64-encoded 32-byte (256-bit) key. Generate one with: openssl rand -base64 32",
		}),

	// SMTP (optional: the app starts without it, digest delivery is disabled).
	SMTP_HOST: z.string().optional().default(""),
	SMTP_PORT: z.coerce.number().int().positive().max(65535).optional().default(587),
	SMTP_USER: z.string().optional().default(""),
	SMTP_PASSWORD: z.string().optional().default(""),
	MAIL_FROM: z.email().optional().default(""),
});

export type AppConfig = z.infer<typeof envSchema>;

class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

let cached: AppConfig | null = null;

/** Validate `process.env` once and return the typed configuration. */
export function getConfig(): AppConfig {
	if (cached) return cached;

	const parsed = envSchema.safeParse(process.env);
	if (!parsed.success) {
		const details = parsed.error.issues
			.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("\n");
		throw new ConfigError(
			`Invalid environment configuration:\n${details}\n\n` +
				`Fix your .env file. See .env.example for the required variables.`,
		);
	}

	cached = parsed.data;
	return cached;
}

/** Used by tests to re-validate a custom env object. */
export function validateEnv(env: Record<string, string | undefined>): AppConfig {
	const parsed = envSchema.safeParse(env);
	if (!parsed.success) {
		const details = parsed.error.issues
			.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("\n");
		throw new ConfigError(`Invalid environment configuration:\n${details}`);
	}
	return parsed.data;
}
