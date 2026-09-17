# Provenance — vendored `@capacitor-community/sqlite` Android module

This directory contains the **Android native module** of the npm package
`@capacitor-community/sqlite`, vendored into the RememberMe Android app so the
app can ship a patched, deterministic plaintext→SQLCipher conversion with
crash recovery (Phase 4 fix, ADR-0005) and user-toggleable authentication-bound
SQLCipher-secret storage (Phase 8, ADR-0009).

## Upstream source

| Field | Value |
| --- | --- |
| Package | `@capacitor-community/sqlite` |
| Pinned version | `8.1.1` (exact; see `android/package.json` and the frozen Bun lockfile) |
| Repository | https://github.com/capacitor-community/sqlite |
| License | MIT — `LICENSE` in this directory is a verbatim copy of the upstream `LICENSE` (`MIT License`, Copyright (c) 2020-2024 Quéau Jean Pierre) |
| Module | `android/` (Gradle library module; `android/build.gradle` + `android/src/main/`) |
| Copied from | the installed package at install time: `android/node_modules/@capacitor-community/sqlite/android/` |

## Re-vendor procedure (reproducible)

```sh
# from the android workspace root
V="node_modules/@capacitor-community/sqlite/android"
D="../android/android/vendor/capacitor-community-sqlite"
rm -rf "$D"
mkdir -p "$D"
cp -R "$V" "$D/android"
cp "node_modules/@capacitor-community/sqlite/LICENSE" "$D/LICENSE"
cp "node_modules/@capacitor-community/sqlite/README.md" "$D/README.md"
```

Then re-apply the patch described below. The static contract test
`android/src/test/vendored-sqlite.vitest.ts` verifies, against the currently
installed `node_modules` copy, that every shared module file is byte-identical
to upstream **except** the five documented patched files
(`UtilsSQLCipher.java`, `CapacitorSQLite.java`, `CapacitorSQLitePlugin.java`,
`UtilsSecret.java`, `Database.java`), and that the only additions are the five
documented app-owned helpers/tests (`EncryptionFileSwap.java`,
`DeviceAuthenticator.java`, `KeyProtectionState.java`,
`KeyProtectionStore.java`, and `KeyProtectionStateTest.java`). That live
comparison is the integrity check; no derived tree hash is recorded here
because local metadata can make such digests non-portable. Re-vendoring must
re-apply both Phase 4 and Phase 8 patches exactly.

## Intended patch (applies to the module under `android/`)

Ten module files differ from upstream: five patched upstream files and five
app-owned helpers/tests.

1. `src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSQLCipher.java`
   — `encrypt()` no longer writes the encrypted copy to a random
   `getCacheDir()` temp and no longer executes `originalFile.delete(); …;
   newFile.renameTo(originalFile)` (a process death between those two steps
   destroyed the only copy). It now:
   - runs the idempotent `EncryptionFileSwap.recover(...)` first (fail-closed
     completion of any interrupted previous conversion);
   - writes the encrypted candidate to the deterministic sibling
     `<main>.encrypting` in the same databases directory;
   - closes every statement/handle in `finally`; the candidate fsync itself
     is owned by `EncryptionFileSwap.commit(...)` — `encrypt()` performs no
     direct `fsyncNoTruncate` call (fsync-ordering hardening: the durable
     page flush cannot be bypassed by another commit caller);
   - commits via `EncryptionFileSwap.commit(...)`: candidate durability
     (`ops.fsync(tmp)`, nontruncating append-mode `FileOutputStream`),
     checked `main → <main>.plain.bak`, checked `<main>.encrypting → main`,
     verifies the promoted main opens with the supplied secret, and only
     then deletes the plaintext backup; sidecars (`-journal`, `-wal`, `-shm`)
     are removed after handles close so plaintext sidecars never apply to
     the encrypted main.
   - adds `verifierFor(secret)` (real SQLCipher readonly content probes) used
     by both `encrypt()` and the pre-probe recovery hook. SQLCipher export
     semantics (`ATTACH … AS plaintext KEY ''; SELECT sqlcipher_export('main',
     'plaintext'); DETACH`, version preservation) are unchanged.

2. `src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLite.java`
   — adds `recoverDatabase(dbName)` and runs it **before** the public
   `isDatabase` probe returns and defensively before `isDatabaseEncrypted`, so
   startup reconciles deterministic artifacts before any mode decision or open.
   No JS/native bridge API is added. Recovery uses actual content state via
   `EncryptionFileSwap.recover` and fails closed on ambiguous states; the
   backup is never deleted unless main is positively verified encrypted with
   the stored secret. (`UtilsSecret.getPassphrase()` first, `GlobalSQLite.secret`
   fallback — the same ordering `getDatabaseState` uses.)

