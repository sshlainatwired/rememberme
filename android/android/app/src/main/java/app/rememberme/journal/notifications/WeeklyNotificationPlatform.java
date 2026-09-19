package app.rememberme.journal.notifications;

import java.util.Calendar;
import java.util.GregorianCalendar;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;

interface WeeklyNotificationPlatform {

    long nowMillis();

    SnapshotRead readSnapshot();

    boolean writeSnapshot(WeeklySnapshot snapshot);

    void scheduleNext(WeeklyScheduleMath.ScheduleTarget target);

    void cancelAlarm();

    boolean canPostNotification();

    void postWeeklyNotification(String weekKey);
}

enum WeeklyPermissionDecision {
    UNSUPPORTED,
    PROMPT,
    DENIED_RUNTIME,
    DENIED_APP,
    DENIED_CHANNEL,
    GRANTED
}

final class WeeklyNotificationPolicy {
    static final String ACTION_OPEN_WEEKLY = "app.rememberme.journal.OPEN_WEEKLY";
    static final String WEEKLY_ROUTE = "/weekly";
    static final String KEY_ENABLED = "enabled";
    static final String KEY_HOUR = "hour";
    static final String KEY_TIMEZONE = "timezone";
    static final String KEY_LAST_NOTIFIED_WEEK = "lastNotifiedWeek";
    static final String KEY_CLAIMED_WEEK = "claimedWeek";
    static final String KEY_PERMISSION_REQUESTED = "permissionRequested";

    private WeeklyNotificationPolicy() {}

    static WeeklyPermissionDecision permissionDecision(
            int apiLevel,
            boolean runtimePermissionGranted,
            boolean permissionRequested,
            boolean appNotificationsEnabled,
            boolean channelEnabled) {
        if (apiLevel < 24) {
            return WeeklyPermissionDecision.UNSUPPORTED;
        }
        if (apiLevel >= 33 && !runtimePermissionGranted) {
            return permissionRequested
                    ? WeeklyPermissionDecision.DENIED_RUNTIME
                    : WeeklyPermissionDecision.PROMPT;
        }
        if (!appNotificationsEnabled) {
            return WeeklyPermissionDecision.DENIED_APP;
        }
        if (apiLevel >= 26 && !channelEnabled) {
            return WeeklyPermissionDecision.DENIED_CHANNEL;
        }
        return WeeklyPermissionDecision.GRANTED;
    }

    static SnapshotRead read(Map<String, ?> values) {
        boolean hasSchedulingKey = containsSchedulingKey(values);
        boolean malformed = hasUnexpectedKey(values);
        if (!hasSchedulingKey) {
            return malformed
                    ? SnapshotRead.corruptPartial(new WeeklySnapshot(false, 0, "UTC", null, null))
                    : SnapshotRead.empty();
        }

        Boolean enabled = booleanValue(values, KEY_ENABLED);
        Integer hour = integerValue(values, KEY_HOUR);
        String timezone = stringValue(values, KEY_TIMEZONE);
        String lastNotifiedWeek = markerValue(values, KEY_LAST_NOTIFIED_WEEK);
        String claimedWeek = markerValue(values, KEY_CLAIMED_WEEK);

        malformed |= enabled == null;
        malformed |= hour == null || !WeeklyNotificationValidation.validHour(hour);
        malformed |= timezone == null || !WeeklyNotificationValidation.validTimezone(timezone);
        malformed |= markerIsMalformed(values, KEY_LAST_NOTIFIED_WEEK, lastNotifiedWeek);
        malformed |= markerIsMalformed(values, KEY_CLAIMED_WEEK, claimedWeek);

        WeeklySnapshot salvage = new WeeklySnapshot(
                enabled != null && enabled,
                hour != null && WeeklyNotificationValidation.validHour(hour) ? hour : 0,
                timezone != null && WeeklyNotificationValidation.validTimezone(timezone)
                        ? timezone : "UTC",
                WeeklyNotificationValidation.validMarker(lastNotifiedWeek)
                        ? lastNotifiedWeek : null,
                WeeklyNotificationValidation.validMarker(claimedWeek) ? claimedWeek : null);
        if (malformed) {
            return SnapshotRead.corruptPartial(salvage);
        }
        return SnapshotRead.valid(new WeeklySnapshot(
                enabled,
                hour,
                timezone,
                lastNotifiedWeek,
                claimedWeek));
    }

    private static boolean containsSchedulingKey(Map<String, ?> values) {
        return values.containsKey(KEY_ENABLED)
                || values.containsKey(KEY_HOUR)
                || values.containsKey(KEY_TIMEZONE)
                || values.containsKey(KEY_LAST_NOTIFIED_WEEK)
                || values.containsKey(KEY_CLAIMED_WEEK);
    }

    private static boolean hasUnexpectedKey(Map<String, ?> values) {
        for (String key : values.keySet()) {
            if (!KEY_ENABLED.equals(key)
                    && !KEY_HOUR.equals(key)
                    && !KEY_TIMEZONE.equals(key)
                    && !KEY_LAST_NOTIFIED_WEEK.equals(key)
                    && !KEY_CLAIMED_WEEK.equals(key)
                    && !KEY_PERMISSION_REQUESTED.equals(key)) {
                return true;
            }
        }
        return false;
    }

    private static Boolean booleanValue(Map<String, ?> values, String key) {
        Object value = values.get(key);
        return value instanceof Boolean ? (Boolean) value : null;
    }

    private static Integer integerValue(Map<String, ?> values, String key) {
        Object value = values.get(key);
        return value instanceof Integer ? (Integer) value : null;
    }

    private static String stringValue(Map<String, ?> values, String key) {
        Object value = values.get(key);
        return value instanceof String ? (String) value : null;
    }

