import { defineMiddleware } from "astro:middleware";
import { getApiApp } from "./server/api";
import { getSession } from "./server/auth";

/**
 * Request pipeline:
 *  - /api/* is delegated to the Hono app (Better Auth + our API).
 *  - Everything else is an Astro page: the session is resolved once and
 *    attached to locals; protected pages redirect to /login; public pages
 *    (login/setup) redirect away when already signed in.
 *
 * Session enforcement is server-side: pages and API endpoints both verify
 * the session cookie on every request. Nothing is stored in localStorage.
 */

const ASSET_PREFIXES = ["/_astro/", "/favicon"];
// "/" is public: the index page decides between /setup (first run) and /login.
const PUBLIC_PATHS = new Set(["/", "/login", "/setup"]);

function parseUrl(raw: string): URL | null {
	try {
		return new URL(raw);
	} catch {
		return null;
	}
}

export const onRequest = defineMiddleware(async (context, next) => {
	const parsed = parseUrl(context.request.url);
	if (!parsed) return next();
	const { pathname } = parsed;

	if (pathname.startsWith("/api/")) {
		const app = await getApiApp();
		return app.fetch(context.request);
	}

	if (ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
		return next();
	}

	const session = await getSession(context.request.headers);
	context.locals.session = session;

	const isPublic = PUBLIC_PATHS.has(pathname);
	if (!session && !isPublic) {
		// Relative Location keeps the request host/port (Astro's absolute URL
		// drops the port in standalone mode, e.g. http://localhost instead of
		// http://localhost:4321).
		return new Response(null, {
			status: 302,
			headers: { Location: "/login" },
		});
	}
	if (session && isPublic) {
		return new Response(null, {
			status: 302,
			headers: { Location: "/journal/today" },
		});
	}
	return next();
});
