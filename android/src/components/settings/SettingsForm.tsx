import { supportedTimeZones } from "@rememberme/core";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/auth/auth-context";
import NotificationPermissionCard from "@/components/notifications/NotificationPermissionCard";
import DataTransferCard from "@/components/settings/DataTransferCard";
import SecurityCard from "@/components/settings/SecurityCard";
import type { AppSettings } from "@/db/settings";
import { useStorage } from "@/db/storage";
import { useSettings } from "@/db/use-settings";
import { useNotificationPermission } from "@/notifications/use-notification-permission";

/** Radio options in display order (light → dark → system). */
const APPEARANCE_OPTIONS: ReadonlyArray<AppSettings["appearance"]> = ["light", "dark", "system"];

function appearanceLabel(appearance: AppSettings["appearance"]): string {
	return appearance[0].toUpperCase() + appearance.slice(1);
}

/**
 * SettingsForm — the Android settings controls (Phase 5 Task 9).
 *
 * Every control is a plain native element with an associated label/semantic
 * class. All changes persist through `SettingsService` (one validated partial
 * update per control; the service writes atomically inside a transaction and
 * returns the authoritative merged read-back, which this hook commits to the
 * UI).
 *
 * Weekly-review delivery, encrypted backup/restore, and native device-lock
 * protection are all live. Security state comes from the native service;
 * SQLite `biometricEnabled` remains only its post-open settings mirror.
 *
 * Fail-closed tiers:
 * - No storage (web/test/dev / App-alone): the on-device-database message.
 * - Real storage but settings still loading: an accessible loading status.
 * - Real storage but the settings read failed: an accessible alert with a
 *   Try again action that re-reads storage; the raw engine/path/SQL detail is
 *   never rendered (the hook keeps the message only as control-flow state).
 * - A storage-backed update failure surfaces a STABLE masked alert while the
 *   ready form stays mounted — never the raw internal error text.
 *
 * "Sign out" ends the in-memory session through the auth context; the
 * RequireAuth gate re-locks the protected routes.
 */
