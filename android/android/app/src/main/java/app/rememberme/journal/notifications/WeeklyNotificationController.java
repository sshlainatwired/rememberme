package app.rememberme.journal.notifications;

/** Serialized, durable-first policy for the local weekly reminder. */
final class WeeklyNotificationController {

    enum ErrorCode {
        INVALID_SETTINGS("invalid_settings"),
        CORRUPT_SNAPSHOT("corrupt_snapshot"),
        PLATFORM_READ_FAILED("platform_read_failed"),
        PREFERENCE_WRITE_FAILED("preference_write_failed"),
        CLAIM_WRITE_FAILED("claim_write_failed"),
        FINAL_WRITE_FAILED("final_write_failed"),
        POST_FAILED("post_failed"),
        SCHEDULE_FAILED("schedule_failed"),
        CANCEL_FAILED("cancel_failed"),
        PLATFORM_FAILED("platform_failed");

        final String value;

        ErrorCode(String value) {
            this.value = value;
        }
    }

    static final class WeeklyNotificationException extends RuntimeException {
        final ErrorCode code;

        WeeklyNotificationException(ErrorCode code) {
            super(code.value);
            this.code = code;
        }

        WeeklyNotificationException(ErrorCode code, Throwable cause) {
            super(code.value, cause);
            this.code = code;
        }
    }

    static final class ReconcileResult {
        final boolean scheduled;
        final boolean caughtUp;

        ReconcileResult(boolean scheduled, boolean caughtUp) {
            this.scheduled = scheduled;
            this.caughtUp = caughtUp;
        }
    }

    private final WeeklyNotificationPlatform platform;

    WeeklyNotificationController(WeeklyNotificationPlatform platform) {
        if (platform == null) {
            throw new IllegalArgumentException("platform_required");
        }
        this.platform = platform;
    }

    synchronized ReconcileResult reconcile(WeeklySettings incoming) {
        SnapshotRead read = readSnapshot();
        if (!WeeklyNotificationValidation.validSettings(incoming)) {
            rejectInvalid(read);
        }
        if (read == null || read.state == null || read.state == SnapshotRead.State.CORRUPT_PARTIAL) {
            rejectCorrupt(read);
        }

        WeeklySnapshot current;
        boolean seeded = read.state == SnapshotRead.State.EMPTY;
        if (seeded) {
            current = new WeeklySnapshot(incoming.enabled, incoming.hour, incoming.timezone, null, null);
            writeOrReject(current, ErrorCode.PREFERENCE_WRITE_FAILED);
        } else {
            current = read.snapshot;
            if (!WeeklyNotificationValidation.validSnapshot(current)) {
                rejectCorrupt(read);
            }
        }

        if (!incoming.enabled) {
            WeeklySnapshot disabled = current.withSettings(incoming);
            if (!seeded) {
                writeOrReject(disabled, ErrorCode.PREFERENCE_WRITE_FAILED);
            }
            cancelOrReject();
            return new ReconcileResult(false, false);
        }

        WeeklySnapshot configured = current.withSettings(incoming);
        if (!seeded) {
            writeOrReject(configured, ErrorCode.PREFERENCE_WRITE_FAILED);
        }
        return reconcileEnabled(configured);
    }

    private SnapshotRead readSnapshot() {
        try {
            SnapshotRead read = platform.readSnapshot();
            if (read == null) {
                throw new IllegalStateException("null_snapshot_read");
            }
            return read;
        } catch (WeeklyNotificationException error) {
            throw error;
        } catch (RuntimeException error) {
            throw new WeeklyNotificationException(ErrorCode.PLATFORM_READ_FAILED, error);
        }
    }

    private ReconcileResult reconcileEnabled(WeeklySnapshot configured) {
        long now;
        WeeklyScheduleMath.ScheduleTarget next;
        String due;
        try {
            now = platform.nowMillis();
            next = WeeklyScheduleMath.nextSundayAt(configured.timezone, configured.hour, now);
            due = WeeklyScheduleMath.latestDueWeek(configured.timezone, configured.hour, now);
        } catch (RuntimeException error) {
            throw new WeeklyNotificationException(ErrorCode.PLATFORM_FAILED, error);
        }

        if (covered(configured.lastNotifiedWeek, due)
                || covered(configured.claimedWeek, due)) {
            return scheduleResult(next, false);
        }
        if (!canPost()) {
            return scheduleResult(next, false);
        }

        WeeklyNotificationException failure = null;
        boolean caughtUp = false;
        try {
            WeeklySnapshot claimed = configured.withMarkers(configured.lastNotifiedWeek, due);
            if (!writeSnapshot(claimed, ErrorCode.CLAIM_WRITE_FAILED)) {
                throw new WeeklyNotificationException(ErrorCode.CLAIM_WRITE_FAILED);
            }

            try {
                platform.postWeeklyNotification(due);
            } catch (RuntimeException error) {
                clearClaimBestEffort(claimed);
                throw new WeeklyNotificationException(ErrorCode.POST_FAILED, error);
            }

            WeeklySnapshot recorded = claimed.withMarkers(due, null);
            if (!writeSnapshot(recorded, ErrorCode.FINAL_WRITE_FAILED)) {
                throw new WeeklyNotificationException(ErrorCode.FINAL_WRITE_FAILED);
            }
            caughtUp = true;
        } catch (WeeklyNotificationException error) {
            failure = error;
        } catch (RuntimeException error) {
            failure = new WeeklyNotificationException(ErrorCode.PLATFORM_FAILED, error);
        }

        try {
            platform.scheduleNext(next);
        } catch (RuntimeException error) {
            if (failure == null) {
                failure = new WeeklyNotificationException(ErrorCode.SCHEDULE_FAILED, error);
            }
        }
        if (failure != null) {
            throw failure;
        }
        return new ReconcileResult(true, caughtUp);
    }

