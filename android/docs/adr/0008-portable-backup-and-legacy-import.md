# ADR-0008 — Portable backup and legacy import (Phase 7)

- **Status**: Accepted for Phase 7
- **Date**: Phase 7
- **Deciders**: RememberMe maintainers / Phase 7 implementer

## Context

The Android app holds journals and settings in an on-device SQLCipher database
that cannot be moved between devices or recovered after loss, and the web
deployment is never reachable from the app. Phase 7 ships a portable,
password-encrypted `.rmbak` backup/restore flow and a one-time offline import
for encrypted rows exported from the web server.

Constraints: Android API 24 floor (no `java.time` preference for the crypto
path, no modern-only APIs), offline-only, no new storage/network permissions,
fail-closed hostile input handling, and a full pre-write validation +
transactional restore so a bad file can never partially mutate the database.

## Decision

### Transport and cryptography

- A thin app-owned Capacitor Android plugin (`DocumentTransfer`) uses the
  Storage Access Framework (`ACTION_OPEN_DOCUMENT` / `ACTION_CREATE_DOCUMENT`
  with the action-specific URI grant flags and `CATEGORY_OPENABLE`) purely to
  let the user pick an input file or destination document. It enforces byte
  limits while streaming, keeps exactly one active call, clears all state in
  every terminal path, and never takes a persistable URI permission or adds a
  storage permission.
- `.rmbak` v1 is a strict JSON envelope: a versioned header with fixed scrypt
  parameters (`N=32768, r=8, p=3, dkLen=64`, 16-byte salt), AES-256-GCM
  (random 12-byte IV, 128-bit tag) whose additional authenticated data covers
  the canonical header plus a 16-byte HMAC-SHA-256 password verifier. Restore
  rejects any archive-selected KDF work before derivation, and
  `maxmem=41,943,040` provides bounded headroom over Noble's 33,559,552-byte
  checked allocation.
- The authenticated plaintext is strict versioned JSON: journal entries
  (calendar date, content, canonical UTC-millisecond timestamps with
  `createdAt <= updatedAt`, sorted unique dates) plus portable settings
  (timezone, weekly-review enabled/hour, appearance). Authentication is
  excluded; notification permission state, scheduling state, device
  identifiers, and other device-bound state are never exported.

### Restore/import safety

- Prepare decrypts and validates everything, fingerprints every imported date
  and the exact raw portable-setting rows (missing rows are distinct from
  explicitly stored defaults), returns a preview (additions, conflicts,
  settings-changed flag, expiry), and writes nothing.
- Apply re-checks both fingerprints under the database lock before `begin()`,
  overwrites only the imported dates and portable settings, preserves
  unrelated rows/auth/biometric state, uses one transaction, and rolls back on
  any failure while preserving the original error cause.
- Prepared plaintext is private to one service instance, single-use, and
  expires after five minutes; disposal, cancellation, and database close also
  drop it.
- After a successful commit the service publishes the same-handle settings
  event, so mounted appearance and weekly-notification consumers re-read
  authoritative storage without a remount. Failed/rolled-back applies publish
  nothing.

### Legacy web migration

- `bun run journal:export-android -- --output <path>` reads only the database
  connection environment, requires exactly one configured user, and selects
  only the six encrypted-row columns. It never decrypts and never imports the
  journal cipher, the config module, or the `JOURNAL_ENCRYPTION_KEY`; output
  is strict versioned JSON (ciphertext, IV, tag, canonical timestamps) written
  exclusively with owner-only (0600) permissions and no overwrite.
- Android validates the complete file before creating the legacy cipher,
  refuses empty files (no row can authenticate the key), decrypts rows
  sequentially, validates every plaintext against the shared content schema,
  and performs zero writes until all rows authenticate. The import-only cipher
  is disposed in every path.

### Key erasure truth

- Passwords, legacy keys, and derived bytes are never persisted or logged.
  Mutable byte buffers (salt, IV, derived keys, temporary plaintext) are wiped
  in `finally`; method-local `CryptoKey` references are dropped; UI secret
  state is cleared on every terminal path. JavaScript strings and collected
  `CryptoKey` objects cannot be physically erased, so disposal of those is
  documented as best effort and tests assert observable buffer/reference
  behavior only.

## Consequences

- `.rmbak` files are self-describing and portable between devices, offline.
- A corrupt or hostile archive/export performs zero writes; a mid-transaction
  failure restores prior data automatically.
- Wrong passwords, tampered ciphertext, and corrupted rows share stable masked
  errors; no input content is echoed.
- The legacy export requires no journal encryption key on the server and leaks
  no plaintext, key, email, or account data.
- The whole-file model caps transfers at 16 MiB and 10,000 rows; a future
  streaming archive version is required before raising either ceiling.
- Phase 8 later provisioned a user-scoped JDK/Android SDK, so native Java,
  Gradle, host-JVM tests, and debug APK assembly pass. Device picker, visual,
  and assistive-technology behavior remain unclaimed.

## Alternatives considered

- Native Java scrypt/AES (rejected at design time: unnecessary custom security
  code and a larger native test surface than the WebCrypto path).
- Browser-only file/download controls (rejected: Android WebView export
  behavior is not reliable enough for portability).
- Third-party file picker/filesystem/share plugins (rejected: a second
  dependency surface is unnecessary when API-24-safe SAF intents cover the
  exact operation).

## References

- `android/src/transfer/{base64,backup-codec,legacy-import,data-transfer,document-transfer}.ts`
- `android/android/app/src/main/java/app/rememberme/journal/transfer/{BoundedDocumentIO,DocumentTransferPlugin}.java`
- `src/server/legacy-export.ts`, `scripts/export-android.ts`
- `android/docs/backup-restore.md`
- `.superpowers/sdd/phase7-plan/phase7-design.md`, `.superpowers/sdd/phase7-plan/research.md`
