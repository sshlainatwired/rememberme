# RememberMe — Android Porting Plan (Phase 0)

Status: **Phases 0–9 complete; Android port FINAL COMPLETE / CLOSED**
Last updated: Phase 9 final closure — Android 744/744, core 104/104, root 169/169, host-JVM JUnit 87/87, debug and unsigned release APKs assembled; canonical matrix retained at `/tmp/rememberme-phase9-final-gates.log`
Owner: RememberMe maintainers / Android port implementer

This plan is also the final closure record. Phase 4 selected the pinned
Capacitor SQLite plugin's **SQLCipher whole-database encryption** with its
Android Keystore-backed secure store; ADR-0005 records the decision. Phases 6–8
ship local weekly review/notifications, encrypted backup/legacy migration, and
optional device-credential key protection. Phase 9 adds the independent
Android CI gate, user/build documentation, final reviews, and release decision.
All ten phases are implemented and closed.

---

## 1. Goal

Add an **offline static Vite + React + Capacitor** Android app to the existing
`rememberme` repository. The existing **Astro web app keeps its UI and product
behavior**; only the plan-sanctioned shared-core seams and their callers change.

The Android app **MUST** include, as non-optional scope:

- **Local weekly notifications** (on-device, Sunday-evening reminder) and an
  **in-app Weekly Review** screen (Phase 6) — the Android equivalent of the
  web's email digest, delivered locally, never via SMTP.
- **Encrypted backup/restore** (versioned `.rmbak`, password-protected) and
  **legacy migration** (import existing web-DB encrypted data) (Phase 7) —
  **shipped and closed**.
- **Optional biometric / device-credential unlock** layered over the on-device
  key (Phase 8) — **shipped and closed**.

Crypto selection is resolved in ADR-0005; the capabilities above remain
committed with the safe directions in Sections 5, 6, 7, and 11.

---

## 2. Baseline (measured Phase 0)

Environment: `main` at `/Users/lain/Projects/rememberme`; Bun CLI 1.4.0,
workspace package-manager pin `bun@1.4.2` (updated in Phase 9 to match the committed lockfile v2 format).

### 2a. Command results

| Step | Command | Result |
| --- | --- | --- |
| Install | `bun install --frozen-lockfile` | NOT RUN (not passed) |
| Lint | `bun run lint` (`biome check src tests scripts`) | Pass; 43 files checked, 0 errors |
| Typecheck | `bun run typecheck` (`astro check && tsc --noEmit`) | Pass; 56 files, 0 errors, 0 warnings, 12 hints |
| Test | `bun test` | Pass; **55 tests** / 5 files, 0 fail |
| Build | `bun run build` (`astro build`) | Pass; server build into `dist/` |

Pre-existing typecheck hints (not errors; web app untouched): deprecated
`FormEvent` in `SettingsForm.tsx` (3×); unused `i` in `archive.astro`; unused
`today` in `journal/index.astro` and `journal/today.astro`; no-effect `await`
on `encryption.test.ts` rejects (7×).

### 2b. Git baseline (precise)

- Before Phase 0: branch `main` at `origin/main` (c97a56b). **No tracked or
  staged changes.**
- Pre-existing untracked file: `spec.md` (untracked before Phase 0; preserved
  untouched — Phase 0 never reads or edits it).
- Phase 0 additions: `android/docs/porting-plan.md`,
  `android/docs/reuse-matrix.md`, `android/docs/adr/0001-android-workspace.md`
  — **new untracked files only**. No commits were made; `git status` after
  Phase 0 shows only `?? android/` and the pre-existing `?? spec.md`.

### 2c. Repository / dependency map

`package.json` deps (all web-side, unchanged): Astro 7 SSR (`astro@^7.1.6`,
`@astrojs/node` standalone adapter), `hono@^4.7.9`, `@libsql/client`,
`drizzle-orm@^0.45.2` + `drizzle-kit`, `better-auth@^1.3.3`, `zod@^4.0.6`,
React 19 + `@astrojs/react`, Radix UI primitives, Tailwind v4 +
`@tailwindcss/vite`, `tailwind-merge`/`clsx`/`class-variance-authority`,
`lucide-react`, `sonner`, `luxon@^3.6.1`, `nodemailer@^9.0.3`, `sharp@^0.35.3`
(override). Dev: `typescript@^6.0.3`, `@biomejs/biome@^2.5.7`,
`@astrojs/check`, `@types/*`.

DB: SQLite via libSQL/Turso (`DATABASE_URL=file:./data/rememberme.db`),
Drizzle schema, one committed migration **`drizzle/0000_worthless_spot.sql`**
(SQL lives in `drizzle/`); **Drizzle metadata lives in `drizzle/meta/`**
(`_journal.json`, `0000_snapshot.json`). Runtime DB file `data/rememberme.db`.

### 2d. Workspace map (source layout)

