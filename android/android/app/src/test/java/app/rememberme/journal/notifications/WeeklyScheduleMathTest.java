package app.rememberme.journal.notifications;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.time.Instant;
import org.junit.Test;

public class WeeklyScheduleMathTest {

    private static final String UTC = "UTC";

    @Test
    public void nextSundayAt_supportsEveryHourAndIsStrictlyFuture() {
        long now = Instant.parse("2024-05-12T00:00:00Z").toEpochMilli();

        for (int hour = 0; hour <= 23; hour++) {
            WeeklyScheduleMath.ScheduleTarget target =
                    WeeklyScheduleMath.nextSundayAt(UTC, hour, now);
            long expectedMillis = Instant.parse(
                    hour == 0 ? "2024-05-19T00:00:00Z"
                            : String.format("2024-05-12T%02d:00:00Z", hour))
                    .toEpochMilli();
            assertEquals(expectedMillis, target.triggerAtMillis);
            assertEquals(hour == 0 ? "2024-05-19" : "2024-05-12", target.sundayDate);
            assertEquals(hour == 0 ? "2024-05-13" : "2024-05-06", target.weekKey);
            assertTrue(target.triggerAtMillis > now);
        }
    }

    @Test
    public void nextSundayAt_exactlyAtConfiguredTime_rollsToNextSunday() {
        long now = Instant.parse("2024-05-12T09:00:00Z").toEpochMilli();

        WeeklyScheduleMath.ScheduleTarget target =
                WeeklyScheduleMath.nextSundayAt(UTC, 9, now);

        assertEquals(Instant.parse("2024-05-19T09:00:00Z").toEpochMilli(), target.triggerAtMillis);
        assertEquals("2024-05-19", target.sundayDate);
        assertEquals("2024-05-13", target.weekKey);
    }

    @Test
    public void latestDueWeek_handlesEveryHourBoundary() {
        long sunday = Instant.parse("2024-05-12T00:00:00Z").toEpochMilli();

        for (int hour = 0; hour <= 23; hour++) {
            long at = sunday + hour * 60L * 60L * 1000L;
            assertEquals("2024-04-29", WeeklyScheduleMath.latestDueWeek(
                    UTC, hour, at - 1000L));
            assertEquals("2024-05-06", WeeklyScheduleMath.latestDueWeek(
                    UTC, hour, at));
            assertEquals("2024-05-06", WeeklyScheduleMath.latestDueWeek(
                    UTC, hour, at + 1000L));
        }

        assertEquals("2024-05-06", WeeklyScheduleMath.latestDueWeek(
                UTC, 9,
                Instant.parse("2024-05-18T16:00:00Z").toEpochMilli()));
    }

    @Test
    public void methods_useSavedZone_notDeviceZone() {
        long now = Instant.parse("2024-05-12T12:00:00Z").toEpochMilli();

        assertEquals("2024-04-29", WeeklyScheduleMath.latestDueWeek("America/New_York", 9, now));
        assertEquals("2024-05-06", WeeklyScheduleMath.latestDueWeek("Asia/Tokyo", 9, now));

        WeeklyScheduleMath.ScheduleTarget target =
                WeeklyScheduleMath.nextSundayAt("Asia/Tokyo", 9, now);
        assertEquals(Instant.parse("2024-05-19T00:00:00Z").toEpochMilli(), target.triggerAtMillis);
    }

    @Test
    public void springForwardGap_resolvesToFirstValidInstantAfterGap() {
        long now = Instant.parse("2024-03-09T12:00:00Z").toEpochMilli();

        WeeklyScheduleMath.ScheduleTarget target = WeeklyScheduleMath.nextSundayAt(
                "America/Los_Angeles", 2, now);

        assertEquals(Instant.parse("2024-03-10T10:00:00Z").toEpochMilli(), target.triggerAtMillis);
        assertEquals("2024-03-10", target.sundayDate);
        assertEquals("2024-03-04", target.weekKey);
    }

    @Test
    public void chathamGap_resolvesToFirstValidInstantAndDueBoundary() {
        long beforeGap = Instant.parse("2024-09-28T13:59:59Z").toEpochMilli();
        long firstValid = Instant.parse("2024-09-28T14:00:00Z").toEpochMilli();

        WeeklyScheduleMath.ScheduleTarget target = WeeklyScheduleMath.nextSundayAt(
                "Pacific/Chatham", 3,
                Instant.parse("2024-09-28T12:00:00Z").toEpochMilli());

        assertEquals(firstValid, target.triggerAtMillis);
        assertEquals("2024-09-29", target.sundayDate);
        assertEquals("2024-09-23", target.weekKey);
        assertEquals("2024-09-16", WeeklyScheduleMath.latestDueWeek(
                "Pacific/Chatham", 3, beforeGap));
        assertEquals("2024-09-23", WeeklyScheduleMath.latestDueWeek(
                "Pacific/Chatham", 3, firstValid));
    }

    @Test
    public void fallBackOverlap_resolvesToEarlierOccurrence() {
        long now = Instant.parse("2024-11-02T12:00:00Z").toEpochMilli();

        WeeklyScheduleMath.ScheduleTarget target = WeeklyScheduleMath.nextSundayAt(
                "America/New_York", 1, now);

        assertEquals(Instant.parse("2024-11-03T05:00:00Z").toEpochMilli(), target.triggerAtMillis);
        assertEquals("2024-11-03", target.sundayDate);
        assertEquals("2024-10-28", target.weekKey);
        assertEquals("2024-11-03T05:00:00Z", Instant.ofEpochMilli(target.triggerAtMillis).toString());
    }

    @Test
    public void rejectsInvalidZonesAndHours() {
        String[] invalidZones = {null, "", "Not/AZone", "GMT+03:00"};
        for (String zoneId : invalidZones) {
            try {
                WeeklyScheduleMath.nextSundayAt(zoneId, 9, 0L);
                fail("expected invalid zone: " + zoneId);
            } catch (IllegalArgumentException expected) {
                // expected
            }
        }

        for (int hour : new int[] {-1, 24, 99}) {
            try {
                WeeklyScheduleMath.latestDueWeek(UTC, hour, 0L);
                fail("expected invalid hour: " + hour);
            } catch (IllegalArgumentException expected) {
                // expected
            }
        }
    }
}
