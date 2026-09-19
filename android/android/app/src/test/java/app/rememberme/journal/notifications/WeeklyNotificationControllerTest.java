package app.rememberme.journal.notifications;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

public class WeeklyNotificationControllerTest {

    private static final String UTC = "UTC";
    private static final long SUNDAY_AT_NINE = Instant.parse("2024-05-12T09:00:00Z").toEpochMilli();
    private static final long AFTER_DUE = Instant.parse("2024-05-12T10:00:00Z").toEpochMilli();

    @Test
    public void emptyState_seedsOnceAndSchedulesOneStrictlyFutureTarget() {
        FakePlatform platform = new FakePlatform(SUNDAY_AT_NINE);
        platform.read = SnapshotRead.empty();

        WeeklyNotificationController.ReconcileResult result = reconcile(
                platform, true, 9, UTC);

        assertTrue(result.scheduled);
        assertTrue(result.caughtUp);
        assertEquals(1, platform.scheduleCount);
        assertEquals(Instant.parse("2024-05-19T09:00:00Z").toEpochMilli(),
                platform.scheduledTarget.triggerAtMillis);
        assertEquals(3, platform.writes.size());
        assertEquals("2024-05-06", platform.postedWeeks.get(0));
        assertTrue(platform.writes.get(0).enabled);
        assertNull(platform.writes.get(0).lastNotifiedWeek);
        assertNull(platform.writes.get(0).claimedWeek);
    }

    @Test
    public void snapshotRead_hasExactlyEmptyValidAndCorruptPartialStates() {
        assertEquals(SnapshotRead.State.EMPTY, SnapshotRead.empty().state);
        assertEquals(SnapshotRead.State.VALID, SnapshotRead.valid(
                snapshot(true, 9, UTC, null, null)).state);
        assertEquals(SnapshotRead.State.CORRUPT_PARTIAL, SnapshotRead.corruptPartial().state);
        assertEquals(SnapshotRead.State.CORRUPT_PARTIAL, SnapshotRead.valid(
                snapshot(true, 24, UTC, null, null)).state);
        assertEquals(SnapshotRead.State.CORRUPT_PARTIAL, SnapshotRead.valid(
                snapshot(true, 9, "not/a-zone", null, null)).state);
        assertEquals(SnapshotRead.State.CORRUPT_PARTIAL, SnapshotRead.valid(
                snapshot(true, 9, UTC, "2024-02-31", null)).state);
    }

    @Test
    public void permissionDecision_coversApiRuntimeAppAndChannelMatrix() {
        assertEquals(WeeklyPermissionDecision.UNSUPPORTED,
                WeeklyNotificationPolicy.permissionDecision(23, false, false, true, true));
        assertEquals(WeeklyPermissionDecision.DENIED_APP,
                WeeklyNotificationPolicy.permissionDecision(24, true, false, false, true));
        assertEquals(WeeklyPermissionDecision.GRANTED,
                WeeklyNotificationPolicy.permissionDecision(25, false, true, true, false));
        assertEquals(WeeklyPermissionDecision.DENIED_CHANNEL,
                WeeklyNotificationPolicy.permissionDecision(26, true, false, true, false));
        assertEquals(WeeklyPermissionDecision.GRANTED,
                WeeklyNotificationPolicy.permissionDecision(32, false, true, true, true));

        assertEquals(WeeklyPermissionDecision.PROMPT,
                WeeklyNotificationPolicy.permissionDecision(33, false, false, false, false));
        assertEquals(WeeklyPermissionDecision.DENIED_RUNTIME,
                WeeklyNotificationPolicy.permissionDecision(33, false, true, false, false));
        assertEquals(WeeklyPermissionDecision.DENIED_APP,
                WeeklyNotificationPolicy.permissionDecision(33, true, false, false, false));
        assertEquals(WeeklyPermissionDecision.DENIED_CHANNEL,
                WeeklyNotificationPolicy.permissionDecision(33, true, false, true, false));
        assertEquals(WeeklyPermissionDecision.GRANTED,
                WeeklyNotificationPolicy.permissionDecision(33, true, false, true, true));
    }

