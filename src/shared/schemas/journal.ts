export type { CalendarDate, Week } from "@rememberme/core";
/**
 * Journal domain schemas — compatibility wrapper.
 *
 * Phase 2 moved the canonical, platform-neutral implementation into the
 * shared `@rememberme/core` package. This module re-exports it unchanged so
 * that every existing web import of `shared/schemas/journal` keeps working
 * with identical behavior. Treat this file as a thin seam; the real logic
 * lives in `packages/rememberme-core/src/journal.ts`.
 */
export {
	JOURNAL_CONTENT_MAX,
	journalContentSchema,
	journalDateSchema,
	journalRangeSchema,
	journalUpsertSchema,
} from "@rememberme/core";
