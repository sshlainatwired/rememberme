# ADR-0003 — Shared platform-neutral core (`@rememberme/core`)

- **Status**: Accepted (Phase 2, implementation complete)
- **Date**: Phase 2
- **Deciders**: RememberMe maintainers / Phase 2 implementer

## Context

Phase 0/1 (ADR-0001, ADR-0002) established that the web app (Astro) and the
Android app (Vite + React + Capacitor) must share only **truly
platform-neutral domain code**, with the reuse classifications recorded in
`reuse-matrix.md`: `shared/schemas/journal.ts` and the lower-level timezone
primitives from `server/timezone.ts` are **SHARE**; `shared/schemas/settings.ts`
is **ADAPT** (Android builds its own settings schema on the shared timezone
primitive); the pure calendar/week/content model from the weekly-digest server
module is **SHARE** after fixing its UTC timezone handling.

Phase 2's central decision (explicitly deferred from ADR-0001/0002) is **how**
to share: a **dedicated package** both builds import, versus copy + sync test.
This ADR records that decision, the package's seam/interface, the reuse
wrappers that preserve web behavior, the Android UI adaptation, and the actual
process gates run.

## Decision

Create a dedicated Bun workspace package **`packages/rememberme-core`**
(published name **`@rememberme/core`**), the single source of truth for
platform-neutral domain logic, imported by both the web and Android workspaces.

### Package shape

- Root `package.json` workspaces are extended to **`["android", "packages/*"]`**;
  the root `bun.lock` remains the single canonical lockfile for all three
  workspaces (web, android, core).
- The package is **ESM-first with source exports**: `main`/`types`/`exports`
  all point at `./src/index.ts` (no build step). Both bundlers (Astro/Vite,
  the web build) can consume TypeScript source directly; the Android Vite
  build transforms it like any other `node_modules` TS.
- **Strict TypeScript**, own `tsconfig.json` (`ES2022` + `ES2022.Intl` lib for
  `Intl.supportedValuesOf`, `strict`, `verbatimModuleSyntax`,
  `isolatedModules`, `noUnusedLocals/Parameters`), own `biome.json`
  (mirrors root/android conventions: tabs, width 100, `recommended` with the
  same two relaxations), own scoped scripts `lint` / `typecheck` / `test`.
  Root convenience wrappers `core:lint` / `core:typecheck` / `core:test` /
  `core:check` pass through to the package.
- **Only platform-safe dependencies**: `zod`, `luxon`. `luxon` is a **runtime**
  dependency, not just typing sugar: `timezone.ts` maps instants to
  zone-local civil dates through `DateTime.fromISO`/`fromMillis`, and the web
  wrapper re-exports its `DateTime` type. The civil calendar in `calendar.ts`
  stays luxon-free. **No** Node, Astro, Hono, Better Auth, or `fs`
  imports — anything that touches a server runtime is deliberately excluded,
  so the static Android build can never break on a stray server import.

### Shared interface (small and clear)

Four modules re-exported from `src/index.ts`:

1. **`journal.ts`** — the existing journal Zod schemas, moved verbatim:
   - `journalDateSchema` (Zod ISO date), `journalContentSchema`
     (`z.string().max(100_000)`), `journalUpsertSchema`,
     `journalRangeSchema` (with `from ≤ to` refine), plus `JOURNAL_CONTENT_MAX`.
   - Semantics locked by tests: **content is never trimmed** — empty strings
     (meaning "no entry" upstream), whitespace-only, newlines and arbitrary
     Unicode survive parsing byte-for-byte; the 100k max counts Unicode code
     points (Zod 4), so 100k emoji parse even though they occupy 200k UTF-16
     units.
2. **`timezone.ts`** — the shared validation primitive and one deterministic
   time-of-day helper:
   - `supportedTimeZones` (`Intl.supportedValuesOf("timeZone")`, **guarded at
     module load**), `isTimezoneSupported(value)` (plain check),
     `timezoneSchema` (Zod refine over the primitive) — usable by both the
     web settings schema and the future Android settings schema. On old
     WebViews without `Intl.supportedValuesOf` the enumerated set is just
     `{"UTC"}` and `isTimezoneSupported` falls back to an
     `Intl.DateTimeFormat` probe (resolved canonical name must equal the
     input) — so under the fallback `supportedTimeZones` is **not** a full
     zone list, and `ES2022.Intl` typings alone do not promise the runtime
     API exists.
   - `todayInTimezone(timezone, now?)` — maps an **instant** to the local
     calendar date. Deterministic: callers pass the current instant
     (`Date`, epoch millis, or ISO string), so tests never depend on the wall
     clock. String instants must be **offset-bearing ISO 8601** (`Z` or a
     numeric offset within ±14:00); date-only and offsetless strings are
     rejected because they would silently resolve to the host's local zone.
     Throws a `RangeError` for an unsupported zone or
     unparseable/ambiguous instant rather than returning invalid garbage.