    @Test
    public void weeklyActionBuffer_rejectsInvalidActionsAndMaintainsFifoDedupeCapAndAck() {
        WeeklyActionBuffer buffer = new WeeklyActionBuffer();

        assertFalse(buffer.accept("wrong.action", "/weekly", "valid-id"));
        assertFalse(buffer.accept(WeeklyNotificationPolicy.ACTION_OPEN_WEEKLY, "/today", "valid-id"));
        assertFalse(buffer.accept(WeeklyNotificationPolicy.ACTION_OPEN_WEEKLY, "/weekly", ""));
        assertFalse(buffer.accept(WeeklyNotificationPolicy.ACTION_OPEN_WEEKLY, "/weekly", null));

        for (int index = 0; index < 8; index++) {
            assertTrue(buffer.accept(
                    WeeklyNotificationPolicy.ACTION_OPEN_WEEKLY,
                    "/weekly",
                    "id-" + index));
        }
        assertFalse(buffer.accept(
                WeeklyNotificationPolicy.ACTION_OPEN_WEEKLY, "/weekly", "id-3"));
        assertEquals(8, buffer.consume().size());
        assertEquals("id-0", buffer.consume().get(0).id);

        assertTrue(buffer.accept(
                WeeklyNotificationPolicy.ACTION_OPEN_WEEKLY, "/weekly", "id-8"));
        List<WeeklyNotificationAction> afterEviction = buffer.consume();
        assertEquals(8, afterEviction.size());
        assertEquals("id-1", afterEviction.get(0).id);
        assertEquals("id-8", afterEviction.get(7).id);

        assertTrue(buffer.acknowledge("id-4"));
        assertFalse(buffer.acknowledge("id-4"));
        assertEquals(7, buffer.consume().size());
        assertFalse(buffer.consume().stream().anyMatch(action -> "id-4".equals(action.id)));
    }

    @Test
    public void permissionMarkerOnlySnapshot_isEmptyAndSeedsAndSchedules() {
        Map<String, Object> preferences = new HashMap<String, Object>();
        preferences.put(WeeklyNotificationPolicy.KEY_PERMISSION_REQUESTED, true);
        assertEquals(SnapshotRead.State.EMPTY, WeeklyNotificationPolicy.read(preferences).state);

        FakePlatform platform = new FakePlatform(SUNDAY_AT_NINE);
        platform.read = WeeklyNotificationPolicy.read(preferences);

        WeeklyNotificationController.ReconcileResult result = reconcile(
                platform, true, 9, UTC);

        assertTrue(result.scheduled);
        assertTrue(result.caughtUp);
        assertEquals(1, platform.scheduleCount);
        assertEquals(3, platform.writes.size());
        assertEquals("2024-05-06", platform.postedWeeks.get(0));
    }

