# ADR-0006 — On-device privacy-gate authentication (Phase 5)

- **Status**: Accepted — Phase 5 FINAL COMPLETE/CLOSED after fix10; both canonical current Terra closure reports are exact standalone `PERFECT`; pre-fix10 reports are stale; Phases 6–9 pending
- **Date**: Phase 5
- **Deciders**: RememberMe maintainers / Phase 5 implementer

## Context

The Android app is offline-first and has no server account or Better Auth
session. Phase 5 still needs a local privacy gate so journal content is not
shown immediately when the app opens. That gate must work in the Android
WebView 60 compatibility floor, add no network or authentication dependency,
and fail closed when persisted auth data is corrupt.

Phase 4 already protects the whole database with SQLCipher and a random
32-byte passphrase stored by the SQLite plugin through Android
Keystore-backed encrypted preferences. A human password has lower entropy and
must not replace or control that storage key.

Phase 5 also replaces the inherited Tailwind v4 styling assumption. The final
Android UI uses plain semantic CSS and native HTML controls so its built CSS
can be checked against the Chrome/WebView 60 floor without adding another UI
or compatibility dependency.

## Decision

### Local verifier contract

Use WebCrypto PBKDF2-HMAC-SHA256 as a password **verifier**, not as an
encryption-key derivation path:

- password length is 8–128 JavaScript string code units, inclusive;
- each setup creates a random 16-byte salt with `crypto.getRandomValues`;
- PBKDF2 uses SHA-256 and exactly 600,000 iterations;
- the derived verifier is exactly 32 bytes;
- the persisted v1 envelope contains exactly `version`, `algorithm`,
  `iterations`, `salt`, and `verifier`;
- salt and verifier use canonical RFC 4648 standard base64;
- equal-length verifier bytes are compared with a single XOR-accumulation
  pass, without content-dependent early return.

The decoder rejects malformed JSON, non-object/array input, missing or unknown
keys, a version or algorithm mismatch, any iteration count other than 600,000,
malformed or noncanonical base64, and any salt/verifier length mismatch before
running PBKDF2. A stored value therefore cannot select a weaker algorithm or
force an attacker-controlled iteration count. Temporary password, salt, and
verifier byte arrays owned by the implementation are zeroed in `finally`
blocks. WebCrypto absence, including an RNG-only implementation without
`subtle`, rejects rather than falling back to application cryptography.

### Schema and singleton ownership

Schema v3 adds one app-managed table:

