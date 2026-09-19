# ADR-0004 — On-device SQLite storage (Phase 3)

- **Status**: Accepted (Phase 3 final complete; two fresh independent Terra reviews returned `PERFECT` — see `.superpowers/sdd/porting-plan/phase3-report.md`)
- **Date**: Phase 3
- **Deciders**: RememberMe maintainers / Phase 3 implementer

## Context

The Android app needs a real offline persistence layer before any journal or
settings work (Phases 5+) can ship. Constraints from the porting plan and
earlier ADRs:

- **No JS storage substitutes**: localStorage / IndexedDB are not an allowed
  stand-in for on-device persistence (ADR-0001). Web wrappers and the web
  app's runtime are untouched.
- **Encryption is deferred**: the crypto/key-management contract is decided in
  Phase 4. Phase 3 stores transitional plaintext that no user-facing editor
  can reach until Phase 4 converts the storage contract.
- **Shared domain core**: validation primitives live in `@rememberme/core`
  (ADR-0003); the Android app reuses the shared journal schemas and timezone
  validation instead of reimplementing them.
- **Native platform**: Capacitor 8 workspace (ADR-0002), app-private storage,
  fully offline.

Decisions needed: which SQLite engine and plugin, how schema versions are
tracked and migrated, how tests exercise the same SQL against a desktop
engine, and how the app bootstraps storage without a web fallback.

## Decision

### Engine and plugin

Use **`@capacitor-community/sqlite@8.1.1`** (peer `@capacitor/core >=8.0.0`,
Android minSdk 24 / compileSdk 36 / Java 21 — matching this workspace's
generated template). It is the community plugin for Capacitor 8 and provides
a real on-device SQLite connection:

- `SQLiteConnection(CapacitorSQLite)` → `createConnection(name, encrypted,
  mode, version, readonly)` → `open`.
- `execute` / `run` / `query` for SQL, plus explicit
  `beginTransaction` / `commitTransaction` / `rollbackTransaction`.
- The availability guard checks the plugin by its **exact registered
  identifier**: `Capacitor.isPluginAvailable("CapacitorSQLite")`. This is a
  P0 boundary — the string must match the identifier the plugin registers via
  `registerPlugin`, not a remembered/lowercase variant, or a native device
  fails closed even though the plugin is installed.

The single app-private database is named `rememberme`, opened **unencrypted**
(`encrypted = false`) — transitional plaintext only, replaced by the Phase 4
encryption contract before any user-facing journal writes.

### Storage seam: one async dialect, two real adapters

Repositories and migrations depend only on a small async `SQLDialect`
interface (`exec` / `run` / `query` / `begin` / `commit` / `rollback` /
`close`). Two adapters implement it against real SQLite engines:

- `node-sqlite.ts` — `node:sqlite` `DatabaseSync` (in-memory), used **only by
  Vitest behavior tests**. Never imported by production code; never bundled.
- `capacitor-sqlite.ts` — `SQLiteDBConnection` on native Android. Because the
  plugin auto-wraps `execute`/`run` in its own transaction, statements run
  **inside an explicit plugin transaction** (`begin`/`commit`/`rollback`)
  pass `transaction = false` — without it the plugin would open a **nested**
  transaction inside ours. Transaction control stays with our explicit
  `begin`/`commit`/`rollback`.

The same migrations and repository SQL therefore run against identical SQLite
semantics in tests and on device.

### Version tracking and migrations

- Version lives in a **`schema_metadata(version)`** table owned by the app,
  deliberately independent of any plugin-managed `PRAGMA user_version`.
- Migrations are **ordered, contiguous, forward-only** (`version = i + 1`).
  The list is validated at startup: gaps, duplicates, or a stored version
  newer than supported fail closed before anything runs.
- `latestVersion` resolves the highest version with plain index arithmetic
  (`migrations.length - 1`) — no `Array.prototype.at`, which is absent from
  older Android System WebView/Chromium versions that an API-24-compatible
  app may encounter; plain index arithmetic avoids that runtime dependency.
- Corrupt `schema_metadata` fails closed BEFORE any migration runs: zero
  rows, multiple rows, or a non-integer/non-number/negative version are
  rejected, and each version-bump `UPDATE` must affect exactly one row.
