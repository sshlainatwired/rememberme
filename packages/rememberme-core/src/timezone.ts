import { DateTime } from "luxon";
import { z } from "zod";

/**
 * Timezone primitives for the platform-neutral core (web + Android).
 *
 * Two responsibilities live here:
 *
 * 1. A validation primitive for IANA timezone names usable by the web
 *    settings schema and, later, the Android-specific settings schema.
 *    Modern runtimes report the canonical zone list via
 *    `Intl.supportedValuesOf("timeZone")`; older WebViews lack that API, so
 *    module load guards against its absence and `isTimezoneSupported` falls
 *    back to an `Intl.DateTimeFormat` probe.
 * 2. `todayInTimezone`: the ONLY place an instant is mapped to a local
 *    calendar day. It is deterministic — callers pass the current instant —
 *    so tests never depend on the wall clock. String instants must carry an
 *    explicit UTC offset ("Z" or a numeric offset within ±14:00), so a naive
 *    date-only or offsetless string can never silently pick up the host's
 *    local zone instead of the caller's instant.
 *
 * Calendar-date arithmetic (weeks, day navigation, formatting) never touches
 * an instant and lives in `./calendar.ts`.
 */

/** True when the runtime provides `Intl.supportedValuesOf` (captured at load). */
const hasSupportedValuesOf = typeof Intl.supportedValuesOf === "function";

/**
 * Every IANA timezone the runtime reports (canonical names), plus "UTC".
 *
 * When `Intl.supportedValuesOf` is absent (old WebView) this is the UTC-only
 * fallback set and {@link isTimezoneSupported} falls back to probing
 * `Intl.DateTimeFormat`. "UTC" is unioned explicitly because some runtimes
 * omit it from the reported list even though it is a valid zone.
 */
export const supportedTimeZones: ReadonlySet<string> = hasSupportedValuesOf
	? new Set([...Intl.supportedValuesOf("timeZone"), "UTC"])
	: new Set(["UTC"]);

/**
 * Fallback probe: accept `value` only when Intl resolves it back to
 * canonically-equal input. Constructing the formatter throws a `RangeError`
 * for unknown or malformed identifiers.
 */
function isCanonicalZone(value: string): boolean {
	try {
		const resolved = new Intl.DateTimeFormat("en-US", {
			timeZone: value,
		}).resolvedOptions().timeZone;
		return resolved === value;
	} catch {
		return false;
	}
}

/**
 * Plain, dependency-free validation of an IANA timezone name.
 *
 * Primary path: exact membership in {@link supportedTimeZones}, the canonical
 * set modern runtimes report — "UTC", "Europe/Istanbul", "America/New_York"
 * are valid; junk, empty, and non-canonical casing like "europe/istanbul" or
 * "utc" are not.
 *
 * Fallback path (no `Intl.supportedValuesOf`): Intl resolves identifiers
 * case-insensitively, so the resolved canonical name must equal the input —
 * that keeps wrong casing invalid deterministically. Alias behavior can
 * remain runtime-dependent here: whether a non-canonical link like
 * "US/Eastern" round-trips through `resolvedOptions().timeZone` unchanged is
 * an engine detail, so aliases may or may not be accepted.
 */
export function isTimezoneSupported(value: string): boolean {
	if (supportedTimeZones.has(value)) return true;
	if (hasSupportedValuesOf) return false;
	return isCanonicalZone(value);
}

/** Zod schema reusing the primitive; shared by web and Android settings. */
export const timezoneSchema = z
	.string()
	.min(1)
	.refine(isTimezoneSupported, { message: "Invalid IANA timezone" });

/** An instant: a `Date`, epoch milliseconds, or an ISO 8601 string. */
export type InstantLike = Date | number | string;

/** The timezone designator an instant string must end with: "Z" or "±hh[:]mm". */
const OFFSET_DESIGNATOR = /([+-]\d{2}(?::?\d{2})?|Z)$/;

/**
 * True when `value` ends in an explicit UTC offset designator within the
 * valid offset range.
 *
 * The designator must be "Z" or a numeric offset whose hours are within the
 * tzdb's real-world ±14:00 range (so "+25:00" is rejected) and whose minutes
 * are 00..59 — luxon itself silently rolls "+03:60" into +04:00, so the raw
 * suffix is validated here. NOTE: the regex can match an offset-looking tail
 * of a non-instant (e.g. "-10" in "2026-08-10"); the caller's
 * `zone.type === "fixed"` requirement rejects those false positives.
 */
function hasValidUtcOffsetSuffix(value: string): boolean {
	const m = OFFSET_DESIGNATOR.exec(value);
	if (!m) return false;
	const part = m[1];
	if (part === "Z") return true;
	const body = part.slice(1); // "hh" | "hhmm" | "hh:mm"
	const hours = Number(body.slice(0, 2));
	const minutes =
		body.length === 5 ? Number(body.slice(3)) : body.length === 4 ? Number(body.slice(2)) : 0;
	return minutes <= 59 && (hours < 14 || (hours === 14 && minutes === 0));
}

function toDateTime(now: InstantLike): DateTime {
	let dt: DateTime;
	if (typeof now === "number") {
		dt = DateTime.fromMillis(now);
	} else if (typeof now === "string") {
		dt = DateTime.fromISO(now, { setZone: true });
		// A string input must denote an actual instant: parseable, with an
		// explicit fixed offset ("Z" or numeric) within valid range. Date-only
		// and offsetless ISO strings parse to the host's local zone and are
		// rejected here rather than silently becoming local midnight.
		if (
			!dt.isValid ||
			!dt.isOffsetFixed ||
			!hasValidUtcOffsetSuffix(now) ||
			dt.offset < -840 ||
			dt.offset > 840
		) {
			throw new RangeError(
				`Invalid instant: ${JSON.stringify(now)} (expected ISO 8601 with an explicit UTC offset, Z or ±hh:mm within ±14:00)`,
			);
		}
	} else {
		dt = DateTime.fromJSDate(now);
	}
	if (!dt.isValid) {
		throw new RangeError(
			`Invalid instant: ${JSON.stringify(now)} (expected ISO 8601 or epoch millis)`,
		);
	}
	return dt;
}

/**
 * Today's calendar date (`YYYY-MM-DD`) in `timezone` for the given instant.
 *
 * `now` defaults to the current wall clock but is injectable so behavior is
 * deterministic under test. Throws a `RangeError` for an unsupported zone or
 * an unparseable/ambiguous instant rather than returning "Invalid DateTime"
 * garbage.
 */
export function todayInTimezone(timezone: string, now: InstantLike = new Date()): string {
	if (!isTimezoneSupported(timezone)) {
		throw new RangeError(`Unsupported IANA timezone: ${JSON.stringify(timezone)}`);
	}
	const local = toDateTime(now).setZone(timezone);
	if (!local.isValid) {
		throw new RangeError(`Unsupported IANA timezone: ${JSON.stringify(timezone)}`);
	}
	return local.toFormat("yyyy-MM-dd");
}
