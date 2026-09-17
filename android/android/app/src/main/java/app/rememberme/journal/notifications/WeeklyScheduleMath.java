package app.rememberme.journal.notifications;

import java.util.Calendar;
import java.util.GregorianCalendar;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;

/** Saved-zone weekly schedule calculations shared by alarms and reconciliation. */
public final class WeeklyScheduleMath {

    private static final long MILLIS_PER_HOUR = 60L * 60L * 1000L;
    private static final long MILLIS_PER_DAY = 24L * MILLIS_PER_HOUR;
    private static final long DST_SEARCH_WINDOW = 7L * MILLIS_PER_DAY;
    private static final Set<String> AVAILABLE_ZONE_IDS = availableZoneIds();

    private WeeklyScheduleMath() {
    }

    /** The resolved instant and its Sunday and Monday week identifiers. */
    public static final class ScheduleTarget {
        public final long triggerAtMillis;
        public final String sundayDate;
        public final String weekKey;

        public ScheduleTarget(long triggerAtMillis, String sundayDate, String weekKey) {
            this.triggerAtMillis = triggerAtMillis;
            this.sundayDate = sundayDate;
            this.weekKey = weekKey;
        }
    }

    /** Returns the next configured Sunday, with an instant strictly after nowMillis. */
    public static ScheduleTarget nextSundayAt(String zoneId, int hour, long nowMillis) {
        TimeZone zone = validatedZone(zoneId);
        validateHour(hour);

        Calendar now = calendar(zone);
        now.setTimeInMillis(nowMillis);
        int daysUntilSunday = (Calendar.SUNDAY - now.get(Calendar.DAY_OF_WEEK) + 7) % 7;
        if (daysUntilSunday == 0 && now.get(Calendar.HOUR_OF_DAY) >= hour) {
            daysUntilSunday = 7;
        }

        Calendar date = calendar(zone);
        date.setTimeInMillis(nowMillis);
        date.add(Calendar.DAY_OF_MONTH, daysUntilSunday);
        long trigger = resolveWallTime(
                zone,
                date.get(Calendar.YEAR),
                date.get(Calendar.MONTH),
                date.get(Calendar.DAY_OF_MONTH),
                hour);

        if (trigger <= nowMillis) {
            Calendar nextDate = calendar(zone);
            nextDate.setTimeInMillis(trigger);
            nextDate.add(Calendar.DAY_OF_MONTH, 7);
            trigger = resolveWallTime(
                    zone,
                    nextDate.get(Calendar.YEAR),
                    nextDate.get(Calendar.MONTH),
                    nextDate.get(Calendar.DAY_OF_MONTH),
                    hour);
        }

        Calendar resolved = calendar(zone);
        resolved.setTimeInMillis(trigger);
        return new ScheduleTarget(
                trigger,
                formatDate(resolved),
                mondayKey(resolved, zone));
    }

    /** Returns the Monday key for the latest configured Sunday at or before nowMillis. */
    public static String latestDueWeek(String zoneId, int hour, long nowMillis) {
        TimeZone zone = validatedZone(zoneId);
        validateHour(hour);

        Calendar now = calendar(zone);
        now.setTimeInMillis(nowMillis);
        int dayOfWeek = now.get(Calendar.DAY_OF_WEEK);
        int daysBack;
        if (dayOfWeek == Calendar.SUNDAY) {
            daysBack = now.get(Calendar.HOUR_OF_DAY) >= hour ? 0 : 7;
        } else {
            daysBack = dayOfWeek - Calendar.SUNDAY;
        }

        Calendar sunday = calendar(zone);
        sunday.setTimeInMillis(nowMillis);
        sunday.add(Calendar.DAY_OF_MONTH, -daysBack);
        Calendar monday = calendar(zone);
        monday.setTimeInMillis(sunday.getTimeInMillis());
        monday.add(Calendar.DAY_OF_MONTH, -6);
        return formatDate(monday);
    }