- When no real metadata table exists, preflight checks **every
  `sqlite_master` object type** for all exact app-reserved names:
  `schema_metadata`, `journal_entries`, and `settings`. A table, view,
  trigger, or other object under any reserved name proves the store is not
  fresh, so startup rejects before `begin` or any metadata write; unrelated
  plugin/system objects remain allowed.
- Before each pending production migration, its declared prior-version
  `TableSpec` is checked through the same `validateSchemaSpec` used by the
  current-schema validator. Malformed v0 metadata or v1 metadata/journal
  layout therefore rejects before transaction or write, preserving the
  recorded version, schema, and data. Custom migration lists opt into this
  app-specific contract explicitly.
- Each migration and its version bump commit **atomically** inside one
  explicit transaction; any SQL failure rolls back schema, data, and version,
  and initialization rejects with the prior state preserved (even if the
  rollback itself throws — the original migration error survives).
- Two real schema versions ship: **v1 `journal_entries`** (one row per
  calendar date: `date` primary key, `content`, `created_at`, `updated_at`)
  and **v2 `settings`** (key/value pairs, JSON-encoded values).
- Re-running startup applies nothing twice (idempotent). Fresh 0→latest and
  v1→v2 paths produce **normalized structural equivalence**: the same
  whitespace-normalized `sqlite_master` DDL on both paths.
- Failure never resets or deletes the database — it fails closed and the app
  shows a clear, non-destructive startup screen.

### Journal semantics

`JournalService` (over the dialect) implements the shared
`@rememberme/core` journal contract:

- Dates are real `YYYY-MM-DD` calendar dates validated with
  `journalDateSchema`; ranges validated with `journalRangeSchema` (reversed
  or malformed ranges fail before SQL).
- Content is never trimmed; whitespace, newlines, and arbitrary Unicode
  survive **byte-for-byte** (up to the shared 100k code-point maximum).
- **Empty content deletes** at the service boundary; one row per date.
- Overwrites preserve `created_at` and refresh `updated_at` from an
  **injected clock** (deterministic tests, no wall-clock flakiness).
- Writes use portable **UPDATE-then-INSERT** (no SQLite UPSERT syntax) so the
  SQL is engine-portable across the node and Capacitor adapters.
- `list(from?, to?)` returns full entries; **`listDates(from?, to?)`** returns
  **sorted `CalendarDate[]` only (no content)**, sharing the exact same shared
  `journalRangeSchema` validation and inclusive bounds; both reject reversed/
  malformed ranges BEFORE any SQL and each whole query runs in ONE queue slot.
- **Stored rows are decoded fail-closed**: every row read by `get`/`list`
  (and every date read by `listDates`) is validated against the shared
  `journalDateSchema`/`journalContentSchema` BEFORE it can reach the UI. A
  stored row with an invalid date or invalid/oversized/non-string content is
  corruption: reads reject with a clear `Corrupt journal entry` error that
  preserves the original validation failure as `cause` and never echoes the
  stored content (it may be huge or binary). The stored `created_at` /
  `updated_at` timestamps are validated the same way: they must be strings
  AND finite, parseable date strings (the injected clock always emits a
  finite `Date.toISOString()`, so the check rejects non-strings and
  malformed/non-finite values while never rejecting anything the clock
  produces); a bad stored timestamp rejects with the same safe wrapper/cause
  and no content echo. Valid stored rows pass through the decoder unchanged.

### Android settings

`SettingsService` stores exactly the committed Android fields — `timezone`,
`weeklyReviewEnabled`, `weeklyReviewHour` (default **20**), `biometricEnabled`,
`appearance` — with safe defaults. No email, no SMTP/server-password, no
web-only fields. Every write is validated against the shared timezone
validation and per-field contracts **before** any SQL; partial updates write
only the provided keys (no clobber) inside ONE explicit transaction, so a
multi-key update is atomic — any key failure (e.g. an aborting trigger) rolls
back every earlier key in the same call, and a rollback failure never masks
the original error.

Stored settings are validated fail-closed: `get()` rejects (rather than
silently defaulting) on malformed JSON, a stored value that fails the
allowed-key validation, or a stored key outside the allowed set. A missing
key still uses its safe default. `openAppDatabase` validates stored settings
before exposing the handle/routes — corruption rejects and closes the DB
without any write or delete.

