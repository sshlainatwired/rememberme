import { DateTime } from "luxon";
import type { AppConfig } from "../config";
import type { JournalCipher } from "../crypto/journal-encryption";
import type { Db } from "../db/client";
import {
	deleteDelivery,
	listDigestSubscribers,
	listEntriesBetween,
	tryRecordDelivery,
} from "../db/repo";
import type { Mailer } from "../mail/mailer";
import { buildDigestEmail } from "../mail/weekly-digest";

/**
 * Weekly digest job.
 *
 * Every Sunday evening (per the user's configured timezone and digest hour)
 * the job collects the previous Monday–Sunday week's journal entries,
 * decrypts them server-side, and emails them. Delivery is idempotent: the
 * (user_id, week_start, week_end) unique constraint guarantees a week is
 * never emailed twice, even if the job runs concurrently.
 *
 * Content is decrypted in memory only; nothing decrypted is written back to
 * the database and nothing is logged.
 */

export interface DigestDeps {
	db: Db;
	cipher: JournalCipher;
	mailer: Mailer;
	config: AppConfig;
}

export interface DigestRunResult {
	attempted: number;
	sent: number;
	alreadyDelivered: number;
	errors: string[];
}

/** The most recent Sunday (inclusive), as a calendar day. */
export function mostRecentSunday(now: DateTime): DateTime {
	const startOfDay = now.setZone("UTC").startOf("day");
	const daysSinceSunday = startOfDay.weekday % 7; // Mon=1..Sun=7 → Sun=0
	return startOfDay.minus({ days: daysSinceSunday });
}

/** Monday of the week containing `date`. */
export function mondayOfWeek(date: DateTime): DateTime {
	const startOfDay = date.setZone("UTC").startOf("day");
	return startOfDay.minus({ days: startOfDay.weekday - 1 });
}

function toDateString(dt: DateTime): string {
	return dt.toFormat("yyyy-MM-dd");
}

/**
 * Run the weekly digest.
 *
 * `dueCheck`: when true (scheduled mode) only users whose local time is
 * Sunday at their configured digest hour are processed. When false (manual
 * endpoint) every enabled user gets the most recently completed week.
 */
export async function runWeeklyDigest(
	deps: DigestDeps,
	now: DateTime = DateTime.now(),
	dueCheck = true,
): Promise<DigestRunResult> {
	const subscribers = await listDigestSubscribers(deps.db);
	const result: DigestRunResult = {
		attempted: subscribers.length,
		sent: 0,
		alreadyDelivered: 0,
		errors: [],
	};

	if (subscribers.length === 0) return result;

	for (const sub of subscribers) {
		const nowInTz = now.setZone(sub.timezone);
		const isDue = nowInTz.weekday === 7 && nowInTz.hour === sub.weeklyDigestHour;
		if (dueCheck && !isDue) continue;

		if (!sub.email) {
			result.errors.push(`digest email not set for user ${sub.userId}`);
			continue;
		}

		const weekEnd = mostRecentSunday(nowInTz);
		const weekStart = weekEnd.minus({ days: 6 });
		const weekStartStr = toDateString(weekStart);
		const weekEndStr = toDateString(weekEnd);

		// Claim this week first; only one concurrent run wins the insert.
		const claimed = await tryRecordDelivery(deps.db, sub.userId, weekStartStr, weekEndStr);
		if (!claimed) {
			result.alreadyDelivered += 1;
			continue;
		}

		try {
			const rows = await listEntriesBetween(deps.db, sub.userId, weekStartStr, weekEndStr);
			const byDate = new Map(rows.map((r) => [r.entryDate, r]));

			const days = [];
			for (let i = 0; i < 7; i++) {
				const date = weekStart.plus({ days: i });
				const row = byDate.get(toDateString(date));
				let content: string | null = null;
				if (row) {
					content = await deps.cipher.decrypt({
						encryptedContent: row.encryptedContent,
						iv: row.iv,
						authTag: row.authTag,
					});
				}
				days.push({ date, content });
			}

			const email = buildDigestEmail(weekStart, weekEnd, days);
			await deps.mailer.send({
				to: sub.email,
				subject: email.subject,
				text: email.text,
				html: email.html,
			});
			result.sent += 1;
		} catch (err) {
			// Undo the claim so the next run can retry.
			await deleteDelivery(deps.db, sub.userId, weekStartStr, weekEndStr);
			result.errors.push(`digest delivery failed for user ${sub.userId}`);
			console.error("Weekly digest delivery failed", err);
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// In-process scheduler (self-hosted friendly)
// ---------------------------------------------------------------------------

const SCHEDULER_TICK_MS = 5 * 60 * 1000; // every 5 minutes
let schedulerStarted = false;

/**
 * Start the in-process scheduler. It wakes every 5 minutes and runs the
 * digest with the Sunday-evening due check, honoring each user's timezone
 * and digest hour. Only runs while the server process is alive — document
 * this limitation; an external cron hitting POST /api/jobs/weekly-digest
 * works too.
 */
export function startDigestScheduler(deps: DigestDeps): void {
	if (schedulerStarted) return;
	schedulerStarted = true;

	const tick = async () => {
		try {
			await runWeeklyDigest(deps, DateTime.now(), true);
		} catch (err) {
			console.error("Weekly digest scheduler error", err);
		}
	};

	// Run shortly after boot, then on the interval.
	setTimeout(tick, 30_000);
	setInterval(tick, SCHEDULER_TICK_MS);
}
