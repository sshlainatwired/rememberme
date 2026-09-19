package com.getcapacitor.community.database.sqlite.SQLite;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

/**
 * Owns the two encrypted preference stores used for the SQLCipher passphrase.
 * The passphrase never leaves native code. All metadata/secret mutations use
 * synchronous commit and the pure {@link KeyProtectionState} protocol performs
 * exact destination readback before source removal or authority changes.
 */
public final class KeyProtectionStore implements KeyProtectionState.Stores {

    public static final String DISABLED_PREFERENCES = "sqlite_encrypted_shared_prefs";
    public static final String PROTECTED_PREFERENCES = "rememberme_biometric_sqlite_secret";
    public static final String PROTECTED_MASTER_KEY_ALIAS = "rememberme_biometric_sqlite_master_key";

    private static final String STATE_PREFERENCES = "rememberme_key_protection_state";
    private static final String MODE_KEY = "mode";
    private static final String SECRET_KEY = "secret";
    private static final int AUTHORIZATION_SECONDS = 15;

    private final Context context;
    private final SharedPreferences statePreferences;
    private SharedPreferences disabledPreferences;
    private SharedPreferences protectedPreferences;

    public KeyProtectionStore(Context context) {
        this.context = context;
        this.statePreferences = context.getSharedPreferences(STATE_PREFERENCES, Context.MODE_PRIVATE);
    }

    public KeyProtectionState.Mode mode() throws Exception {
        return KeyProtectionState.decodeMode(readMode());
    }

    /** Transitional mode is treated as protected so startup must authenticate and recover it. */
    public boolean isEnabledOrEnabling() throws Exception {
        return mode() != KeyProtectionState.Mode.DISABLED;
    }

    /** Existing/fresh disabled installs use the original file and default MasterKey alias. */
    public SharedPreferences prepareDisabled() throws Exception {
        if (mode() != KeyProtectionState.Mode.DISABLED) {
            throw new Exception("Protected key access requires system authentication");
        }
        openDisabledPreferences();
        return disabledPreferences;
    }

    /** Open protected storage after system authentication and resolve any interrupted enable. */
    public SharedPreferences prepareAfterAuthentication() throws Exception {
        openDisabledPreferences();
        openProtectedPreferences();
        KeyProtectionState.Mode current = mode();
        if (current == KeyProtectionState.Mode.ENABLING) {
            current = KeyProtectionState.recoverEnabling(this);
        }
        if (current == KeyProtectionState.Mode.DISABLED) return disabledPreferences;
        if (current != KeyProtectionState.Mode.ENABLED) {
            throw new Exception("Unknown key-protection state");
        }

        String protectedSecret = readProtectedSecret();
        if (!isPresent(protectedSecret)) throw new Exception("Protected passphrase is missing");
        String disabledSecret = readDisabledSecret();
        if (isPresent(disabledSecret)) {
            if (!protectedSecret.equals(disabledSecret)) {
                throw new Exception("Conflicting passphrase copies");
            }
            clearDisabledSecret();
            if (isPresent(readDisabledSecret())) throw new Exception("Ungated passphrase removal failed");
        }
        return protectedPreferences;
    }

    public SharedPreferences enableAfterAuthentication() throws Exception {
        openDisabledPreferences();
        openProtectedPreferences();
        KeyProtectionState.enable(this);
        return protectedPreferences;
    }

    public SharedPreferences disableAfterAuthentication() throws Exception {
        openDisabledPreferences();
        openProtectedPreferences();
        KeyProtectionState.disable(this);
        return disabledPreferences;
    }

    @Override
    public String readMode() {
        return statePreferences.getString(MODE_KEY, null);
    }

    @Override
    public void writeMode(KeyProtectionState.Mode mode) throws Exception {
        if (!statePreferences.edit().putString(MODE_KEY, mode.name()).commit()) {
            throw new Exception("Key-protection mode could not be stored");
        }
        if (!mode.name().equals(statePreferences.getString(MODE_KEY, null))) {
            throw new Exception("Key-protection mode verification failed");
        }
    }

    @Override
    public String readDisabledSecret() throws Exception {
        requireOpen(disabledPreferences, "disabled");
        return disabledPreferences.getString(SECRET_KEY, null);
    }

    @Override
    public void writeDisabledSecret(String value) throws Exception {
        requireOpen(disabledPreferences, "disabled");
        putSecret(disabledPreferences, value, "disabled");
    }

    @Override
    public void clearDisabledSecret() throws Exception {
        requireOpen(disabledPreferences, "disabled");
        clearSecret(disabledPreferences, "disabled");
    }

    @Override
    public String readProtectedSecret() throws Exception {
        requireOpen(protectedPreferences, "protected");
        return protectedPreferences.getString(SECRET_KEY, null);
    }

    @Override
    public void writeProtectedSecret(String value) throws Exception {
        requireOpen(protectedPreferences, "protected");
        putSecret(protectedPreferences, value, "protected");
    }

    @Override
    public void clearProtectedSecret() throws Exception {
        requireOpen(protectedPreferences, "protected");
        clearSecret(protectedPreferences, "protected");
    }

    private void openDisabledPreferences() throws Exception {
        if (disabledPreferences != null) return;
        MasterKey masterKey = new MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
        disabledPreferences = encryptedPreferences(DISABLED_PREFERENCES, masterKey);
    }

    private void openProtectedPreferences() throws Exception {
        if (protectedPreferences != null) return;
        MasterKey masterKey = new MasterKey.Builder(context, PROTECTED_MASTER_KEY_ALIAS)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .setUserAuthenticationRequired(true, AUTHORIZATION_SECONDS)
            .build();
        protectedPreferences = encryptedPreferences(PROTECTED_PREFERENCES, masterKey);
    }

    private SharedPreferences encryptedPreferences(String name, MasterKey masterKey) throws Exception {
        return EncryptedSharedPreferences.create(
            context,
            name,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        );
    }

    private static void putSecret(SharedPreferences preferences, String value, String store) throws Exception {
        if (!isPresent(value)) throw new Exception("Refusing to store an empty passphrase");
        if (!preferences.edit().putString(SECRET_KEY, value).commit()) {
            throw new Exception("Passphrase write failed for " + store + " store");
        }
    }

    private static void clearSecret(SharedPreferences preferences, String store) throws Exception {
        if (!preferences.edit().remove(SECRET_KEY).commit()) {
            throw new Exception("Passphrase removal failed for " + store + " store");
        }
    }

    private static void requireOpen(SharedPreferences preferences, String store) throws Exception {
        if (preferences == null) throw new Exception(store + " passphrase store is not open");
    }

    private static boolean isPresent(String value) {
        return value != null && !value.isEmpty();
    }
}