`update()` validates ALL existing stored settings **before** starting its
transaction: the first action inside the lock is a validated read of every
stored row (`getUnlocked()`), so a rejected update (stored state already
corrupt) performs ZERO `begin`/writes and cannot mutate some other key that
wasn't being patched. The read-after-write that returns the merged result
runs after commit as before, still inside the same queue slot.

### Operation isolation (shared dialect)

One dialect/connection backs both `JournalService` and `SettingsService`, so
their public reads/writes are serialized through a small database-level async
queue (`withLock` on the dialect, both adapters). A whole settings transaction
(begin→writes→commit→read) and a whole journal UPDATE→INSERT→read each run
inside one queue slot, so overlapping operations cannot interleave
mid-transaction (preventing SQLite's “cannot start a transaction within a
transaction” and a UNIQUE-constraint double-INSERT on a missing-date upsert).
Private unlocked read helpers avoid nested-lock deadlocks; a rejected
operation does not poison the queue.

**Close is part of the same queue** (both adapters): `close()` is enqueued
BEHIND every already-queued operation (an in-flight lock drains first) and
memoized — every sequential/concurrent caller shares the exact same promise;
once close starts, new `withLock` operations REJECT immediately without
executing; a failed close replays its rejection to every later caller (no
retry); a completed close is never re-run. The migration-failure bootstrap
close path is preserved.

### Full app-schema validation (fail closed before routes)

`openAppDatabase` runs **`validateAppSchema`** AFTER migrations and BEFORE any
service/routes are exposed: a database whose recorded `schema_metadata`
version is current must still carry the expected table structure, so a
half-migrated/altered store (or a hand-crafted DB merely claiming v2) can
never reach routes. Checks are semantic `PRAGMA table_info` comparisons
(portable on both adapters): each expected table must exist as a REAL table
(not a view) with exactly its expected columns in order, declared type, NOT
NULL, and PRIMARY KEY — matching the current v2 layout
(`schema_metadata`, `journal_entries`, `settings`; TEXT primary keys report
`notnull=0` in SQLite unless declared NOT NULL, and the spec matches the
engine). SQLite internal tables/indexes and unrelated future tables are not
rejected. Corruption rejects, closes the connection, and performs zero
writes/deletes. An optional `PRAGMA quick_check` integrity scan is supported
but OFF by default (native-plugin portability unverified on device); the
structural contract is proven deterministically on both adapters.

**Stored journal data is validated the same way, at the same gate**: after
schema validation (and stored-settings validation), `openAppDatabase` scans
ALL existing journal rows with the public `journal.list()` before the handle
is returned. `list()` runs every row through the shared-schema stored-row
decoder (date, content, and the `created_at`/`updated_at` timestamps), so
one corrupt date/content/timestamp row rejects bootstrap, the connection is
closed exactly once, the corruption error is preserved as `cause`, and the
bootstrap itself performs zero writes. `list()` acquires the queue lock at
the top level (bootstrap is not inside another locked service call), so the
scan cannot nested-deadlock. A valid store opens normally; a corrupt store
fails closed with the non-destructive startup message.

### API-24 / WebView legacy bundle (`@vitejs/plugin-legacy`)

Capacitor 8's `Bridge.DEFAULT_ANDROID_WEBVIEW_VERSION` is **60**
(`MINIMUM_ANDROID_WEBVIEW_VERSION` is 55). A module-only Vite output uses
`<script type="module">` plus modern syntax that Chrome/WebView 60 cannot
parse, so the app would render nothing on that floor. The Android workspace
added `@vitejs/plugin-legacy@8.2.3` (peer `vite ^8.0.0`, verified against the
installed Vite 8.2.2) plus its required `terser` peer, and the Vite config now
emits BOTH the modern module bundle AND a `<script nomodule>` legacy bundle
transformed down to **`chrome >= 60`** — the exact Capacitor default floor.
Nothing below Capacitor's configurable minimum (55) is claimed to work.

`android/scripts/verify-legacy-build.mjs` is a **pure reader** (it never runs
vite/vitest) that fails the build if `dist/index.html` lacks the nomodule
legacy entry/polyfills or the `-legacy-` artifacts. It is part of the
canonical `build` gate (`vite build && verifier`) AND the `cap:sync` package
script runs it on the **current** `dist` immediately before `cap sync
android`, so every package-script sync (`bun run cap:sync` / root
`android:sync`) copies only verified output into the native assets; the raw
`cap sync android` CLI alone performs no verification and is not claimed as a
safe copy path.

