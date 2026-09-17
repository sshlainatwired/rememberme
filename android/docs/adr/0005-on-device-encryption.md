# ADR-0005 — On-device encryption and key management (Phase 4)

- **Status**: Accepted (Phase 4 final complete; Phase 8 later unblocked Java/Gradle/host-JVM tests and debug APK assembly; device SQLCipher/runtime verification remains unclaimed)
- **Date**: Phase 4
- **Deciders**: RememberMe maintainers / Phase 4 implementer

## Context

Phase 3 added the app-private SQLite database but deliberately opened it as
transitional plaintext. No journal editor or user-facing write path may ship
until Phase 4 replaces that contract with encryption at rest. Android has no
server environment variable, so the web app's `JOURNAL_ENCRYPTION_KEY` cannot
become the device database key.

The Android workspace already pins `@capacitor-community/sqlite@8.1.1`. Its
Android implementation ships SQLCipher and exposes connection modes for fresh
encrypted databases, normal encrypted opens, and plaintext conversion. The
same plugin provides a secure-store API for the database passphrase.

Phase 7 must later import the web app's existing AES-256-GCM row format:
`{ encryptedContent, iv, authTag }`, with standard base64, a 12-byte IV, and a
16-byte tag split from the WebCrypto result. That compatibility requirement is
separate from Android's at-rest representation.

## Decision

### Whole-database encryption

Use the installed Capacitor SQLite plugin's native **SQLCipher** path for the
single `rememberme` database. `capacitor.config.ts` sets
`plugins.CapacitorSQLite.androidIsEncryption: true`. Every production
connection is created with `encrypted = true`:

- fresh database or already-encrypted database: mode `secret`;
- existing Phase 3 plaintext database: mode `encryption`, which asks the
  plugin to convert it before opening;
- no `no-encryption` production path remains.

This protects the entire app database, including journal entries, settings,
and schema metadata, without changing the Phase 3 logical schema.

### Random passphrase and native secure store

When the plugin reports that no passphrase is stored and no unrecoverable
encrypted database is present, JavaScript creates exactly 32 random bytes with
`crypto.getRandomValues`. It standard-base64 encodes those bytes and passes
the string once to `SQLiteConnection.setEncryptionSecret`.

The mutable 32-byte JavaScript buffer is zeroed in `finally`, whether the
bridge call succeeds or fails. The application exposes no API for retrieving
the stored passphrase and does not log or include it in errors. On later
starts, the plugin uses the stored secret internally.

Installed plugin source provides the storage chain used by this decision:

- an Android Keystore-backed `MasterKey` with
  `MasterKey.KeyScheme.AES256_GCM`;
- `EncryptedSharedPreferences` named `sqlite_encrypted_shared_prefs`;
- AES-256-SIV preference-key encryption and AES-256-GCM preference-value
  encryption;
- native SQLCipher (`net.zetetic.database.sqlcipher` and the `sqlcipher`
  native library) for database access.

No dependency was added in Phase 4.

### Vendored crash-recovery protocol (Phase 4 fix)

The upstream `@capacitor-community/sqlite@8.1.1` Android conversion
(`UtilsSQLCipher.encrypt`) was not crash-safe: it wrote the encrypted copy to a
random `getCacheDir()` temp file, then executed `originalFile.delete()` followed
by `newFile.renameTo(originalFile)`. A process death between the delete and the
rename destroyed the only copy; a death mid-export left a non-deterministic
cache temp; and plaintext `-journal`/`-wal`/`-shm` sidecars could later be
applied to the promoted encrypted main. The app now vendors the pinned native
Android module under
`android/android/vendor/capacitor-community-sqlite/` and overrides
`project(':capacitor-community-sqlite').projectDir` in the app-owned
`android/android/settings.gradle` **after** `apply from:
'capacitor.settings.gradle'`, so verified `cap:sync` output still resolves the
same project name to the vendored module without a duplicate include. The
generated `capacitor.settings.gradle` is never edited. PROVENANCE (pinned
version/source/license, reproducible re-vendor command, intended patch) and the
upstream LICENSE/README sit in the vendor directory; the static contract
`android/src/test/vendored-sqlite.vitest.ts` proves the vendored module is the
installed upstream except for exactly four patched files plus one new helper
(every other shared file is byte-identical) — the contract currently runs
**23 tests** (RED was 4 failed / 19 passed against the pre-patch suite).

Patched behavior (preserving SQLCipher export semantics — `ATTACH … AS
plaintext KEY ''; SELECT sqlcipher_export('main','plaintext'); DETACH` and
version preservation):