    private static long resolveWallTime(
            TimeZone zone, int year, int month, int day, int hour) {
        Calendar requested = calendar(zone);
        requested.set(year, month, day, hour, 0, 0);
        requested.set(Calendar.MILLISECOND, 0);
        long candidate = requested.getTimeInMillis();

        // Lenient Calendar resolution can advance a gap by the size of the
        // offset change. Find the transition itself so non-hour-aligned gaps
        // resolve to their first valid instant, not to the normalized wall
        // time (for example, Chatham 03:00 becomes 03:45).
        if (!matchesWallTime(requested, candidate, zone, year, month, day, hour)) {
            return firstValidInstantAfterGap(zone, candidate);
        }

        // Calendar implementations may select the later side of a fall-back
        // overlap. Try each nearby offset and retain the earliest matching
        // instant, which is the earlier occurrence by definition.
        int selectedOffset = zone.getOffset(candidate);
        long earliest = candidate;
        for (int offset : nearbyOffsets(zone, candidate)) {
            long alternative = candidate + (long) selectedOffset - offset;
            if (alternative < earliest
                    && matchesWallTime(requested, alternative, zone, year, month, day, hour)) {
                earliest = alternative;
            }
        }
        return earliest;
    }

    private static long firstValidInstantAfterGap(TimeZone zone, long candidate) {
        long previousInstant = candidate - DST_SEARCH_WINDOW;
        int previousOffset = zone.getOffset(previousInstant);
        while (previousInstant < candidate) {
            long nextInstant = Math.min(candidate, previousInstant + MILLIS_PER_HOUR);
            int nextOffset = zone.getOffset(nextInstant);
            if (nextOffset != previousOffset) {
                return firstInstantWithOffset(zone, previousInstant, nextInstant, nextOffset);
            }
            previousInstant = nextInstant;
            previousOffset = nextOffset;
        }
        return candidate;
    }

    private static long firstInstantWithOffset(
            TimeZone zone, long beforeTransition, long afterTransition, int newOffset) {
        long low = beforeTransition;
        long high = afterTransition;
        while (high - low > 1) {
            long middle = low + (high - low) / 2;
            if (zone.getOffset(middle) == newOffset) {
                high = middle;
            } else {
                low = middle;
            }
        }
        return high;
    }

    private static Set<Integer> nearbyOffsets(TimeZone zone, long instant) {
        Set<Integer> offsets = new HashSet<Integer>();
        for (long delta = -DST_SEARCH_WINDOW; delta <= DST_SEARCH_WINDOW; delta += MILLIS_PER_HOUR) {
            offsets.add(zone.getOffset(instant + delta));
        }
        return offsets;
    }

    private static boolean matchesWallTime(
            Calendar reusable,
            long instant,
            TimeZone zone,
            int year,
            int month,
            int day,
            int hour) {
        reusable.setTimeInMillis(instant);
        return reusable.get(Calendar.YEAR) == year
                && reusable.get(Calendar.MONTH) == month
                && reusable.get(Calendar.DAY_OF_MONTH) == day
                && reusable.get(Calendar.HOUR_OF_DAY) == hour
                && reusable.get(Calendar.MINUTE) == 0
                && reusable.get(Calendar.SECOND) == 0
                && reusable.get(Calendar.MILLISECOND) == 0
                && reusable.getTimeZone().equals(zone);
    }

    private static String mondayKey(Calendar sunday, TimeZone zone) {
        Calendar monday = calendar(zone);
        monday.setTimeInMillis(sunday.getTimeInMillis());
        monday.add(Calendar.DAY_OF_MONTH, -6);
        return formatDate(monday);
    }

    private static String formatDate(Calendar date) {
        return String.format(
                Locale.US,
                "%04d-%02d-%02d",
                date.get(Calendar.YEAR),
                date.get(Calendar.MONTH) + 1,
                date.get(Calendar.DAY_OF_MONTH));
    }

    private static Calendar calendar(TimeZone zone) {
        Calendar calendar = new GregorianCalendar(zone, Locale.US);
        calendar.setLenient(true);
        return calendar;
    }

    private static TimeZone validatedZone(String zoneId) {
        if (zoneId == null || !AVAILABLE_ZONE_IDS.contains(zoneId)) {
            throw new IllegalArgumentException("Invalid IANA timezone: " + zoneId);
        }
        TimeZone zone = TimeZone.getTimeZone(zoneId);
        if (!zoneId.equals(zone.getID())) {
            throw new IllegalArgumentException("Invalid IANA timezone: " + zoneId);
        }
        return zone;
    }

    private static void validateHour(int hour) {
        if (hour < 0 || hour > 23) {
            throw new IllegalArgumentException("Hour must be between 0 and 23: " + hour);
        }
    }

    private static Set<String> availableZoneIds() {
        Set<String> ids = new HashSet<String>();
        String[] available = TimeZone.getAvailableIDs();
        for (String id : available) {
            ids.add(id);
        }
        return ids;
    }
}