```text
src/
  middleware.ts                 # Astro middleware: /api delegation + session
  pages/                        # setup, login, journal/[date], archive, settings
  components/                   # React islands + shadcn-style UI + layouts
  server/
    config.ts                   # Zod-validated env (fail fast)
    auth.ts                     # Better Auth instance
    crypto/                     # AES-256-GCM (WebCrypto) + key validation
    db/                         # schema, client, repository queries
    api/                        # Hono app + routes
    jobs/                       # weekly digest scheduler (web-only)
    mail/                       # SMTP mailer + digest email builder
  shared/schemas/               # Zod schemas shared by server and client
scripts/migrate.ts              # standalone migration runner (reads drizzle/)
drizzle/                        # 0000_worthless_spot.sql + meta/
tests/                          # 55 tests
```

### 2e. Source → role map

| Module | Kind | Role |
| --- | --- | --- |
| `server/crypto/key.ts` | crypto | base64 ⇄ bytes, key validation |
| `server/crypto/journal-encryption.ts` | crypto | AES-256-GCM encrypt/decrypt (WebCrypto), cipher factory |
| `server/db/schema.ts` | DB | SQLite tables: Better Auth's `user`/`session`/`account`/`verification` + app tables `journal_entries`/`settings`/`digest_deliveries` (no separate "auth" table) |
| `server/db/client.ts` | DB | libSQL client factory |
| `server/db/repo.ts` | DB | repository queries (get/upsert/delete entry, settings, digest) |
| `server/config.ts` | env | Zod-validated env |
| `server/auth.ts` | auth | Better Auth instance + session helper |
| `server/api/…` | API | Hono routes: setup/login/logout, journal, settings, digest |
| `server/jobs/weekly-digest.ts` | digest | week math (pure) + scheduler + SMTP delivery (web-only) |
| `server/mail/…` | mail | SMTP + digest email build |
| `server/timezone.ts` | util | timezone-aware "today" + day formatting |
| `shared/schemas/*` | schemas | Zod: auth, journal, settings |
| `pages/*` | UI (server) | Astro SSR pages |
| `components/*` | UI (client) | React islands: forms, editor, sidebar, settings |
| `styles/global.css` | UI | Tailwind/global styles |

### 2f. CI / workflow inventory (Phase 9 implemented)

The Android CI job is implemented as an independent job in the existing CI
workflow. Existing web gates, publishing behavior, audit cadence, and
Dependabot scope remain intact:

| Workflow | Current Phase 9 state |
| --- | --- |
| `.github/workflows/ci.yml` | Existing root lint/typecheck/build and unit-test jobs are unchanged. The Android job uses the frozen root lockfile, JDK 21, SDK 36, scoped lint/typecheck/test/build, verified `cap:sync`, tracked Capacitor-file freshness, host-JVM tests, and debug plus unsigned-release APK assembly; successful APKs are retained as CI artifacts. |
| `.github/workflows/dep-audit.yml` | `bun audit --audit-level=high` covers the canonical root `bun.lock`, including Android workspace dependencies; weekly cron and dispatch remain. |
| `.github/workflows/dependabot-lockfile.yml` | Root `bun.lock` regeneration already covers Android manifest changes because Android dependencies use the root lockfile (ADR-0002). |
| `.github/workflows/docker-publish.yml` | Unchanged: publishes only the web Docker image. Android CI artifacts are not published releases. |
| `.github/workflows/semgrep.yml` | The existing repository-wide `p/default` PR/nightly scans already include Android TypeScript and Java; Phase 9 makes that scope explicit without narrowing paths. |
| `.github/dependabot.yml` | The root npm ecosystem already covers workspace manifests and the canonical lockfile; GitHub Actions and Docker update groups remain. |

Legacy export is a **manual server-side script (Phase 7, §7b)** — not a CI
workflow — so it implies no workflow change (the Android side only parses the
exported file).

---

## 3. Target architecture

Preferred layout: a top-level **`android/`** workspace hosting the Capacitor
project, with the **generated native Android project nested at
`android/android/`** (`npx cap add android`). Both production targets live in
one repo; the Vite build and the native shell stay cleanly separated.

```text
android/                         # NEW — Capacitor + Vite + React project root
  package.json                   # its own manifest (Vite + React + TS + Capacitor 8.x); deps in the canonical root bun.lock (ADR-0002)
  src/                           # React app source (adapted from web client)
  vite.config.ts  vitest.config.ts  index.html  tsconfig.json
  capacitor.config.ts
  android/                       # NATIVE Android project — first-class source (commit-ready; tracked on commit)
    app/src/main/                #   manifest, MainActivity, res/ (first-class source)
    app/build.gradle  settings.gradle  gradle.properties
  docs/                          # porting plan, reuse matrix, ADRs
    adr/0001-android-workspace.md
```

The repo root (Astro web app) is **unchanged**; `android/` is additive. No
competing package-manager/build-orchestrator stack is introduced: **no pnpm,
yarn, Nx, or Turbo** — Bun remains the single package manager (web + android),
per ADR-0001.

### 3a. Native source (first-class) vs ignored artifacts

Native **source** (first-class, per ADR-0001; commit-ready and **must be
tracked when the Android work is committed**): `android/android/app/src/**`
(manifest, `MainActivity`, `res/`), `android/android/*.gradle`,
`settings.gradle`, `gradle.properties`, `gradle/` wrapper
(`gradlew`, `gradle/wrapper/**`), `capacitor.config.ts`,
`android/package.json`. (Since Phase 1 the root `bun.lock` is the canonical
lockfile for android deps too — ADR-0002; there is no `android/bun.lock`.)

