package app.rememberme.journal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.getcapacitor.community.database.sqlite.SQLite.EncryptionFileSwap;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import org.junit.Test;

/**
 * Host-JVM unit tests for {@link EncryptionFileSwap}'s recoverable
 * existence/state decisions (Phase 4 plaintext-conversion crash recovery,
 * ADR-0005).
 *
 * <p>These tests are java.io-only because the helper itself is java.io-only
 * (API-24 safe). The {@link EncryptionFileSwap.Verifier} is stubbed over file
 * content (marker bytes) so that renamed files are classified by their bytes,
 * mirroring how the real verifier's SQLCipher opens classify by actual page
 * content.
 *
 * <p><strong>Not executed on the authoring machine.</strong> No JDK is
 * installed here (and no device), so these tests compile-plausibly against the
 * pinned JUnit 4.13.2 but were NOT run; see ADR-0005 "Native verification
 * limitation". They are covered by the static contract in
 * {@code android/src/test/vendored-sqlite.vitest.ts} and are intended to run
 * in a provisioned CI/toolchain environment.
 *
 * <p>Coverage honesty: the second-rename failure branch ({@code renameTo}
 * returning false for {@code .encrypting→main}) is not cleanly injectable
 * through the public java.io-only API — renames run inside one temp
 * filesystem where {@code renameTo} succeeds, and the target-exists case fails
 * closed before {@code renameTo} is invoked. The equivalent checked-rollback
 * machinery is exercised through the verification-failure rollback
 * ({@link #commit_verifyFailure_rollsBackToPlaintextAndPreservesCandidate}),
 * and the fail-closed guards are exercised directly in the ambiguous-state
 * tests.
 */
public class EncryptionFileSwapTest {

    private static final String PLAIN = "SQLite format 3 PLAINTEXT-marker-0123456789abcdef";
    private static final String ENCRYPTED = "SQLite format 3 ENCRYPTED-marker-0123456789abcdef";
    private static final String GARBAGE = "certainly not any sqlite database file 0123456789abcdef";

    /** Content-based verifier: classifies a file by its leading marker bytes. */
    private static final class ContentVerifier implements EncryptionFileSwap.Verifier {
        @Override
        public boolean opensEncryptedWithSecret(File file) {
            return startsWith(file, ENCRYPTED);
        }

        @Override
        public boolean opensPlaintext(File file) {
            return startsWith(file, PLAIN);
        }

        private static boolean startsWith(File file, String marker) {
            if (!file.isFile()) {
                return false;
            }
            byte[] expected = marker.getBytes();
            byte[] actual = new byte[expected.length];
            int n;
            FileInputStream in = null;
            try {
                in = new FileInputStream(file);
                n = in.read(actual);
            } catch (IOException e) {
                return false;
            } finally {
                if (in != null) {
                    try {
                        in.close();
                    } catch (IOException ignore) {
                    }
                }
            }
            if (n != expected.length) {
                return false;
            }
            for (int i = 0; i < expected.length; i++) {
                if (actual[i] != expected[i]) {
                    return false;
                }
            }
            return true;
        }
    }

    private static File tempDir() throws IOException {
        File dir = File.createTempFile("efs-test-", ".dir");
        if (!dir.delete() || !dir.mkdir()) {
            throw new IOException("cannot create temp dir");
        }
        dir.deleteOnExit();
        return dir;
    }

    private static File file(File dir, String name) throws IOException {
        File f = new File(dir, name);
        f.deleteOnExit();
        return f;
    }

    private static void write(File f, String content) throws IOException {
        FileOutputStream out = new FileOutputStream(f);
        try {
            out.write(content.getBytes("US-ASCII"));
        } finally {
            out.close();
        }
    }

    private static void assertContent(File f, String expected) throws IOException {
        assertTrue("file exists: " + f.getAbsolutePath(), f.isFile());
        assertEquals("content of " + f.getName(), expected, readContent(f));
    }

    private static String readContent(File f) throws IOException {
        byte[] all = new byte[(int) f.length()];
        FileInputStream in = new FileInputStream(f);
        try {
            int off = 0;
            while (off < all.length) {
                int n = in.read(all, off, all.length - off);
                if (n < 0) {
                    break;
                }
                off += n;
            }
            return new String(all, "US-ASCII");
        } finally {
            in.close();
        }
    }

