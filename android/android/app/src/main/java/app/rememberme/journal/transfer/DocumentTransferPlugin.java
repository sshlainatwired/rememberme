package app.rememberme.journal.transfer;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Thin Storage Access Framework document bridge used by backup/restore.
 *
 * Responsibilities are intentionally narrow: open a user-selected document or
 * create a new one, enforce the caller's byte limit while streaming, and
 * return the document bytes as base64 (or confirm the save). It never takes a
 * persistable URI permission, never retains URIs, paths, content, passwords,
 * or keys after a call settles, and requires no storage permission. Exactly
 * one picker call may be active at a time; overlapping calls are rejected.
 */
@CapacitorPlugin(name = "DocumentTransfer")
public final class DocumentTransferPlugin extends Plugin {

    private static final String CALLBACK_OPEN = "openDocumentCallback";
    private static final String CALLBACK_SAVE = "saveDocumentCallback";
    private static final String STATUS_CANCELLED = "cancelled";
    private static final String STATUS_SELECTED = "selected";
    private static final String STATUS_SAVED = "saved";
    private static final String ERROR_BUSY = "transfer_busy";
    private static final String ERROR_INVALID = "transfer_invalid";
    private static final String ERROR_UNAVAILABLE = "transfer_unavailable";
    private static final String ERROR_IO = "transfer_io";

    private PluginCall activeCall;

    @PluginMethod
    public void openDocument(PluginCall call) {
        if (!beginActive(call)) {
            return;
        }
        try {
            int maxBytes = call.getInt("maxBytes", -1);
            String mimeType = firstMimeType(call);
            if (maxBytes < 0 || mimeType == null) {
                rejectInvalid(call);
                return;
            }
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(mimeType)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (intent.resolveActivity(getContext().getPackageManager()) == null) {
                rejectUnavailable(call);
                return;
            }
            startActivityForResult(call, intent, CALLBACK_OPEN);
        } catch (RuntimeException error) {
            rejectInvalid(call);
        }
    }

    @PluginMethod
    public void saveDocument(PluginCall call) {
        if (!beginActive(call)) {
            return;
        }
        try {
            String suggestedName = call.getString("suggestedName");
            String mimeType = call.getString("mimeType");
            String bytesBase64 = call.getString("bytesBase64");
            int maxBytes = call.getInt("maxBytes", -1);
            byte[] bytes = decode(call, bytesBase64);
            if (suggestedName == null || mimeType == null || maxBytes < 0 || bytes == null) {
                rejectInvalid(call);
                return;
            }
            if (bytes.length > maxBytes) {
                rejectInvalid(call);
                return;
            }
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(mimeType)
                    .putExtra(Intent.EXTRA_TITLE, suggestedName)
                    .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            if (intent.resolveActivity(getContext().getPackageManager()) == null) {
                rejectUnavailable(call);
                return;
            }
            startActivityForResult(call, intent, CALLBACK_SAVE);
        } catch (RuntimeException error) {
            rejectInvalid(call);
        }
    }

    @ActivityCallback
    private void openDocumentCallback(PluginCall call, ActivityResult result) {
        try {
            if (result.getResultCode() == Activity.RESULT_CANCELED) {
                call.resolve(new JSObject().put("status", STATUS_CANCELLED));
                return;
            }
            Intent data = result.getData();
            Uri uri = data == null ? null : data.getData();
            if (uri == null) {
                rejectInvalid(call);
                return;
            }
            int maxBytes = call.getInt("maxBytes", -1);
            if (maxBytes < 0) {
                rejectInvalid(call);
                return;
            }
            try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
                if (input == null) {
                    rejectInvalid(call);
                    return;
                }
                byte[] bytes = BoundedDocumentIO.read(input, maxBytes);
                call.resolve(new JSObject()
                        .put("status", STATUS_SELECTED)
                        .put("name", displayName(uri))
                        .put("bytesBase64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)));
            } catch (IOException error) {
                reject(call, ERROR_IO);
            }
        } finally {
            activeCall = null;
        }
    }

    @ActivityCallback
    private void saveDocumentCallback(PluginCall call, ActivityResult result) {
        try {
            if (result.getResultCode() == Activity.RESULT_CANCELED) {
                call.resolve(new JSObject().put("status", STATUS_CANCELLED));
                return;
            }
            Uri uri = result.getData() == null ? null : result.getData().getData();
            byte[] bytes = decode(call, call.getString("bytesBase64"));
            int maxBytes = call.getInt("maxBytes", -1);
            if (uri == null || bytes == null || maxBytes < 0) {
                rejectInvalid(call);
                return;
            }
            try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "w")) {
                if (output == null) {
                    rejectInvalid(call);
                    return;
                }
                BoundedDocumentIO.write(output, bytes, maxBytes);
            } catch (IOException error) {
                reject(call, ERROR_IO);
                return;
            }
            call.resolve(new JSObject().put("status", STATUS_SAVED));
        } finally {
            activeCall = null;
        }
    }

    /** Claim the single active-call slot; reject overlaps without touching state. */
    private boolean beginActive(PluginCall call) {
        if (activeCall == null) {
            activeCall = call;
            return true;
        }
        call.reject(ERROR_BUSY, ERROR_BUSY);
        return false;
    }

    private void rejectInvalid(PluginCall call) {
        endActiveIfCurrent(call);
        call.reject(ERROR_INVALID, ERROR_INVALID);
    }

    private void rejectUnavailable(PluginCall call) {
        endActiveIfCurrent(call);
        call.reject(ERROR_UNAVAILABLE, ERROR_UNAVAILABLE);
    }

    private void reject(PluginCall call, String code) {
        endActiveIfCurrent(call);
        call.reject(code, code);
    }

    /** Clear the active slot exactly when it belongs to this call (all error paths). */
    private void endActiveIfCurrent(PluginCall call) {
        if (activeCall == call) {
            activeCall = null;
        }
    }

    private static byte[] decode(PluginCall call, String bytesBase64) {
        if (bytesBase64 == null) {
            return null;
        }
        try {
            return android.util.Base64.decode(bytesBase64, android.util.Base64.NO_WRAP);
        } catch (IllegalArgumentException error) {
            return null;
        }
    }

    private static String firstMimeType(PluginCall call) {
        try {
            Object value = call.getData().opt("mimeTypes");
            if (value instanceof org.json.JSONArray) {
                org.json.JSONArray array = (org.json.JSONArray) value;
                for (int index = 0; index < array.length(); index += 1) {
                    String mimeType = array.optString(index, null);
                    if (mimeType != null && mimeType.length() > 0) {
                        return mimeType;
                    }
                }
            }
            if (value instanceof String) {
                String mimeType = ((String) value).trim();
                return mimeType.length() > 0 ? mimeType : null;
            }
            return null;
        } catch (RuntimeException error) {
            return null;
        }
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContext()
                .getContentResolver()
                .query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    return name == null ? "" : name;
                }
            }
        } catch (RuntimeException error) {
            // Fall back to the last URI path segment; the name is informational only.
        }
        String path = uri.getLastPathSegment();
        return path == null ? "" : path;
    }
}