The whole `android/` tree — native project included — is **currently
untracked**, part of the working-tree implementation; committing the
Android changes is what brings this first-class source under version
control.

**Ignored / generated artifacts** (never committed — **enforced now in the
root `.gitignore`, Phase 0**, with precise patterns; the included
`android/android` native source is never ignored): `android/node_modules/`,
`android/dist/`, `android/coverage/`, `android/android/.gradle/`,
`android/android/**/build/`, `android/android/local.properties`
(machine-specific SDK path), signing secrets (`*.jks`, `*.keystore`,
`keystore.properties`, `signing.properties`),
`android/android/capacitor-cordova-android-plugins/` (regenerated by
`cap sync`), logs.

### 3b. Android-scoped commands and CI/native gates

Root commands are the **Astro web workspace's** commands; they do **NOT**
cover Android. Do not imply otherwise:

- Root: `bun run lint`, `bun run typecheck`, `bun run build` → web only
  (Astro). Root `bun test` runs the 65 web tests **and**, since Phase 2, also
  discovers the 104 shared-core tests in `packages/rememberme-core` (169
  total); Android's `*.vitest.*` suite stays isolated (see below).
- Android gets its own scoped scripts in `android/package.json`, invoked as
  `bun run --cwd android <script>` (or equivalent):
  `lint`, `typecheck`, `test`, `build` (Vite build + legacy verifier),
  `cap:sync` (verified-dispatch to `cap sync android`), and `android:add`
  (`npx cap add android`). Its test
  suite runs only under `bun run --cwd android test` — `vitest`'s explicit
  include (`src/**/*.vitest.{ts,tsx}` in `android/vitest.config.ts`, not
  `vite.config.ts`) keeps it out of the root Bun run.
- Native/Gradle gates: `cap:sync` freshness (the
  **package script** runs the pure-reader legacy verifier on the current
  `dist` and fails before `cap sync android` if the output fails the legacy
  contract — so only verified output is copied into the native project).
  The Phase 9 Android CI job then checks tracked generated Gradle files, runs
  host-JVM tests, assembles debug and unsigned release APKs, and retains those
  APKs as non-published build artifacts. Root web jobs remain separate.

### 3c. Capability split (web vs Android)

| Capability | Web (unchanged) | Android (new) |
| --- | --- | --- |
| Auth (setup/login/session) | Better Auth | On-device auth (Phase 5) + optional native key unlock (Phase 8) |
| Journal CRUD | Hono API + Drizzle | On-device SQLite repo (Phase 3) inside SQLCipher (Phase 4) |
| Encryption | WebCrypto AES-256-GCM server-side | SQLCipher whole-database encryption; random passphrase in plugin Keystore-backed secure preferences (Phase 4) |
| Weekly digest | Email job + Nodemailer | **Local weekly notifications + in-app Weekly Review** (Phase 6) |
| Backup / migration | n/a (web is data source) | **Encrypted `.rmbak` backup/restore + legacy migration** (Phase 7) |
| Biometric unlock | n/a | **Optional biometric / device-credential unlock** (Phase 8) |
| Timezone/"today" | `server/timezone.ts` (luxon) | Share timezone primitives; Android-specific settings schema |

---

## 4. Reuse summary

Full per-item matrix is in `reuse-matrix.md`. High-level classification
(**kept strictly consistent with the matrix** — KEEP/SHARE/ADAPT agree between
the two docs):

- **KEEP (copy verbatim)**: `lib/utils.ts` (`cn`) only among the named UI
  helpers.
- **SHARE (single source, imported by both builds)**: the canonical
  `packages/rememberme-core/src/{journal,timezone,calendar,weekly}.ts` modules.
  The web `src/shared/schemas/journal.ts` and `src/server/timezone.ts` files are
  compatibility seams that delegate to `@rememberme/core`, not shared source
  files themselves. `shared/schemas/settings.ts` is **NOT** verbatim-shared —
  see ADAPT and §8 item 2.
- **ADAPT**: semantic button/card primitives; native input/label/checkbox
  controls in place of the shadcn/Radix input/label/switch/dialog layer;
  direct semantic `SaveStatus` rendering; `JournalEditor`, `Sidebar`, auth
  verifier/service/forms/session gate, archive/week-grid logic,
  `styles/global.css`, and `shared/schemas/settings.ts` → **Android-specific
  settings schema** (weekly-review enabled/time, biometric/security,
  backup/restore, appearance; no email/digest-schedule/no server-password),
  built on the shared timezone primitives.
- **REWRITE**: `server/db/*` (on-device **SQLite** — see Phase 3; JS storage
  is not an allowed substitute), `server/crypto/*` (on-device crypto — Phase
  4), and API routes → local repository service.
- **ANDROID-NOT-NEEDED**: `middleware.ts`, `server/api/*`, `server/mail/*`,
  `server/jobs/weekly-digest.ts` (the scheduler/SMTP/digest-email module is
  not shareable — its **pure calendar/week/content model is extracted into a
  platform-neutral, tested module** instead), `server/auth.ts`,
  `server/config.ts`, `server/db/client.ts`, Astro pages/layouts,
  `scripts/migrate.ts`, `drizzle/`.