    private ReconcileResult scheduleResult(
            WeeklyScheduleMath.ScheduleTarget next, boolean caughtUp) {
        try {
            platform.scheduleNext(next);
            return new ReconcileResult(true, caughtUp);
        } catch (RuntimeException error) {
            throw new WeeklyNotificationException(ErrorCode.SCHEDULE_FAILED, error);
        }
    }

    private boolean canPost() {
        try {
            return platform.canPostNotification();
        } catch (RuntimeException error) {
            throw new WeeklyNotificationException(ErrorCode.PLATFORM_FAILED, error);
        }
    }

    private boolean writeSnapshot(WeeklySnapshot snapshot, ErrorCode code) {
        try {
            return platform.writeSnapshot(snapshot);
        } catch (RuntimeException error) {
            throw new WeeklyNotificationException(code, error);
        }
    }

    private void writeOrReject(WeeklySnapshot snapshot, ErrorCode code) {
        try {
            if (!platform.writeSnapshot(snapshot)) {
                throw new WeeklyNotificationException(code);
            }
        } catch (WeeklyNotificationException error) {
            throw error;
        } catch (RuntimeException error) {
            throw new WeeklyNotificationException(code, error);
        }
    }

    private void cancelOrReject() {
        try {
            platform.cancelAlarm();
        } catch (RuntimeException error) {
            throw new WeeklyNotificationException(ErrorCode.CANCEL_FAILED, error);
        }
    }

    private void clearClaimBestEffort(WeeklySnapshot claimed) {
        try {
            platform.writeSnapshot(claimed.withMarkers(claimed.lastNotifiedWeek, null));
        } catch (RuntimeException ignored) {
            // Keep the durable claim when the clear cannot be committed.
        }
    }

    private void rejectInvalid(SnapshotRead read) {
        rejectDisabled(ErrorCode.INVALID_SETTINGS, read);
    }

    private void rejectCorrupt(SnapshotRead read) {
        rejectDisabled(ErrorCode.CORRUPT_SNAPSHOT, read);
    }

    private void rejectDisabled(ErrorCode reason, SnapshotRead read) {
        WeeklySnapshot retained = retainedSnapshot(read == null ? null : read.snapshot);
        RuntimeException cancelFailure = null;
        try {
            platform.cancelAlarm();
        } catch (RuntimeException error) {
            cancelFailure = error;
        }

        RuntimeException writeFailure = null;
        boolean written = false;
        try {
            written = platform.writeSnapshot(retained);
        } catch (RuntimeException error) {
            writeFailure = error;
        }
        if (cancelFailure != null) {
            throw new WeeklyNotificationException(reason, cancelFailure);
        }
        if (writeFailure != null) {
            throw new WeeklyNotificationException(reason, writeFailure);
        }
        if (!written) {
            throw new WeeklyNotificationException(reason);
        }
        throw new WeeklyNotificationException(reason);
    }

    private static WeeklySnapshot retainedSnapshot(WeeklySnapshot candidate) {
        if (candidate == null) {
            return new WeeklySnapshot(false, 0, "UTC", null, null);
        }
        int hour = WeeklyNotificationValidation.validHour(candidate.hour) ? candidate.hour : 0;
        String timezone = WeeklyNotificationValidation.validTimezone(candidate.timezone)
                ? candidate.timezone : "UTC";
        String last = WeeklyNotificationValidation.validMarker(candidate.lastNotifiedWeek)
                ? candidate.lastNotifiedWeek : null;
        String claimed = WeeklyNotificationValidation.validMarker(candidate.claimedWeek)
                ? candidate.claimedWeek : null;
        return new WeeklySnapshot(false, hour, timezone, last, claimed);
    }

    private static boolean covered(String marker, String due) {
        return marker != null && marker.compareTo(due) >= 0;
    }
}
