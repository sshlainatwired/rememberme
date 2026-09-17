package com.getcapacitor.community.database.sqlite.SQLite;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import org.junit.Test;

/**
 * Host-JVM forced-failure tests for {@link EncryptionFileSwap}'s crash-recovery
 * protocol (Phase 4, ADR-0005). These close the untested rename/delete failure
 * paths that the public java.io-only API cannot exercise from outside the
 * package: by living in the SAME package as the helper, they can construct it
 * via the package-private {@code EncryptionFileSwap(File, FileOps)} seam and
 * route every filesystem mutation through a deterministic fake that forces
 * {@code rename}/{@code delete} to fail at exact points (deciding by
 * source/target path) with no reliance on OS permission quirks.
 *
 * <p>Backup-stays-authoritative is preserved: on every forced failure the
 * durable plaintext backup (or an explicit fail-closed state) remains and the
 * exception is propagated. No test weakens or bypasses the {@code Verifier}
 * checks.
 *
 * <p><strong>Not executed on the authoring machine.</strong> No JDK is
 * installed here (see ADR-0005 "Native verification limitation"), so these
 * tests compile-plausibly against the pinned JUnit 4.13.2 but were NOT run.
 * They are covered by the static contract in
 * {@code android/src/test/vendored-sqlite.vitest.ts} and are intended to run
 * in a provisioned CI/toolchain environment, alongside
 * {@code app.rememberme.journal.EncryptionFileSwapTest}.
 */
public class EncryptionFileSwapFaultsTest {

    private static final String PLAIN = "SQLite format 3 PLAINTEXT-marker-0123456789abcdef";
    private static final String ENCRYPTED = "SQLite format 3 ENCRYPTED-marker-0123456789abcdef";

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
            try {
                FileInputStream in = new FileInputStream(file);
                try {
                    n = in.read(actual);
                } finally {
                    in.close();
                }
            } catch (IOException e) {
                return false;
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

    /**
     * Deterministic filesystem fake. Every non-injected operation delegates to
     * the real {@code java.io} behaviour ({@link EncryptionFileSwap#REAL});
     * {@code rename}/{@code delete} consult the (optional) failure predicates
     * applied to the source/target, so a fault is forced at exactly one point
     * while everything else keeps working on the real temp filesystem.
     */
    private static final class FaultFileOps implements EncryptionFileSwap.FileOps {
        @FunctionalInterface
        interface Predicate {
            boolean test(File f);
        }

        Predicate failRenameFrom; // fail rename(from, to) when from matches
        Predicate failRenameTo; // fail rename(from, to) when to matches
        Predicate failDelete; // fail delete(f) when f matches
        Predicate failFsync; // fail fsync(f) when f matches

        @Override
        public boolean exists(File f) {
            return EncryptionFileSwap.REAL.exists(f);
        }

        @Override
        public boolean isFile(File f) {
            return EncryptionFileSwap.REAL.isFile(f);
        }

        @Override
        public boolean rename(File from, File to) {
            if (failRenameFrom != null && failRenameFrom.test(from)) {
                return false;
            }
            if (failRenameTo != null && failRenameTo.test(to)) {
                return false;
            }
            return EncryptionFileSwap.REAL.rename(from, to);
        }

        @Override
        public boolean delete(File f) {
            if (failDelete != null && failDelete.test(f)) {
                return false;
            }
            return EncryptionFileSwap.REAL.delete(f);
        }

        @Override
        public void fsync(File f) throws IOException {
            if (failFsync != null && failFsync.test(f)) {
                throw new IOException("forced fsync failure: " + f.getAbsolutePath());
            }
            EncryptionFileSwap.REAL.fsync(f);
        }
    }

    private static File tempDir() throws IOException {
        File dir = File.createTempFile("efs-fault-", ".dir");
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
        byte[] all = new byte[(int) f.length()];
        try {
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
            } finally {
                in.close();
            }
        } catch (IOException e) {
            throw new IOException("cannot read " + f.getAbsolutePath(), e);
        }
        assertEquals("content of " + f.getName(), expected, new String(all, "US-ASCII"));
    }

    private static boolean suffix(File f, String s) {
        return f.getName().endsWith(s);
    }

    // ---- forced-failure: second rename (.encrypting -> main) fails, rollback succeeds ----