---

## 5. Phased plan (10 phases, as supplied)

- **Phase 0 (done)**: baseline measurements, this plan, `reuse-matrix.md`,
  ADR-0001. Process gates defined below.
- **Phase 1 — Scaffold**: create `android/` (Vite + React + TS) +
  `capacitor.config.ts`. **Pin `@capacitor/core`, `@capacitor/cli`,
  `@capacitor/android`, and every official `@capacitor/*` plugin used to the
  compatible **8.x** major** (same 8.x line across all of them; Capacitor 9
  alpha at `/docs/next/` is out of scope). After any dep/plugin change,
  **`bun run --cwd android cap:sync` (the verified package script, Section 3b)
  is required** before native builds — it re-verifies the current `dist` legacy contract,
  then runs `cap sync android`. Verify `vite build`
  and `npx cap add android` produce a runnable shell at `android/android/`;
  wire scoped scripts (Section 3b); define the Android CI job skeleton.
  Decide shared-module extraction (package vs copy+sync test).
- **Phase 2 — Shared core**: extract a dependency-free shared module for Zod
  schemas + timezone primitives + pure calendar/week/content model (below),
  imported by both builds; stand up the local service layer mirroring web API
  contracts.
- **Phase 3 — SQLite**: wire the **on-device SQLite** storage layer (Capacitor
  SQLite / `@sqlite` plugin). **This is the storage decision: SQLite only —
  JS storage (localStorage/IndexedDB) is not an allowed substitute.**
  Replicate repository logic (get/upsert/delete entry, list dates, settings)
  on SQLite, with the **versioned schema migration strategy in §5b**.
- **Phase 4 — Encrypted storage (FINAL COMPLETE — implementation +
  crash-recovery and closure fix passes done; two fresh independent Terra
  reviews returned exact `PERFECT`)**: use the pinned Capacitor
  SQLite plugin's native SQLCipher path for the whole database; generate one
  random 32-byte passphrase and store it through the plugin's Android
  Keystore-backed encrypted preferences; convert existing Phase 3 plaintext in
  mode `encryption`; fail closed on missing keys and malformed native probes.
  Because the upstream conversion deleted the plaintext original before
  renaming (process-death data loss), the pinned 8.1.1 native Android module
  is vendored under `android/android/vendor/capacitor-community-sqlite/`
  with a deterministic crash-safe conversion (`.encrypting`/`.plain.bak`,
  checked renames + rollback, candidate fsync inside `commit()` via the
  injectable FileOps seam before any rename, sidecar cleanup, pre-probe
  recovery); the app-owned settings.gradle projectDir override after
  `capacitor.settings.gradle` supersedes the generated include. The vendored
  module at Phase 4 closure matched installed upstream except four patched
  files (`UtilsSQLCipher.java`, `CapacitorSQLite.java`, `UtilsSecret.java`,
  `Database.java`) plus `EncryptionFileSwap.java`; Phase 8 later adds the
  documented `CapacitorSQLitePlugin.java` patch and native key-protection
  helpers/tests. The live vendored-source contract enforces the current exact
  patch set. ADR-0005 records
  rejected alternatives, the state protocol, the process-death guarantee and
  its API-24 power-loss boundary (rename ordering is not durable across power
  loss without a directory fsync; ambiguous states fail closed, data
  preserved), and the Phase 7 import-only WebCrypto compatibility proof.
  Closure fix passes hardened the vendored module: a checked synchronous
  `SharedPreferences.commit()` for the passphrase (`.apply()` absent),
  fail-closed disabled `UtilsSQLCipher.decrypt` (and `Database.open` rejects
  decryption mode before file mutation), an injectable `FileOps`
  rename/delete/fsync/exists seam driving same-package JUnit4 fault tests,
  and manifest backup/transfer exclusions (`allowBackup="false"`,
  `fullBackupContent="false"`, `dataExtractionRules` excluding
  root/database/sharedpref/external); recovery promotions are fsync-first —
  every `recover()` `.encrypting`→main branch routes through one private
  `promoteRecoveryCandidate` helper that calls `ops.fsync(tmp)` (same seam)
  before any delete/rename, so an unflushed crash candidate is durable
  before promotion; the app route contract keeps the
  `/weekly` route withheld until Phase 6. Native SQLCipher runtime
  verification still requires a device. The host-JVM JUnit4 recovery suites
  (`EncryptionFileSwapTest` 21 + `EncryptionFileSwapFaultsTest` 8) now compile
  and pass under the Phase 8 user-scoped toolchain.
