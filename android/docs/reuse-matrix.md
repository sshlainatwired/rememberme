# RememberMe — Source Reuse Matrix (Web → Android)

Status: **Phases 0–9 complete; Android port FINAL COMPLETE / CLOSED**
Target: offline static Vite + React + Capacitor Android app
Baseline: 55 tests green, lint/typecheck/build pass on `main`.

All ten phases are implemented and closed. The current reviewed snapshot passes Android 746/746, core 104/104, root 169/169, host-JVM JUnit 89/89, Gradle compile, debug and unsigned release APK assembly, verified sync, audit, and static closure gates. Optional device authentication moves the unchanged SQLCipher passphrase between native encrypted stores; no key enters JavaScript or backups. The Phase 9 Android CI job is implemented and the user/build documentation is current. Real prompt, Keystore invalidation, API/OEM, visual, assistive-technology, release-signing, and store-delivery gates remain explicitly unclaimed.

Classification legend (identical to `porting-plan.md` §4 — the two docs agree
on every item):

- **KEEP** — copy verbatim into the Android app (pure logic / no server deps).
- **SHARE** — single source of truth imported by BOTH the web and the Android
  build (must be dependency-free: zod/luxon only).
- **ADAPT** — copy, then modify for the on-device/Android context.
- **REWRITE** — reimplement against the local store / on-device crypto.
- **ANDROID-NOT-NEEDED** — server/HTTP/web-only; do not port.

---

## 1. Source files

| File | Classification | Notes / adaptation |
| --- | --- | --- |
| `packages/rememberme-core/src/journal.ts` | **SHARE** | Canonical journal schemas and limits imported through `@rememberme/core` by both builds. |
| `src/shared/schemas/journal.ts` | **ANDROID-NOT-NEEDED** | Web compatibility seam that imports/re-exports the canonical `@rememberme/core` journal API; Android imports core directly. |
| `shared/schemas/settings.ts` | **ADAPT** | **Not verbatim-shared.** Only the lower-level timezone primitives/validators are scooped out and shared; Android defines its own settings schema (weekly-review enabled/time, biometric/security, backup/restore, appearance — no email/SMTP schedule, no server password). |
| `shared/schemas/auth.ts` | **ADAPT** | `loginSchema`-style validation reuses; setup/password-change keys move to on-device auth. Zod stays. |
| `packages/rememberme-core/src/timezone.ts` | **SHARE** | Canonical timezone primitives (`todayInTimezone`, `formatDay`) imported through `@rememberme/core` by both builds. |
| `packages/rememberme-core/src/{calendar,weekly}.ts` | **SHARE** | Canonical platform-neutral civil-calendar and week/content models imported by both builds. |
| `src/server/timezone.ts` | **ANDROID-NOT-NEEDED** | Web compatibility seam that delegates to canonical `@rememberme/core` helpers; Android imports core directly. |
| `lib/utils.ts` | **KEEP** | `cn` remains a small copied utility; Android does not depend on Tailwind-generated styling for its semantic UI contract. |
| `components/ui/button.tsx` | **ADAPT** | Kept as a React primitive but rewritten to semantic `.btn` classes; no Tailwind v4 output dependency. |
| `components/ui/card.tsx` | **ADAPT** | Kept as a React primitive but rewritten to semantic `.card` classes. |
| `components/ui/input.tsx` | **ADAPT** | Phase 5 forms use labeled native `<input>` controls with semantic classes rather than copying the shadcn/Tailwind component. |
| `components/ui/label.tsx` | **ADAPT** | Phase 5 uses native `<label htmlFor>` associations; the Radix/shadcn label abstraction is not ported. |
| `components/ui/switch.tsx` | **ADAPT** | Android uses labeled native checkboxes for weekly review and Phase 8 device protection. Radix Switch is not ported; native services own notification and key-protection behavior. |
| `components/ui/dialog.tsx` | **ADAPT** | Radix Dialog is not ported. Backup/restore uses an app-owned preview/confirmation surface; device authentication uses the Android system prompt. |
| `components/journal/JournalEditor.tsx` | **ADAPT** | Implemented against `JournalService` with 800 ms debounce, serialized newest-value writes, 5-second retry, delete-on-empty, unmount/beforeunload handling, and no HTTP. |
| `components/journal/SaveStatus.tsx` | **ADAPT** | The status contract is rendered directly as semantic `Saving…`/`Saved`/masked-error copy; the web timestamp component was not copied verbatim. |
| `components/navigation/Sidebar.tsx` | **ADAPT** | Replaced by the compact React `AppShell`/tab-bar structure for Today/Archive/Settings; sign-out is local. |
| `components/settings/SettingsForm.tsx` | **ADAPT** | Native HTML controls cover timezone, weekly review, appearance, Phase 6 notifications, Phase 7 backup/restore/legacy import, and the Phase 8 native-authoritative Security card. No email/SMTP/server-password controls. |
| `components/auth/LoginForm.tsx` | **ADAPT** | Native local-password login remains the fallback; when native protection is enabled and available, the same form offers device unlock. Both paths open only the in-memory `AuthService` session. |
| `components/auth/SetupForm.tsx` | **ADAPT** | Implemented as a native password/confirmation form; seeds validated device timezone and creates only a local verifier, never the SQLCipher key. |
| `android/src/auth/{passwords,verifier,auth-service,auth-context}.ts(x)` | **ADAPT** | Strict local PBKDF2 verifier plus in-memory session. Phase 8 adds trusted device-credential session unlock only after native key authentication and stored-auth validation; it never changes the password/verifier or SQLCipher key. |
| `android/src/components/journal/{JournalEditor,JournalView}.tsx` | **ADAPT** | Local-service editor/view adaptation with stale-work guards and entry-marker refresh. |
| `android/src/lib/month-grid.ts` + archive components/page | **ADAPT** | Monday-first calendar model and native React grid consume shared civil-date primitives and saved timezone; no server/API fetch. |
| `android/src/db/use-settings.ts` + Settings UI | **ADAPT** | Storage-backed hook and native settings form add serialized convergence, handle-identity guards, masked retry, and live appearance propagation. |
| `pages/*.astro` (all) | **ANDROID-NOT-NEEDED** | SSR pages; replaced by React routes in the Vite app. |
| `layouts/*.astro` | **ANDROID-NOT-NEEDED** | SSR layouts; replaced by React shell. |
| `middleware.ts` | **ANDROID-NOT-NEEDED** | Astro middleware / session redirects. |
| `styles/global.css` | **ADAPT** | Phase 5 rewrote Android styling as plain semantic CSS. Vite targets Chrome 60 and a pure generated-CSS verifier rejects incompatible constructs; Tailwind v4 de-layering was not reused. |
| `components/journal/WeekStrip.astro` | **ADAPT** | Logic reused as React (week strip). Astro syntax → React. |