- The encrypted candidate is written to the deterministic sibling
  `<main>.encrypting`; the durable plaintext original is staged as
  `<main>.plain.bak` — both in the same databases directory, never a
  cache-dir random temp.
- Statements/handles close safely (in `finally`); pre-existing deterministic
  artifacts are reconciled first by the idempotent `EncryptionFileSwap.recover`
  and fail closed if ambiguous.
- After the candidate is fully written and handles are closed, its pages
  are fsynced inside `EncryptionFileSwap.commit()` (`ops.fsync(tmp)` through
  the injectable FileOps seam; production `REAL` is the nontruncating
  append-mode `new FileOutputStream(file, true).getFD().sync()` — API-24-safe),
  BEFORE any sidecar deletion or rename. `UtilsSQLCipher.encrypt()` performs
  no direct fsync, so the durable page flush cannot be bypassed by any caller
  that reaches the swap.
- Recovery promotions are fsync-first as well: every `recover()` branch that
  can rename `<main>.encrypting`→main (tmp-only, bak+tmp, tmp+plaintext-main)
  routes through one private `promoteRecoveryCandidate` helper that calls
  `ops.fsync(tmp)` before any delete or rename, so a crash-leftover candidate
  that was never flushed (death before `commit()`'s fsync) is made durable
  before promotion; a failing fsync throws with tmp/main/bak artifacts
  preserved and no rename.
- `-journal`/`-wal`/`-shm` sidecars are removed after handles close, so
  plaintext sidecars can never apply to the encrypted main.
- The swap is fully checked: `main → <main>.plain.bak`, then
  `<main>.encrypting → main`; if the second rename fails, a checked rollback
  restores the backup. The plaintext original is never deleted before a
  durable recoverable backup exists and the promoted main is positively
  verified to open with the stored secret; only then is the backup deleted.
  If verification fails, the state is rolled back (or left deterministic)
  and an error is thrown.
- Deterministic recovery runs BEFORE the public `isDatabase` probe returns and
  defensively before `isDatabaseEncrypted`, with no JS/native bridge API
  addition. It uses actual content state (real SQLCipher readonly opens),
  never deletes `<main>.plain.bak` unless main is positively verified
  encrypted with the stored secret, restores the backup when main is
  absent/unknown, removes stale `<main>.encrypting` when main is confirmed
plaintext or encrypted, fails closed on ambiguous main-plaintext +
backup (a corrupt `<main>.plain.bak` beside verified plaintext main is the
same ambiguous state — every artifact preserved, no promote, no delete, no
stale-`.encrypting` removal), and treats tmp-only conservatively
(promote/verify if possible; never silently delete the only potential data).
Recovery is idempotent.

**Process-death guarantee and its boundary.** The protocol is correct for
process death at any point: a deterministic next startup reconciles artifacts
to either the original plaintext database or the verified encrypted database,
never losing the only copy. Its boundary is **power loss / kernel panic** on
API 24: rename and directory-update durability is not guaranteed without a
filesystem directory fsync, which `java.io` (API-24-safe) cannot perform — so
rename *ordering* is not atomic across sudden power loss, and a filesystem
that reorders/`loses` the directory update can produce the ambiguous
main-plaintext + backup state, which the recovery fails closed on (data is
preserved, startup rejects rather than guessing). Data pages written before
the no-truncate fsync are durable; the final rename and delete are the
power-loss boundary, documented rather than claimed.

**Tests.** The recovery decision matrix is covered by host-JVM JUnit4 tests
(29 `@Test` methods total: 21 in
`android/android/app/src/test/java/app/rememberme/journal/EncryptionFileSwapTest.java`
covering every recoverable existence/state branch, promote/restore/stale
delete, commit swap + verification-failure rollback, no-truncate fsync,
sidecar removal, and artifact presence; plus 8 fault-injection `@Test`
methods in the same-package
`android/android/app/src/test/java/com/getcapacitor/community/database/sqlite/SQLite/EncryptionFileSwapFaultsTest.java`
driving the injectable `FileOps` seam — second-rename rollback success and
failure, sidecar-delete failure, backup-delete failure, forced candidate
fsync failure (plaintext main + candidate intact, no rename), forced
recovery-promotion fsync failure (tmp + bak preserved, main absent, no
rename), idempotent artifact recovery, and corrupt `<main>.plain.bak` with main verified plaintext — recovery fails closed, preserving every artifact (no promote, no delete, no stale-`.encrypting` removal)). These 29 recovery tests now compile and pass under the Phase 8 user-scoped JDK/Android SDK toolchain as part of the 71-test app host-JVM suite. No device SQLCipher behavior is inferred from that host run. (A separate 1-`@Test` `ApplicationIdTest` identity
guard also exists.) The Java static contract (provenance, settings override,
protocol markers, probe hooks, JUnit existence, the FileOps injection seam,
durable-secret/disabled-decryption markers) IS executed and green —
currently **23/23**.

### Durable secret storage and disabled decryption mode

Two Terra findings tightened the vendored native module further; the static
contract now counts four patched files (`UtilsSecret.java` and `Database.java`
join `UtilsSQLCipher.java` and `CapacitorSQLite.java`):

- **Synchronous secret durability.** `UtilsSecret.setPassphrase` used the
  `SharedPreferences.Editor` async `apply()`, which can silently fail or be
  lost on process death, leaving JavaScript to proceed believing the secret
  was durably stored. It now uses a synchronous, checked `commit()` and throws
  an unchecked `IllegalStateException` when the write reports failure, so
  `setEncryptionSecret` rejects before any native conversion runs. Keystore /
  EncryptedSharedPreferences behavior is unchanged.
- **Disabled decryption mode.** RememberMe never uses `decryption` mode. The
  upstream `UtilsSQLCipher.decrypt` wrote a plaintext copy to a random cache
  temp, deleted the encrypted original, renamed the temp unchecked, and used
  the default charset for the passphrase. The method body is replaced by an
  unconditional fail-closed `UnsupportedOperationException` with no file
  access, and `Database.open` rejects `decryption` mode before any file
  mutation. Normal `secret`, `encryption`, and secret-rotation
  (`changeEncryptionSecret`) paths are unchanged; remaining passphrase
  conversion in touched code is explicit UTF-8.
- **Injectable file operations for fault tests.** `EncryptionFileSwap` routes
  rename/delete/fsync/exists through a package-private `FileOps` seam (a
  `REAL` production implementation plus a constructor that accepts an
  injected one), so same-package host-JVM JUnit tests can force deterministic
  failures — second-rename rollback success/failure, sidecar-delete failure,
  backup-delete failure, forced candidate-fsync failure (fail-closed, no
  rename), idempotent artifact recovery, and corrupt-`<main>.plain.bak`
  recovery with main verified plaintext (fail-closed, artifacts preserved,
  no promote/delete) — without touching
  a real filesystem or requiring device permissions.

### Fail-closed startup state machine

Every plugin state probe must return an actual boolean `result`; missing or
malformed bridge data rejects. Startup reconciles stale plugin connections,
requires encryption to be enabled in native configuration, then resolves the
following states before creating a connection:

| Database | Stored secret | Encryption state | Action |
| --- | --- | --- | --- |
| absent | absent | n/a | generate/store one secret; open `secret` |
| absent | present | n/a | reuse it; open `secret` |
| plaintext | absent | false | generate/store one secret; convert with `encryption` |
| plaintext | present | false | reuse it; convert with `encryption` |
| encrypted | present | true | normal open with `secret` |
| encrypted | absent | true or native `Database unknown` | reject as key loss before random generation, secret replacement, connection creation, or open |
| existing | any | malformed/other probe failure | reject before create/open |

The real plugin can open a database without a passphrase to identify
plaintext. If that fails and no stored passphrase exists, it reports the
existing database as unknown because it cannot prove which unavailable key
encrypted it. The adapter treats that state as possible key loss, preserves
the native failure as `cause`, and never generates a replacement.

If plaintext conversion fails after storing the new secret, the secret remains
available and the next startup retries mode `encryption` — but retry is only
safe because of the vendored crash-safe conversion protocol documented above.
The upstream plugin's conversion deleted the original plaintext database
before renaming the encrypted copy into place, so a crash between those two
steps could destroy the only copy; that flaw is patched in the vendored
module. If connection open fails after registration, existing best-effort
cleanup removes the registration without masking the original failure. Apart
from the conversion protocol itself, no application failure deletes or resets
the database.

Clearing app data or uninstalling removes both the app-private database and its
secure preference state. Restoring only one without the other would be
unrecoverable, so the native manifest retains `android:allowBackup="false"` plus
`fullBackupContent="false"` and `dataExtractionRules` exclusions for the
`root`/`database`/`sharedpref`/`external` domains (asserted by the static
contract `android/src/test/manifest-backup.vitest.ts`).
Portable recovery belongs to the password-protected `.rmbak` format in Phase
7, not Android Auto Backup.

### Biometric boundary

`androidBiometric.biometricAuth` remains explicitly `false`. Phase 4 must not
show a biometric or device-credential prompt. Phase 8 may gate access to the
native key after a separate lifecycle and fallback review; it must not replace
the random database passphrase with a human password.

### Legacy web compatibility

`src/crypto/legacy-journal.ts` is an **import-only Phase 7 compatibility
seam**, not the Android storage format. It uses the runtime WebCrypto AES-GCM
implementation; no cipher is implemented in application code. It enforces:

- canonical RFC 4648 standard base64, including zero unused trailing bits;
- exactly 32 key bytes, a non-extractable imported `CryptoKey`, and zeroing of
  the decoded raw-key buffer after import;
- fresh 12-byte IVs and exact 16-byte tags;
- strict hostile-payload validation before decrypt;
- generic authentication and UTF-8 failures that echo no key, plaintext, or
  payload.

Tests decrypt a hard-coded result produced by the root web cipher, verify the
Android split layout with direct WebCrypto in both directions, and cover
round-trips, tampering, wrong keys, malformed/noncanonical encoding, invalid
sizes, and malformed UTF-8. The legacy key will be supplied only during a
Phase 7 import and must never be persisted.

Phase 8 adds optional user-authentication-bound storage for the same passphrase; ADR-0009 supersedes this ADR's deferred biometric boundary without changing SQLCipher encryption or the random passphrase.

## Rejected alternatives

- **Per-row WebCrypto for Android storage**: adds an encrypted-column
  migration and key plumbing while leaving other database content outside the
  contract. SQLCipher already protects the whole store.
- **A second secure-storage or cryptography plugin**: adds dependency and
  bridge surface while the pinned SQLite plugin already supplies SQLCipher
  and Keystore-backed secret storage.
- **User-password-derived database key**: couples storage availability to the
  Phase 5 UX and gives a human secret less entropy than a generated key.
  Backup passwords are a separate portable Phase 7 KDF contract.
- **Hard-coded or bundled secret**: every installation would share recoverable
  key material and extraction from the application package would expose it.
- **Persisting the web row-cipher layout**: duplicates encryption inside
  SQLCipher and turns a narrow import format into permanent schema coupling.

## Consequences

- Phase 5 can use the existing journal/settings services without seeing key or
  ciphertext details; encryption is enforced at the native open boundary.
- A lost secure-store secret for an existing encrypted database is deliberate
  data loss unless the user has a Phase 7 backup. Startup fails closed instead
  of silently creating a new empty identity.
- Physical database ciphertext/tamper behavior depends on SQLCipher and must
  be verified on Android. The Phase 8 local toolchain compiles Java, runs host
  JUnit, and assembles a debug APK, but no emulator/device SQLCipher round-trip,
  plaintext-conversion, file inspection, or physical-tamper pass is claimed.
- Shipping SQLCipher can trigger encryption export-classification/reporting
  obligations. The plugin README explicitly links its Encryption Export
  Regulations notice; release work must complete the applicable legal/export
  review rather than assuming open-source inclusion removes that obligation.
- Root Astro/web runtime behavior and its server-side encryption remain
  unchanged.

## References

- `android/src/db/capacitor-sqlite.ts`
- `android/src/db/capacitor-sqlite.vitest.ts`
- `android/src/crypto/legacy-journal.ts`
- `android/src/crypto/legacy-journal.vitest.ts`
- `android/src/test/vendored-sqlite.vitest.ts` (static contract for the vendored module — 23 tests)
- `android/src/test/manifest-backup.vitest.ts` (static contract for backup/transfer exclusions)
- `android/capacitor.config.ts`
- `android/android/app/src/main/AndroidManifest.xml`
- `android/android/settings.gradle` (app-owned vendored-projectDir override, applied after `capacitor.settings.gradle`)
- `android/android/vendor/capacitor-community-sqlite/PROVENANCE.md`
- `android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLite.java` (vendored project source)
- `android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSQLCipher.java` (vendored project source)
- `android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSecret.java` (vendored project source)
- `android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/Database.java` (vendored project source)
- `android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/EncryptionFileSwap.java` (new java.io-only helper)
- `android/android/app/src/test/java/app/rememberme/journal/EncryptionFileSwapTest.java` (host-JVM JUnit4, 21 `@Test`; passing in Phase 8)
- `android/android/app/src/test/java/com/getcapacitor/community/database/sqlite/SQLite/EncryptionFileSwapFaultsTest.java` (same-package host-JVM JUnit4 fault injection, 8 `@Test`; passing in Phase 8)
- `android/node_modules/@capacitor-community/sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLite.java` (installed-source evidence only; not project source)
- `android/node_modules/@capacitor-community/sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSQLCipher.java` (installed-source evidence only; not project source)
- ADR-0004 (Phase 3 storage and plaintext handoff)
- `.superpowers/sdd/porting-plan/phase4-plan.md`