- **Phase 5 — Journal UX (FINAL COMPLETE/CLOSED after fix10; both canonical
  current Terra closure reports are exact standalone `PERFECT`; pre-fix10 reports
  are stale)**: the Android app now
  has native-HTML setup/login gates over a strict local PBKDF2 verifier and an
  in-memory session, while the password remains completely separate from the
  Phase 4 SQLCipher key. Schema v3 adds the singleton `local_auth` row;
  bootstrap validates schema, settings, all journal rows, and auth before
  exposing routes. The journal surface includes saved-timezone Today routing,
  an 800 ms debounced/latest-value-serialized editor with 5-second retry and
  delete-on-empty behavior, week markers, a bounded Monday-first archive grid,
  appearance synchronization, and an Android-specific Settings form. Android
  uses native HTML controls and plain semantic CSS with a Chrome/WebView-60
  output verifier instead of the web Radix/Tailwind v4 control layer. Offline
  and phase-boundary tests keep network/remote resources, `/weekly`,
  notifications, backup/restore, and biometric behavior out of this phase.
  The final implementation suite reached 524/524 across 33 files, superseding
  the historical 498/498 Task 10 count. Fix10 closure evidence is recorded in
  `/tmp/phase5-task12-fix10-gates.log`. Gradle and host-JVM JUnit were later
  unblocked in Phase 8; device and visual checks remain unclaimed.
- **Phase 6 — Notifications + Weekly Review (FINAL COMPLETE / CLOSED)**: implementation and permitted local verification are complete; the final Phase 6 snapshot Android suite passed 589/589 and two independent closure reports ended with exact standalone `PERFECT`. Native compilation and host-JVM tests were later unblocked and fixed in Phase 8; device prompt/notification, visual, and assistive gates remain unclaimed. See `.superpowers/sdd/porting-plan/phase6-report.md`.
- **Phase 7 — Backup/migrate + restore (FINAL COMPLETE / CLOSED)**: encrypted
  `.rmbak` backup/restore and legacy migration are implemented and closed per
  Section 7, including the web-side export command/script (§7b transport,
  produced by the user on the server, ciphertext-only, no key/plaintext), the
  `JOURNAL_ENCRYPTION_KEY` import contract with full pre-write validation and
  transactional rollback, and the SAF-based password/key-gated flows in
  Settings. Final evidence: Android 668/668 across 47 files, core 104/104,
  root 169/169, canonical matrix retained at
  `/tmp/rememberme-phase7-final-gates.log`; native JDK/SDK/device + host-JVM
  JUnit4 gates were blocked at that closure. The Phase 8 toolchain later
  unblocked Gradle/JUnit; device behavior remains unclaimed. See
  `.superpowers/sdd/porting-plan/phase7-report.md`.
- **Phase 8 — Device key protection (FINAL COMPLETE / CLOSED)**: optional
  biometric/device-credential authentication now moves the unchanged SQLCipher
  passphrase between distinct native encrypted stores. Native mode is
  authoritative before SQLite opens; API 24–29 uses `KeyguardManager`, API 30+
  uses strong biometric or device credential; cold-start authentication opens
  the validated in-memory local session without a second password prompt.
  Crash-state, malformed bridge, key-loss, retry, stale-owner, logging, and
  Phase 7 isolation regressions are covered. ADR-0009 records the decision.
  Final evidence: Android 738/738, core 104/104, root 169/169, host-JVM JUnit
  87/87, Gradle compile + debug APK assembly, audit, build, verified sync, and
  diff checks pass; log `/tmp/rememberme-phase8-final-gates.log`. See
  `.superpowers/sdd/porting-plan/phase8-report.md`.
- **Phase 9 — CI + docs (FINAL COMPLETE / CLOSED)**: the independent Android
  CI job runs scoped lint/typecheck/test/build, `cap:sync` freshness through the
  **verified package script**, host-JVM tests, and Gradle
  `assembleDebug`/`assembleRelease`; it retains exact unsigned APK artifacts
  without publishing and disables checkout credential persistence. README and
  architecture documentation are current. Final evidence: Android 744/744,
  core 104/104, root 169/169, host-JVM JUnit 87/87, dependency audit, verified
  sync, debug + unsigned-release assembly, diagnostics, and diff checks pass;
  log `/tmp/rememberme-phase9-final-gates.log`. Five external Mentor attempts
  returned no artifact, so no external verdict is claimed; two explicit final
  fallback review tracks returned `PERFECT`. The release decision is no tag,
  signing, publication, or store upload without separate approval and the
  documented signing/legal/device gates. See
  `.superpowers/sdd/porting-plan/phase9-report.md`.

### 5a. Mandatory process gates — Terra loops (every phase)

Every phase, including Phase 0 and Phase 9, must run the verification process
below; a phase is complete only when it passes the exact PERFECT gate.

1. **Two mandatory, independent Terra review loops** — each phase runs two
   separate Terra review passes, performed independently (not chained from a
   single instance), covering the phase's deliverables: correctness,
   security-conscious design, and consistency with these docs.
2. **Exact PERFECT gate** — a phase may proceed only when **both** loops
   return the **exact verdict `PERFECT`**. Any other verdict (any finding, at
   any severity) means the phase is not complete.
3. **DeepSeek fix loop** — findings from either Terra loop are fixed in a
   dedicated DeepSeek fix pass; after the fixes, **both Terra loops re-run**.
   Iterate (Terra → DeepSeek fix → Terra) until both loops return `PERFECT`.
4. **Final global Terra review** — at overall program closure, run one final
   global Terra review across all phases and all Phase 0 docs (accuracy vs these
   requirements, no open product questions, cross-doc consistency). The
   overall effort is DONE only when that review also returns exactly
   `PERFECT`.

