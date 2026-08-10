import { Hono } from "hono";
import { DateTime } from "luxon";
import { runWeeklyDigest } from "../../jobs/weekly-digest";
import { HttpError, requireSession } from "../http";
import type { ApiDeps } from "../types";

/** Manual digest trigger (also usable from an external cron). */
export function digestRoutes(deps: ApiDeps) {
	const app = new Hono();

	// POST /api/jobs/weekly-digest
	app.post("/jobs/weekly-digest", async (c) => {
		await requireSession(c, deps.auth);
		if (!deps.mailer) {
			throw new HttpError(503, "SMTP is not configured");
		}

		const result = await runWeeklyDigest(
			{
				db: deps.db,
				cipher: deps.cipher,
				mailer: deps.mailer,
				config: deps.config,
			},
			DateTime.now(),
			false, // manual run: send the most recently completed week
		);

		return c.json({ ok: true, ...result });
	});

	return app;
}