export default function SettingsForm() {
	const storage = useStorage();
	const { settings, error, reload, update } = useSettings();
	const { logout } = useAuth();
	const { requestIfPrompt } = useNotificationPermission();
	const mountedRef = useRef(false);
	const enableTokenRef = useRef(0);
	const storageRef = useRef(storage);
	const pendingWeeklyReviewRef = useRef<{
		storage: typeof storage;
		token: number;
		enabled: boolean;
	} | null>(null);
	const [pendingWeeklyReview, setPendingWeeklyReview] = useState<{
		storage: typeof storage;
		token: number;
		enabled: boolean;
	} | null>(null);
	if (storageRef.current !== storage) {
		storageRef.current = storage;
		++enableTokenRef.current;
	}

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			++enableTokenRef.current;
		};
	}, []);

	// Non-weekly controls keep the existing async persistence behavior. The
	// weekly toggle uses the awaited handler below so prompting can only follow
	// an authoritative, still-current successful write.
	const apply = (patch: Partial<AppSettings>): void => {
		update(patch).catch(() => {});
	};

	const setWeeklyReviewEnabled = async (enabled: boolean): Promise<void> => {
		const token = ++enableTokenRef.current;
		const capturedStorage = storage;
		const pending = { storage: capturedStorage, token, enabled };
		pendingWeeklyReviewRef.current = pending;
		setPendingWeeklyReview(pending);
		const isCurrentPending = () =>
			mountedRef.current &&
			token === enableTokenRef.current &&
			capturedStorage === storageRef.current &&
			pendingWeeklyReviewRef.current === pending;
		try {
			const latest = await update({ weeklyReviewEnabled: enabled });
			if (!isCurrentPending()) return;
			pendingWeeklyReviewRef.current = null;
			setPendingWeeklyReview(null);
			if (!enabled || !latest.weeklyReviewEnabled) return;
			await requestIfPrompt();
		} catch {
			if (isCurrentPending()) {
				pendingWeeklyReviewRef.current = null;
				setPendingWeeklyReview(null);
			}
			// useSettings records the masked save error; a failed write must never
			// reach the permission prompt.
		}
	};

	if (storage === null) {
		return (
			<p className="muted-text">
				Settings require the on-device database, which is only available inside the Android app.
			</p>
		);
	}

	// Real storage: the form fails closed until the settings read settles — an
	// accessible loading status while pending, an accessible alert on failure.
	// No controls render on unverified state.
	if (settings === null) {
		if (error === null) {
			return (
				<p role="status" className="muted-text">
					Loading your journal…
				</p>
			);
		}
		// Read failed: offer a retry that re-reads storage and recovers into the
		// ready form. `error` gates this tier (control flow) but its raw detail
		// is never rendered — the copy below is stable and safe.
		return (
			<div role="alert">
				<p>We couldn't load your settings.</p>
				<button type="button" className="btn btn-secondary" onClick={() => void reload()}>
					Try again
				</button>
			</div>
		);
	}

	const zones = [...supportedTimeZones].sort();
	const hours = Array.from({ length: 24 }, (_, h) => h);
	const weeklyReviewEnabled =
		pendingWeeklyReview?.storage === storage
			? pendingWeeklyReview.enabled
			: settings.weeklyReviewEnabled;

	return (
		<form className="settings-form" onSubmit={(e) => e.preventDefault()}>
			<div className="field">
				<label className="field-label" htmlFor="settings-timezone">
					Timezone
				</label>
				<select
					id="settings-timezone"
					className="select"
					value={settings.timezone}
					onChange={(e) => apply({ timezone: e.target.value })}
				>
					{zones.map((z) => (
						<option key={z} value={z}>
							{z}
						</option>
					))}
				</select>
				<p className="field-hint">Uses the saved timezone to determine “Today”.</p>
			</div>

			<div className="field">
				<span className="field-label" id="settings-appearance-label">
					Appearance
				</span>
				<div className="radio-row" role="radiogroup" aria-labelledby="settings-appearance-label">
					{APPEARANCE_OPTIONS.map((appearance) => (
						<label key={appearance} className="radio-option">
							<input
								type="radio"
								name="appearance"
								value={appearance}
								checked={settings.appearance === appearance}
								onChange={() => apply({ appearance })}
							/>
							<span>{appearanceLabel(appearance)}</span>
						</label>
					))}
				</div>
			</div>

			<div className="field">
				<span className="field-label" id="settings-weekly-label">
					Weekly review
				</span>
				<label className="checkbox-row">
					<input
						type="checkbox"
						checked={weeklyReviewEnabled}
						onChange={(e) => void setWeeklyReviewEnabled(e.target.checked)}
					/>
					<span>Enable weekly review</span>
				</label>
				<label className="field-label" htmlFor="settings-weekly-hour">
					Hour
				</label>
				<select
					id="settings-weekly-hour"
					className="select"
					value={settings.weeklyReviewHour}
					onChange={(e) => apply({ weeklyReviewHour: Number(e.target.value) })}
				>
					{hours.map((h) => (
						<option key={h} value={h}>
							{h}:00
						</option>
					))}
				</select>
				<p className="field-hint">
					When enabled, your local reminder is scheduled for this hour each Sunday. The in-app
					Weekly Review stays available even if notifications are blocked.
				</p>
				<NotificationPermissionCard />
			</div>

			<SecurityCard security={storage.security} />

			<section aria-labelledby="settings-backup-title">
				<h2 id="settings-backup-title" className="field-label">
					Backup &amp; restore
				</h2>
				<DataTransferCard database={storage} />
			</section>

			{error !== null && (
				// `error` stays hook state for control flow, but the rendered copy is
				// stable and masked — never the raw internal message/path/SQL text.
				<p className="error-text" role="alert">
					We couldn't save your settings. Please try again.
				</p>
			)}
			<button type="button" className="btn btn-secondary" onClick={() => void logout()}>
				Sign out
			</button>
		</form>
	);
}