## 2. Server modules

| File | Classification | Notes |
| --- | --- | --- |
| `server/config.ts` | **ANDROID-NOT-NEEDED** | Env validation; Android has no process env. |
| `server/auth.ts` | **ANDROID-NOT-NEEDED** | Better Auth. Android uses on-device auth + key unlock (Phases 4/8). |
| `server/crypto/key.ts` | **REWRITE** | Android at-rest storage does not reuse the env-key module: SQLCipher uses a random passphrase stored through the native plugin's Keystore-backed encrypted preferences. Phase 4 added strict dependency-free base64 decoding only inside the Phase 7 import-compatibility seam. |
| `server/crypto/journal-encryption.ts` | **REWRITE** | Phase 4 proved the exact WebCrypto AES-256-GCM `{ encryptedContent, iv, authTag }` layout in an Android import-only compatibility module. Android does **not** persist that row format; SQLCipher encrypts the whole database. Phase 7 invokes the compatibility seam only while importing. |
| `server/db/schema.ts` | **REWRITE** | Drizzle/libSQL schema is server-side. Android uses its **own on-device SQLite schema (Phase 3)** replicating the app tables' domain (`journal_entries`, settings; no Better Auth tables). Encrypted-column layout is read-only input for legacy migration. |
| `server/db/client.ts` | **ANDROID-NOT-NEEDED** | libSQL client. |
| `server/db/repo.ts` | **REWRITE** | Repository logic (get/upsert/delete entry, list dates, settings) is a clean contract; reimplement on on-device SQLite (Phase 3). |
| `server/api/index.ts` | **ANDROID-NOT-NEEDED** | Hono app. |
| `server/api/http.ts` | **ANDROID-NOT-NEEDED** | HTTP error/JSON helpers. |
| `server/api/types.ts` | **ANDROID-NOT-NEEDED** | `ApiDeps` DI contract (may inform a local `LocalDeps` shape). |
| `server/api/routes/*` | **REWRITE** (concept) | Route handlers define the journal/settings contracts; Android replaces them with a local service with the same semantics (no HTTP). |
| `server/jobs/weekly-digest.ts` | **ANDROID-NOT-NEEDED** (module) + **SHARE** (extracted model) | The scheduler, DB, SMTP, and email renderer remain web-only. Phase 2 extracted the pure model to `@rememberme/core/weekly`: Sunday-inclusive week math, Monday–Sunday ordering, and `DigestDay` = calendar date + nullable content. It is deterministic civil-date code with tests; callers map an instant to a local date before using it. Weekly Review and notification scheduling consume it in Phase 6. |
| `server/mail/*` | **ANDROID-NOT-NEEDED** | SMTP + digest email builder (HTML/text rendering web-only). |
| web-side export script (`scripts/export-android.ts`, Phase 7) | **SHIPPED (web-side)** | `bun run journal:export-android -- --output <path>` produces the documented, **versioned legacy-export file** (ciphertext-only rows + timestamps; **no key, no plaintext**) via a user-run server command; sole-user enforced, exclusive 0600 write. The Android app parses/validates that file during migration (offline transport, §7b). |
| Better Auth tables (`user`/`session`/`account`/`verification`) | **ANDROID-NOT-NEEDED** | Better Auth internals; Android has no session tables. |

