package com.getcapacitor.community.database.sqlite.SQLite;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

/** API-24-compatible system authentication without application-owned credentials. */
public final class DeviceAuthenticator {

    public interface Listener {
        void onAuthenticated();

        void onCancelled();

        void onError();
    }

    private final Context context;
    private final String title;
    private final String subtitle;

    public DeviceAuthenticator(Context context, String title, String subtitle) {
        this.context = context;
        this.title = title;
        this.subtitle = subtitle;
    }

    public boolean isAvailable() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            int authenticators =
                BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
            return BiometricManager.from(context).canAuthenticate(authenticators) == BiometricManager.BIOMETRIC_SUCCESS;
        }
        KeyguardManager keyguard = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        return keyguard != null && keyguard.isDeviceSecure();
    }

    /** API 24-29 uses the system credential activity; API 30+ uses BiometricPrompt. */
    public boolean requiresCredentialActivity() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.R;
    }

    public Intent createCredentialIntent() throws Exception {
        if (!requiresCredentialActivity()) {
            throw new Exception("Credential activity is not used on this Android version");
        }
        KeyguardManager keyguard = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        if (keyguard == null || !keyguard.isDeviceSecure()) {
            throw new Exception("Device credential is unavailable");
        }
        Intent intent = keyguard.createConfirmDeviceCredentialIntent(title, subtitle);
        if (intent == null) throw new Exception("Device credential is unavailable");
        return intent;
    }

    /** Start API-30+ strong-biometric-or-device-credential authentication. */
    public void authenticate(FragmentActivity activity, Listener listener) throws Exception {
        if (requiresCredentialActivity() || !isAvailable()) {
            throw new Exception("System authentication is unavailable");
        }
        int authenticators =
            BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        BiometricPrompt prompt = new BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(context),
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationError(int errorCode, @NonNull CharSequence errorText) {
                    super.onAuthenticationError(errorCode, errorText);
                    if (
                        errorCode == BiometricPrompt.ERROR_CANCELED ||
                        errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                        errorCode == BiometricPrompt.ERROR_USER_CANCELED
                    ) {
                        listener.onCancelled();
                    } else {
                        listener.onError();
                    }
                }

                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    super.onAuthenticationSucceeded(result);
                    listener.onAuthenticated();
                }

                @Override
                public void onAuthenticationFailed() {
                    super.onAuthenticationFailed();
                    // A non-matching biometric is not terminal; the system prompt
                    // remains active and can accept another attempt or credential.
                }
            }
        );
        BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setAllowedAuthenticators(authenticators)
            .build();
        prompt.authenticate(promptInfo);
    }
}
