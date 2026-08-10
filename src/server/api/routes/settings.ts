import { APIError } from "better-auth";
import { Hono } from "hono";
import { changePasswordSchema } from "../../../shared/schemas/auth";
import { settingsSchema } from "../../../shared/schemas/settings";
import { createSettings, getSettingsByUserId, updateSettings } from "../../db/repo";
import { HttpError, parseJsonBody, requireSession } from "../http";
import type { ApiDeps } from "../types";

/** Settings API: digest recipient, timezone, and schedule. */
export function settingsRoutes(deps: ApiDeps) {
	const app = new Hono();

	// GET /api/settings
	app.get("/settings", async (c) => {
		const session = await requireSession(c, deps.auth);
		const row = await getSettingsByUserId(deps.db, session.user.id);
		return c.json({
			email: row?.email ?? "",
			timezone: row?.timezone ?? "UTC",
			weeklyDigestEnabled: row?.weeklyDigestEnabled ?? false,
			weeklyDigestHour: row?.weeklyDigestHour ?? 20,
		});
	});

	// PUT /api/settings
	app.put("/settings", async (c) => {
		const session = await requireSession(c, deps.auth);
		const parsed = settingsSchema.safeParse(await parseJsonBody(c));
		if (!parsed.success) {
			throw new HttpError(400, "Invalid settings");
		}

		const existing = await getSettingsByUserId(deps.db, session.user.id);
		if (existing) {
			await updateSettings(deps.db, session.user.id, parsed.data);
		} else {
			await createSettings(deps.db, session.user.id, parsed.data);
		}
		return c.json(parsed.data);
	});

	// POST /api/settings/password — change password, revoke other sessions.
	app.post("/settings/password", async (c) => {
		await requireSession(c, deps.auth);
		const parsed = changePasswordSchema.safeParse(await parseJsonBody(c));
		if (!parsed.success) {
			throw new HttpError(400, "Invalid password payload");
		}

		try {
			await deps.auth.api.changePassword({
				body: {
					currentPassword: parsed.data.currentPassword,
					newPassword: parsed.data.newPassword,
					revokeOtherSessions: true,
				},
				headers: c.req.raw.headers,
			});
		} catch (err) {
			// Better Auth reports a wrong current password as a 4xx APIError
			// (status 400 in this version). Map any client error to a clean 400.
			if (err instanceof APIError && err.statusCode >= 400 && err.statusCode < 500) {
				throw new HttpError(400, "Current password is incorrect");
			}
			throw err;
		}

		return c.json({ ok: true });
	});

	return app;
}