## 3. Tests

| File | Classification | Notes |
| --- | --- | --- |
| `tests/schemas.test.ts` | **SHARE / port** | Zod schema tests are portable; run against the shared schemas (and the Android settings schema). |
| `tests/encryption.test.ts` | **ADAPT** | Round-trip/tamper/wrong-key tests are the spec; extend with legacy-migration cases (wrong/missing/corrupt key, rollback) for Phase 7. |
| `tests/journal-api.test.ts` | **ADAPT** | HTTP tests; port the domain assertions against the local service and SQLite repo (Phase 3/5). |
| `tests/auth.test.ts` | **ADAPT** | Better Auth flow assertions are adapted to strict on-device password auth plus Phase 8 cold-start and in-process biometric/device-credential unlock, cancellation, ownership, and fallback tests. |
| `tests/digest.test.ts` | **ADAPT** | Week-math / timezone-hour gating / ordering tests → Android Weekly Review + notification schedule (Phase 6). Drop SMTP/delivery assertions; the extracted pure model gets its own tests. |

---

## 4. Summary counts

| Classification | Representative items |
| --- | --- |
| KEEP | `lib/utils` and other dependency-safe pure helpers copied without behavioral change |
| SHARE | canonical `packages/rememberme-core/src/{journal,timezone,calendar,weekly}.ts` modules imported through `@rememberme/core` by both builds |
| ADAPT | semantic button/card primitives; native input/label/checkbox controls instead of shadcn/Radix switch/dialog/label; `JournalEditor`/`JournalView`/save status; `AppShell`; `SettingsForm`/`SecurityCard`/`useSettings`; auth verifier/service/forms/session gate with device unlock; archive/month-grid logic; rewritten semantic `styles/global.css`; `shared/schemas/settings.ts` → Android settings schema; `tests/{encryption,journal-api,auth,digest}*.test.ts` |
| REWRITE | SQLCipher/native-key bootstrap and native two-store key-protection state machine, legacy import-only WebCrypto compatibility seam, on-device SQLite repo, local service layer |
| ANDROID-NOT-NEEDED | `middleware.ts`, `server/api/*`, `server/mail/*`, `server/jobs/weekly-digest.ts` module, web-side export script (Phase 7), `server/auth`, `server/config`, `server/db/client`, Astro pages/layouts, `scripts/migrate.ts`, `drizzle/`, Better Auth tables |

Workflow classification: the legacy export is a **manual, server-side,
user-run command (Phase 7)** — not a CI workflow and not part of the Android
app. Separately, the Phase 9 Android CI job is implemented in
`.github/workflows/ci.yml` without changing that migration boundary (see
`porting-plan.md` §2f).

---

## 5. Sharing caveat (important)

`SHARE` items must be **dependency-free or carry only safe deps** (zod,
luxon). The web build is Astro/SSR + `@astrojs/node`; the Android build is
static Vite; any shared file that (transitively) imports a server-only module
breaks the static build. **Phase 2 decided: option (1)** — a dedicated
workspace package **`@rememberme/core`** (`packages/rememberme-core`) that
both builds import, per ADR-0003. Copy + sync test (option 2) was rejected.
The web journal/timezone wrappers remain compatibility seams and are not the
shared source. See `porting-plan.md` §8 and ADR-0001/ADR-0003.

---

## 6. Legacy encrypted format (Phase 4/7 decision driver)

Web stores `{ encryptedContent, iv, authTag }` (base64; AES-256-GCM, 12-byte
IV, 16-byte tag appended by WebCrypto) and derives the key from env. Android
does **not** persist this format: it **reads** it only during legacy migration
(Phase 7), decrypting in memory with the source `JOURNAL_ENCRYPTION_KEY` before
writing into the SQLCipher-protected database. Phase 4 proved compatibility
with a hard-coded root-web fixture and direct WebCrypto cross-checks; canonical
base64, exact IV/tag lengths, tampering, wrong keys, and malformed UTF-8 all
fail closed. The Phase 7 import remains transactional (validate-all, rollback
on any failure, wrong/missing/corrupt key handled explicitly).