Phase 9 execution note: five configured Mentor attempts across two model
providers completed without returning any conversation or artifact. No Terra
or Mentor verdict is attributed to those attempts. Following the Phase 8
closure precedent, two explicit same-snapshot coordinator fallback tracks
covered CI/spec correctness and security/global consistency; both ended with
standalone `PERFECT`. The attempts and fallback evidence are retained under
`.superpowers/sdd/phase9-plan/`.

Verification gates per phase (technical): Phase 1 `vite build` + `cap add
android`; Phase 3 SQLite round-trip offline; Phase 4 crypto round-trip /
tamper / wrong-key / key-loss; Phase 5 offline journal UX; Phase 6
notification fires at configured Sunday/hour + Weekly Review rendering (incl.
empty days); Phase 7 backup restores identically + legacy data imports with
rollback verified; Phase 8 biometric/device-credential unlock + key stays
secure. Host-JVM JUnit and debug APK assembly now pass locally; real prompt,
Keystore invalidation, OEM/API, visual, and assistive verification remain
device-lab operational gates, not future product phases.

### 5b. SQLite schema migration strategy (Phase 3)

Versioned, non-destructive, forward-only migrations on the on-device SQLite
store:

- **Version tracking**: a `schema_metadata` table (or `PRAGMA user_version`)
  stores the current schema version; the recorded version is bumped
  transactionally with each applied migration.
- **Ordered, transactional, forward-only**: migrations are an ordered list of
  versioned, idempotent steps; each step runs in a transaction that both
  applies the schema change and records the new version atomically. Only
  forward migrations exist — no downgrade path, **no destructive reset**, no
  data wipe on upgrade.
- **Deterministic, idempotent startup**: on every startup the store applies
  exactly the pending migrations (recorded version < target schema version);
  a completed migration is never re-applied, and the resulting schema is
  deterministic across runs and devices. Startup is safe to run repeatedly
  (crash between steps leaves a consistent prior version, re-run resumes).
- **Failure semantics — fail closed**: if any step fails, its transaction
  rolls back and the prior DB version stays **intact**; the app refuses to
  run against a half-migrated schema (fails closed) rather than serving a
  mismatched store. A corrupt/unreadable store fails closed with a clear
  error.
- **Unversioned-store preflight**: before creating version metadata, reject
  any object already present in `sqlite_master` under an exact app-reserved
  name (`schema_metadata`, `journal_entries`, or `settings`; including a view,
  not only a table), without starting a transaction or writing. This
  distinguishes a truly fresh store from damaged prior app state.
- **Prior-version schema validation**: before each pending production
  migration starts, validate the recorded version's expected table shapes.
  A malformed prior schema rejects before transaction/write so migration
  cannot commit new DDL or a version bump over corrupt state.
- **Backup guardrail**: before any **risky future migration** (destructive or
  large rewrite), a pre-migration `.rmbak` backup (Phase 7) is required where
  applicable, so the prior DB can be recovered.
- **Compatibility / upgrade tests**: required coverage — fresh install
  (0 → latest), migrated install (N → N+1), migration failure (rollback
  leaves prior DB intact / fails closed), and restart-after-migration
  (idempotent, no re-apply); plus a fresh-vs-migrated schema equivalence
  check.

---

## 6. Notifications + Weekly Review plan (Phase 6)

- **Permission UX**: request `POST_NOTIFICATIONS` at runtime in context (first
  enabling weekly review), explain the value, handle denial without blocking
  the app, and guide the user to system settings for re-enabling. Permission
  status shown in Settings.
- **Channels**: create a dedicated notification channel (e.g.
  `weekly_review`); channel importance/config is fixed at first creation;
  changes require re-creating the channel (or OS reinstall) — design channel
  attributes up front.
- **Schedule**: best-effort / **inexact** scheduling (`setInexactRepeating` /
  `setAndAllowWhileIdle` window around the configured Sunday + hour); do
  **NOT** request `SCHEDULE_EXACT_ALARM` (or the user-grantable exact-alarm
  permission). Document that exact fire time is not guaranteed on modern
  Android; the app also shows the review in-app so a missed/early
  notification is not data loss.
- **Doze / app standby**: inexact alarms are deferred in deep Doze; handle
  catch-up (on next app foreground, refresh/emit the review if due and not
  yet shown), no wake locks, no background-network requirements.
- **Cancellation / reschedule / idempotency**: any settings change
  (enable/disable, time, hour, timezone) cancels the existing schedule and
  reschedules; scheduling is idempotent (one stable alarm per app, keyed
  request code derived from a fixed id, not from wall-clock values).
- **Reboot**: alarms are cleared on reboot — register `BOOT_COMPLETED`
  (`RECEIVE_BOOT_COMPLETED` permission) and reschedule on boot.
- **Timezone / DST**: listen for `TIMEZONE_CHANGED` (and ACTION TIME_SET /
  DST change) and recompute the next occurrence in local time; recompute on
  app launch too.
- **App upgrade**: alarms and channel survive upgrades; keep request codes /
  channel / notification IDs stable; on first launch after upgrade verify the
  schedule is still correct and reschedule if version changes affected it.
- **Tap → deep link**: tapping the notification opens the in-app **Weekly
  Review** screen via a deep link (deeplink route, e.g.
  `rememberme://weekly-review` or equivalent Capacitor app URL); handle cold
  start (navigate after boot, not only when already foregrounded).

