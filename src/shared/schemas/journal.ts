import { z } from "zod";

/** Maximum length of a journal entry (characters). */
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

export type JournalRange = z.infer<typeof journalRangeSchema>;