### Error-cause preservation

The migration wrapper (`migrations.ts`) and the bootstrap migration-failure
wrapper keep the user-safe fail-closed messages but now attach the EXACT
underlying error as `{ cause }` (nested where applicable — bootstrap →
migration wrapper → engine error); stored-settings corruption wrapping remains
clear and cause-preserving (corrupt-settings error names the key, with the
field-validation error as its cause), and stored-journal corruption wrapping
keeps the same discipline (a generic `Corrupt journal entry` message — never
echoing stored content — with the shared-schema validation failure as its
cause; stored-timestamp failures name only the stored value's type before
wrapping, so the raw timestamp is never echoed either).

### Native bootstrap and fail-closed gate

- `main.tsx` mounts an `AppBootstrap` gate with `attemptNative =
  Capacitor.isNativePlatform()`. Native: open + migrate **before** any route
  renders, then expose the handle through a `StorageProvider` context.
- Non-native (web/test/dev): storage is not attempted at all — the shell
  renders, but there is **no browser persistence substitute**; screens that
  need storage fail closed.
- Open/migration failure renders a clear, non-destructive startup screen
  ("nothing was deleted or reset") instead of the app.
- `initDatabase` is a process-wide singleton: repeated calls reuse one
  connection, avoiding duplicate plugin-connection errors (including under
  React StrictMode's double effect run). `AppBootstrap` accepts an injectable
  `initializer` defaulting to `initDatabase`. It is the **sole**
  `StorageProvider` — `App.tsx` renders none, so App-alone renders honestly
  read the context default `null`.
- `openNativeDatabase` reconciles stale native registrations via the owning
  manager's `checkConnectionsConsistency()` **before** `createConnection` on
  every open, so a leftover native registration cannot collide with the fresh
  create. A resolved `false` (native inconsistencies were closed/reset) is
  safe to proceed; a thrown check fails closed BEFORE any `createConnection`
  registers anything. Open-failure cleanup and owning-manager close semantics
  are preserved.

### Phase 4 handoff and outcome

All Phase 3 plaintext content was transitional **test/service data only** —
there was no editor or user-facing journal write path. Phase 4 has now replaced
the production open contract with SQLCipher whole-database encryption before
Phase 5: fresh/already-encrypted databases use mode `secret`; existing Phase 3
plaintext databases use mode `encryption`; the random passphrase is stored
through the plugin's Android Keystore-backed encrypted preferences. Missing
key state fails closed. ADR-0005 owns the current encryption decision; this
ADR's plaintext statements remain historical Phase 3 evidence, not the current
production contract.

## Consequences

- Real SQLite behavior is exercised in CI-style Vitest runs via `node:sqlite`
  with zero added DB dependency; production uses the real native plugin.
- Migration safety is fail-closed by construction: future/gap/corrupt schema,
  SQL failure, and off-platform open all reject with prior state intact.
- The `transaction=false` discipline is mandatory — forgetting it nests
  transactions inside the plugin's implicit ones and breaks explicit control.
- v1 journal + v2 settings prove both the 0→latest and N→N+1 paths; adding a
  v3 later is a single contiguous entry in `DEFAULT_MIGRATIONS`.
- `@capacitor-community/sqlite` and its `jeep-sqlite` dependency are included
  in the Android workspace; the root `bun.lock` remains canonical. `cap sync`
  wires exactly one plugin into the generated native project.
- `@vitejs/plugin-legacy@8.2.3` + `terser` (Android dev deps) add the
  `chrome >= 60` non-module legacy bundle; the canonical `build` gate and the
  `cap:sync` script both verify the current `dist` before it is copied into
  the native project (the raw `cap sync` CLI does not and is not claimed).

## References

- ADR-0001 (Android architecture; SQLite committed, no JS storage).
- ADR-0002 (Capacitor 8 workspace; versions, sync).
- ADR-0003 (shared `@rememberme/core`; reused for journal schemas and
  timezone validation).
- Porting plan: `android/docs/porting-plan.md` Phase 3; Phase 4 encryption
  contract handoff.
