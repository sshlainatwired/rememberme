# ADR-0007 — Local weekly notification schedule math (Phase 6)

- **Status**: Accepted for Phase 6 Task 1
- **Date**: Phase 6
- **Deciders**: RememberMe maintainers / Phase 6 implementer

## Context

Weekly reminders are local to the saved profile timezone. The device timezone
may differ while travelling, and the alarm must still represent the user's
saved Sunday/hour schedule. The schedule helper is also used by reconciliation
to identify the latest due week, so both paths must apply the same calendar and
DST rules.

The Android API floor is 24. Production scheduling math therefore cannot use
`java.time` or depend on a newer desugaring library.

## Decision

`WeeklyScheduleMath` is a pure Java helper that accepts a validated IANA
timezone ID, an hour from 0 through 23, and an instant in epoch milliseconds.
It constructs every `Calendar` with the saved `TimeZone`; it never reads the
device default timezone.

`nextSundayAt` returns a `ScheduleTarget` containing the resolved trigger
instant, its real Sunday date (`yyyy-MM-dd`), and the Monday ISO week key. The
trigger is strictly later than the supplied instant, including when the
instant is exactly at the configured Sunday/hour.

`latestDueWeek` returns the Monday key for the most recent configured Sunday.
Sunday before the configured hour belongs to the preceding week; Sunday at or
after the hour belongs to the current Sunday week; Monday through Saturday
belong to the immediately preceding Sunday week. ISO date strings are ordered
lexicographically, so the notification controller can retain only the latest
due week after a large forward clock jump. Comparing `lastNotifiedWeek` or
`claimedWeek` with that key also makes a manual clock rollback idempotent.

Invalid IDs are rejected unless they are real entries in
`TimeZone.getAvailableIDs()` and resolve without the `TimeZone` fallback. Hours
outside 0 through 23 are rejected.

The shared wall-time resolver uses lenient `Calendar` normalization for a
spring-forward gap. A requested time in the gap resolves to the first valid
post-gap wall time. For a fall-back overlap, it checks nearby offsets and
selects the earliest instant that still has the requested wall-clock fields,
which is the earlier occurrence. This explicit adjustment handles runtimes
where `Calendar` initially selects the later offset.

## Consequences

- Saved-zone schedule behavior is deterministic and API-24 compatible.
- A forward jump does not replay every missed week; policy can post only the
  latest due week.
- A crash-safe write-ahead claim in the controller can suppress a duplicate
  after a crash between claiming and posting, accepting a possible missed
  reminder because the in-app weekly review remains available.
- The implementation uses no exact alarm API and no device-zone fallback.
- Tests use exact `java.time.Instant` values only as host-test fixtures for
  boundary and DST assertions. Production contains no `java.time` import.
- No synthetic year-boundary cases are used to define the contract; week keys
  are derived from actual `Calendar` dates.

## References

- `android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyScheduleMath.java`
- `android/android/app/src/test/java/app/rememberme/journal/notifications/WeeklyScheduleMathTest.java`
- `.superpowers/sdd/phase6-plan/task-1-brief.md`
- `.superpowers/sdd/phase6-plan/phase6-plan.md` § Global constraints and Task 1