    @Test
    public void cleanState_noArtifacts_isNoop() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        new EncryptionFileSwap(main).recover(new ContentVerifier());
        assertContent(main, PLAIN);
        assertFalse(new File(dir, "dbSQLite.db.encrypting").exists());
        assertFalse(new File(dir, "dbSQLite.db.plain.bak").exists());
    }

    @Test
    public void tmpOnly_verifiedEncrypted_promotesIntoAbsentMain() throws IOException {
        File dir = tempDir();
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, ENCRYPTED);
        File main = file(dir, "dbSQLite.db");
        new EncryptionFileSwap(main).recover(new ContentVerifier());
        assertContent(main, ENCRYPTED);
        assertFalse(tmp.exists());
    }

    @Test
    public void tmpOnly_unverifiable_failsClosedAndPreservesTmp() throws IOException {
        File dir = tempDir();
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, GARBAGE);
        File main = file(dir, "dbSQLite.db");
        try {
            new EncryptionFileSwap(main).recover(new ContentVerifier());
            fail("tmp-only unverifiable state must fail closed");
        } catch (IOException expected) {
            // fail closed, nothing deleted
        }
        assertFalse(main.exists());
        assertTrue("only potential data preserved", tmp.exists());
    }

    @Test
    public void tmpAndPlaintextMain_verifiedTmp_completesSwapAndReleasesBackup() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, ENCRYPTED);
        new EncryptionFileSwap(main).recover(new ContentVerifier());
        assertContent(main, ENCRYPTED);
        assertFalse("backup released after positive verification", new File(dir, "dbSQLite.db.plain.bak").exists());
        assertFalse(tmp.exists());
    }

    @Test
    public void tmpAndPlaintextMain_staleTmp_deletedMainIsAuthoritative() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, GARBAGE);
        new EncryptionFileSwap(main).recover(new ContentVerifier());
        assertContent(main, PLAIN);
        assertFalse(tmp.exists());
    }

    @Test
    public void tmpAndEncryptedMain_verifiedMain_deletesStaleTmp() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, ENCRYPTED);
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, GARBAGE);
        new EncryptionFileSwap(main).recover(new ContentVerifier());
        assertContent(main, ENCRYPTED);
        assertFalse(tmp.exists());
        assertFalse(new File(dir, "dbSQLite.db.plain.bak").exists());
    }

    @Test
    public void tmpAndMain_unknownBoth_failsClosedPreservesEverything() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, GARBAGE);
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, GARBAGE);
        try {
            new EncryptionFileSwap(main).recover(new ContentVerifier());
            fail("unknown main + unverifiable tmp must fail closed");
        } catch (IOException expected) {
        }
        assertTrue(main.exists());
        assertTrue(tmp.exists());
    }

    @Test
    public void bakOnly_mainAbsent_restoresBackup() throws IOException {
        File dir = tempDir();
        File bak = file(dir, "dbSQLite.db.plain.bak");
        write(bak, PLAIN);
        File main = file(dir, "dbSQLite.db");
        new EncryptionFileSwap(main).recover(new ContentVerifier());
        assertContent(main, PLAIN);
        assertFalse(bak.exists());
    }

    @Test
    public void mainAndBak_encryptedVerifiedMain_releasesBackup() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, ENCRYPTED);
        File bak = file(dir, "dbSQLite.db.plain.bak");
        write(bak, PLAIN);
        new EncryptionFileSwap(main).recover(new ContentVerifier());
        assertContent(main, ENCRYPTED);
        assertFalse("backup deleted only after positive encryption verification", bak.exists());
    }

    @Test
    public void mainAndBak_plaintextMain_failsClosedAmbiguous() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        File bak = file(dir, "dbSQLite.db.plain.bak");
        write(bak, PLAIN);
        try {
            new EncryptionFileSwap(main).recover(new ContentVerifier());
            fail("ambiguous main-plaintext+bak must fail closed");
        } catch (IOException expected) {
        }
        assertContent(main, PLAIN);
        assertTrue(bak.exists());
    }

    @Test
    public void tmpBakNoMain_verifiedTmp_promotes() throws IOException {
        File dir = tempDir();
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, ENCRYPTED);
        File bak = file(dir, "dbSQLite.db.plain.bak");
        write(bak, PLAIN);
        File main = file(dir, "dbSQLite.db");
        new EncryptionFileSwap(main).recover(new ContentVerifier());
        assertContent(main, ENCRYPTED);
        assertFalse(tmp.exists());
        assertFalse(bak.exists());
    }

    @Test
    public void tmpBakNoMain_staleTmp_restoresBackupAndDeletesTmp() throws IOException {
        File dir = tempDir();
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, GARBAGE);
        File bak = file(dir, "dbSQLite.db.plain.bak");
        write(bak, PLAIN);
        File main = file(dir, "dbSQLite.db");
        new EncryptionFileSwap(main).recover(new ContentVerifier());
        assertContent(main, PLAIN);
        assertFalse(bak.exists());
        assertFalse(tmp.exists());
    }

    @Test
    public void tmpMainBak_encryptedMain_cleansStaleTmpAndBackup() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, ENCRYPTED);
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, GARBAGE);
        File bak = file(dir, "dbSQLite.db.plain.bak");
        write(bak, PLAIN);
        new EncryptionFileSwap(main).recover(new ContentVerifier());
        assertContent(main, ENCRYPTED);
        assertFalse(tmp.exists());
        assertFalse(bak.exists());
    }

    @Test
    public void tmpMainBak_plaintextMain_failsClosedAmbiguous() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, ENCRYPTED);
        File bak = file(dir, "dbSQLite.db.plain.bak");
        write(bak, PLAIN);
        try {
            new EncryptionFileSwap(main).recover(new ContentVerifier());
            fail("ambiguous main-plaintext+bak (with .encrypting) must fail closed");
        } catch (IOException expected) {
        }
        assertTrue(main.exists());
        assertTrue(tmp.exists());
        assertTrue(bak.exists());
    }

    @Test
    public void commit_successfulSwap_swapsVerifiesAndReleasesBackup() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, ENCRYPTED);
        new EncryptionFileSwap(main).commit(new ContentVerifier());
        assertContent(main, ENCRYPTED);
        assertFalse(tmp.exists());
        assertFalse(new File(dir, "dbSQLite.db.plain.bak").exists());
    }

    @Test
    public void commit_verifyFailure_rollsBackToPlaintextAndPreservesCandidate() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, GARBAGE); // passes commit()'s exists check but fails encrypted verification
        try {
            new EncryptionFileSwap(main).commit(new ContentVerifier());
            fail("promoted main failing secret verification must throw after rollback");
        } catch (IOException expected) {
        }
        // Checked rollback: plaintext restored, failed candidate preserved, backup gone.
        assertContent(main, PLAIN);
        assertTrue("failed candidate preserved as deterministic artifact", tmp.exists());
        assertFalse(new File(dir, "dbSQLite.db.plain.bak").exists());
        // Idempotent follow-up recovery removes the stale candidate.
        new EncryptionFileSwap(main).recover(new ContentVerifier());
        assertContent(main, PLAIN);
        assertFalse(tmp.exists());
    }

    @Test
    public void commit_mainAbsent_promotesVerifiedCandidate() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, ENCRYPTED);
        new EncryptionFileSwap(main).commit(new ContentVerifier());
        assertContent(main, ENCRYPTED);
        assertFalse(tmp.exists());
    }

    @Test
    public void commit_unverifiableCandidate_failsClosedWithoutDeleting() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, GARBAGE);
        try {
            new EncryptionFileSwap(main).commit(new ContentVerifier());
            fail("unverifiable candidate with no main must fail closed");
        } catch (IOException expected) {
        }
        assertFalse(main.exists());
        assertTrue(tmp.exists());
    }

    @Test
    public void fsyncNoTruncate_preservesContentAndLength() throws IOException {
        File dir = tempDir();
        File f = file(dir, "dbSQLite.db.encrypting");
        write(f, ENCRYPTED);
        EncryptionFileSwap.fsyncNoTruncate(f);
        assertContent(f, ENCRYPTED);
        assertEquals("append-mode sync must never truncate", ENCRYPTED.length(), f.length());
    }

    @Test
    public void deleteSidecars_removesJournalWalShm() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        File journal = file(dir, "dbSQLite.db-journal");
        File wal = file(dir, "dbSQLite.db-wal");
        File shm = file(dir, "dbSQLite.db-shm");
        write(journal, PLAIN);
        write(wal, PLAIN);
        write(shm, PLAIN);
        EncryptionFileSwap.deleteSidecars(main);
        assertFalse(journal.exists());
        assertFalse(wal.exists());
        assertFalse(shm.exists());
    }

    @Test
    public void hasArtifacts_trueWhenEncryptingOrBackupPresent() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        EncryptionFileSwap swap = new EncryptionFileSwap(main);
        assertFalse(swap.hasArtifacts());
        write(file(dir, "dbSQLite.db.encrypting"), ENCRYPTED);
        assertTrue(swap.hasArtifacts());
    }
}