    @Test
    public void secondRenameFails_rollbackSucceeds() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, ENCRYPTED);

        // Fail only the `.encrypting -> main` rename; allow `.plain.bak -> main`.
        FaultFileOps ops = new FaultFileOps();
        ops.failRenameFrom = f -> suffix(f, EncryptionFileSwap.ENCRYPTING_SUFFIX);

        try {
            new EncryptionFileSwap(main, ops).commit(new ContentVerifier());
            fail("second rename failing must throw");
        } catch (IOException expected) {
            assertTrue("backup restored reported", expected.getMessage().contains("backup restored"));
        }
        // Checked rollback restored the plaintext original from the durable backup.
        assertContent(main, PLAIN);
        assertFalse("backup moved back to main", new File(dir, "dbSQLite.db.plain.bak").exists());
        assertTrue("candidate preserved for retry", tmp.exists());
    }

    // ---- forced-failure: second rename fails AND rollback fails ----

    @Test
    public void secondRenameFails_rollbackFails() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, ENCRYPTED);

        // Fail every rename that targets main (i.e. both `.encrypting -> main`
        // and the rollback `.plain.bak -> main`).
        FaultFileOps ops = new FaultFileOps();
        File mainPath = main;
        ops.failRenameTo = f -> f.equals(mainPath);

        try {
            new EncryptionFileSwap(main, ops).commit(new ContentVerifier());
            fail("second rename failing AND rollback failing must throw");
        } catch (IOException expected) {
            assertTrue("rollback failure reported", expected.getMessage().contains("rollback failed"));
        }
        // Deterministic fail-closed state: nothing destroyed, the durable backup
        // and the candidate both survive for the next recovery pass.
        assertFalse("main absent (swap incomplete)", main.exists());
        assertTrue("durable plaintext backup preserved", new File(dir, "dbSQLite.db.plain.bak").exists());
        assertTrue("encrypted candidate preserved", tmp.exists());
    }

    // ---- forced-failure: candidate fsync fails inside commit, before any rename ----

    @Test
    public void fsyncFails_preservesPlaintextMainAndCandidate_noRename() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, ENCRYPTED);

        // Fail only the candidate's fsync inside commit(); renames/deletes stay real.
        FaultFileOps ops = new FaultFileOps();
        File tmpPath = tmp;
        ops.failFsync = f -> f.equals(tmpPath);

        try {
            new EncryptionFileSwap(main, ops).commit(new ContentVerifier());
            fail("candidate fsync failing must throw");
        } catch (IOException expected) {
            assertTrue("fsync failure reported", expected.getMessage().contains("fsync"));
        }
        // Fail-closed: no sidecar deletion, no rename, no backup staged — the
        // authoritative plaintext main and the (not-yet-durable) candidate both
        // survive untouched and no .plain.bak was created.
        assertContent(main, PLAIN);
        assertTrue("candidate preserved for retry", tmp.exists());
        assertFalse("no rename happened", new File(dir, "dbSQLite.db.plain.bak").exists());
    }

    // ---- forced-failure: recovery promotion fsync fails, before any rename ----

    @Test
    public void recoveryFsyncFails_tmpAndBak_noRename_artifactsPreserved() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        // Interrupted conversion (tmp + bak, main absent): recovery would
        // promote the verified candidate, but the candidate may never have
        // been flushed (crash before commit()'s fsync) — recovery must fsync
        // it before renaming, and a failing fsync must abort before any
        // mutation while every artifact stays data-preserving.
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, ENCRYPTED);
        File bak = file(dir, "dbSQLite.db.plain.bak");
        write(bak, PLAIN);

        FaultFileOps ops = new FaultFileOps();
        File tmpPath = tmp;
        ops.failFsync = f -> f.equals(tmpPath);

        try {
            new EncryptionFileSwap(main, ops).recover(new ContentVerifier());
            fail("recovery candidate fsync failing must throw");
        } catch (IOException expected) {
            assertTrue("fsync failure reported", expected.getMessage().contains("fsync"));
        }
        // Fail-closed: fsync precedes any rename or delete, so tmp and the
        // durable backup both survive with their content intact and main was
        // never created (no promote happened).
        assertContent(tmp, ENCRYPTED);
        assertContent(bak, PLAIN);
        assertFalse("no promote happened", main.exists());
    }

    // ---- forced-failure: corrupt backup + corrupt candidate, main absent, fail closed ----

    @Test
    public void corruptBakAndTmp_failsClosed_preservesAllArtifacts() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        // Interrupted conversion whose only copies are corrupt: neither the
        // candidate nor the durable backup verifies. Recovery (tmp+bak, main
        // absent, tmp unverifiable) routes to restore-the-backup, which must
        // reject the corrupt .plain.bak BEFORE any rename/delete — a
        // restorable plaintext original is never guessed.
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, "CORRUPTED-" + ENCRYPTED);
        File bak = file(dir, "dbSQLite.db.plain.bak");
        write(bak, "CORRUPTED-" + PLAIN);

        // Every mutation predicate fails: if restoreBackup (or any other
        // branch) attempted a rename/delete instead of the verification check,
        // the forced failure would surface a different error than the
        // fail-closed verification one.
        FaultFileOps ops = new FaultFileOps();
        ops.failRenameFrom = f -> true;
        ops.failRenameTo = f -> true;
        ops.failDelete = f -> true;

        try {
            new EncryptionFileSwap(main, ops).recover(new ContentVerifier());
            fail("corrupt backup must fail closed before any mutation");
        } catch (IOException expected) {
            assertTrue("backup verification reported", expected.getMessage().contains("plaintext backup"));
        }
        // Fail-closed: the unverifiable artifacts are preserved untouched and
        // main was never created (no rename/delete happened).
        assertContent(tmp, "CORRUPTED-" + ENCRYPTED);
        assertContent(bak, "CORRUPTED-" + PLAIN);
        assertFalse("no main created", main.exists());
    }

    // ---- forced-failure: sidecar delete fails before the swap ----

    @Test
    public void sidecarDeleteFails_beforeSwap() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, ENCRYPTED);
        File journal = file(dir, "dbSQLite.db-journal");
        write(journal, PLAIN); // a real sidecar that must be stripped before the swap

        FaultFileOps ops = new FaultFileOps();
        ops.failDelete = f -> suffix(f, "-journal");

        try {
            new EncryptionFileSwap(main, ops).commit(new ContentVerifier());
            fail("sidecar deletion failing before the swap must throw");
        } catch (IOException expected) {
            assertTrue("sidecar deletion reported", expected.getMessage().contains("sidecar"));
        }
        // Nothing renamed: authoritative plaintext main is untouched.
        assertContent(main, PLAIN);
        assertTrue("no swap happened, candidate untouched", tmp.exists());
        assertTrue("durable backup not created", !new File(dir, "dbSQLite.db.plain.bak").exists());
    }

    // ---- forced-failure: backup delete fails after verified promotion ----

    @Test
    public void backupDeleteFails_afterVerifiedPromotion() throws IOException {
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");
        write(main, PLAIN);
        File tmp = file(dir, "dbSQLite.db.encrypting");
        write(tmp, ENCRYPTED);

        FaultFileOps ops = new FaultFileOps();
        ops.failDelete = f -> suffix(f, EncryptionFileSwap.PLAIN_BACKUP_SUFFIX);

        try {
            new EncryptionFileSwap(main, ops).commit(new ContentVerifier());
            fail("backup delete failing after verified promotion must throw");
        } catch (IOException expected) {
            assertTrue("backup release reported", expected.getMessage().contains("plaintext backup"));
        }
        // Promotion and verification already succeeded; the only failure is the
        // final release of the durable backup, which stays preserved.
        assertContent(main, ENCRYPTED);
        assertFalse("candidate promoted into main", tmp.exists());
        assertTrue("durable plaintext backup preserved for rollback", new File(dir, "dbSQLite.db.plain.bak").exists());
        // A subsequent recovery pass releases the leftover backup.
        new EncryptionFileSwap(main).recover(new ContentVerifier());
        assertContent(main, ENCRYPTED);
        assertFalse("backup released on retry", new File(dir, "dbSQLite.db.plain.bak").exists());
    }

    // ---- idempotent recovery from the artifacts each failure leaves ----

    @Test
    public void recoveryIdempotent_fromLeftoverArtifacts() throws IOException {
        ContentVerifier verifier = new ContentVerifier();
        File dir = tempDir();
        File main = file(dir, "dbSQLite.db");

        // Leftover A: state left by second-rename-fail + rollback-fail.
        File tmpA = file(dir, "dbSQLite.db.encrypting");
        write(tmpA, ENCRYPTED);
        File bakA = file(dir, "dbSQLite.db.plain.bak");
        write(bakA, PLAIN);
        // No main: swap was incomplete. First pass promotes the verified candidate.
        new EncryptionFileSwap(main, EncryptionFileSwap.REAL).recover(verifier);
        assertContent(main, ENCRYPTED);
        assertFalse("candidate promoted", tmpA.exists());
        assertFalse("backup released after verified promotion", bakA.exists());
        // A second pass is a no-op: the first pass already converged.
        new EncryptionFileSwap(main, EncryptionFileSwap.REAL).recover(verifier);
        assertContent(main, ENCRYPTED);
        assertFalse("backup remains absent", bakA.exists());

        // Leftover B: state left by sidecar-delete-fail before the swap (a
        // complete candidate + authoritative plaintext main + stale sidecar).
        File main2 = file(dir, "db2.db");
        write(main2, PLAIN);
        File tmp2 = file(dir, "db2.db.encrypting");
        write(tmp2, ENCRYPTED);
        File wal2 = file(dir, "db2.db-wal");
        write(wal2, PLAIN);
        new EncryptionFileSwap(main2, EncryptionFileSwap.REAL).recover(verifier);
        assertContent(main2, ENCRYPTED);
        assertFalse("candidate promoted", tmp2.exists());
        assertFalse("stale sidecar stripped", wal2.exists());
        assertFalse("backup released", new File(dir, "db2.db.plain.bak").exists());
    }
}
