import { z } from "zod";

/**
 * Journal domain schemas (platform-neutral core, web + Android).
 *
 * Semantics preserved from the web app:
 * - Dates are calendar dates `YYYY-MM-DD` (Zod ISO date validation).
 * - Content is never trimmed: empty strings (meaning "no entry"), whitespace,
 *   newlines and arbitrary Unicode all survive parsing byte-for-byte.
 * - The 100,000-character maximum counts Unicode code points (Zod 4
 *   string-length semantics), so 100,000 emoji are accepted even though they
 *   occupy 200,000 UTF-16 code units.
 */

/** Maximum length of a journal entry, in characters (Unicode code points). */
export const JOURNAL_CONTENT_MAX = 100_000;

/** Calendar date, e.g. "2026-08-10". Validated with Zod's ISO date. */
export const journalDateSchema = z.iso.date();

/** Journal entry content. Empty strings are allowed (meaning "no entry"). */
export const journalContentSchema = z.string().max(JOURNAL_CONTENT_MAX);

/** Request body for PUT /api/journal/:date */
export const journalUpsertSchema = z.object({
	content: journalContentSchema,
});

/** Query parameters for GET /api/journal?from=&to= (both optional). */
export const journalRangeSchema = z
	.object({
		from: z.iso.date().optional(),
		to: z.iso.date().optional(),
	})
	.refine((d) => !d.from || !d.to || d.from <= d.to, {
		message: "from must not be after to",
	});
