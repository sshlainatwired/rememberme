package com.getcapacitor.community.database.sqlite.SQLite;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import net.zetetic.database.sqlcipher.SQLiteDatabase;
import net.zetetic.database.sqlcipher.SQLiteStatement;

public class UtilsSQLCipher {

    private static final String TAG = UtilsSQLCipher.class.getName();

    /**
     * The detected state of the database, based on whether we can
     * open it without a passphrase, with the passphrase 'secret'.
     */
    public enum State {
        DOES_NOT_EXIST,
        UNENCRYPTED,
        ENCRYPTED_SECRET,
        ENCRYPTED_GLOBAL_SECRET,
        UNKNOWN
    }

    /**
     * Determine whether or not this database appears to be encrypted,
     * based on whether we can open it without a passphrase or with
     * the passphrase 'secret'.
     *
     * @param dbPath a File pointing to the database
     * @param sharedPreferences an instance of SharedPreferences
     * @param globVar an instance of GlobalSQLite
     * @return the detected state of the database
     */
    public State getDatabaseState(Context ctxt, File dbPath, SharedPreferences sharedPreferences, GlobalSQLite globVar) {
        System.loadLibrary("sqlcipher");
        if (dbPath.exists()) {
            SQLiteDatabase db = null;

            try {
                db = SQLiteDatabase.openDatabase(dbPath.getAbsolutePath(), "", null, SQLiteDatabase.OPEN_READONLY, null);

                db.getVersion();

                return State.UNENCRYPTED;
            } catch (Exception e) {
                try {
                    String passphrase = sharedPreferences.getString("secret", "");
                    if (passphrase.length() > 0) {
                        db = SQLiteDatabase.openDatabase(dbPath.getAbsolutePath(), passphrase, null, SQLiteDatabase.OPEN_READONLY, null);
                        db.getVersion();
                        return State.ENCRYPTED_SECRET;
                    } else {
                        return State.UNKNOWN;
                    }
                } catch (Exception e1) {
                    try {
                        if (globVar.secret.length() > 0) {
                            db = SQLiteDatabase.openDatabase(
                                dbPath.getAbsolutePath(),
                                globVar.secret,
                                null,
                                SQLiteDatabase.OPEN_READONLY,
                                null
                            );
                            db.getVersion();
                            return State.ENCRYPTED_GLOBAL_SECRET;
                        } else {
                            return State.UNKNOWN;
                        }
                    } catch (Exception e2) {
                        return State.UNKNOWN;
                    }
                }
            } finally {
                if (db != null) {
                    db.close();
                }
            }
        }

        return State.DOES_NOT_EXIST;
    }

    /**
     * Replaces this database with a version encrypted with the supplied
     * passphrase, using a deterministic, crash-recoverable swap.
     * Do not call this while the database is open.
     *
     * <p>The upstream implementation wrote the encrypted copy to a random
     * cache-dir temp file and then deleted the original before renaming the
     * temp into place; a process death between those two steps destroyed the
     * only copy. This patched version writes the encrypted candidate to
     * {@code <main>.encrypting} in the same databases directory, fsyncs it
     * without truncation, swaps {@code main → <main>.plain.bak} then
     * {@code <main>.encrypting → main} with every rename checked, verifies
     * the promoted main opens with the supplied secret, and only then deletes
     * the plaintext backup. Sidecars are removed after every handle closes so
     * plaintext journals never apply to the encrypted main. Recovery of an
     * interrupted previous conversion runs first and is idempotent (see
     * {@link EncryptionFileSwap} and ADR-0005).
     *
     * The passphrase is untouched in this call.
     *
     * @param ctxt a Context (unused by the deterministic protocol; kept for signature compatibility)
     * @param originalFile a File pointing to the database
     * @param passphrase the passphrase from the user
     * @throws IOException
     */
    public void encrypt(Context ctxt, File originalFile, byte[] passphrase) throws IOException {
        System.loadLibrary("sqlcipher");

        if (originalFile.exists()) {
            final String secret = (passphrase == null) ? "" : new String(passphrase, StandardCharsets.UTF_8);
            final EncryptionFileSwap swap = new EncryptionFileSwap(originalFile);
            final EncryptionFileSwap.Verifier verifier = verifierFor(secret);

            // Complete any interrupted previous conversion deterministically
            // (idempotent) before starting a fresh one.
            swap.recover(verifier);

            SQLiteDatabase db = null;
            SQLiteStatement st = null;
            try {
                int version;
                db = SQLiteDatabase.openDatabase(originalFile.getAbsolutePath(), "", null, SQLiteDatabase.OPEN_READWRITE, null);
                version = db.getVersion();
                db.close();
                db = null;

                // Deterministic in-place temp: <main>.encrypting next to main,
                // never a random cache-dir file.
                File tmp = swap.getEncryptingFile();
                if (!tmp.createNewFile()) {
                    throw new IOException("cannot create deterministic temp " + tmp.getAbsolutePath());
                }

                db = SQLiteDatabase.openDatabase(tmp.getAbsolutePath(), secret, null, SQLiteDatabase.OPEN_READWRITE, null, null);
                StringBuilder sql = new StringBuilder();
                sql.append("ATTACH DATABASE ? AS plaintext KEY ");
                sql.append("'';");
                st = db.compileStatement(sql.toString());

                st.bindString(1, originalFile.getAbsolutePath());
                st.execute();

                StringBuilder sql1 = new StringBuilder();
                sql1.append("SELECT sqlcipher_export('main', 'plaintext');");
                db.rawExecSQL(sql1.toString());
                StringBuilder sql2 = new StringBuilder();
                sql2.append("DETACH DATABASE plaintext;");
                db.rawExecSQL(sql2.toString());

                db.setVersion(version);
                st.close();
                st = null;
                db.close();
                db = null;

                // The candidate fsync (nontruncating append mode) is owned by
                // EncryptionFileSwap.commit(), which routes ops.fsync(tmp) before any
                // sidecar deletion or rename — so encrypt() itself performs no
                // direct fsync that a different commit path could bypass.

                // Checked swap main -> .plain.bak, .encrypting -> main, verify
                // the promoted main with the secret, then release the backup.
                swap.commit(verifier);
            } finally {
                if (st != null) {
                    try {
                        st.close();
                    } catch (Exception ignore) {
                        // best effort; the original error is preserved
                    }
                }
                if (db != null) {
                    try {
                        db.close();
                    } catch (Exception ignore) {
                        // best effort; the original error is preserved
                    }
                }
            }
        } else {
            throw new FileNotFoundException(originalFile.getAbsolutePath() + " not found");
        }
    }