3. `src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSecret.java`
   — `setPassphrase` persists synchronously with a checked
   `SharedPreferences.commit()` instead of the plugin's async `apply()` path,
   and throws when the write reports failure, so `setEncryptionSecret` rejects
   (fail-closed) before any native conversion runs. Keystore /
   EncryptedSharedPreferences behavior is unchanged; the app never relies on
   a possibly-dropped async passphrase write.

4. `src/main/java/com/getcapacitor/community/database/sqlite/SQLite/Database.java`
   — `open()` rejects a `decryption` mode request with an explicit
   "decryption mode is disabled" error BEFORE any file mutation, and never
   calls `decrypt(...)`, so an encrypted store can never be silently reverted
   to plaintext through a plugin call. Normal `secret`, `encryption`, and
   secret-rotation (`changeEncryptionSecret`) paths are unchanged.

5. `src/main/java/com/getcapacitor/community/database/sqlite/SQLite/EncryptionFileSwap.java`
   — **new** java.io-only (API-24-safe, no `java.nio.file`/`Files.move`)
   public helper class implementing the deterministic artifact naming
   (`<main>.encrypting`, `<main>.plain.bak`), checked renames, checked
   rollback, sidecar handling, and the idempotent fail-closed recovery state
   machine. Candidate durability is part of the protocol: `commit()` calls
   `ops.fsync(tmp)` (the injected FileOps seam; production `REAL` is the
   nontruncating append-mode `FileOutputStream`+`getFD().sync()`) BEFORE any
   sidecar deletion or rename, so a forced fsync failure aborts with the
   plaintext main + candidate intact and no rename. Recovery promotions are
   fsync-first too: every `recover()` branch that can rename
   `<main>.encrypting`→main (tmp-only, bak+tmp, tmp+plaintext-main) routes
   through one private `promoteRecoveryCandidate` helper that calls
   `ops.fsync(tmp)` before any delete/rename, so a crash-leftover candidate
   that was never flushed is made durable before promotion; a failing fsync
   throws with tmp/main/bak artifacts preserved and no rename. Every filesystem mutation
   routes through the package-private `FileOps` seam
   (rename/delete/fsync/exists). SQLCipher opens are isolated behind the
   `Verifier` interface so the decision logic is exercised by host-JVM JUnit4
   tests (`android/android/app/src/test/java/app/rememberme/journal/EncryptionFileSwapTest.java`),
   and the same-package forced-failure suite
   (`android/android/app/src/test/java/com/getcapacitor/community/database/sqlite/SQLite/EncryptionFileSwapFaultsTest.java`)
   drives rename/delete/fsync faults against the seam.
   Restore-the-backup fails closed on unverifiable content: before ANY
   rename/delete the backup must positively open as plaintext
   (`verifier.opensPlaintext(bak)`), so a corrupt `<main>.plain.bak` is
   preserved untouched and an error is thrown rather than promoting foreign
   bytes over main (fault case `corruptBakAndTmp_failsClosed`).

### Phase 8 key-protection additions

- `CapacitorSQLite.java` now delegates passphrase-store selection and migration
  to `KeyProtectionStore`, activates neither store in its constructor, refuses
  secret-dependent access before explicit preparation, exposes native-only
  initial secret provisioning, and removes the upstream constructor-time
  biometric prompt and silent ungated fallback. Its existing Phase 4
  conversion recovery remains intact.
- `CapacitorSQLitePlugin.java` adds five non-secret bridge methods for prepare,
  status, toggle, in-process session authentication, and native initial-secret
  provisioning. One active authentication/security transition is permitted;
  API 24–29 uses system device credentials and API 30+ uses a strong biometric
  or device credential. Initial provisioning returns only `{ created: true }`;
  raw platform/secret values are never returned, and plugin initialization uses
  fixed log/rejection copy rather than native exception text.
- `UtilsSecret.java` also checks durable removal, rejects access before the
  authoritative store has been prepared, and creates a fresh 32-byte SQLCipher
  passphrase with `SecureRandom` entirely in native code. Its temporary byte
  buffer is cleared in `finally`; the passphrase never enters JavaScript or a
  Capacitor request/response.
- `KeyProtectionState.java` is an Android-free crash protocol; its host-JVM
  `KeyProtectionStateTest.java` covers transition ordering and injected faults.
- `KeyProtectionStore.java` owns distinct disabled/authentication-bound
  encrypted-preference stores and strict native mode metadata.
- `DeviceAuthenticator.java` owns the API-specific system-authentication UI.

Everything else in `android/` is a verbatim upstream copy, including
`build.gradle`, manifests, and all other npm-shipped source files.

## Dependency note

`android/build.gradle` retains the upstream dependency set (SQLCipher
`net.zetetic:sqlcipher-android:4.17.0@aar`, `androidx.security:security-crypto`,
`androidx.biometric`, `androidx.room`, …). No new Gradle/Java dependency is
added by this patch. No `node_modules` file is modified by this work.