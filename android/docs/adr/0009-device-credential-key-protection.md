# ADR-0009 — Optional device-credential SQLCipher key protection (Phase 8)

- **Status**: Accepted for Phase 8
- **Date**: Phase 8
- **Deciders**: RememberMe maintainers / Phase 8 implementer

## Context

RememberMe already encrypts its Android database with SQLCipher. A random native-generated passphrase is stored in AndroidX `EncryptedSharedPreferences`; the Phase 5 password is only an in-memory privacy gate and never derives or wraps that passphrase.

Phase 8 adds an optional device-authentication requirement without sending the SQLCipher passphrase through Capacitor or JavaScript. It must retain API 24 support, work offline, survive process death during enablement, preserve password login as a fallback after the database is open, and fail closed when native metadata, Keystore state, or secret copies are missing or inconsistent.

## Decision

### Native authority and two stores

Native metadata in `rememberme_key_protection_state` is authoritative before any encrypted database probe or connection. Its exact states are `DISABLED`, `ENABLING`, and `ENABLED`; absent metadata upgrades existing installations as `DISABLED`, while every unknown value rejects.

The unchanged SQLCipher passphrase moves between two AndroidX encrypted preference stores:

- disabled: `sqlite_encrypted_shared_prefs`, using the default `MasterKey`;
- enabled: `rememberme_biometric_sqlite_secret`, using alias `rememberme_biometric_sqlite_master_key` with `setUserAuthenticationRequired(true, 15)`.

`CapacitorSQLite` no longer opens even the disabled store in its constructor. `prepareKeyAccess()` must initialize the authoritative store before secret-dependent plugin methods, conversion recovery, database probes, or encrypted connection creation. SQLite `biometricEnabled` is only a post-open UI mirror reconciled from native status; it never selects the store.

### Authentication by Android API level

- API 30 and newer use `BiometricPrompt` with `BIOMETRIC_STRONG | DEVICE_CREDENTIAL`.
- API 24–29 use `KeyguardManager.createConfirmDeviceCredentialIntent`.
- A failed biometric match is nonterminal. User cancellation is a typed, retryable result. Lockout, unavailable device security, callback failure, malformed state, and Keystore errors reject with stable codes.
- Only one native security operation can own a prompt at a time, and every terminal callback clears that owner.

The plugin exposes only non-secret methods: `prepareKeyAccess`, `getKeyProtectionStatus`, `setKeyProtection`, and `authenticateSession`. Fresh passphrase creation also remains native-only through `ensureEncryptionSecret`; only a success marker crosses the bridge.

### Crash-safe key movement

Enablement performs these durable steps:

1. require a valid disabled-store passphrase;
2. commit `ENABLING`;
3. write and read back the protected copy exactly;
4. remove and verify removal of the disabled copy;
5. commit `ENABLED`.

Startup authenticates before resolving `ENABLING`. Equal duplicate copies finish enablement, a protected-only copy becomes `ENABLED`, and a disabled-only copy reverts to `DISABLED`. Missing-both or differing copies preserve all remaining data and reject.

Disabling authenticates, writes and verifies the disabled copy, commits `DISABLED`, then removes and verifies removal of the protected copy. A cleanup failure may leave a more-protected duplicate after disabled authority is durable; it never deletes the verified disabled copy or silently leaves enabled authority without its protected secret.

The protocol does not rotate the passphrase or reopen an existing SQLCipher connection. It changes which native encrypted store can provide the same passphrase on the next cold start.

### Bootstrap and local session

Production bootstrap calls native preparation before every SQLite consistency, encryption, secret, conversion, or connection operation. Cancellation clears only that singleton initialization attempt so **Try again** can start one fresh attempt; permanent failures remain memoized.

After schema, settings, journal, and local-auth validation, bootstrap reconciles the SQLite mirror. An authenticated enabled cold start then calls `AuthService.unlockWithDeviceCredential()`, which strictly rereads the configured local-auth row and opens only the in-memory session. It neither accepts a password nor performs PBKDF2, changes the verifier, or writes persistent auth data. This yields one system prompt and no second password prompt. In-process logout still clears the session; the login form can run a fresh device prompt or use the existing password fallback.

### UI, errors, and portable data

Settings reads native status, performs authenticated enable/disable transitions, reloads authoritative status after success, and serializes interaction. Cancellation changes no setting. Owner replacement and unmount invalidate stale completions. Native exceptions are replaced by fixed public messages; plugin initialization logging also uses fixed copy rather than exception text.

The SQLCipher passphrase is never returned, logged, shown in a Toast, placed in JavaScript, or written to a backup. `.rmbak` contains only portable settings and explicitly excludes `biometricEnabled`; restore and legacy import cannot change native protection. Android Auto Backup remains disabled/excluded. Recovery from lost or invalidated protected key material therefore requires a separately retained encrypted `.rmbak` backup.

### Key-loss and memory limits

Missing protected secret, invalidated/unavailable Keystore material, conflicting copies, malformed mode, and malformed bridge results all fail closed without generating a replacement, resetting the database, or falling back to an ungated copy. JavaScript sees only typed cancellation or a fixed unavailable error.

Mutable generated random bytes are wiped in `finally`. The passphrase necessarily exists in Java `String` values and inside AndroidX/SQLCipher APIs; Java does not provide reliable physical erasure of those immutable runtime copies. This design minimizes their scope and never claims physical zeroization of strings.

## Rejected alternatives

- **UI-only biometric gate**: rejected because it leaves the SQLCipher passphrase available without device authentication.
- **Silent fallback to the disabled store**: rejected because key loss or cancellation would weaken protection.
- **Use the Phase 5 password as the SQLCipher key**: rejected because it couples storage recovery to a lower-entropy human secret and changes the existing encryption boundary.
- **Generate a new key after Keystore loss**: rejected because it would hide unrecoverable data loss and could create a new empty identity over preserved encrypted data.
- **One store with a boolean flag**: rejected because changing a flag cannot add a user-authentication requirement to already wrapped key material.
- **`BiometricPrompt` device-credential flags on every API**: rejected because the combined authenticator contract is not supported consistently on API 24–29.
- **Enable the plugin’s legacy constructor biometric path**: rejected because it prompts at the wrong lifecycle boundary and does not implement the required crash-safe user toggle. `androidBiometric.biometricAuth` remains `false`.

## Consequences

- Disabled installations retain their prior startup behavior after explicit native preparation.
- Enabled cold starts require supported system authentication before SQLCipher can open and then reach a validated unlocked local session without a password prompt.
- Corruption, cancellation, key loss, and mirror-write failures do not reset or replace data. Native state remains authoritative and later reconciliation repairs only the SQLite mirror.
- Host-JVM state-machine and Android app tests can verify transition ordering, recovery, bridge boundaries, and orchestration. Real prompt presentation, Keystore authorization/invalidation, API/OEM behavior, visuals, and assistive technology still require emulator/device testing and are not claimed by this ADR.

## References

- `android/src/security/device-unlock.ts`
- `android/src/db/bootstrap.ts`
- `android/src/auth/auth-service.ts`
- `android/src/auth/auth-context.tsx`
- `android/src/components/layout/AppBootstrap.tsx`
- `android/src/components/auth/LoginForm.tsx`
- `android/src/components/settings/SecurityCard.tsx`
- `android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLite.java`
- `android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLitePlugin.java`
- `android/android/vendor/capacitor-community-sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/{KeyProtectionState,KeyProtectionStore,DeviceAuthenticator,UtilsSecret}.java`
- ADR-0005, ADR-0006, ADR-0008
- `.superpowers/sdd/phase8-plan/{research,phase8-design,phase8-plan}.md`