Weekly Review content: Monday–Sunday, "No entry." for empty days, count of
entries — reused from the **extracted pure calendar/week/content model**
(§8 item 3), not from the web email builder.

---

## 7. Backup / restore + legacy migration (Phase 7 — FINAL COMPLETE / CLOSED)

### 7a. Encrypted portable backup (`.rmbak`)

- **Format**: single-file archive named `*.rmbak` with a **format `version`
  field** in the header; restore rejects unknown/newer versions with a clear
  message.
- **Authenticated encryption / integrity**: encrypted with authenticated
  encryption (AES-256-GCM, or encrypt-then-MAC AEAD); integrity is verified
  on restore — a modified/corrupt archive fails validation before any write.
- **KDF**: modern password KDF (**Argon2id** or scrypt) with a **random
  per-archive salt and explicit KDF parameters stored in the archive header**
  (algorithm, params, salt) so restore does not depend on a fixed local
  config. The KDF output protects the archive key.
- **Password never stored**: the backup password is never persisted on
  device and never written into the archive; it is supplied per export/per
  import by the user (and only transiently held in memory).
- **Transactional validation / rollback / conflict**: restore validates the
  entire archive (header version, KDF verifier, AEAD tag, content schema)
  before applying anything; on any failure nothing is written (rollback);
  row/date conflicts apply a documented policy (default: restore overwrites
  conflicting dates after an explicit confirmation; merge is not implicit).
- **New-device portability**: only the `.rmbak` file + the password are
  needed to restore on a fresh device (no dependence on device keys, app data,
  or web env).

### 7b. Legacy migration (web `JOURNAL_ENCRYPTION_KEY` import)

Import of existing web-DB encrypted entries (their `EncryptedJournal` rows)
into the Android local store.

**Transport — offline, server-side export (planned in Phase 7):** the web
side gets a **user-generated, explicit server-side export command/script**
(built in Phase 7; a `scripts/`-style command or equivalent run by the user on
the server) that produces a **documented, versioned export file** containing
the encrypted rows plus dates/metadata — **no key and no plaintext** (each
entry is exactly `{entryDate, encryptedContent, iv, authTag}` + timestamps;
file header carries format version). The user **manually transfers** that file
(USB / file share / cloud copy) and **selects it in the Android app** (file
picker). Android's parser **validates the file** (format version supported,
JSON shape, `YYYY-MM-DD` date bounds, base64 well-formedness, size/row limits)
**before** any import step. This keeps migration **fully offline**: no
permanent network or server dependency on the Android side — the server-side
export is a one-time user action, and nothing in the Android app calls the
server.

Import contract:

- **Source key only during import**: the web `JOURNAL_ENCRYPTION_KEY` is
  requested **only within the import flow**, never stored, never logged, and
  not required at any other time.
- **Verify the key**: validate base64 → exactly 32 bytes (reuse
  `isBase64EncodedKey` semantics) and confirm with a decrypt probe before
  importing.
- **In-memory decrypt, re-encrypt**: rows are decrypted in memory with the
  legacy key and re-encrypted with the **Android** key (Phase 4 crypto), then
  written to the Android SQLite store.
- **Erase the legacy key**: after import completes (success or failure), the
  legacy key is zeroed/erased from memory.
- **Failure handling**: wrong key (GCM auth failure on the probe or first
  row) → clear error, zero data touched; missing/unsupplied key → import
  refused/aborted; corrupt rows or truncated input → per-row validation
  failure with a precise message.
- **Rollback**: import runs transactionally — all rows staged/validated
  before any commit; if any step fails, prior state is preserved (no partial
  import).
- **Tests**: wrong-key, missing-key, corrupt-row, and partial-import
  rollback cases are required test coverage (adapt `tests/encryption.test.ts`
  and `tests/journal-api.test.ts` patterns for the local service).

---

## 8. Reuse-matrix notes (corrections applied)

1. **KEEP/SHARE/ADAPT classifications are consistent between `porting-plan.md`
   §4 and `reuse-matrix.md`** — including semantic button/card, native control
   replacements, and direct `SaveStatus` rendering as ADAPT; the canonical
   `@rememberme/core` journal/timezone/calendar/weekly modules are SHARE, while
   the web journal/timezone wrappers are compatibility seams.
2. **`shared/schemas/settings.ts` is not verbatim-shared**: the two builds
   share only the lower-level timezone primitives (and any pure validators);
   Android defines its **own settings schema** (Section 4) atop them.
