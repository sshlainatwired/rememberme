# RememberMe

A self-hosted, privacy-first personal journal. Write one entry a day, read it
back anytime, and get a private email digest every Sunday night — all on your
own hardware, with journal content encrypted before it ever touches disk.

- **Encryption at rest** — every entry is AES-256-GCM encrypted (WebCrypto)
  before it is stored; the database never contains plaintext journal content.
- **Password-only** — no email login, no OAuth, no third-party accounts. The
  first launch creates your password; after that it is the only key to your
  journal.
- **One entry per day** — an autosaving editor (800 ms debounce) with
  saved/error states, so your words are never lost.
- **Weekly digest** — Sunday evening (in *your* timezone) you get an email of
  the week's entries, Monday–Sunday, with "No entry." for empty days.
- **No telemetry, no trackers, no CDNs** — fonts and assets are self-hosted;
  the app phones home to exactly nobody.

---

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript (strict, no `any`) |
| Framework | [Astro](https://astro.build) 7 (SSR) + React islands |
| API | [Hono](https://hono.dev) |
| Auth | [Better Auth](https://better-auth.com) (email + password only) |
| ORM / DB | [Drizzle](https://orm.drizzle.team) + libSQL (SQLite / Turso) |
| Validation | [Zod](https://zod.dev) v4 — every external input |
| Email | [Nodemailer](https://nodemailer.com) |
| Styling | Tailwind CSS v4 + shadcn/ui-style components |
| Dates | Luxon (timezone-aware scheduling) |
| Tests | `bun test` |

## Quick start (local)

```bash
bun install
cp .env.example .env
# fill in the two required secrets (see below)
bun run db:migrate
bun run dev
```

Open <http://localhost:4321> — you'll be guided through first-launch setup.

### Required secrets

Generate both with:

```bash
openssl rand -base64 32
```

| Variable | Why |
| --- | --- |
| `BETTER_AUTH_SECRET` | Session signing. Change it and all sessions are invalidated. |
| `JOURNAL_ENCRYPTION_KEY` | AES-256-GCM key for journal content. **Losing it loses every entry.** |

> **Back up `JOURNAL_ENCRYPTION_KEY` somewhere safe.** There is no recovery:
> entries are encrypted with this key and the app deliberately never stores
> it. If you lose the key, the entries are unreadable forever.

### SMTP (weekly digest)

The app runs without SMTP (the digest job reports it is unavailable). To
deliver digests, set:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=you@example.com
SMTP_PASSWORD=secret
MAIL_FROM=digest@example.com
```

In development, with `SMTP_HOST` empty, the digest job still runs end-to-end
but delivers nowhere (a silent no-op mailer).

## Run with Docker

```bash
cp .env.example .env        # fill in secrets
mkdir -p data && chown -R 1000:1000 data   # container runs as uid 1000
docker compose up -d
```

The container runs migrations on startup, then starts the app on
`http://localhost:4321`. The SQLite database lives in `./data/` on the host —
back it up (with your key!) and you can move installations freely.

## Android app

The `android/` workspace is a separate, fully offline Vite + React + Capacitor
app. It stores the journal in an on-device SQLCipher database, shows a local
Monday–Sunday Weekly Review, and schedules best-effort local reminders without
network access. Encrypted `.rmbak` files provide portable backup and restore;
legacy web exports can be imported offline.

Build prerequisites are **OpenJDK 21**, **Android SDK 36**, and Android SDK
Build Tools 35.0.0. From the repository root:

```bash
bun install --frozen-lockfile
bun run --cwd android lint
bun run --cwd android typecheck
bun run --cwd android test
bun run --cwd android build
bun run --cwd android cap:sync  # verifies the legacy WebView contract first
cd android/android
./gradlew testDebugUnitTest
./gradlew assembleDebug
```

The debug APK is written to
`android/android/app/build/outputs/apk/debug/app-debug.apk`. The SQLCipher
passphrase remains native: it is stored in encrypted preferences and never
crosses the Capacitor bridge. Optional protection requires a strong biometric
or device credential before native code can read that passphrase. It is local
to one Android installation and is intentionally absent from `.rmbak` files.

No emulator/device result is claimed for system prompts, Keystore invalidation,
API/OEM behavior, visuals, or assistive technology. CI and host-JVM tests do
not replace those device-lab checks.

## Common commands

```bash
bun run dev          # dev server (http://localhost:4321)
bun run build        # production build into dist/
bun run start        # run the built server (dist/server/entry.mjs)
bun run db:generate  # generate a new Drizzle migration after schema changes
bun run db:migrate   # apply migrations (runs automatically in Docker)
bun run typecheck    # astro check + tsc --noEmit
bun run lint         # biome check
bun test             # 169 tests: 65 web + 104 shared-core (@rememberme/core)
```

## How it works

### Request pipeline

Astro 7 SSR (`@astrojs/node`, standalone) is the single server. A small
middleware:

- routes every `/api/*` request to the Hono app (Better Auth's own routes are
  mounted under `/api/auth/*` inside it);
- resolves the session once per request and attaches it to `locals`;
- redirects unauthenticated visitors to `/login` and signed-in visitors away
  from `/login`/`/setup`.

`Astro.locals.session` is the auth boundary on every page; every API route
calls `requireSession` before touching data.

### Encryption

- Key: `JOURNAL_ENCRYPTION_KEY` (base64 of exactly 32 bytes = AES-256).
  Validated at startup — the server refuses to start on an invalid/missing
  key.
- Per entry: fresh random 12-byte IV, AES-256-GCM via the runtime WebCrypto
  API (no hand-rolled crypto). The 16-byte auth tag and the IV are stored
  alongside the ciphertext.
- Decryption happens only when an entry (or the digest) is actually read —
  in memory, never written back.
- The threat model assumes the database may be compromised: entries, IVs and
  tags are all recoverable, but plaintext is not without the key.

### Authentication

Better Auth with the email/password provider. The UI is password-only: the
underlying account uses a fixed internal email (`owner@rememberme.local`) that
is never shown to or requested from you. Sessions are HttpOnly cookies
(`rememberme.*`, SameSite=Lax, Secure when `BETTER_AUTH_URL` is https),
expiring after `SESSION_EXPIRES_IN_DAYS` (default 7). Changing your password
revokes every other session.

### Weekly digest

- The scheduler wakes every 5 minutes while the server runs; it only sends
  when, **in the user's configured timezone**, it is Sunday at the configured
  digest hour.
- The week is Monday–Sunday; missing days render as *"No entry."*.
- Delivery is idempotent: the `(user_id, week_start, week_end)` unique
  constraint guarantees a week is emailed at most once, even under concurrent
  runs.
- Content is HTML-escaped; subject is `Your week — August 3 — August 9, 2026`;
  footer is `7 days · N entries`.
- Manual trigger for external cron: `POST /api/jobs/weekly-digest` (signed in)
  sends the most recently completed week. A failed send is skipped for that
  week (no retry) and logged server-side without content.

### Settings

`/settings` — email, timezone (IANA list, used for "today" and the digest),
digest on/off and send hour, and password change.

### Archive & week strip

`/archive` shows month grids with a dot on days that have entries — metadata
only, no content. Every journal page shows the current week's strip for quick
navigation.

## Security & threat model

| Concern | Mitigation |
| --- | --- |
| DB leak (backup, server compromise) | Journal content is AES-256-GCM encrypted; keys are never in the DB |
| Key exposure | `JOURNAL_ENCRYPTION_KEY` comes only from the environment; never logged, never returned by any API |
| Password leak | Argon2/bcrypt-style hashing by Better Auth; no password is ever logged |
| Session theft | HttpOnly cookies, SameSite=Lax, Secure on https, expiry, revoke-on-password-change |
| CSRF | SameSite=Lax cookies + JSON-only API (Astro's form-origin check is disabled because it drops the port in standalone mode — documented in `astro.config.mjs`) |
| XSS | React escaping + Zod validation + HTML-escaped digest emails; no `dangerouslySetInnerHTML` |
| SMTP credentials | Env-only, never stored in the DB, never sent to the browser |
| Error leaks | All API errors are safe structured messages; stack traces stay server-side |
| Injection | All external input (bodies, query params, route params, env) passes Zod |

Known limitations:

- The digest only sends while the server process is running. For reliable
  delivery on a small home server that sleeps, point a cron job at
  `POST /api/jobs/weekly-digest` or use a hosted scheduler.
- A failed digest send is not retried for that week.
- Deleting an entry is permanent; there is no trash.
- The app is a single-owner journal: one password, one account.

## Project layout

```text
src/
  middleware.ts          # Astro middleware: /api delegation + session
  pages/                 # setup, login, journal/[date], archive, settings
  components/            # React islands + shadcn-style UI + layouts
  server/
    config.ts            # Zod-validated environment (fail fast)
    auth.ts              # Better Auth instance
    crypto/              # AES-256-GCM (WebCrypto) + key validation
    db/                  # schema, client, repository queries
    api/                 # Hono app + routes (journal, settings, auth, digest)
    jobs/                # weekly digest job + scheduler
    mail/                # SMTP mailer + digest email builder
  shared/schemas/        # Zod schemas shared by server and client
scripts/migrate.ts       # standalone migration runner
drizzle/                 # committed migrations
tests/                   # bun test suite
```

## Tests

`bun test` — 169 tests: 65 web + 104 shared-core
(`@rememberme/core`, also runnable on its own via `bun run core:test`):

- `encryption` — round-trip, unique IVs, tamper detection (ciphertext, tag,
  IV), wrong-key failure, large/empty/unicode content, invalid key rejection.
- `schemas` — Zod validation of dates, content limits, settings, auth.
- `journal-api` — CRUD over HTTP, one-entry-per-date, encrypted-at-rest
  (plaintext never appears in the row), auth enforcement, structured errors.
- `auth` — setup, second-setup rejection, wrong/right password, logout,
  protected routes, password change (incl. wrong current password), expired
  sessions.
- `digest` — week math, timezone/hour gating, idempotency, manual mode,
  HTML escaping, no-mailer 503.
- `core` — `packages/rememberme-core` (5 files, 104 tests): civil calendar
  math incl. the 0000..9999 representable-range boundaries, journal schemas,
  timezone primitives, weekly digest model.

## License

MIT.
