import { journalDateSchema, mondayOfWeek, weekDates } from "@rememberme/core";
import { Navigate, useParams } from "react-router-dom";
import JournalView from "@/components/journal/JournalView";

/**
 * Journal — the daily journal screen for an arbitrary calendar date.
 *
 * The date comes from the `/journal/:date` route parameter and is validated
 * against the shared `journalDateSchema` (real `YYYY-MM-DD` calendar dates
 * only, leap years included). Anything malformed — a wrong shape, an
 * impossible date like February 30, a non-numeric segment — is redirected
 * safely to Today.
 *
 * Boundary weeks: a well-formed date can still be unrenderable when its own
 * Monday–Sunday week falls outside the representable year range 0000..9999 —
 * `mondayOfWeek` underflows for dates in 0000-01-01..0000-01-02, and
 * `weekDates` overflows for 9999-12-27..9999-12-31. Those dates redirect to
 * Today. WeekStrip separately omits an adjacent-week control when only that
 * navigation target is outside the range.
 *
 * Phase 5 Task 7 hands all rendering to `<JournalView>{date}`, which owns the
 * heading, WeekStrip, and keyed editor.
 */
export default function Journal() {
	const parsed = journalDateSchema.safeParse(useParams().date);
	if (!parsed.success) {
		return <Navigate to="/today" replace />;
	}
	const date = parsed.data;
	try {
		weekDates(mondayOfWeek(date));
	} catch (error) {
		if (error instanceof RangeError) {
			return <Navigate to="/today" replace />;
		}
		throw error;
	}

	return <JournalView date={date} />;
}