3. **The weekly server module (`server/jobs/weekly-digest.ts`) itself is not
   shareable** (scheduler, DB, SMTP, email renderer). Instead, its **pure
   calendar/week/content model** (week-day math incl. Sunday/Monday helpers,
   Monday–Sunday ordering, `DigestDay` date+nullable-content shape) is
   **extracted into a platform-neutral module, after fixing the timezone
   handling** (web code zoned via `setZone("UTC").startOf("day")`; the shared
   model must compute on the caller's local/IANA zone), **tested**, and only
   that extracted module is SHARE (used by Android Weekly Review + notification
   schedule in Phase 6).
4. **SQLite is the Phase 3 storage decision; JS storage is not an allowed
   substitute** (see Phase 3), with the versioned migration strategy in §5b.
5. **Legacy export transport**: the exporter is a **web-side script (Phase 7),
   not part of the Android app** — Android only parses its documented,
   versioned file (offline; §7b). The reuse matrix classifies it
   accordingly; no CI workflow change is involved (§2f).

---

## 9. Risks

- **Crypto-at-rest parity**: legacy rows use WebCrypto AES-256-GCM with
  base64 IV + tag split across three columns. Phase 4 proved that Android can
  read this exact layout; Phase 7 must use it only for import, never persist
  it as the Android at-rest format.
- **Key management**: ADR-0005 selects a random SQLCipher passphrase stored by
  the SQLite plugin in Android Keystore-backed encrypted preferences. Missing
  secure-store state for an existing encrypted database fails closed. Key
  loss remains data loss, mitigated by `.rmbak` backup in Phase 7. Phase 8
  implements optional biometric/device-credential gating by moving the same
  passphrase into a user-authentication-bound native encrypted store; key loss
  still fails closed without replacement or ungated fallback.
- **Shared-module extraction**: shared files must remain dependency-safe or
  the static build breaks. Phase 2 selected the `@rememberme/core` workspace
  package; copy+sync was rejected.
- **Legacy migration integrity**: import depends on reproducing the web's
  encrypted-row format decryptably — gated by the Phase 4 spike and the
  Phase 7 transactional import.
- **Notification reliability**: inexact alarms + Doze mean the notification
  may be late/absent; mitigated by in-app Weekly Review + catch-up on
  foreground. Exact-alarm permission is intentionally not requested.
- **Capacitor version drift**: pin v8 across core/cli/android/all official
  plugins; v9 alpha (`/docs/next/`) is a separate, future upgrade.
- **Android device-lab coverage**: the local and CI OpenJDK 21 / Android SDK 36
  toolchains compile the app/plugin, run host-JVM tests, and assemble debug plus
  unsigned release APKs. No emulator/device result is claimed for system
  prompts, Keystore authorization/invalidation, API/OEM behavior, visuals, or
  assistive technology; those remain operational device-lab gates.

---

## 10. Capacitor references (verified Phase 0)

Current stable: **Capacitor 8** (Active, released 2025-12-08; latest patch
8.5.x). v9 is at `/docs/next/` (alpha) — do not adopt. Compatible-major
direction: **pin `@capacitor/core`, `@capacitor/cli`, `@capacitor/android`,
and all official `@capacitor/*` plugins to the 8.x major**, with `cap sync`
after dependency changes.

Primary official links:

- Docs (v8 current): <https://capacitorjs.com/docs>
- Installing Capacitor: <https://capacitorjs.com/docs/getting-started>
- Environment setup (Android Studio 2025.2.1+): <https://capacitorjs.com/docs/getting-started/environment-setup>
- Using with React: <https://capacitorjs.com/solution/react>
- Development workflow: <https://capacitorjs.com/docs/basics/workflow>
- Upgrade to 8.0: <https://capacitorjs.com/docs/updating/8-0>
- Support policy / version table: <https://capacitorjs.com/docs/main/reference/support-policy>
- Releases: <https://github.com/ionic-team/capacitor/releases>

---

## 11. Recorded directions (no open product questions)

Committed scope with agreed direction; Phase 4 crypto selection is resolved
by ADR-0005:

1. **Android Weekly digest replacement**: local weekly notifications + in-app
   Weekly Review (Phase 6); the web's SMTP digest is web-only and unchanged.
2. **Settings**: Android-specific settings schema (weekly-review enabled/time,
   biometric/security, backup/restore, appearance). No email/SMTP schedule,
   no server password change on Android.
3. **On-device key**: random SQLCipher passphrase stored by the pinned SQLite
   plugin in Android Keystore-backed encrypted preferences; Phase 8 adds an
   optional authentication-bound store selected by native-authoritative mode
   metadata, with no passphrase crossing into JavaScript.
4. **Backup**: versioned `.rmbak`, authenticated encryption, modern password
   KDF with stored salt/params, password never stored, transactional
   validation/rollback + documented conflict policy, new-device portability
   (Phase 7).
5. **Legacy migration**: offline transport via a web-side export command
   (Phase 7) producing a documented versioned file (encrypted rows +
   dates/metadata; no key/plaintext); the Android parser validates the file
   before any import. The legacy key is requested only during import,
   verified, used to decrypt in memory, re-encrypt with the Android key, then
   erased; wrong/missing/corrupt cases + rollback + tests. No permanent
   network or server dependency (Phase 7, §7b).
6. **Native project**: `android/android/` is first-class native source
   (manifest, resources, gradle, plugins, CI) — commit-ready, never
   ignored, and tracked when the Android work is committed (currently
   untracked in the working tree); generated artifacts
   (`.gradle`, `build/`, `local.properties`, keystores/signing secrets)
   ignored (Section 3a).
7. **SQLite only** for on-device storage (Phase 3); JS storage is not an
   allowed substitute.
8. **Shared module**: dependency-free shared zod/timezone/calendar-week
   model (Phase 2), with the pure week model extracted from the (non-shareable)
   weekly server module after the timezone fix.
