package com.getcapacitor.community.database.sqlite.SQLite;

import static com.getcapacitor.community.database.sqlite.SQLite.UtilsSQLCipher.State.DOES_NOT_EXIST;
import static com.getcapacitor.community.database.sqlite.SQLite.UtilsSQLCipher.State.ENCRYPTED_GLOBAL_SECRET;
import static com.getcapacitor.community.database.sqlite.SQLite.UtilsSQLCipher.State.ENCRYPTED_SECRET;
import static com.getcapacitor.community.database.sqlite.SQLite.UtilsSQLCipher.State.UNKNOWN;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.TextUtils;
import android.util.Base64;
import java.io.File;
import java.security.SecureRandom;
import java.util.Arrays;

public class UtilsSecret {

    private static final String TAG = UtilsFile.class.getName();
    private UtilsFile uFile = new UtilsFile();
    private GlobalSQLite globVar = new GlobalSQLite();
    private UtilsSQLCipher uCipher = new UtilsSQLCipher();

    private static SharedPreferences sharedPreferences;
    private Context context;

    public UtilsSecret(Context context, SharedPreferences sharedPreferences) {
        this.context = context;
        this.sharedPreferences = sharedPreferences;
    }

    /**
     * Create the initial SQLCipher passphrase entirely inside native code.
     * Only a success marker crosses the Capacitor bridge; the temporary random
     * byte buffer is cleared on every path. The encoded Java String remains an
     * unavoidable runtime copy until stored by AndroidX encrypted preferences.
     */
    public void ensureEncryptionSecret() throws Exception {
        String savedPassPhrase = getPassphrase();
        if (savedPassPhrase != null && savedPassPhrase.length() > 0) {
            throw new Exception("a passphrase has already been set");
        }
        byte[] bytes = new byte[32];
        try {
            new SecureRandom().nextBytes(bytes);
            setEncryptionSecret(Base64.encodeToString(bytes, Base64.NO_WRAP));
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    /**
     * SetEncryptionSecret
     * @param passphrase
     * @throws Exception
     */
    public void setEncryptionSecret(String passphrase) throws Exception {
        try {
            if (TextUtils.isEmpty(passphrase)) {
                String msg = "passphrase must not be empty";
                throw new Exception(msg);
            }
            // test if Encryption secret is already set
            String savedPassPhrase = getPassphrase();
            if (savedPassPhrase != null && savedPassPhrase.length() > 0) {
                throw new Exception("a passphrase has already been set ");
            }
            // Store encrypted passphrase in sharedPreferences
            setPassphrase(passphrase);

            // Get the list of databases
            String[] dbList = uFile.getListOfFiles(context);
            if (dbList.length > 0) {
                for (String dbName : dbList) {
                    File file = context.getDatabasePath(dbName);

                    UtilsSQLCipher.State state = uCipher.getDatabaseState(context, file, sharedPreferences, globVar);
                    // change password if encrypted with globVar.secret
                    if (state == ENCRYPTED_GLOBAL_SECRET) {
                        uCipher.changePassword(context, file, globVar.secret, passphrase);
                    } else if (state == DOES_NOT_EXIST || state == UNKNOWN) {
                        String msg = "State for: " + dbName + " not correct";
                        throw new Exception(msg);
                    }
                }
            }
        } catch (Exception e) {
            throw new Exception(e.getMessage());
        }
    }

    /**
     * ChangeEncryptionSecret
     * @param passphrase
     * @param oldPassphrase
     * @throws Exception
     */
    public void changeEncryptionSecret(String passphrase, String oldPassphrase) throws Exception {
        try {
            if (TextUtils.isEmpty(passphrase) || TextUtils.isEmpty(oldPassphrase)) {
                String msg = "Passphrase and/or oldpassphrase must not be empty";
                throw new Exception(msg);
            }
            // check the oldPassphrase
            String secret = getPassphrase();
            if (secret == null || secret.isEmpty()) {
                String msg = "Encryption secret has not been set";
                throw new Exception(msg);
            } else if (!secret.equals(oldPassphrase)) {
                String msg = "Oldpassphrase is wrong secret";
                throw new Exception(msg);
            } else {
                // Get the list of databases
                String[] dbList = uFile.getListOfFiles(context);
                if (dbList.length > 0) {
                    for (String dbName : dbList) {
                        File file = context.getDatabasePath(dbName);

                        UtilsSQLCipher.State state = uCipher.getDatabaseState(context, file, sharedPreferences, globVar);
                        // change password if encrypted with oldPassphrase
                        if (state == ENCRYPTED_SECRET) {
                            uCipher.changePassword(context, file, oldPassphrase, passphrase);
                        } else if (state == DOES_NOT_EXIST || state == ENCRYPTED_GLOBAL_SECRET || state == UNKNOWN) {
                            String msg = "State for: " + dbName + " not correct";
                            throw new Exception(msg);
                        }
                    }
                }
                // Store the new encrypted passphrase in sharedPreferences
                setPassphrase(passphrase);
            }
        } catch (Exception e) {
            throw new Exception(e.getMessage());
        }
    }

    /**
     * ClearEncryptionSecret
     * @throws Exception
     */
    public void clearEncryptionSecret() throws Exception {
        try {
            // test if Encryption secret is already set
            String savedPassPhrase = getPassphrase();
            if (savedPassPhrase != null && savedPassPhrase.length() > 0) {
                // Clear encrypted passphrase in sharedPreferences
                clearPassphrase();
            }
        } catch (Exception e) {
            throw new Exception(e.getMessage());
        }
    }

    /**
     * CheckEncryptionSecret
     * @param passphrase
     * @throws Exception
     */
    public Boolean checkEncryptionSecret(String passphrase) throws Exception {
        Boolean ret = false;
        try {
            if (TextUtils.isEmpty(passphrase)) {
                String msg = "passphrase must not be empty";
                throw new Exception(msg);
            }
            // test if Encryption secret is already set
            String savedPassPhrase = getPassphrase();
            if (savedPassPhrase.isEmpty()) {
                throw new Exception("no passphrase stored  in sharedPreferences");
            }

            if (savedPassPhrase.equals(passphrase)) {
                ret = true;
            }
            return ret;
        } catch (Exception e) {
            throw new Exception(e.getMessage());
        }
    }

    public void setPassphrase(String passphrase) {
        // Durable synchronous write: the upstream async apply() can silently
        // fail or be lost on process death, leaving JS to believe the secret
        // was stored when it never hit disk. commit() returns false on
        // failure; throw fail-closed so setEncryptionSecret rejects before
        // any native conversion runs.
        boolean committed = sharedPreferences.edit().putString("secret", passphrase).commit();
        if (!committed) {
            throw new IllegalStateException("Failed to durably store the database passphrase (SharedPreferences commit returned false)");
        }
    }

    public static String getPassphrase() {
        if (sharedPreferences == null) {
            throw new IllegalStateException("Database key access has not been prepared");
        }
        return sharedPreferences.getString("secret", "");
    }

    public void clearPassphrase() {
        if (!sharedPreferences.edit().remove("secret").commit()) {
            throw new IllegalStateException("Failed to durably remove the database passphrase");
        }
    }

    public static Boolean isPassphrase() {
        if (!getPassphrase().isEmpty()) {
            return true;
        }
        return false;
    }
}