3. **`calendar.ts`** — **pure civil-calendar helpers**, deliberately **luxon-
   free** and with **no instant and no IANA zone anywhere**, so "local
   calendar arithmetic mixed with UTC instant arithmetic" is impossible by
   construction:
   - `isCalendarDate(value)`, `mondayOfWeek(date)` (Monday of the Monday–Sunday
     week, purely civil), `weekDates(monday)` (7 dates Mon..Sun), `addDays`,
     `formatDay(date, _timezone?)` ("Monday · August 10, 2026" — weekday/month
     derive purely from the civil date; the `timezone` arg is accepted only to
     preserve the legacy web signature and is unused), `formatWeekRange`.
   - Implemented with proleptic-Gregorian integer day math (no `Date`), so
     results are reproducible on any runtime. Years are zero-padded to four
     digits in both machine (`YYYY-MM-DD`) and human (`formatDay`/
     `formatWeekRange`) labels, with a protected range 0000..9999 — anything
     outside throws a `RangeError`.
4. **`weekly.ts`** — the extracted, pure weekly content model:
   - `DigestDay` is a calendar-date string plus nullable content;
     `DigestWeek` is an exact readonly seven-day tuple.
   - `buildDigestWeek` orders content Monday–Sunday, maps missing dates to
     `null`, ignores out-of-week keys, and preserves present content exactly,
     including empty strings, whitespace, newlines, and Unicode.
   - `mostRecentSunday` is Sunday-inclusive and otherwise returns the previous
     Sunday using only civil helpers. The module imports no Date, Luxon, Node,
     server, or platform APIs.

### Reuse wrappers (preserve web behavior, no business duplication)

The root server/shared modules become thin **compatibility re-exports/wrappers**
of core, keeping every existing public import and its behavior:

- `src/shared/schemas/journal.ts` → re-exports `JOURNAL_CONTENT_MAX`,
  `journalContentSchema`, `journalDateSchema`, `journalRangeSchema`,
  `journalUpsertSchema` from `@rememberme/core` (plus two core type re-exports).
  No logic remains here.