    /**
     * A content verifier for {@link EncryptionFileSwap} that really opens the
     * file with SQLCipher: {@code opensEncryptedWithSecret} passes the stored
     * secret; {@code opensPlaintext} passes an empty key. Every failure
     * (wrong key, not a database, missing file) returns {@code false}.
     */
    public EncryptionFileSwap.Verifier verifierFor(final String secret) {
        return new EncryptionFileSwap.Verifier() {
            @Override
            public boolean opensEncryptedWithSecret(File file) {
                return opensWith(file, secret);
            }

            @Override
            public boolean opensPlaintext(File file) {
                return opensWith(file, "");
            }
        };
    }

    private boolean opensWith(File file, String passphrase) {
        System.loadLibrary("sqlcipher");
        SQLiteDatabase db = null;
        try {
            db = SQLiteDatabase.openDatabase(file.getAbsolutePath(), passphrase, null, SQLiteDatabase.OPEN_READONLY, null);
            db.getVersion();
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            if (db != null) {
                try {
                    db.close();
                } catch (Exception ignore) {
                    // best effort
                }
            }
        }
    }

    /**
     * Decryption mode is disabled (fail-closed). The upstream implementation
     * wrote the plaintext copy to a random cache-dir temp, deleted the
     * encrypted original, renamed the temp unchecked, and used the default
     * charset for the passphrase — a pointless plaintext conversion that also
     * destroys the only encrypted copy on a crash between delete and rename.
     * RememberMe never uses decryption mode; refuse unconditionally with a
     * clear exception and no file access at all.
     *
     * @param ctxt a Context (unused; decryption is refused before any file access)
     * @param originalFile a File (unused; decryption is refused before any file access)
     * @param passphrase the passphrase (unused; decryption is refused before any file access)
     * @throws IOException always
     */
    public void decrypt(Context ctxt, File originalFile, byte[] passphrase) throws IOException {
        throw new UnsupportedOperationException(
            "decryption mode is disabled: converting an encrypted database back to plaintext is not supported"
        );
    }

    public void changePassword(Context ctxt, File file, String password, String nwpassword) throws Exception {
        System.loadLibrary("sqlcipher");

        if (file.exists()) {
            SQLiteDatabase db = SQLiteDatabase.openDatabase(file.getAbsolutePath(), password, null, SQLiteDatabase.OPEN_READWRITE, null);

            if (!db.isOpen()) {
                throw new Exception("database " + file.getAbsolutePath() + " open failed");
            }
            db.changePassword(nwpassword);
            db.close();
        } else {
            throw new FileNotFoundException(file.getAbsolutePath() + " not found");
        }
    }
}
