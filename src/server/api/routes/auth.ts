import { Hono } from "hono";
import { loginSchema, setupSchema } from "../../../shared/schemas/auth";
import { defaultSettingsInput } from "../../../shared/schemas/settings";
import { OWNER_EMAIL, OWNER_NAME } from "../../auth";
import { createSettings, getSoleUser, getUserCount } from "../../db/repo";
import { HttpError, parseJsonBody } from "../http";
import type { ApiDeps } from "../types";

/**
 * First-launch setup, password-only login, and logout.
 *
 * Better Auth handles hashing and sessions; these routes only translate the
 * password-only UI into Better Auth calls (the account's email is a fixed
 * internal placeholder, never shown to or requested from the user).
 */

export function authRoutes(deps: ApiDeps) {
	const app = new Hono();

	// POST /api/setup — first launch: create the account + default settings.
	app.post("/setup", async (c) => {
		const parsed = setupSchema.safeParse(await parseJsonBody(c));
		if (!parsed.success) {
			throw new HttpError(400, "Invalid setup request");
		}
		if ((await getUserCount(deps.db)) > 0) {
			throw new HttpError(400, "RememberMe is already set up");
		}

		const res = await deps.auth.api.signUpEmail({
			body: {
				email: OWNER_EMAIL,
				password: parsed.data.password,
				name: OWNER_NAME,
			},
			headers: c.req.raw.headers,
			asResponse: true,
		});

		if (res.status !== 200) {
			throw new HttpError(400, "Setup failed");
		}

		const data = (await res.json()) as { user?: { id: string } };
		if (!data.user) {
			throw new HttpError(500, "Setup failed");
		}

		await createSettings(deps.db, data.user.id, {
			...defaultSettingsInput,
			timezone: parsed.data.timezone,
		});

		const cookie = res.headers.get("set-cookie");
		return c.newResponse(JSON.stringify({ ok: true }), 200, {
			"set-cookie": cookie ?? "",
		});
	});

	// POST /api/login — password only; resolves the single account server-side.
	app.post("/login", async (c) => {
		const parsed = loginSchema.safeParse(await parseJsonBody(c));
		if (!parsed.success) {
			throw new HttpError(400, "Invalid login request");
		}

		const soleUser = await getSoleUser(deps.db);
		if (!soleUser) {
			throw new HttpError(400, "RememberMe is not set up yet");
		}

		const res = await deps.auth.api.signInEmail({
			body: { email: soleUser.email, password: parsed.data.password },
			headers: c.req.raw.headers,
			asResponse: true,
		});

		if (res.status !== 200) {
			throw new HttpError(401, "Incorrect password");
		}

		const cookie = res.headers.get("set-cookie");
		return c.newResponse(JSON.stringify({ ok: true }), 200, {
			"set-cookie": cookie ?? "",
		});
	});

	// POST /api/logout — clears the session cookie.
	app.post("/logout", async (c) => {
		const res = await deps.auth.api.signOut({
			headers: c.req.raw.headers,
			asResponse: true,
		});
		const cookie = res.headers.get("set-cookie");
		return c.newResponse(JSON.stringify({ ok: true }), 200, {
			"set-cookie": cookie ?? "",
		});
	});

	return app;
}
