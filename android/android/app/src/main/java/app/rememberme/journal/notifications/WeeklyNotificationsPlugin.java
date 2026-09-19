package app.rememberme.journal.notifications;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.List;

@CapacitorPlugin(
        name = "WeeklyNotifications",
        permissions = {
            @Permission(
                    alias = "notifications",
                    strings = { Manifest.permission.POST_NOTIFICATIONS })
        })
public final class WeeklyNotificationsPlugin extends Plugin {

    private static final String EVENT_WEEKLY_NOTIFICATION_ACTION = "weeklyNotificationAction";
    private static final String STATUS_GRANTED = "granted";
    private static final String STATUS_DENIED = "denied";
    private static final String STATUS_PROMPT = "prompt";
    private static final String STATUS_UNSUPPORTED = "unsupported";
    private static final String BLOCKED_RUNTIME = "runtime";
    private static final String BLOCKED_APP = "app";
    private static final String BLOCKED_CHANNEL = "channel";
    private static final String ERROR_PLATFORM_FAILED = "platform_failed";
    private static final String ERROR_PERMISSION_REQUESTED_WRITE =
            "permission_requested_write_failed";
    private static final String ERROR_SETTINGS_OPEN = "notification_settings_open_failed";
    private static final String ERROR_ACTION_ID_REQUIRED = "action_id_required";
    private static final String ERROR_ACTION_NOT_FOUND = "action_not_found";

    private static WeeklyNotificationsPlugin instance;

    @Override
    public void load() {
        instance = this;
        emitBufferedActions();
    }

    @PluginMethod
    public void reconcile(PluginCall call) {
        WeeklySettings settings = settingsFromCall(call);
        try {
            WeeklyNotificationController.ReconcileResult result =
                    AndroidWeeklyNotificationPlatform.reconcile(getContext(), settings);
            call.resolve(new JSObject()
                    .put("scheduled", result.scheduled)
                    .put("caughtUp", result.caughtUp));
        } catch (RuntimeException error) {
            rejectFailure(call, error);
        }
    }

