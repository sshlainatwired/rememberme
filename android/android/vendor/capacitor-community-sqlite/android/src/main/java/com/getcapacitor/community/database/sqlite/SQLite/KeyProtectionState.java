package com.getcapacitor.community.database.sqlite.SQLite;

/**
 * Pure crash-state protocol for moving the SQLCipher passphrase between the
 * ordinary and user-authentication-bound encrypted preference stores.
 *
 * <p>This class deliberately has no Android dependencies. Store effects are
 * injected so host-JVM tests can prove ordering and every interrupted state.
 * A destination is always written and read back exactly before the source can
 * be removed; authority changes only after the authoritative copy is known.
 */
public final class KeyProtectionState {

    public enum Mode {
        DISABLED,
        ENABLING,
        ENABLED,
    }

    /** Durable store operations. Every mutating implementation must commit synchronously. */
    public interface Stores {
        String readMode() throws Exception;

        void writeMode(Mode mode) throws Exception;

        String readDisabledSecret() throws Exception;

        void writeDisabledSecret(String value) throws Exception;

        void clearDisabledSecret() throws Exception;

        String readProtectedSecret() throws Exception;

        void writeProtectedSecret(String value) throws Exception;

        void clearProtectedSecret() throws Exception;
    }

    private KeyProtectionState() {}

    /** Missing metadata upgrades existing installs as disabled; every other value is exact. */
    public static Mode decodeMode(String value) throws Exception {
        if (value == null) return Mode.DISABLED;
        for (Mode mode : Mode.values()) {
            if (mode.name().equals(value)) return mode;
        }
        throw new Exception("Unknown key-protection mode");
    }

    public static Mode readMode(Stores stores) throws Exception {
        return decodeMode(stores.readMode());
    }

    /** Move a verified disabled-store secret into the protected store. */
    public static Mode enable(Stores stores) throws Exception {
        if (readMode(stores) != Mode.DISABLED) {
            throw new Exception("Key protection can only be enabled from disabled mode");
        }
        String secret = requireSecret(stores.readDisabledSecret(), "disabled");

        // ENABLING is durable before the second store can be changed, so every
        // later interruption has one deterministic startup recovery path.
        stores.writeMode(Mode.ENABLING);
        stores.writeProtectedSecret(secret);
        requireEqual(secret, stores.readProtectedSecret(), "protected destination");

        stores.clearDisabledSecret();
        requireAbsent(stores.readDisabledSecret(), "disabled source");
        stores.writeMode(Mode.ENABLED);
        return Mode.ENABLED;
    }

    /** Resolve an interrupted enable without deleting an unverified last copy. */
    public static Mode recoverEnabling(Stores stores) throws Exception {
        if (readMode(stores) != Mode.ENABLING) {
            throw new Exception("Key-protection recovery requires enabling mode");
        }
        String disabled = stores.readDisabledSecret();
        String protectedValue = stores.readProtectedSecret();
        boolean hasDisabled = isPresent(disabled);
        boolean hasProtected = isPresent(protectedValue);

        if (hasDisabled && hasProtected) {
            requireEqual(disabled, protectedValue, "duplicate stores");
            stores.clearDisabledSecret();
            requireAbsent(stores.readDisabledSecret(), "disabled source");
            stores.writeMode(Mode.ENABLED);
            return Mode.ENABLED;
        }
        if (hasProtected) {
            stores.writeMode(Mode.ENABLED);
            return Mode.ENABLED;
        }
        if (hasDisabled) {
            // The protected destination was never durably established. The
            // original verified copy remains authoritative.
            stores.writeMode(Mode.DISABLED);
            return Mode.DISABLED;
        }
        throw new Exception("Key-protection recovery found no passphrase copy");
    }

    /** Restore a verified ordinary-store copy before disabling protection. */
    public static Mode disable(Stores stores) throws Exception {
        if (readMode(stores) != Mode.ENABLED) {
            throw new Exception("Key protection can only be disabled from enabled mode");
        }
        String secret = requireSecret(stores.readProtectedSecret(), "protected");

        stores.writeDisabledSecret(secret);
        requireEqual(secret, stores.readDisabledSecret(), "disabled destination");
        // Only now may the ordinary store become authoritative.
        stores.writeMode(Mode.DISABLED);

        stores.clearProtectedSecret();
        requireAbsent(stores.readProtectedSecret(), "protected source");
        return Mode.DISABLED;
    }

    private static String requireSecret(String value, String store) throws Exception {
        if (!isPresent(value)) throw new Exception("Missing passphrase in " + store + " store");
        return value;
    }

    private static void requireEqual(String expected, String actual, String store) throws Exception {
        if (!isPresent(actual) || !expected.equals(actual)) {
            throw new Exception("Passphrase verification failed for " + store);
        }
    }

    private static void requireAbsent(String value, String store) throws Exception {
        if (isPresent(value)) throw new Exception("Passphrase removal failed for " + store);
    }

    private static boolean isPresent(String value) {
        return value != null && !value.isEmpty();
    }
}
