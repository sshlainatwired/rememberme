import { useCallback, useEffect, useRef, useState } from "react";

export interface SecurityController {
	getStatus(): Promise<{ enabled: boolean; available: boolean }>;
	setEnabled(enabled: boolean): Promise<{
		status: "changed" | "cancelled";
		enabled: boolean;
	}>;
}

interface SecurityStatus {
	enabled: boolean;
	available: boolean;
}

/** Native-authoritative device-lock protection controls. */
export default function SecurityCard({ security }: { security: SecurityController }) {
	const [status, setStatus] = useState<SecurityStatus | null>(null);
	const [error, setError] = useState(false);
	const [busy, setBusy] = useState(false);
	const [owner, setOwner] = useState(security);
	const mountedRef = useRef(false);
	const ownerRef = useRef(security);
	const generationRef = useRef(0);
	const busyRef = useRef(false);

	if (owner !== security) {
		setOwner(security);
		ownerRef.current = security;
		generationRef.current += 1;
		busyRef.current = false;
		setStatus(null);
		setError(false);
		setBusy(false);
	}

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			generationRef.current += 1;
		};
	}, []);

	const loadStatus = useCallback(
		async (showBusy: boolean): Promise<void> => {
			if (busyRef.current) return;
			const generation = ++generationRef.current;
			const captured = security;
			const isCurrent = () =>
				mountedRef.current && generation === generationRef.current && captured === ownerRef.current;
			if (showBusy) {
				busyRef.current = true;
				setBusy(true);
			}
			setError(false);
			try {
				const next = await captured.getStatus();
				if (isCurrent()) setStatus(next);
			} catch {
				if (isCurrent()) setError(true);
			} finally {
				if (showBusy && isCurrent()) {
					busyRef.current = false;
					setBusy(false);
				}
			}
		},
		[security],
	);

	useEffect(() => {
		void loadStatus(false);
	}, [loadStatus]);

	const changeProtection = async (enabled: boolean): Promise<void> => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setError(false);
		const generation = ++generationRef.current;
		const captured = security;
		const isCurrent = () =>
			mountedRef.current && generation === generationRef.current && captured === ownerRef.current;
		try {
			const result = await captured.setEnabled(enabled);
			if (!isCurrent()) return;
			if (result.status === "cancelled") {
				setStatus((current) =>
					current === null ? { enabled: result.enabled, available: true } : current,
				);
				return;
			}
			const authoritative = await captured.getStatus();
			if (isCurrent()) setStatus(authoritative);
		} catch {
			if (!isCurrent()) return;
			setError(true);
			// The native key transition may have succeeded even though the SQLite
			// mirror write failed. Re-read the native status so the control shows
			// the authoritative state rather than the stale pre-transition value,
			// and report the mirror failure separately.
			try {
				const authoritative = await captured.getStatus();
				if (isCurrent()) setStatus(authoritative);
			} catch {
				// Native status unreachable: keep the last rendered status; the
				// failure alert already explains that the transition did not
				// settle cleanly.
			}
		} finally {
			if (isCurrent()) {
				busyRef.current = false;
				setBusy(false);
			}
		}
	};

	return (
		<section aria-labelledby="settings-security-title">
			<h2 id="settings-security-title" className="field-label">
				Security
			</h2>
			<p id="settings-security-description" className="field-hint">
				When enabled, every cold start requires your device screen lock before the encrypted journal
				can open.
			</p>
			<p className="field-hint">
				Keep an encrypted .rmbak backup and its password in case the device lock or protected key is
				lost.
			</p>

			{status === null && !error && (
				<p className="muted-text" role="status">
					Checking device security…
				</p>
			)}

			{status !== null && (
				<label className="checkbox-row">
					<input
						type="checkbox"
						checked={status.enabled}
						disabled={busy || !status.available}
						aria-describedby="settings-security-description"
						onChange={(event) => void changeProtection(event.target.checked)}
					/>
					<span>Require device unlock</span>
				</label>
			)}

			{status !== null && !status.available && (
				<p className="muted-text">Set up a device screen lock to use this protection.</p>
			)}
			{busy && (
				<p className="muted-text" role="status">
					Waiting for device authentication…
				</p>
			)}
			{error && (
				<div role="alert">
					<p>We couldn't update device unlock. Your current protection was not reset.</p>
					<button type="button" className="btn btn-secondary" onClick={() => void loadStatus(true)}>
						Reload security status
					</button>
				</div>
			)}
		</section>
	);
}