    @PluginMethod
    public void getPermissionStatus(PluginCall call) {
        try {
            call.resolve(permissionStatus(new AndroidWeeklyNotificationPlatform(getContext())));
        } catch (RuntimeException error) {
            rejectFailure(call, error);
        }
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        AndroidWeeklyNotificationPlatform platform;
        try {
            platform = new AndroidWeeklyNotificationPlatform(getContext());
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                call.resolve(permissionStatus(platform));
                return;
            }
            if (!platform.markPermissionRequested()) {
                reject(call, ERROR_PERMISSION_REQUESTED_WRITE);
                return;
            }
            requestPermissionForAlias("notifications", call, "notificationsPermissionCallback");
        } catch (RuntimeException error) {
            rejectFailure(call, error);
        }
    }

    @PermissionCallback
    public void notificationsPermissionCallback(PluginCall call) {
        try {
            call.resolve(permissionStatus(new AndroidWeeklyNotificationPlatform(getContext())));
        } catch (RuntimeException error) {
            rejectFailure(call, error);
        }
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            AndroidWeeklyNotificationPlatform platform =
                    new AndroidWeeklyNotificationPlatform(getContext());
            JSObject status = permissionStatus(platform);
            String blockedAt = status.getString("blockedAt");
            Intent settingsIntent = BLOCKED_CHANNEL.equals(blockedAt)
                    ? platform.channelNotificationSettingsIntent()
                    : platform.appNotificationSettingsIntent();
            getActivity().startActivity(settingsIntent);
            call.resolve();
        } catch (RuntimeException error) {
            if (error instanceof WeeklyNotificationController.WeeklyNotificationException) {
                rejectFailure(call, error);
            } else {
                reject(call, ERROR_SETTINGS_OPEN);
            }
        }
    }

    @PluginMethod
    public void consumePendingActions(PluginCall call) {
        try {
            JSArray actions = new JSArray();
            List<WeeklyNotificationAction> pendingActions =
                    AndroidWeeklyNotificationPlatform.consumePendingActions();
            for (WeeklyNotificationAction action : pendingActions) {
                actions.put(actionObject(action));
            }
            call.resolve(new JSObject().put("actions", actions));
        } catch (RuntimeException error) {
            rejectFailure(call, error);
        }
    }

    @PluginMethod
    public void acknowledgeAction(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            reject(call, ERROR_ACTION_ID_REQUIRED);
            return;
        }
        try {
            if (!AndroidWeeklyNotificationPlatform.acknowledgeAction(id)) {
                reject(call, ERROR_ACTION_NOT_FOUND);
                return;
            }
            call.resolve();
        } catch (RuntimeException error) {
            rejectFailure(call, error);
        }
    }

    public static void captureIntent(Intent intent) {
        WeeklyNotificationAction action = AndroidWeeklyNotificationPlatform.captureIntent(intent);
        WeeklyNotificationsPlugin loadedPlugin = instance;
        if (loadedPlugin != null && action != null) {
            loadedPlugin.emitAction(action);
        }
    }

    private void emitBufferedActions() {
        for (WeeklyNotificationAction action
                : AndroidWeeklyNotificationPlatform.consumePendingActions()) {
            emitAction(action);
        }
    }

    private void emitAction(WeeklyNotificationAction action) {
        notifyListeners(EVENT_WEEKLY_NOTIFICATION_ACTION, actionObject(action), true);
    }

    private static JSObject actionObject(WeeklyNotificationAction action) {
        return new JSObject()
                .put("id", action.id)
                .put("route", action.route);
    }

    private static WeeklySettings settingsFromCall(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        Integer hour = call.getInt("hour");
        String timezone = call.getString("timezone");
        if (enabled == null || hour == null || timezone == null) {
            return new WeeklySettings(false, -1, timezone);
        }
        return new WeeklySettings(enabled, hour, timezone);
    }

    private static JSObject permissionStatus(AndroidWeeklyNotificationPlatform platform) {
        platform.ensureNotificationChannel();
        WeeklyPermissionDecision decision = WeeklyNotificationPolicy.permissionDecision(
                Build.VERSION.SDK_INT,
                platform.isRuntimePermissionGranted(),
                platform.isPermissionRequested(),
                platform.areNotificationsEnabled(),
                platform.channelImportance() != android.app.NotificationManager.IMPORTANCE_NONE);
        switch (decision) {
            case UNSUPPORTED:
                return status(STATUS_UNSUPPORTED, null);
            case PROMPT:
                return status(STATUS_PROMPT, null);
            case DENIED_RUNTIME:
                return status(STATUS_DENIED, BLOCKED_RUNTIME);
            case DENIED_APP:
                return status(STATUS_DENIED, BLOCKED_APP);
            case DENIED_CHANNEL:
                return status(STATUS_DENIED, BLOCKED_CHANNEL);
            case GRANTED:
                return status(STATUS_GRANTED, null);
            default:
                throw new IllegalStateException("unknown_permission_decision");
        }
    }

    private static JSObject status(String value, String blockedAt) {
        JSObject result = new JSObject().put("status", value);
        result.put(
                "blockedAt",
                blockedAt == null ? org.json.JSONObject.NULL : blockedAt);
        return result;
    }

    private static void rejectFailure(PluginCall call, RuntimeException error) {
        if (error instanceof WeeklyNotificationController.WeeklyNotificationException) {
            WeeklyNotificationController.WeeklyNotificationException failure =
                    (WeeklyNotificationController.WeeklyNotificationException) error;
            reject(call, failure.code.value);
            return;
        }
        reject(call, ERROR_PLATFORM_FAILED);
    }

    private static void reject(PluginCall call, String code) {
        call.reject(code, code);
    }
}