    @Test
    public void disabledReconcile_commitsDurableDisableBeforeCancellation() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, "2024-05-06", "2024-04-29"));

        WeeklyNotificationController.ReconcileResult result = reconcile(
                platform, false, 12, "America/New_York");

        assertFalse(result.scheduled);
        assertFalse(result.caughtUp);
        assertEquals(1, platform.cancelCount);
        assertEquals(false, platform.writes.get(0).enabled);
        assertEquals(12, platform.writes.get(0).hour);
        assertEquals("America/New_York", platform.writes.get(0).timezone);
        assertEquals("2024-05-06", platform.writes.get(0).lastNotifiedWeek);
        assertEquals("2024-04-29", platform.writes.get(0).claimedWeek);
        assertEquals(0, platform.scheduleCount);
        assertEquals(0, platform.postedWeeks.size());
    }

    @Test
    public void disableThenRestart_retriesCancelWithoutRearmingOrPosting() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(false, 9, UTC, "2024-05-06", null));
        platform.cancelFailure = new RuntimeException("cancel unavailable");

        expectCode(WeeklyNotificationController.ErrorCode.CANCEL_FAILED,
                () -> reconcile(platform, false, 9, UTC));
        assertFalse(platform.persisted.enabled);
        assertEquals(0, platform.scheduleCount);
        assertEquals(0, platform.postedWeeks.size());

        platform.cancelFailure = null;
        platform.read = SnapshotRead.valid(platform.persisted);
        WeeklyNotificationController.ReconcileResult result = reconcile(
                platform, false, 9, UTC);
        assertFalse(result.scheduled);
        assertFalse(result.caughtUp);
        assertEquals(2, platform.cancelCount);
        assertEquals(0, platform.scheduleCount);
        assertEquals(0, platform.postedWeeks.size());
    }

    @Test
    public void disabledCommitFailure_rejectsBeforeCancellation() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, null, null));
        platform.failWrites = true;

        expectCode(WeeklyNotificationController.ErrorCode.PREFERENCE_WRITE_FAILED,
                () -> reconcile(platform, false, 9, UTC));
        assertEquals(0, platform.cancelCount);
        assertEquals(0, platform.scheduleCount);
    }

    @Test
    public void enabledPath_schedulesStrictlyFutureAlarm() {
        FakePlatform platform = new FakePlatform(SUNDAY_AT_NINE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, "2024-05-06", null));

        WeeklyNotificationController.ReconcileResult result = reconcile(
                platform, true, 9, UTC);

        assertTrue(result.scheduled);
        assertFalse(result.caughtUp);
        assertTrue(platform.scheduledTarget.triggerAtMillis > SUNDAY_AT_NINE);
        assertEquals(Instant.parse("2024-05-19T09:00:00Z").toEpochMilli(),
                platform.scheduledTarget.triggerAtMillis);
        assertEquals(0, platform.postedWeeks.size());
    }

    @Test
    public void sameWeek_isSuppressedByLastNotificationMarker() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, "2024-05-06", null));

        WeeklyNotificationController.ReconcileResult result = reconcile(
                platform, true, 9, UTC);

        assertTrue(result.scheduled);
        assertFalse(result.caughtUp);
        assertEquals(0, platform.postedWeeks.size());
    }

    @Test
    public void largeForwardJump_postsOnlyLatestDueWeek() {
        FakePlatform platform = new FakePlatform(Instant.parse("2024-08-01T12:00:00Z").toEpochMilli());
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, "2024-05-06", null));

        WeeklyNotificationController.ReconcileResult result = reconcile(
                platform, true, 9, UTC);

        assertTrue(result.scheduled);
        assertTrue(result.caughtUp);
        assertEquals(1, platform.postedWeeks.size());
        assertEquals("2024-07-22", platform.postedWeeks.get(0));
    }

    @Test
    public void permissionDenied_schedulesWithoutClaimPostOrDedupeRecord() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, null, null));
        platform.canPost = false;

        WeeklyNotificationController.ReconcileResult result = reconcile(
                platform, true, 9, UTC);

        assertTrue(result.scheduled);
        assertFalse(result.caughtUp);
        assertEquals(0, platform.postedWeeks.size());
        assertEquals(0, platform.claimWrites);
        assertEquals(0, platform.dedupeWrites);
        assertNull(platform.persisted.lastNotifiedWeek);
        assertNull(platform.persisted.claimedWeek);
    }

    @Test
    public void postFailure_clearsClaimAndCanRetryOnNextReconcile() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, null, null));
        platform.postFailure = new RuntimeException("post unavailable");

        expectCode(WeeklyNotificationController.ErrorCode.POST_FAILED,
                () -> reconcile(platform, true, 9, UTC));
        assertEquals(1, platform.scheduleCount);
        assertNull(platform.persisted.claimedWeek);
        assertEquals(0, platform.postedWeeks.size());

        platform.postFailure = null;
        platform.read = SnapshotRead.valid(platform.persisted);
        WeeklyNotificationController.ReconcileResult retry = reconcile(
                platform, true, 9, UTC);
        assertTrue(retry.scheduled);
        assertTrue(retry.caughtUp);
        assertEquals(1, platform.postedWeeks.size());
    }

    @Test
    public void postFailure_clearFailureRetainsClaimAndSuppressesRestartRetry() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, null, null));
        platform.postFailure = new RuntimeException("post unavailable");
        platform.failClear = true;

        expectCode(WeeklyNotificationController.ErrorCode.POST_FAILED,
                () -> reconcile(platform, true, 9, UTC));
        assertEquals("2024-05-06", platform.persisted.claimedWeek);
        assertEquals(1, platform.scheduleCount);

        platform.postFailure = null;
        platform.failClear = false;
        platform.read = SnapshotRead.valid(platform.persisted);
        WeeklyNotificationController.ReconcileResult restart = reconcile(
                platform, true, 9, UTC);
        assertTrue(restart.scheduled);
        assertFalse(restart.caughtUp);
        assertEquals(0, platform.postedWeeks.size());
    }

    @Test
    public void writeAheadClaimFailure_doesNotNotify() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, null, null));
        platform.failClaimWrite = true;

        expectCode(WeeklyNotificationController.ErrorCode.CLAIM_WRITE_FAILED,
                () -> reconcile(platform, true, 9, UTC));
        assertEquals(0, platform.postedWeeks.size());
        assertEquals(1, platform.scheduleCount);
    }

    @Test
    public void finalRecordFailure_leavesClaimAndRestartSuppressesDuplicate() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, null, null));
        platform.failFinalWrite = true;

        expectCode(WeeklyNotificationController.ErrorCode.FINAL_WRITE_FAILED,
                () -> reconcile(platform, true, 9, UTC));
        assertEquals(1, platform.postedWeeks.size());
        assertEquals(1, platform.scheduleCount);
        assertEquals("2024-05-06", platform.persisted.claimedWeek);
        assertNull(platform.persisted.lastNotifiedWeek);

        platform.failFinalWrite = false;
        platform.read = SnapshotRead.valid(platform.persisted);
        WeeklyNotificationController.ReconcileResult restart = reconcile(
                platform, true, 9, UTC);
        assertTrue(restart.scheduled);
        assertFalse(restart.caughtUp);
        assertEquals(1, platform.postedWeeks.size());
    }

    @Test
    public void scheduleFailure_rejectsInsteadOfReportingScheduled() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, "2024-05-06", null));
        platform.scheduleFailure = new RuntimeException("alarm unavailable");

        expectCode(WeeklyNotificationController.ErrorCode.SCHEDULE_FAILED,
                () -> reconcile(platform, true, 9, UTC));
        assertEquals(0, platform.postedWeeks.size());
    }

    @Test
    public void processRestartAfterClaimBeforePost_suppressesDuplicate() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, null, null));
        platform.crashAfterClaim = true;

        expectCode(WeeklyNotificationController.ErrorCode.CLAIM_WRITE_FAILED,
                () -> reconcile(platform, true, 9, UTC));
        assertEquals("2024-05-06", platform.persisted.claimedWeek);
        assertEquals(0, platform.postedWeeks.size());

        platform.crashAfterClaim = false;
        platform.read = SnapshotRead.valid(platform.persisted);
        WeeklyNotificationController.ReconcileResult restart = reconcile(
                platform, true, 9, UTC);
        assertTrue(restart.scheduled);
        assertFalse(restart.caughtUp);
        assertEquals(0, platform.postedWeeks.size());
    }

    @Test
    public void clockRollback_isSuppressedByOrderedIsoMarkerComparison() {
        FakePlatform platform = new FakePlatform(Instant.parse("2024-05-01T12:00:00Z").toEpochMilli());
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, "2024-05-06", null));

        WeeklyNotificationController.ReconcileResult result = reconcile(
                platform, true, 9, UTC);

        assertTrue(result.scheduled);
        assertFalse(result.caughtUp);
        assertEquals(0, platform.postedWeeks.size());
    }

    @Test
    public void malformedInput_cancelsAndPersistsDisabledWithoutOverwritingMarkers() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, "2024-05-06", "2024-04-29"));

        expectCode(WeeklyNotificationController.ErrorCode.INVALID_SETTINGS,
                () -> reconcile(platform, true, 24, UTC));
        assertEquals(1, platform.cancelCount);
        assertFalse(platform.persisted.enabled);
        assertEquals("2024-05-06", platform.persisted.lastNotifiedWeek);
        assertEquals("2024-04-29", platform.persisted.claimedWeek);
        assertEquals(0, platform.scheduleCount);
        assertEquals(0, platform.postedWeeks.size());
    }

    @Test
    public void invalidInput_cancelFailureStillAttemptsDurableDisable() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, "2024-05-06", null));
        platform.cancelFailure = new RuntimeException("cancel unavailable");

        expectCode(WeeklyNotificationController.ErrorCode.INVALID_SETTINGS,
                () -> reconcile(platform, true, 24, UTC));
        assertFalse(platform.persisted.enabled);
        assertEquals("2024-05-06", platform.persisted.lastNotifiedWeek);
        assertEquals(0, platform.scheduleCount);
    }

    @Test
    public void corruptPartialState_cancelsAndRejectsWithoutScheduling() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.corruptPartial(snapshot(false, 9, UTC, "2024-05-06", null));

        expectCode(WeeklyNotificationController.ErrorCode.CORRUPT_SNAPSHOT,
                () -> reconcile(platform, true, 9, UTC));
        assertEquals(1, platform.cancelCount);
        assertFalse(platform.persisted.enabled);
        assertEquals("2024-05-06", platform.persisted.lastNotifiedWeek);
        assertEquals(0, platform.scheduleCount);
        assertEquals(0, platform.postedWeeks.size());
    }

    @Test
    public void markers_surviveDisableAndReenable() {
        FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, "2024-05-06", "2024-04-29"));

        reconcile(platform, false, 14, "Asia/Tokyo");
        WeeklySnapshot disabled = platform.persisted;
        assertEquals("2024-05-06", disabled.lastNotifiedWeek);
        assertEquals("2024-04-29", disabled.claimedWeek);

        platform.read = SnapshotRead.valid(disabled);
        reconcile(platform, true, 8, UTC);
        assertEquals("2024-05-06", platform.persisted.lastNotifiedWeek);
        assertEquals("2024-04-29", platform.persisted.claimedWeek);
        assertEquals(0, platform.postedWeeks.size());
    }

    @Test
    public void reconciliation_isSerializedByControllerLock() throws Exception {
        final FakePlatform platform = new FakePlatform(AFTER_DUE);
        platform.read = SnapshotRead.valid(snapshot(true, 9, UTC, "2024-05-06", null));
        platform.blockFirstRead = true;
        final WeeklyNotificationController controller = new WeeklyNotificationController(platform);
        final AtomicReference<Throwable> failure = new AtomicReference<Throwable>();
        final CountDownLatch firstFinished = new CountDownLatch(1);
        final CountDownLatch secondStarted = new CountDownLatch(1);
        final CountDownLatch secondFinished = new CountDownLatch(1);

        Thread first = reconcileAsync(controller, failure, null, firstFinished);
        assertTrue(platform.firstReadStarted.await(1, TimeUnit.SECONDS));
        Thread second = reconcileAsync(controller, failure, secondStarted, secondFinished);
        assertTrue(secondStarted.await(1, TimeUnit.SECONDS));
        assertFalse(platform.secondReadEntered.await(100, TimeUnit.MILLISECONDS));

        platform.releaseFirstRead.countDown();
        assertTrue(platform.firstReadFinished.await(1, TimeUnit.SECONDS));
        assertTrue(platform.secondReadEntered.await(1, TimeUnit.SECONDS));
        assertTrue(firstFinished.await(1, TimeUnit.SECONDS));
        assertTrue(secondFinished.await(1, TimeUnit.SECONDS));
        first.join(1000L);
        second.join(1000L);

        assertFalse(platform.secondReadEnteredBeforeRelease.get());
        assertNull(failure.get());
        assertEquals(1, platform.maxConcurrentReads.get());
    }

    private static Thread reconcileAsync(
            final WeeklyNotificationController controller,
            final AtomicReference<Throwable> failure,
            final CountDownLatch started,
            final CountDownLatch finished) {
        Thread thread = new Thread(() -> {
            if (started != null) {
                started.countDown();
            }
            try {
                controller.reconcile(new WeeklySettings(true, 9, UTC));
            } catch (Throwable error) {
                failure.compareAndSet(null, error);
            } finally {
                finished.countDown();
            }
        });
        thread.start();
        return thread;
    }

    private static WeeklyNotificationController.ReconcileResult reconcile(
            FakePlatform platform, boolean enabled, int hour, String timezone) {
        return new WeeklyNotificationController(platform).reconcile(
                new WeeklySettings(enabled, hour, timezone));
    }

    private static WeeklySnapshot snapshot(
            boolean enabled, int hour, String timezone, String last, String claimed) {
        return new WeeklySnapshot(enabled, hour, timezone, last, claimed);
    }

    private static void expectCode(
            WeeklyNotificationController.ErrorCode code, Runnable operation) {
        try {
            operation.run();
            fail("expected " + code);
        } catch (WeeklyNotificationController.WeeklyNotificationException error) {
            assertEquals(code, error.code);
            assertEquals(code.value, error.getMessage());
            assertNotNull(error.getMessage());
        }
    }

    private static final class FakePlatform implements WeeklyNotificationPlatform {
        private final long nowMillis;
        private SnapshotRead read = SnapshotRead.empty();
        private WeeklySnapshot persisted = snapshot(false, 9, UTC, null, null);
        private final List<WeeklySnapshot> writes = new ArrayList<WeeklySnapshot>();
        private final List<String> postedWeeks = new ArrayList<String>();
        private WeeklyScheduleMath.ScheduleTarget scheduledTarget;
        private int scheduleCount;
        private int cancelCount;
        private int claimWrites;
        private int dedupeWrites;
        private boolean canPost = true;
        private boolean failWrites;
        private boolean failClaimWrite;
        private boolean failFinalWrite;
        private boolean failClear;
        private boolean crashAfterClaim;
        private RuntimeException cancelFailure;
        private RuntimeException scheduleFailure;
        private RuntimeException postFailure;
        private boolean blockFirstRead;
        private final CountDownLatch firstReadStarted = new CountDownLatch(1);
        private final CountDownLatch releaseFirstRead = new CountDownLatch(1);
        private final CountDownLatch firstReadFinished = new CountDownLatch(1);
        private final CountDownLatch secondReadEntered = new CountDownLatch(1);
        private final AtomicBoolean secondReadEnteredBeforeRelease = new AtomicBoolean();
        private final AtomicBoolean firstRead = new AtomicBoolean(true);
        private final AtomicInteger activeReads = new AtomicInteger();
        private final AtomicInteger maxConcurrentReads = new AtomicInteger();

        private FakePlatform(long nowMillis) {
            this.nowMillis = nowMillis;
        }

        @Override
        public long nowMillis() {
            return nowMillis;
        }

        @Override
        public SnapshotRead readSnapshot() {
            int active = activeReads.incrementAndGet();
            maxConcurrentReads.accumulateAndGet(active, Math::max);
            boolean isFirstRead = blockFirstRead && firstRead.compareAndSet(true, false);
            try {
                if (isFirstRead) {
                    firstReadStarted.countDown();
                    try {
                        releaseFirstRead.await(1, TimeUnit.SECONDS);
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                    }
                } else if (blockFirstRead) {
                    if (releaseFirstRead.getCount() != 0) {
                        secondReadEnteredBeforeRelease.set(true);
                    }
                    secondReadEntered.countDown();
                }
                return read;
            } finally {
                activeReads.decrementAndGet();
                if (isFirstRead) {
                    firstReadFinished.countDown();
                }
            }
        }

        @Override
        public synchronized boolean writeSnapshot(WeeklySnapshot snapshot) {
            if (snapshot.claimedWeek != null) {
                claimWrites++;
                if (failClaimWrite) {
                    return false;
                }
            }
            if (snapshot.lastNotifiedWeek != null) {
                dedupeWrites++;
                if (failFinalWrite) {
                    return false;
                }
            } else if (snapshot.claimedWeek == null && persisted.claimedWeek != null && failClear) {
                return false;
            }
            if (failWrites) {
                return false;
            }
            persisted = snapshot;
            writes.add(snapshot);
            if (crashAfterClaim && snapshot.claimedWeek != null) {
                crashAfterClaim = false;
                throw new RuntimeException("simulated process death after durable claim");
            }
            return true;
        }

        @Override
        public synchronized void scheduleNext(WeeklyScheduleMath.ScheduleTarget target) {
            if (scheduleFailure != null) {
                throw scheduleFailure;
            }
            scheduleCount++;
            scheduledTarget = target;
        }

        @Override
        public synchronized void cancelAlarm() {
            cancelCount++;
            if (cancelFailure != null) {
                throw cancelFailure;
            }
        }

        @Override
        public boolean canPostNotification() {
            return canPost;
        }

        @Override
        public synchronized void postWeeklyNotification(String weekKey) {
            if (postFailure != null) {
                throw postFailure;
            }
            postedWeeks.add(weekKey);
        }
    }
}
