/**
 * Timezone-aware date helpers — compatibility wrapper.
 *
 * Phase 2 moved the canonical helpers into the shared `@rememberme/core`
 * package. `todayInTimezone` now lives there with a deterministic, injectable
 * instant and throws on an unsupported zone; `formatDay` moved to the core's
 * pure civil-calendar module (its optional timezone argument is accepted but
 * never changes the result, because weekday/month derive purely from the
 * civil date). This module keeps the original public names and behavior for
 * every existing web import.
 *
 * NOTE: the web's `server/jobs/weekly-digest.ts` has its own private week
 * helpers (`mondayOfWeek`/`mostRecentSunday`) that still use the old UTC
 * `setZone("UTC").startOf("day")` math. Those were intentionally left in the
 * server module (out of scope for this phase) — only the platform-neutral
 * primitives were extracted to core.
 */
import { formatDay as coreFormatDay, todayInTimezone as coreToday } from "@rememberme/core";

/** Today's calendar date (YYYY-MM-DD). Now deterministic — pass an instant. */
export function todayInTimezone(timezone: string): string;
export function todayInTimezone(timezone: string, now?: Date | number | string): string;
export function todayInTimezone(timezone: string, now?: Date | number | string): string {
	return coreToday(timezone, now ?? new Date());
}

/** Human-readable weekday + date, e.g. "Monday · August 10, 2026". */
export function formatDay(date: string, timezone?: string): string {
	return coreFormatDay(date, timezone);
}

/** Re-export the luxon DateTime type the web callers may reference. */
export type { DateTime as LuxonDateTime } from "luxon";
