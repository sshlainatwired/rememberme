import { Hono } from "hono";
import { type Auth, getAuth } from "../auth";
import { type AppConfig, getConfig } from "../config";
import { getCipher, type JournalCipher } from "../crypto/journal-encryption";
import { type Db, getDb } from "../db/client";
import { getUserCount } from "../db/repo";
import { startDigestScheduler } from "../jobs/weekly-digest";
import { createMailer, type Mailer } from "../mail/mailer";
import { HttpError, onError } from "./http";
import { authRoutes } from "./routes/auth";
import { digestRoutes } from "./routes/digest";
import { journalRoutes } from "./routes/journal";
import { settingsRoutes } from "./routes/settings";
import type { ApiDeps } from "./types";

/**
 * Hono API application.
 *
 * Better Auth's own routes live under /api/auth/* (mounted via its raw fetch
 * handler); everything else is our API, mounted the same way. `createApp` is
 * a pure factory so tests can inject an in-memory database, a test cipher,
 * and a fake mailer.
 */
export function createApp(deps: ApiDeps) {
	const app = new Hono();
	app.onError(onError);

	// Sign-up is a first-run operation only. Once the first account exists the
	// app is single-owner: the raw Better Auth route is closed (404) and new
	// accounts are created exclusively via POST /api/setup (server-side
	// signUpEmail call, which does not go through this HTTP route).
	app.post("/api/auth/sign-up/email", async (c) => {
		if ((await getUserCount(deps.db)) > 0) {
			throw new HttpError(404, "Not found");
		}
		return deps.auth.handler(c.req.raw);
	});

	// Better Auth: /api/auth/sign-in/email, /sign-out, /session …
	app.on(["POST", "GET"], "/api/auth/*", (c) => deps.auth.handler(c.req.raw));

	app.route("/api", authRoutes(deps));
	app.route("/api", journalRoutes(deps));
	app.route("/api", settingsRoutes(deps));
	app.route("/api", digestRoutes(deps));

	return app;
}

export type ApiApp = ReturnType<typeof createApp>;

let appInstance: ApiApp | null = null;

/**
 * Singleton API app bound to the validated environment. Constructed lazily on
 * first request (builds don't need environment variables), and the digest
 * scheduler starts only when SMTP is configured.
 */
export async function getApiApp(): Promise<ApiApp> {
	if (!appInstance) {
		const config: AppConfig = getConfig();
		const db: Db = getDb();
		const auth: Auth = getAuth();
		const cipher: JournalCipher = await getCipher(config);
		const mailer: Mailer | null = createMailer(config);
		appInstance = createApp({ config, db, auth, cipher, mailer });
		if (mailer) {
			startDigestScheduler({ db, cipher, mailer, config });
		}
	}
	return appInstance;
}
