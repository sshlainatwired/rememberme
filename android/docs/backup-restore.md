# Backup and restore

RememberMe Android keeps journals and settings on-device in the encrypted SQLCipher database. Two offline transfer paths are supported:

## Portable password-encrypted backups (`.rmbak`)

- **Backup** encrypts every local journal entry plus portable settings (timezone, weekly-review enabled/hour, appearance) into a password-protected `.rmbak` file. Authentication credentials, the SQLCipher database key, notification permission state, and device-bound state are never exported.
- **Restore** decrypts on the device, previews additions/conflicts, and after explicit confirmation overwrites only matching dates and portable settings inside one SQLite transaction. Unrelated local entries, authentication, and biometric state stay intact. Any failure rolls back completely.
- The file is a strict versioned envelope: scrypt parameters (`N=32768, r=8, p=3, dkLen=64`) with a random salt, an HMAC password verifier, and AES-256-GCM authenticated content. Files are limited to 16 MiB and 10,000 rows; previews expire after five minutes.
- The password is never stored or exported. Mutable key/plaintext buffers are wiped; JavaScript strings and `CryptoKey` objects can only be released, not physically erased.

## One-time legacy web migration

The web server cannot be reached from the Android app. To move existing encrypted entries:

1. On the server, run the export command in the app directory:

   ```bash
   bun run journal:export-android -- --output ./rememberme-legacy-export.json
   ```

   The command requires exactly one configured user, refuses to overwrite an existing file (owner-only permissions), and exports only ciphertext columns and timestamps — never the encryption key, plaintext, email, or account data. The journal key is not needed to run it.

2. Move the JSON file to the device (e.g. USB, a file share, or cloud drive).

3. In the Android app: **Settings → Data transfer → Legacy migration**, pick the file, enter the web `JOURNAL_ENCRYPTION_KEY` (base64), review the preview, then confirm. Rows decrypt sequentially on-device and are written transactionally; wrong keys, corrupted rows, and malformed files write nothing and report a masked error.

## Error recovery

- A file that fails validation or decryption changes nothing on-device.
- If a restore fails mid-transaction, the previous data is restored automatically.
- Unsupported file versions, oversized files, or modified content are rejected with stable, user-safe messages.
