package app.rememberme.journal.notifications;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import app.rememberme.journal.MainActivity;
import app.rememberme.journal.R;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Android implementation of the weekly-notification port. */
public final class AndroidWeeklyNotificationPlatform implements WeeklyNotificationPlatform {

    static final String PREFERENCES_NAME = "rememberme.weekly.notifications";
    static final String CHANNEL_ID = "rememberme.weekly.review";
    static final int NOTIFICATION_ID = 60426;
    static final int ALARM_REQUEST_CODE = 60426;
    static final String ALARM_ACTION = "app.rememberme.journal.WEEKLY_ALARM";
    static final String ACTION_OPEN_WEEKLY = WeeklyNotificationPolicy.ACTION_OPEN_WEEKLY;
    static final String KEY_ENABLED = "enabled";
    static final String KEY_HOUR = "hour";
    static final String KEY_TIMEZONE = "timezone";
    static final String KEY_LAST_NOTIFIED_WEEK = "lastNotifiedWeek";
    static final String KEY_CLAIMED_WEEK = "claimedWeek";
    static final String KEY_PERMISSION_REQUESTED = "permissionRequested";
    static final String EXTRA_ROUTE = "route";
    static final String EXTRA_ACTION_ID = "id";
    static final String WEEKLY_ROUTE = WeeklyNotificationPolicy.WEEKLY_ROUTE;
    static final int PENDING_INTENT_FLAGS = PendingIntent.FLAG_UPDATE_CURRENT
            | PendingIntent.FLAG_IMMUTABLE;

    /** Package-accessible for MainActivity and the Capacitor facade; all access is synchronized. */
    static final WeeklyActionBuffer PENDING_ACTIONS = new WeeklyActionBuffer();
    static final Object RECONCILIATION_LOCK = new Object();

    private final Context context;
    private final SharedPreferences preferences;

    public AndroidWeeklyNotificationPlatform(Context context) {
        if (context == null) {
            throw new IllegalArgumentException("context_required");
        }
        this.context = context.getApplicationContext();
        this.preferences = this.context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    @Override
    public long nowMillis() {
        return System.currentTimeMillis();
    }

    @Override
    public SnapshotRead readSnapshot() {
        try {
            final Map<String, ?> values = preferences.getAll();
            return WeeklyNotificationPolicy.read(values);
        } catch (RuntimeException error) {
            throw failure(WeeklyNotificationController.ErrorCode.PLATFORM_READ_FAILED, error);
        }
    }

    @Override
    public boolean writeSnapshot(WeeklySnapshot snapshot) {
        if (!WeeklyNotificationValidation.validSnapshot(snapshot)) {
            throw failure(WeeklyNotificationController.ErrorCode.PREFERENCE_WRITE_FAILED, null);
        }
        try {
            SharedPreferences.Editor editor = preferences.edit()
                    .putBoolean(KEY_ENABLED, snapshot.enabled)
                    .putInt(KEY_HOUR, snapshot.hour)
                    .putString(KEY_TIMEZONE, snapshot.timezone);
            if (snapshot.lastNotifiedWeek == null) {
                editor.remove(KEY_LAST_NOTIFIED_WEEK);
            } else {
                editor.putString(KEY_LAST_NOTIFIED_WEEK, snapshot.lastNotifiedWeek);
            }
            if (snapshot.claimedWeek == null) {
                editor.remove(KEY_CLAIMED_WEEK);
            } else {
                editor.putString(KEY_CLAIMED_WEEK, snapshot.claimedWeek);
            }
            return editor.commit();
        } catch (RuntimeException error) {
            throw failure(WeeklyNotificationController.ErrorCode.PREFERENCE_WRITE_FAILED, error);
        }
    }

    @Override
    public void scheduleNext(WeeklyScheduleMath.ScheduleTarget target) {
        if (target == null) {
            throw failure(WeeklyNotificationController.ErrorCode.SCHEDULE_FAILED, null);
        }
        try {
            AlarmManager alarmManager = alarmManager();
            alarmManager.setAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    target.triggerAtMillis,
                    alarmPendingIntent());
        } catch (RuntimeException error) {
            throw failure(WeeklyNotificationController.ErrorCode.SCHEDULE_FAILED, error);
        }
    }

    @Override
    public void cancelAlarm() {
        try {
            alarmManager().cancel(alarmPendingIntent());
        } catch (RuntimeException error) {
            throw failure(WeeklyNotificationController.ErrorCode.CANCEL_FAILED, error);
        }
    }

    @Override
    public boolean canPostNotification() {
        ensureNotificationChannel();
        return WeeklyNotificationPolicy.permissionDecision(
                Build.VERSION.SDK_INT,
                isRuntimePermissionGranted(),
                true,
                areNotificationsEnabled(),
                channelImportance() != NotificationManager.IMPORTANCE_NONE)
                == WeeklyPermissionDecision.GRANTED;
    }