- `src/server/timezone.ts` → re-exports `todayInTimezone` (now delegating to
  core's deterministic version; the web signature `todayInTimezone(timezone)`
  is preserved by defaulting `now` to `new Date()`) and `formatDay`
  (delegating to core's civil version). The `DateTime` luxon type is
  re-exported for any callers that referenced it.
- `src/shared/schemas/settings.ts` → imports and re-exports the shared
  `timezoneSchema` from core, retaining the **web-only** settings fields
  (`emailSchema`, `digestHourSchema`, `settingsSchema`, `SettingsInput`,
  `defaultSettingsInput`).
- The web's own `server/jobs/weekly-digest.ts` private week helpers are **not**
  refactored (out of scope; only the platform-neutral primitives were
  extracted). The web app remains green.

Dependencies: root `package.json` and `android/package.json` each add
`"@rememberme/core": "workspace:*"`. No server module beyond the wrappers was
refactored.

### Android UI adaptation (no coupling to Astro/server)

A React **`WeekStrip`** component (`android/src/components/journal/WeekStrip.tsx`)
is the Android equivalent of the web `components/journal/WeekStrip.astro`,
with all **range/date math coming from `@rememberme/core`** (`mondayOfWeek`,
`weekDates`, `addDays`, `formatWeekRange`). Presentation, router targets, and
accessibility are Android-local:

- Accessible links: `aria-label` per day ("Wednesday, August 12"); `aria-current
  ="date"` on the open day; prev/next-week links (default day + week targets are
  the `/journal/:date` route; a custom `linkForDate` builder overrides them).
- Touch targets: prev/next controls use component-local `min-h-11 min-w-11`
  (44×44px), while day cells use `min-h-14`; the global `:where(a)` rule
  remains a baseline safeguard. At narrow widths (down to 320px) the strip is
  full-bleed within AppShell (`-mx-4` with base `p-1`, reset to normal
  margins/`p-4` at `sm`), keeping all seven 44px day cells on one row without
  horizontal overflow.
- Entry markers: a `data-has-entry="true"/"false"` attribute and a ✓ / —
  badge, driven by an `entryDates` set that **defaults to empty** — Phase 2
  does not pretend persistence exists (SQLite lands in Phase 3). Each day link
  references unique screen-reader-only `Entry saved` / `No entry` text through
  `aria-describedby`, preserving the full-date accessible name.
- `Today.tsx` integrates the strip using `todayInTimezone(deviceZone)` +
  `mondayOfWeek`, reusing the existing Card/AppShell UI tokens; **no Ionic or
  new framework** was introduced.
- **Routes (Phase 2 follow-up fix):** `/today` stays the today shortcut; a new
  `/journal/:date` route renders `Journal.tsx`, which validates the `:date`
  route param against the shared `journalDateSchema` (real `YYYY-MM-DD` only,
  leap years included) and safely redirects anything malformed or impossible
  (e.g. `2026-02-30`, `not-a-date`) to `/today` via `Navigate replace`. The
  page renders the selected date via `formatDay` as an accessible `h1`
  (`aria-labelledby` section) and the WeekStrip with `/journal/YYYY-MM-DD`
  day cells and prev/next week links. This replaced the earlier
  `/today?date=…` day-target wiring, which the Today page ignored, so calendar
  navigation was broken. WeekStrip now defaults its day and week links to
  `/journal/:date` (Today and Journal pages no longer pass a custom builder).
  A route redirects when its containing week would leave the representable
  `0000..9999` range. For a renderable boundary week, an unavailable adjacent
  week direction is omitted and replaced by an inert 44×44px spacer.
  No persistence or editor yet — same placeholder Card as Today.

Vitest + Testing Library tests (`android/src/test/weekstrip.vitest.tsx`) cover
range/dates, current-day semantics, entry markers and their accessible
descriptions, 44×44px minimum targets, and prev/next navigation.

## Rationale

1. **A package beats copy + sync test** (the Phase 0/1 open decision): one
   source of truth imported by both builds; no drift risk, no sync script;
   both bundlers consume the same source. This is the "single source,
   free of platform-specific dependencies, imported by both builds" SHARE model
   from the reuse matrix.
2. **Source exports, no build step**: keeps the package transparent, avoids a
   dist/consume-cycle, and works with both Astro (web) and Vite (Android)
   without a separate tarball/publish. It's workspace-internal and `private`,
   so there is no registry publication concern.
3. **Pure civil calendar in core**: the web's old week math zoned via
   `setZone("UTC").startOf("day")` was a UTC-mixing bug for non-UTC zones
   (documented in `reuse-matrix.md` §5 note). Core's calendar module has no
   zone at all, and its tests prove it detects the old bug (see Red evidence).
4. **Deterministic today**: `todayInTimezone` accepting the instant makes
   timezone behavior testable without a wall clock and is the seam the Android
   settings schema and Weekly Review will build on.
5. **Minimal blast radius**: the web suite, build, lint, and typecheck remain
   green with only wrapper changes; Android gains real shared logic without
   importing any server/Astro code.

## Consequences

### Positive

- Web + Android share one dependency-free domain core; reuse classifications
  in `reuse-matrix.md` are now realized as an actual package.
- No duplicated business logic: the web wrappers have zero logic; Android gets
  the same validated schemas, timezone primitive, and civil-calendar helpers.
- Both toolchains typecheck/lint/test/build green through the shared package.

### Negative / costs

- The core package's `tsconfig` must stay aligned with both target libs
  (`ES2022.Intl` for `Intl.supportedValuesOf`); Android's own `tsconfig` lib
  list must include `ES2022.Intl` to consume `@rememberme/core`'s types.
  The lib flag only supplies **typings** — it does not guarantee the runtime
  API exists, which is why `timezone.ts` guards `Intl.supportedValuesOf` at
  module load and falls back for old WebViews (see the timezone bullet).
- Root `bun.lock` now covers three workspaces; any core dependency change must
  re-run the root `bun install` (lockfile-gated).
- The web `server/jobs/weekly-digest.ts` still carries its own private,
  UTC-zoned week helpers; reconciling it against core is deliberately not in
  scope.

### Android UI: no persistence claimed

The WeekStrip default `entryDates` is the empty set and `Today` renders the
strip without an editor; neither pretends on-device storage exists (that is
Phase 3 SQLite + Phase 5 journal UX). The shared layer reused here is exactly
the platform-neutral calendar/timezone seam the plan calls for.

## Verification (actual gates)

### TDD evidence

**Red (before implementation) — core package suite:**

```
$ cd packages/rememberme-core && bun test
SUMMARY:  0 pass  4 fail
  error: Cannot find module './journal' ...
  error: Cannot find module './calendar' ...
  error: Cannot find module './timezone' ...
  error: Cannot find module './index' ...
```

**Green (after implementation) — core suite:**

```
$ cd packages/rememberme-core && bun test
SUMMARY:  94 pass  0 fail
Ran 94 tests across 5 files.
```

The calendar suite includes a **detector for the old UTC-mixing bug**:
`legacyUtcMondayOfWeek("2026-08-10", "Europe/Istanbul")` (the real legacy
algorithm) returns `"2026-08-03"`, while the shared `mondayOfWeek("2026-08-10")`
correctly returns `"2026-08-10"` — the test asserts they differ (Istanbul and
Tokyo positive-offset zones). Timezone suite covers UTC, `Europe/Istanbul`,
`America/New_York`, a positive offset near midnight, and the 2026 US DST
start/end transitions. The weekly suite verifies Sunday-inclusive week math,
Monday–Sunday ordering, nullable missing content, exact preservation of present
content, and month/year/leap boundaries.

**Red → Green — shared weekly model:** tests were added before `weekly.ts` and
failed because the module did not exist; implementation and public export then
made the new model suite green without changing the web digest runtime.

**Red → Green — Android WeekStrip suite:** the initial run failed (module not
found + a prev/next-href expectation that joined the router base path); after
implementing the component and correcting the test's router path, the suite is
green (below).

**Red → Green — Android `/journal/:date` route suite:** a new route test block
(`src/test/app.vitest.tsx`) was written first: `/journal/2026-08-10` must render
the `formatDay` heading, the strip must produce `/journal/…` day and prev/next
hrefs, invalid dates must redirect to Today, and the Today page must keep its
strip on journal-date routes. Alongside it, the WeekStrip suite's default-wiring
expectations were updated to the new spec (prev/next on normal weeks, default
hrefs `/journal/…`). Both ran red before implementation (`/journal/:date`
matched no route → fell through to the `*` redirect; the strip still emitted
`/today?date=…` and no week nav), then green after adding the route, the
Journal page, and the WeekStrip default target.

**Red → Green — representable year boundaries:** route tests first exposed
uncaught `RangeError`s for weeks crossing year `0000`/`9999`, then a remaining
underflow from the previous-week link on the first renderable week. The final
implementation redirects unrenderable weeks and omits only an unavailable
adjacent-week control; tests retain the closest renderable lower and upper
weeks.

**Green (after implementation) — Android suites:**

```
$ cd android && bunx vitest run
Test Files  2 passed (2)
     Tests  39 passed (39)
```

### Gate results (Phase 2, actual)

| Gate | Command | Result |
| --- | --- | --- |
| Frozen install | `bun install --frozen-lockfile` (root) | See full battery below |
| Core lint | `bun run --cwd packages/rememberme-core lint` | Pass |
| Core typecheck | `bun run --cwd packages/rememberme-core typecheck` | Pass |
| Core test | `bun run --cwd packages/rememberme-core test` | Pass; 94 tests / 5 files |
| Android lint | `bun run --cwd android lint` | Pass |
| Android typecheck | `bun run --cwd android typecheck` | Pass; 0 errors |
| Android test | `bun run --cwd android test` | Pass; 39 tests / 2 files |
| Android build | `bun run --cwd android build` | Pass; vite 8, 1953 modules |
| Cap sync | `bun run --cwd android cap:sync` | Pass; assets + plugins updated |
| Web lint | `bun run lint` | Pass |
| Web typecheck | `bun run typecheck` | Pass |
| Web plain bun test | `bun test` | Pass (web + core suites; Android vitest excluded by `*.vitest.*`) |
| Web build | `bun run build` | Pass |

Note: the native Gradle `assembleDebug` gate remains **skipped** — the local
toolchain still has no JDK/SDK (identical to Phase 1; ADR-0002). Not claimed.

## Follow-ups (deferred)

- Phase 3: on-device SQLite storage (WeekStrip entry markers start feeding
  real persisted dates).
- Phase 5: journal editor + Android settings schema built on the shared
  `timezoneSchema`.
- Phase 6: Weekly Review + local notifications reusing core's calendar helpers.
- Reconcile the web `weekly-digest.ts` private UTC-zoned week helpers against
  core's civil model (out of Phase 2 scope).
