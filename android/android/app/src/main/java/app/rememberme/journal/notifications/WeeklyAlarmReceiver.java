package app.rememberme.journal.notifications;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Reconciles the durable weekly-notification state after alarms and lifecycle changes. */
public final class WeeklyAlarmReceiver extends BroadcastReceiver {

    private static final String TAG = "WeeklyAlarmReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!isAllowedAction(intent == null ? null : intent.getAction())) {
            return;
        }
        try {
            AndroidWeeklyNotificationPlatform.reconcileStoredState(context);
        } catch (RuntimeException error) {
            Log.e(TAG, "Weekly notification reconciliation failed", error);
        }
    }

    static boolean isAllowedAction(String action) {
        return Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || AndroidWeeklyNotificationPlatform.ALARM_ACTION.equals(action);
    }
}
