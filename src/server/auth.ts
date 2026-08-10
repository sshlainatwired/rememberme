import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { AppConfig } from "./config";
import { getConfig } from "./config";
import { type Db, getDb } from "./db/client";

/**
 * Better Auth is the only authentication implementation. RememberMe uses the
 * email/password provider with a fixed internal email (`owner@rememberme.local`)
 * so the UI stays password-only: no email login, no OAuth, no verification.
 */

export const OWNER_EMAIL = "owner@rememberme.local";
export const OWNER_NAME = "Owner";

/** Build the Better Auth instance for a config + db (injectable for tests). */
export function createAuth(config: AppConfig, db: Db) {
	const secureCookies = isHttps(config.BETTER_AUTH_URL);
	return betterAuth({
		database: drizzleAdapter(db, { provider: "sqlite" }),
		secret: config.BETTER_AUTH_SECRET,
		baseURL: config.BETTER_AUTH_URL,
		emailAndPassword: {
			enabled: true,
			minPasswordLength: 8,
		},
		session: {
			expiresIn: 60 * 60 * 24 * config.SESSION_EXPIRES_IN_DAYS,
		},
		advanced: {
			cookiePrefix: "rememberme",
			useSecureCookies: secureCookies,
			defaultCookieAttributes: {
				sameSite: "lax",
			},
		},
		trustedOrigins: [config.BETTER_AUTH_URL],
	});
}

export type Auth = ReturnType<typeof createAuth>;

function isHttps(url: string): boolean {
	try {
		return new URL(url).protocol === "https:";
	} catch {
		return false;
	}
}

let authInstance: Auth | null = null;

/** Singleton Better Auth instance bound to the validated environment. */
export function getAuth(): Auth {
	if (!authInstance) {
		authInstance = createAuth(getConfig(), getDb());
	}
	return authInstance;
}

/** Session for a request, or null when signed out / expired. */
export function getSession(headers: Headers) {
	return getAuth().api.getSession({ headers });
}