```sql
CREATE TABLE local_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  verifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

The column CHECK constraint enforces the singleton identifier. `AuthService` also
rechecks the row count and the types/parseability of verifier and timestamp
fields on every read. More than one row, an invalid timestamp, or an invalid
verifier envelope is corruption and fails closed.

### Setup, login, and session lifecycle

Production exposes one `AuthService` through the singleton database handle.
First-time setup is serialized end-to-end by a per-service promise queue:

1. validate password bounds;
2. read and strictly validate existing auth, rejecting an existing or corrupt
   configuration before changing settings or deriving;
3. validate and persist the device timezone through `SettingsService`;
4. derive the verifier outside the database lock;
5. validate the generated timestamp;
6. inside one queued database section, recheck absence and atomically
   `BEGIN`/insert id 1/`COMMIT`, with checked rollback on failure;
7. mark only the in-memory session unlocked.

Timezone-first setup is deliberately recoverable: if derivation or insertion
fails, a harmless validated timezone seed may remain and setup can be retried;
no partial auth row survives. The 600,000-iteration derivation and settings
update never hold or nest the database lock.

Login reads and strict-decodes the singleton once, derives the candidate, and
sets the in-memory unlocked flag only after a match. A wrong password and an
unconfigured store both return exactly `Invalid password. Please try again.`
so the UI exposes no configuration oracle. Corruption remains a distinct
fail-closed startup/auth error. Logout clears only the in-memory flag; a
process restart begins locked even though the verifier remains configured.
No password, verifier, or session token is logged or exported.

### Bootstrap boundary

`openAppDatabase` applies migrations, validates the exact schema, validates
stored settings, validates every stored journal row, then validates the auth
singleton and verifier before exposing services or routes. Any failure closes
the connection, preserves the underlying cause, performs no destructive
reset, and shows no journal surface. Setup and login screens replace the app
shell until authentication succeeds; tabs and journal content are not mounted
behind a merely visual overlay.

### SQLCipher separation

The Phase 5 password never derives, rotates, retrieves, or wraps the SQLCipher
passphrase. It gates an in-memory UI session and persists only a one-way
verifier in the SQLCipher-protected `local_auth` table. Database open and
at-rest encryption remain the Phase 4 native-key state machine. Phase 8 may
add biometric/device-credential gating over the native key after its own
lifecycle and fallback review; it must not reinterpret the Phase 5 password
as the database key.

### UI and CSS adaptation

Authentication and settings use labeled native HTML controls (`form`,
`input`, `select`, `button`, and the Phase 5 weekly-review `checkbox`). The
Android port does not bring over the web Radix `Switch`, `Dialog`, or `Label`
components. Out-of-phase notification, backup/restore, and biometric sections
remain truthful noninteractive copy.

Tailwind v4 de-layering was rejected for this compatibility floor. Android
uses plain semantic CSS, Vite `build.cssTarget: "chrome60"`, the existing
legacy JavaScript build verifier, and the dependency-free
`verify-legacy-css.mjs` denial/required-selector gate. The verifier rejects
unsupported constructs in generated CSS and is mutation/probe tested. This is
a static build contract, not a device visual test; no emulator/device visual
result is claimed.

## Rejected alternatives

- **Use the password as the SQLCipher passphrase**: couples database recovery
to a lower-entropy human secret and contradicts the Phase 4 random-key
boundary.
- **Derive, rotate, or wrap the SQLCipher key with PBKDF2**: adds a second key
lifecycle and migration/recovery protocol that Phase 5 does not need.
- **Per-row application encryption**: duplicates SQLCipher, leaves other
schema data outside that row contract, and confuses the Phase 7 import-only
legacy cipher with Android storage.
- **Persist a plaintext or reversibly encrypted password**: creates directly
recoverable credentials; only a salted one-way verifier is needed.
- **Add a third-party authentication or crypto library**: expands dependency,
network, and bridge surface when WebCrypto and the local service are
sufficient.
- **Reuse the web Better Auth flow**: requires server/account/session behavior
and violates offline-only operation.
- **Reuse Radix switch/dialog/label primitives**: adds unnecessary abstraction
and styling/runtime behavior for simple native controls under an old WebView
floor.
- **Keep Tailwind v4 output and strip layers after build**: generated modern
constructs are broader than layers alone; a plain semantic stylesheet plus a
pure output verifier gives a smaller, explicit compatibility contract.

## Consequences

- The password gate protects against casual local viewing after app start or
logout; it is not a claim that a compromised running process cannot inspect an
already-open database.
- SQLCipher remains solely responsible for encryption at rest and native key
storage.
- Corrupt verifier/schema/settings/journal state prevents the app from
opening; it is preserved for recovery instead of reset.
- Settings, editor, archive, and auth remain fully offline. Phase-boundary
tests deny browser/native HTTP channels and remote resource URLs and keep
`/weekly`, notifications, backup/restore, and biometric functionality out of
Phase 5.
- JavaScript/TypeScript tests, lint, typecheck, Vite legacy build, and CSS
contract pass. Phase 8 later provisioned a user-scoped JDK/Android SDK, so
Gradle compilation, host-JVM tests, and debug APK assembly now pass; emulator/
device and visual behavior remain unclaimed.

## References

- `android/src/auth/passwords.ts`
- `android/src/auth/verifier.ts`
- `android/src/auth/auth-service.ts`
- `android/src/auth/auth-context.tsx`
- `android/src/components/auth/SetupForm.tsx`
- `android/src/components/auth/LoginForm.tsx`
- `android/src/db/migrations.ts`
- `android/src/db/schema-validation.ts`
- `android/src/db/bootstrap.ts`
- `android/src/components/settings/SettingsForm.tsx`
- `android/src/components/journal/JournalEditor.tsx`
- `android/scripts/verify-legacy-css.mjs`
- `android/vite.config.ts`
- `android/src/test/phase-boundary.vitest.tsx`
- ADR-0005 (SQLCipher encryption and native key management)
- `.superpowers/sdd/porting-plan/phase5-plan.md`
