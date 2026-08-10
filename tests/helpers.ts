import { migrate } from "drizzle-orm/libsql/migrator";
import { type ApiApp, createApp } from "../src/server/api";
import { type Auth, createAuth } from "../src/server/auth";
import { type AppConfig, validateEnv } from "../src/server/config";
import { createJournalCipher, type JournalCipher } from "../src/server/crypto/journal-encryption";
import { createDb, type Db } from "../src/server/db/client";
import type { MailMessage } from "../src/server/mail/mailer";

/** A valid 32-byte base64 key for tests. */
export const TEST_KEY_BASE64 = Buffer.from(
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	"hex",
).toString("base64");

/** A different (wrong) 32-byte key. */
export const OTHER_KEY_BASE64 = Buffer.from(
	"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
	"hex",
).toString("base64");

/** Test environment (passes the config schema). */
export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
	return validateEnv({
		NODE_ENV: "test",
		DATABASE_URL: "file:./data/test.db",
		BETTER_AUTH_URL: "http://localhost:4321",
		BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
		JOURNAL_ENCRYPTION_KEY: TEST_KEY_BASE64,
		SMTP_HOST: "",
		SMTP_PORT: "587",
		SMTP_USER: "",
		SMTP_PASSWORD: "",
		MAIL_FROM: "digest@example.com",
		SESSION_EXPIRES_IN_DAYS: "7",
		...overrides,
	});
}

/** Mailer that records messages instead of sending. */
export interface CapturingMailer {
	send(message: MailMessage): Promise<void>;
	sent: MailMessage[];
}

export interface TestContext {
	config: AppConfig;
	db: Db;
	cipher: JournalCipher;
	auth: Auth;
	mailer: CapturingMailer;
	app: ApiApp;
}

/** In-memory test context: db, cipher, app, capturing mailer. */
export async function makeTestContext(
	overrides: Record<string, string | undefined> = {},
): Promise<TestContext> {
	const config = testConfig(overrides);
	const db = createDb(":memory:");
	// Create the real schema (same migrations the app ships) in the test DB.
	await migrate(db as never, { migrationsFolder: "./drizzle" });
	const cipher = await createJournalCipher(TEST_KEY_BASE64);
	const mailer: CapturingMailer = {
		sent: [],
		async send(message: MailMessage) {
			this.sent.push(message);
		},
	};
	const auth = createAuth(config, db);
	const app = createApp({ db, auth, cipher, mailer, config });
	return { config, db, cipher, auth, mailer, app };
}

/** Extract the first cookie from a Set-Cookie header (name=value). */
export function cookieFromResponse(res: Response): string | null {
	const setCookie = res.headers.get("set-cookie");
	if (!setCookie) return null;
	return setCookie.split(";")[0];
}

/** base64 helpers for assertions. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}
export function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
