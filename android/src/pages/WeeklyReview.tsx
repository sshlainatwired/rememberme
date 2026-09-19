import {
	buildDigestWeek,
	type DigestWeek,
	formatWeekRange,
	type InstantLike,
	mondayOfWeek,
	mostRecentSunday,
	todayInTimezone,
} from "@rememberme/core";
import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DatabaseHandle } from "@/db/bootstrap";
import { useStorage } from "@/db/storage";
import { useSettings } from "@/db/use-settings";

const MASKED_ERROR = "We couldn't load your weekly review. Please try again.";
const WEEKDAYS = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
] as const;

type ReviewState =
	| { status: "loading" }
	| { status: "error" }
	| { status: "ready"; week: DigestWeek; range: string; count: number };

export interface WeeklyReviewProps {
	/** Current instant; defaults to one captured wall-clock instant. */
	now?: InstantLike;
}

/**
 * Weekly Review — the saved-timezone Monday–Sunday journal digest.
 *
 * Storage, settings, week derivation, and the journal read are all fail-closed:
 * unresolved/absent storage never renders day content, and every read/helper
 * failure renders the same stable copy. Owner identity and a monotonically
 * increasing generation keep late reads from a replaced database or week out
 * of the current screen.
 */
export default function WeeklyReview({ now }: WeeklyReviewProps) {
	const storage = useStorage();
	const { settings, error: settingsError } = useSettings();
	const wallClockNowRef = useRef<InstantLike>(now ?? new Date());
	const instant = now ?? wallClockNowRef.current;
	const [review, setReview] = useState<ReviewState>({ status: "loading" });
	const mountedRef = useRef(true);
	const ownerRef = useRef<DatabaseHandle | null>(storage);
	const generationRef = useRef(0);
	const inputRef = useRef({
		owner: storage,
		timezone: settings?.timezone ?? null,
		instant,
		settingsError,
	});

	// Clear the previous owner's/week's resolved days during render, before the
	// replacement read can settle. This mirrors the storage/settings identity
	// boundary and prevents a stale day frame during a provider rebind or
	// settings failure.
	if (
		inputRef.current.owner !== storage ||
		inputRef.current.timezone !== (settings?.timezone ?? null) ||
		inputRef.current.instant !== instant ||
		inputRef.current.settingsError !== settingsError
	) {
		inputRef.current = {
			owner: storage,
			timezone: settings?.timezone ?? null,
			instant,
			settingsError,
		};
		ownerRef.current = storage;
		generationRef.current += 1;
		setReview({ status: "loading" });
	}

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const timezone = settings?.timezone ?? null;
	useEffect(() => {
		const generation = ++generationRef.current;
		let cancelled = false;
		if (storage === null || timezone === null || settingsError !== null) {
			return () => {
				cancelled = true;
			};
		}

		const owner = storage;
		const isCurrent = () =>
			!cancelled &&
			mountedRef.current &&
			ownerRef.current === owner &&
			generationRef.current === generation;

		setReview({ status: "loading" });
		void (async () => {
			try {
				const today = todayInTimezone(timezone, instant);
				const sunday = mostRecentSunday(today);
				const monday = mondayOfWeek(sunday);
				const rows = await owner.journal.list(monday, sunday);
				const contentByDate = new Map<string, string>();
				for (const row of rows) contentByDate.set(row.date, row.content);
				const week = buildDigestWeek(monday, contentByDate);
				const count = week.filter((day) => day.content !== null).length;
				if (isCurrent()) {
					setReview({ status: "ready", week, range: formatWeekRange(monday), count });
				}
			} catch {
				if (isCurrent()) setReview({ status: "error" });
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [instant, settingsError, storage, timezone]);

	const pending = storage !== null && settings === null && settingsError === null;

	return (
		<section aria-labelledby="weekly-title" className="page-section">
			<div className="page-heading-row">
				<Sparkles className="page-icon" aria-hidden="true" />
				<h1 id="weekly-title" className="page-title">
					Weekly Review
				</h1>
			</div>

			{settingsError !== null ? (
				<div role="alert">
					<p>{MASKED_ERROR}</p>
				</div>
			) : storage === null ? (
				<Card>
					<CardContent>
						<p className="muted-text">
							Review requires the on-device database, which is only available inside the Android
							app.
						</p>
					</CardContent>
				</Card>
			) : pending ? (
				<p role="status" className="muted-text">
					Loading your weekly review…
				</p>
			) : review.status === "error" ? (
				<div role="alert">
					<p>{MASKED_ERROR}</p>
				</div>
			) : review.status === "ready" ? (
				<Card>
					<CardHeader>
						<CardTitle>This week, at a glance</CardTitle>
						<h3>{review.range}</h3>
						<CardDescription>
							{review.count} {review.count === 1 ? "entry" : "entries"}
						</CardDescription>
					</CardHeader>
					<CardContent>
						<ol>
							{review.week.map((day, index) => (
								<li key={day.date}>
									<h4>
										{WEEKDAYS[index]} <time dateTime={day.date}>{day.date}</time>
									</h4>
									<pre data-testid={`weekly-entry-${day.date}`}>
										{day.content === null ? "No entry." : day.content}
									</pre>
								</li>
							))}
						</ol>
					</CardContent>
				</Card>
			) : (
				<p role="status" className="muted-text">
					Loading your weekly review…
				</p>
			)}
		</section>
	);
}
