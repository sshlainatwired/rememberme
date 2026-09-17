package com.getcapacitor.community.database.sqlite.SQLite;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * Deterministic, API-24-safe crash-recovery swap for the plaintext → SQLCipher
 * conversion, used by {@link UtilsSQLCipher#encrypt} and by the plugin's
 * pre-probe recovery hook (see {@code CapacitorSQLite.recoverDatabase}).
 *
 * <p>Upstream {@code UtilsSQLCipher.encrypt} wrote the encrypted copy to a
 * random cache-dir temp file and then executed {@code originalFile.delete()}
 * followed by {@code newFile.renameTo(originalFile)}. A process death between
 * the delete and the rename destroyed the only copy of the database; a death
 * mid-export left a non-deterministic cache temp; and the plaintext file's
 * {@code -journal}/{-wal}/{-shm} sidecars could later be applied to the
 * promoted encrypted main.
 *
 * <p>This helper replaces that sequence with a checked, idempotent protocol
 * using only deterministic artifacts next to the database:
 * <ul>
 *   <li>{@code <main>.encrypting} — the fsynced encrypted candidate;</li>
 *   <li>{@code <main>.plain.bak} — the durable plaintext original (backup).</li>
 * </ul>
 * Sidecars ({@code -journal}, {@code -wal}, {@code -shm}) are removed only
 * after every handle is closed, so plaintext sidecars never apply to the
 * promoted encrypted main. All renames are checked; the plaintext original is
 * never deleted until the promoted main is positively verified to open with
 * the stored secret. Recovery is idempotent and fails closed on ambiguous
 * states, never deleting a file it cannot classify.
 *
 * <p>This class is deliberately {@code java.io}-only (no {@code java.nio}
 * file-API surface) so it compiles and runs on API 24. The SQLCipher opens
 * are isolated behind {@link Verifier} so the decision logic can be exercised
 * by host-JVM unit tests (see {@code EncryptionFileSwapTest} in the app
 * module). Every filesystem mutation (rename, delete, fsync, existence) is
 * routed through the package-private {@link FileOps} seam so same-package
 * host-JVM tests can deterministically force failures at exact points without
 * relying on OS permission quirks. The public constructors and methods always
 * use the real {@code java.io} behaviour ({@link #REAL}); the fault-injection
 * constructor is package-private and never exposed to plugin callers.
 */
public class EncryptionFileSwap {

    /** Deterministic in-place temp name for the encrypted candidate. */
    public static final String ENCRYPTING_SUFFIX = ".encrypting";

    /** Deterministic in-place backup name for the plaintext original. */
    public static final String PLAIN_BACKUP_SUFFIX = ".plain.bak";

    private static final String[] SIDECAR_SUFFIXES = {"-journal", "-wal", "-shm"};

    /**
     * Content-verification seam. The production implementation (in
     * {@code UtilsSQLCipher}) really opens the file with SQLCipher and reads
     * a page; host-JVM unit tests stub this over marker file content.
     */
    public interface Verifier {
        /** True iff the file opens and reads as an encrypted database with the stored secret. */
        boolean opensEncryptedWithSecret(File file);

        /** True iff the file opens and reads as an unencrypted (plaintext) database. */
        boolean opensPlaintext(File file);
    }

    /**
     * Injectable filesystem-operation seam (package-private). Production wires
     * {@link #REAL}; same-package host-JVM tests substitute a deterministic
     * fake that forces {@code rename}/{@code delete}/{@code fsync} to fail at
     * exact points (deciding by source/target path) without OS permission
     * quirks. {@code exists}/{@code isFile} are read-only and default to the
     * real {@code File} behaviour so the fake only overrides what it must.
     */
    interface FileOps {
        boolean exists(File f);

        boolean isFile(File f);

        /** {@link File#renameTo} semantics: true on success, false on failure. */
        boolean rename(File from, File to);

        /** {@link File#delete} semantics: true on success, false on failure. */
        boolean delete(File f);

        /** API-24-safe non-truncating fsync. */
        void fsync(File f) throws IOException;
    }

    /** Real {@code java.io} filesystem operations. */
    static final FileOps REAL = new FileOps() {
        @Override
        public boolean exists(File f) {
            return f.exists();
        }

        @Override
        public boolean isFile(File f) {
            return f.isFile();
        }

        @Override
        public boolean rename(File from, File to) {
            return from.renameTo(to);
        }

        @Override
        public boolean delete(File f) {
            return f.delete();
        }

        @Override
        public void fsync(File f) throws IOException {
            fsyncNoTruncate(f);
        }
    };

    private final File main;
    private final File tmp;
    private final File bak;
    private final FileOps ops;

    /**
     * @param mainFile the live database file (e.g. {@code remembermeSQLite.db});
     *     any existing {@code <main>.encrypting}/{@code <main>.plain.bak}
     *     siblings are derived from it in the same directory.
     */
    public EncryptionFileSwap(File mainFile) {
        this(mainFile, REAL);
    }

    /**
     * Package-private fault-injection seam: identical to the public
     * constructor but routes every filesystem mutation through {@code ops}.
     * Used only by same-package host-JVM tests; plugin callers always get the
     * real {@code java.io} behaviour.
     */
    EncryptionFileSwap(File mainFile, FileOps ops) {
        if (mainFile == null) {
            throw new NullPointerException("mainFile");
        }
        if (ops == null) {
            throw new NullPointerException("ops");
        }
        File dir = mainFile.getParentFile();
        if (dir == null) {
            throw new NullPointerException("mainFile has no parent directory");
        }
        this.main = mainFile;
        String name = mainFile.getName();
        this.tmp = new File(dir, name + ENCRYPTING_SUFFIX);
        this.bak = new File(dir, name + PLAIN_BACKUP_SUFFIX);
        this.ops = ops;
    }

    public File getMain() {
        return main;
    }

    public File getEncryptingFile() {
        return tmp;
    }

    public File getPlainBackupFile() {
        return bak;
    }

    /** True when deterministic conversion artifacts exist next to main. */
    public boolean hasArtifacts() {
        return ops.exists(tmp) || ops.exists(bak);
    }

    /** The {@code -journal}/{-wal}/{-shm} sidecar files of a database file. */
    public static File[] sidecars(File dbFile) {
        String base = dbFile.getAbsolutePath();
        File[] result = new File[SIDECAR_SUFFIXES.length];
        for (int i = 0; i < SIDECAR_SUFFIXES.length; i++) {
            result[i] = new File(base + SIDECAR_SUFFIXES[i]);
        }
        return result;
    }

    /**
     * fsync a database file WITHOUT truncating it. Append mode
     * ({@code append = true}) never truncates; {@code getFD().sync()} flushes
     * the SQLCipher-written pages. Call only after the last handle to the
     * file has been closed.
     */
    public static void fsyncNoTruncate(File file) throws IOException {
        FileOutputStream out = new FileOutputStream(file, true);
        try {
            out.getFD().sync();
        } finally {
            out.close();
        }
    }

    /** Delete each sidecar of {@code dbFile} if present; fails closed if any remains (real io). */
    public static void deleteSidecars(File dbFile) throws IOException {
        for (File sidecar : sidecars(dbFile)) {
            realDeleteChecked(sidecar, "sidecar");
        }
    }

    /**
     * Delete the sidecars of {@code dbFile} through the injected {@code ops}
     * seam (fault-injectable). Used by the internal recovery/commit paths.
     */
    private void deleteSidecarsViaOps(File dbFile) throws IOException {
        for (File sidecar : sidecars(dbFile)) {
            deleteChecked(sidecar, "sidecar");
        }
    }

    private void deleteChecked(File file, String what) throws IOException {
        if (ops.exists(file) && !ops.delete(file)) {
            throw new IOException("cannot delete " + what + " " + file.getAbsolutePath());
        }
    }

    private static void realDeleteChecked(File file, String what) throws IOException {
        if (file.exists() && !file.delete()) {
            throw new IOException("cannot delete " + what + " " + file.getAbsolutePath());
        }
    }

    private void renameChecked(File from, File to, String what) throws IOException {
        if (!ops.exists(from)) {
            throw new IOException(what + " source missing: " + from.getAbsolutePath());
        }
        if (ops.exists(to)) {
            throw new IOException(what + " target already exists (fail closed): " + to.getAbsolutePath());
        }
        if (!ops.rename(from, to)) {
            throw new IOException(what + " rename failed: " + from.getAbsolutePath() + " -> " + to.getAbsolutePath());
        }
    }

    /**
     * Idempotent deterministic recovery of an interrupted conversion, driven
     * by actual content state via {@code verifier}. Every branch keeps or
     * restores a durable recoverable copy; nothing is ever deleted unless the
     * surviving file is positively verified. See the ADR-0005 recovery state
     * table and {@code EncryptionFileSwapTest} for the full matrix.
     */
    public void recover(Verifier verifier) throws IOException {
        boolean hasTmp = ops.exists(tmp);
        boolean hasBak = ops.exists(bak);
        boolean hasMain = ops.exists(main);
        if (!hasTmp && !hasBak) {
            return; // clean state: the healthy database is left untouched.
        }

        boolean mainEncrypted = false;
        boolean mainPlaintext = false;
        boolean tmpEncrypted = false;
        if (hasMain) {
            mainEncrypted = verifier.opensEncryptedWithSecret(main);
            mainPlaintext = verifier.opensPlaintext(main);
        }
        if (hasTmp) {
            tmpEncrypted = verifier.opensEncryptedWithSecret(tmp);
        }

        // tmp-only, main absent: the only potential data. Promote if the
        // candidate verifies; never silently delete the only potential copy.
        // Promotion is fsync-first (promoteRecoveryCandidate): a crash can
        // leave an unflushed candidate, so it is made durable before rename.
        if (hasTmp && !hasBak && !hasMain) {
            if (tmpEncrypted) {
                promoteRecoveryCandidate(verifier);
                return;
            }
            throw new IOException(
                "recovery: only artifact is an unverifiable .encrypting file; preserved, no action taken: "
                    + tmp.getAbsolutePath());
        }

        // Interrupted between main->bak and tmp->main: both copies exist.
        if (hasTmp && hasBak && !hasMain) {
            if (tmpEncrypted) {
                promoteRecoveryCandidate(verifier);
                releaseBackup();
            } else {
                restoreBackup(verifier);
                deleteStaleTmp();
            }
            return;
        }

        // main absent, durable backup present: restore it.
        if (!hasTmp && hasBak && !hasMain) {
            restoreBackup(verifier);
            return;
        }

        if (hasTmp && hasMain && !hasBak) {
            if (mainEncrypted) {
                // main is positively verified encrypted: tmp is stale debris.
                deleteStaleTmp();
                return;
            }
            if (mainPlaintext && tmpEncrypted) {
                // plaintext main + complete encrypted candidate: finish the swap.
                // fsync-first promotion makes the interrupted candidate durable
                // before it is renamed over the plaintext main.
                promoteRecoveryCandidate(verifier);
                return;
            }
            if (mainPlaintext) {
                // main (authoritative) confirmed plaintext; tmp unverifiable -> stale.
                deleteStaleTmp();
                return;
            }
            throw new IOException(
                "recovery: main state unknown and .encrypting unverifiable; both preserved: " + main.getAbsolutePath());
        }

        // main + backup: never release or overwrite anything unless main is
        // positively verified encrypted with the stored secret.
        if (!hasTmp && hasMain && hasBak) {
            if (mainEncrypted) {
                releaseBackup();
                return;
            }
            throw new IOException(
                "recovery: ambiguous main + .plain.bak (main not verified encrypted with the stored secret); "
                    + "fail closed, both preserved: " + main.getAbsolutePath());
        }

        if (hasTmp && hasMain && hasBak) {
            if (mainEncrypted) {
                deleteStaleTmp();
                releaseBackup();
                return;
            }
            throw new IOException(
                "recovery: ambiguous main + .plain.bak with .encrypting present (main not verified encrypted); "
                    + "fail closed, all preserved: " + main.getAbsolutePath());
        }

        throw new IOException("recovery: unreachable file state");
    }

    /**
     * Checked swap used by the conversion itself, after the encrypted
     * candidate has been fully written and closed. This method makes the
     * candidate durable first (fsync via the ops seam, nontruncating append
     * mode) BEFORE any sidecar deletion or rename, then performs the swap:
     * {@code main → .plain.bak}, {@code .encrypting → main}, verify the
     * promoted main with the stored secret, and only then delete the backup.
     * If the second rename or the verification fails, a checked rollback
     * restores the plaintext original and the (possibly failed) candidate is
     * preserved as {@code .encrypting}, leaving a deterministic state.
     */
    public void commit(Verifier verifier) throws IOException {
        if (!ops.exists(tmp)) {
            throw new IOException("commit: encrypted candidate missing: " + tmp.getAbsolutePath());
        }
        if (ops.exists(bak)) {
            throw new IOException(
                "commit: unexpected .plain.bak present (recover() must run first): " + bak.getAbsolutePath());
        }
        // fsync-ordering hardening: make the candidate durable BEFORE any sidecar
        // deletion or rename, so a crash right after commit() can never leave a
        // promoted main whose pages were never flushed. Routed through the ops
        // seam (REAL = nontruncating append-mode FileOutputStream); a failing
        // fsync aborts with the plaintext main + candidate intact and no rename.
        ops.fsync(tmp);
        if (!ops.exists(main)) {
            // Nothing to back up; promote the verified candidate directly.
            if (!verifier.opensEncryptedWithSecret(tmp)) {
                throw new IOException("commit: candidate does not open with the stored secret; aborting without deletion");
            }
            promoteIntoAbsentMain(verifier);
            return;
        }
        if (!verifier.opensPlaintext(main)) {
            throw new IOException(
                "commit: main is not a plaintext database; refusing to convert: " + main.getAbsolutePath());
        }
        promoteWithBackup(verifier);
    }

    /**
     * Recovery promotion: make the interrupted candidate durable BEFORE any
     * rename. commit() fsyncs before delegating, but a recovery candidate (a
     * crash-leftover .encrypting, e.g. from a death before commit()'s fsync)
     * may never have been flushed — promoting it without fsync would install
     * pages that are not durably on disk. Every recover() branch that can
     * rename tmp→main routes through this single helper so no path can skip
     * the fsync; a failing fsync throws before anything is deleted or
     * renamed, and the candidate/backup artifacts stay data-preserving.
     */
    private void promoteRecoveryCandidate(Verifier verifier) throws IOException {
        ops.fsync(tmp);
        if (ops.exists(main)) {
            promoteWithBackup(verifier);
        } else {
            promoteIntoAbsentMain(verifier);
        }
    }

    private void promoteIntoAbsentMain(Verifier verifier) throws IOException {
        deleteSidecarsViaOps(tmp); // candidate's own journals must not follow it.
        renameChecked(tmp, main, "promote .encrypting to main");
        if (!verifier.opensEncryptedWithSecret(main)) {
            try {
                renameChecked(main, tmp, "rollback unverified promote");
            } catch (IOException rollback) {
                throw new IOException(
                    "recovery: promoted main failed verification and rollback failed; deterministic state preserved: "
                        + main.getAbsolutePath(),
                    rollback);
            }
            throw new IOException(
                "recovery: promoted main failed verification; rolled back to .encrypting: " + main.getAbsolutePath());
        }
        deleteSidecarsViaOps(main);
    }

    private void promoteWithBackup(Verifier verifier) throws IOException {
        // Handles are closed at this point: strip the plaintext main's
        // sidecars so they can never apply to the encrypted main, then swap.
        deleteSidecarsViaOps(main);
        deleteSidecarsViaOps(tmp);
        renameChecked(main, bak, "main -> .plain.bak");
        try {
            renameChecked(tmp, main, ".encrypting -> main");
        } catch (IOException e) {
            try {
                renameChecked(bak, main, "rollback .plain.bak -> main");
            } catch (IOException rollback) {
                throw new IOException(
                    "recovery: .encrypting -> main rename failed AND rollback failed; deterministic state preserved "
                        + "(backup at .plain.bak, candidate at .encrypting)",
                    e);
            }
            throw new IOException("recovery: .encrypting -> main rename failed; backup restored", e);
        }
        if (!verifier.opensEncryptedWithSecret(main)) {
            try {
                renameChecked(main, tmp, "unverified encrypted main -> .encrypting");
                renameChecked(bak, main, ".plain.bak restore");
            } catch (IOException rollback) {
                throw new IOException(
                    "recovery: promoted main failed verification and rollback could not complete; deterministic state "
                        + "preserved (re-checked on next startup)",
                    rollback);
            }
            deleteSidecarsViaOps(main);
            throw new IOException("recovery: promoted main failed verification; restored plaintext backup");
        }
        deleteSidecarsViaOps(main);
        releaseBackup();
    }

    /**
     * Restore the durable plaintext backup to main; a present main is
     * displaced, never deleted. Fails closed BEFORE any mutation when the
     * backup does not positively open as plaintext (corrupt or foreign
     * content): the backup is preserved untouched and an error is thrown
     * rather than promoting unverifiable bytes over main.
     */
    private void restoreBackup(Verifier verifier) throws IOException {
        if (!verifier.opensPlaintext(bak)) {
            throw new IOException(
                "restoreBackup: .plain.bak does not open as a plaintext database; "
                    + "plaintext backup preserved, fail closed, no mutation: "
                    + bak.getAbsolutePath());
        }
        if (ops.exists(main)) {
            deleteSidecarsViaOps(main);
            renameChecked(main, tmp, "displace unverified main to .encrypting");
        }
        renameChecked(bak, main, ".plain.bak -> main restore");
        deleteSidecarsViaOps(main); // stale sidecars of the displaced file; restored main is plaintext.
        deleteSidecarsViaOps(bak); // bak path no longer exists; drop its stale sidecars.
        deleteSidecarsViaOps(tmp);
    }

    /**
     * Delete the durable plaintext backup. Callers must have positively
     * verified that main opens encrypted with the stored secret.
     */
    private void releaseBackup() throws IOException {
        deleteSidecarsViaOps(bak);
        deleteChecked(bak, "plaintext backup");
    }

    private void deleteStaleTmp() throws IOException {
        deleteSidecarsViaOps(tmp);
        deleteChecked(tmp, "stale .encrypting candidate");
    }
}
