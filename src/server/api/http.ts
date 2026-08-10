import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Auth } from "../auth";

/**
 * Shared HTTP helpers for the Hono API: a typed error with status, a safe
 * JSON body parser, session enforcement, and the global error handler that
 * never leaks internals to the client.
 */

export class HttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}

export async function parseJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new HttpError(400, "Request body must be valid JSON");
	}
}

/** Require a valid session; throws 401 when missing/expired. */
export async function requireSession(c: Context, auth: Auth) {
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session) throw new HttpError(401, "Not signed in");
	return session;
}

export function onError(err: Error, c: Context) {
	if (err instanceof HttpError) {
		return c.json({ error: err.message }, err.status as ContentfulStatusCode);
	}
	// Log the technical detail server-side only; the client gets a safe message.
	console.error("API error", err);
	return c.json({ error: "Something went wrong" }, 500);
}