    @Override
    public void postWeeklyNotification(String weekKey) {
        if (!WeeklyNotificationValidation.validMarker(weekKey)) {
            throw failure(WeeklyNotificationController.ErrorCode.POST_FAILED, null);
        }
        try {
            ensureNotificationChannel();
            String actionId = UUID.randomUUID().toString();
            Intent openIntent = new Intent(context, MainActivity.class)
                    .setAction(ACTION_OPEN_WEEKLY)
                    .putExtra(EXTRA_ROUTE, WEEKLY_ROUTE)
                    .putExtra(EXTRA_ACTION_ID, actionId);
            PendingIntent openPendingIntent = PendingIntent.getActivity(
                    context,
                    NOTIFICATION_ID,
                    openIntent,
                    PENDING_INTENT_FLAGS);
            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle("Weekly Review")
                    .setContentText("Your week is ready to review.")
                    .setContentIntent(openPendingIntent)
                    .setAutoCancel(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N
                    && Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                builder.setPriority(NotificationCompat.PRIORITY_DEFAULT);
            }
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build());
        } catch (RuntimeException error) {
            throw failure(WeeklyNotificationController.ErrorCode.POST_FAILED, error);
        }
    }

    void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = notificationManager();
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(new NotificationChannel(
                    CHANNEL_ID,
                    "Weekly Review",
                    NotificationManager.IMPORTANCE_DEFAULT));
        }
    }

    boolean areNotificationsEnabled() {
        ensureNotificationChannel();
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }

    boolean isRuntimePermissionGranted() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ensureNotificationChannel();
        }
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || ContextCompat.checkSelfPermission(
                        context, Manifest.permission.POST_NOTIFICATIONS)
                        == PackageManager.PERMISSION_GRANTED;
    }

    int channelImportance() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return NotificationManager.IMPORTANCE_DEFAULT;
        }
        ensureNotificationChannel();
        NotificationChannel channel = notificationManager().getNotificationChannel(CHANNEL_ID);
        return channel == null ? NotificationManager.IMPORTANCE_NONE : channel.getImportance();
    }

    boolean isPermissionRequested() {
        try {
            return preferences.getBoolean(KEY_PERMISSION_REQUESTED, false);
        } catch (RuntimeException error) {
            throw failure(WeeklyNotificationController.ErrorCode.PLATFORM_READ_FAILED, error);
        }
    }

    Intent appNotificationSettingsIntent() {
        return new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
    }

    Intent channelNotificationSettingsIntent() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return appNotificationSettingsIntent();
        }
        ensureNotificationChannel();
        return new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName())
                .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL_ID);
    }

    boolean markPermissionRequested() {
        try {
            return preferences.edit().putBoolean(KEY_PERMISSION_REQUESTED, true).commit();
        } catch (RuntimeException error) {
            throw failure(WeeklyNotificationController.ErrorCode.PREFERENCE_WRITE_FAILED, error);
        }
    }

    Context applicationContext() {
        return context;
    }

    static WeeklyNotificationController.ReconcileResult reconcile(
            Context context, WeeklySettings settings) {
        synchronized (RECONCILIATION_LOCK) {
            AndroidWeeklyNotificationPlatform platform =
                    new AndroidWeeklyNotificationPlatform(context);
            return new WeeklyNotificationController(platform).reconcile(settings);
        }
    }

    static void reconcileStoredState(Context context) {
        synchronized (RECONCILIATION_LOCK) {
            AndroidWeeklyNotificationPlatform platform =
                    new AndroidWeeklyNotificationPlatform(context);
            SnapshotRead read = platform.readSnapshot();
            if (read.isEmpty()) {
                return;
            }
            WeeklySnapshot snapshot = read.snapshot;
            WeeklySettings storedSettings = snapshot == null
                    ? new WeeklySettings(false, 0, "UTC")
                    : new WeeklySettings(snapshot.enabled, snapshot.hour, snapshot.timezone);
            new WeeklyNotificationController(platform).reconcile(storedSettings);
        }
    }

    public static synchronized WeeklyNotificationAction captureIntent(Intent intent) {
        if (intent == null) {
            return null;
        }
        String id = intent.getStringExtra(EXTRA_ACTION_ID);
        return PENDING_ACTIONS.accept(
                        intent.getAction(), intent.getStringExtra(EXTRA_ROUTE), id)
                ? PENDING_ACTIONS.get(id)
                : null;
    }

    static synchronized List<WeeklyNotificationAction> consumePendingActions() {
        return PENDING_ACTIONS.consume();
    }

    static synchronized boolean acknowledgeAction(String id) {
        return PENDING_ACTIONS.acknowledge(id);
    }

    private AlarmManager alarmManager() {
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) {
            throw new IllegalStateException("alarm_manager_unavailable");
        }
        return alarmManager;
    }

    private PendingIntent alarmPendingIntent() {
        Intent alarmIntent = new Intent(context, WeeklyAlarmReceiver.class)
                .setAction(ALARM_ACTION);
        return PendingIntent.getBroadcast(
                context,
                ALARM_REQUEST_CODE,
                alarmIntent,
                PENDING_INTENT_FLAGS);
    }

    private NotificationManager notificationManager() {
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            throw new IllegalStateException("notification_manager_unavailable");
        }
        return manager;
    }

    private static WeeklyNotificationController.WeeklyNotificationException failure(
            WeeklyNotificationController.ErrorCode code, Throwable cause) {
        return cause == null
                ? new WeeklyNotificationController.WeeklyNotificationException(code)
                : new WeeklyNotificationController.WeeklyNotificationException(code, cause);
    }

}
