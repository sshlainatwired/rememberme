import { Hono } from "hono";
import {
	journalDateSchema,
	journalRangeSchema,
	journalUpsertSchema,
} from "../../../shared/schemas/journal";
import { deleteEntry, getEntry, listEntryDates, upsertEntry } from "../../db/repo";
import { HttpError, parseJsonBody, requireSession } from "../http";
import type { ApiDeps } from "../types";

/**
 * Journal API. Entry dates are calendar dates (YYYY-MM-DD) in the user's
 * configured timezone. Content is encrypted before every write and decrypted
 * only when an entry is actually read.
 */

function parseDate(raw: string | undefined): string {
	const parsed = journalDateSchema.safeParse(raw);
	if (!parsed.success) {
		throw new HttpError(400, "Invalid date; expected YYYY-MM-DD");
	}
	return parsed.data;
}

export function journalRoutes(deps: ApiDeps) {
	const app = new Hono();

	// GET /api/journal?from=&to= — entry dates only (no content).
	app.get("/journal", async (c) => {
		const session = await requireSession(c, deps.auth);
		const parsed = journalRangeSchema.safeParse({
			from: c.req.query("from") ?? undefined,
			to: c.req.query("to") ?? undefined,
		});
		if (!parsed.success) {
			throw new HttpError(400, "Invalid query parameters");
		}
		const dates = await listEntryDates(deps.db, session.user.id, parsed.data);
		return c.json({ dates });
	});

	// GET /api/journal/:date — full entry content (decrypted).
	app.get("/journal/:date", async (c) => {
		const session = await requireSession(c, deps.auth);
		const date = parseDate(c.req.param("date"));
		const row = await getEntry(deps.db, session.user.id, date);
		const content = row
			? await deps.cipher.decrypt({
					encryptedContent: row.encryptedContent,
					iv: row.iv,
					authTag: row.authTag,
				})
			: "";
		return c.json({ date, content });
	});

	// PUT /api/journal/:date — create or update today's/past entries.
	// An empty body deletes the entry (an empty entry is "no entry").
	app.put("/journal/:date", async (c) => {
		const session = await requireSession(c, deps.auth);
		const date = parseDate(c.req.param("date"));
		const parsed = journalUpsertSchema.safeParse(await parseJsonBody(c));
		if (!parsed.success) {
			throw new HttpError(400, "Invalid journal payload");
		}

		const { content } = parsed.data;
		if (content === "") {
			await deleteEntry(deps.db, session.user.id, date);
			return c.json({ ok: true, date, deleted: true });
		}

		const encrypted = await deps.cipher.encrypt(content);
		await upsertEntry(deps.db, session.user.id, date, encrypted);
		return c.json({ ok: true, date, savedAt: new Date().toISOString() });
	});

	return app;
}
