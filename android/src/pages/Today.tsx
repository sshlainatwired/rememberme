import { type InstantLike, todayInTimezone } from "@rememberme/core";
import { NotebookPen } from "lucide-react";
import { deviceTimezone } from "@/auth/device-timezone";
import JournalView from "@/components/journal/JournalView";
import { useStorage } from "@/db/storage";
import { useSettings } from "@/db/use-settings";

/**
 * Today — the daily journal entry screen. Phase 2 adds the Monday–Sunday
 * WeekStrip (shared calendar helpers); Phase 3 added the on-device SQLite
 * storage seam; Phase 4 added SQLCipher whole-database encryption. The
 * Phase 5 Task 7 delegates the rendered content to `<JournalView>{date}`, which
 * owns the WeekStrip + editor. Today adds only the settings fail-closed gate.
 *
 * Phase 5 Task 6: "today" is the calendar date in the SAVED timezone
 * (`settings.timezone`, seeded by first-run setup). While a real storage
 * read is pending or failed, Today fails closed — an accessible loading or
 * error state, never a device-zone date. The device zone is only ever the
 * fallback for the null-storage App-alone seam (web/test/dev), and once
 * settings are loaded it is never consulted for the Today date. `now` is an
 * injectable instant seam so tests are deterministic; production uses the
 * wall clock.
 */
export interface TodayProps {
	/** Current instant; defaults to the wall clock, injectable for tests. */
	now?: InstantLike;
}

export default function Today({ now }: TodayProps) {
	const storage = useStorage();
	const { settings, error } = useSettings();

	// A real storage read is pending (settings null, no error yet) or failed;
	// Today fails closed here — no device-zone date, no week strip.
	const pending = storage !== null && settings === null && error === null;
	const failed = storage !== null && settings === null && error !== null;

	const zone = settings?.timezone ?? deviceTimezone();
	const today = todayInTimezone(zone, now ?? new Date());

	return (
		<>
			{pending && (
				<p role="status" className="muted-text">
					Loading your journal…
				</p>
			)}
			<section
				aria-labelledby="today-title"
				className="page-section"
				aria-busy={pending || undefined}
			>
				<div className="page-heading-row">
					<NotebookPen className="page-icon" aria-hidden="true" />
					<h1 id="today-title" className="page-title">
						Today
					</h1>
				</div>

				{failed && (
					<div role="alert">
						<p>We couldn't load your journal.</p>
						<p className="muted-text">Please try again.</p>
					</div>
				)}
				{!pending && !failed && <JournalView date={today} />}
			</section>
		</>
	);
}