    private static String markerValue(Map<String, ?> values, String key) {
        return stringValue(values, key);
    }

    private static boolean markerIsMalformed(
            Map<String, ?> values, String key, String marker) {
        return values.containsKey(key) && (marker == null || !WeeklyNotificationValidation.validMarker(marker));
    }
}

final class WeeklyNotificationAction {
    final String id;
    final String route;

    WeeklyNotificationAction(String id, String route) {
        this.id = id;
        this.route = route;
    }
}

final class WeeklyActionBuffer {
    static final int MAX_ACTIONS = 8;
    private final LinkedHashMap<String, WeeklyNotificationAction> actions =
            new LinkedHashMap<String, WeeklyNotificationAction>();

    boolean accept(String action, String route, String id) {
        if (!WeeklyNotificationPolicy.ACTION_OPEN_WEEKLY.equals(action)
                || !WeeklyNotificationPolicy.WEEKLY_ROUTE.equals(route)
                || id == null
                || id.isEmpty()
                || actions.containsKey(id)) {
            return false;
        }
        actions.put(id, new WeeklyNotificationAction(id, route));
        while (actions.size() > MAX_ACTIONS) {
            actions.remove(actions.keySet().iterator().next());
        }
        return true;
    }

    List<WeeklyNotificationAction> consume() {
        return Collections.unmodifiableList(
                new ArrayList<WeeklyNotificationAction>(actions.values()));
    }

    WeeklyNotificationAction get(String id) {
        return actions.get(id);
    }

    boolean acknowledge(String id) {
        return id != null && actions.remove(id) != null;
    }
}

class WeeklySettings {
    final boolean enabled;
    final int hour;
    final String timezone;

    WeeklySettings(boolean enabled, int hour, String timezone) {
        this.enabled = enabled;
        this.hour = hour;
        this.timezone = timezone;
    }
}

final class WeeklySnapshot extends WeeklySettings {
    final String lastNotifiedWeek;
    final String claimedWeek;

    WeeklySnapshot(
            boolean enabled,
            int hour,
            String timezone,
            String lastNotifiedWeek,
            String claimedWeek) {
        super(enabled, hour, timezone);
        this.lastNotifiedWeek = lastNotifiedWeek;
        this.claimedWeek = claimedWeek;
    }

    WeeklySnapshot withSettings(WeeklySettings settings) {
        return new WeeklySnapshot(
                settings.enabled,
                settings.hour,
                settings.timezone,
                lastNotifiedWeek,
                claimedWeek);
    }

    WeeklySnapshot withMarkers(String lastNotifiedWeek, String claimedWeek) {
        return new WeeklySnapshot(enabled, hour, timezone, lastNotifiedWeek, claimedWeek);
    }
}

final class SnapshotRead {
    enum State {
        EMPTY,
        VALID,
        CORRUPT_PARTIAL
    }

    final State state;
    final WeeklySnapshot snapshot;

    private SnapshotRead(State state, WeeklySnapshot snapshot) {
        this.state = state;
        this.snapshot = snapshot;
    }

    static SnapshotRead empty() {
        return new SnapshotRead(State.EMPTY, null);
    }

    static SnapshotRead valid(WeeklySnapshot snapshot) {
        if (!WeeklyNotificationValidation.validSnapshot(snapshot)) {
            return corruptPartial(snapshot);
        }
        return new SnapshotRead(State.VALID, snapshot);
    }

    static SnapshotRead corruptPartial() {
        return corruptPartial(null);
    }

    static SnapshotRead corruptPartial(WeeklySnapshot salvage) {
        return new SnapshotRead(State.CORRUPT_PARTIAL, salvage);
    }

    boolean isEmpty() {
        return state == State.EMPTY;
    }

    boolean isValid() {
        return state == State.VALID;
    }

    boolean isCorruptPartial() {
        return state == State.CORRUPT_PARTIAL;
    }
}

final class WeeklyNotificationValidation {

    private static final Set<String> AVAILABLE_ZONE_IDS = availableZoneIds();

    private WeeklyNotificationValidation() {
    }

    static boolean validSettings(WeeklySettings settings) {
        return settings != null
                && validHour(settings.hour)
                && validTimezone(settings.timezone);
    }

    static boolean validSnapshot(WeeklySnapshot snapshot) {
        return snapshot != null
                && validSettings(snapshot)
                && validMarker(snapshot.lastNotifiedWeek)
                && validMarker(snapshot.claimedWeek);
    }

    static boolean validHour(int hour) {
        return hour >= 0 && hour <= 23;
    }

    static boolean validTimezone(String timezone) {
        if (timezone == null || !AVAILABLE_ZONE_IDS.contains(timezone)) {
            return false;
        }
        return timezone.equals(TimeZone.getTimeZone(timezone).getID());
    }

    static boolean validMarker(String marker) {
        if (marker == null) {
            return true;
        }
        if (!marker.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) {
            return false;
        }
        int year = number(marker, 0, 4);
        int month = number(marker, 5, 7);
        int day = number(marker, 8, 10);
        if (year < 1 || month < 1 || month > 12 || day < 1) {
            return false;
        }
        Calendar calendar = new GregorianCalendar(TimeZone.getTimeZone("UTC"));
        calendar.setLenient(false);
        calendar.clear();
        calendar.set(year, month - 1, day, 0, 0, 0);
        try {
            calendar.getTimeInMillis();
            return true;
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private static int number(String value, int from, int to) {
        return Integer.parseInt(value.substring(from, to));
    }

    private static Set<String> availableZoneIds() {
        Set<String> ids = new HashSet<String>();
        for (String id : TimeZone.getAvailableIDs()) {
            ids.add(id);
        }
        return ids;
    }
}
