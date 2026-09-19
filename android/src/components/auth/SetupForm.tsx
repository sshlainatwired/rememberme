import { type FormEvent, useState } from "react";
import { useAuth } from "@/auth/auth-context";

/** Min/max password length mirroring ValidatePassword (see auth-service). */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/**
 * First-run setup form (Phase 5 Task 5).
 *
 * Plain native controls and semantic classes only (Task 1 CSS contract); the
 * gate renders this INSTEAD of the shell, so there is no tab bar here. Setting
 * a password on this device (via `AuthService.setup`) is what first configures
 * the store; `setup()` seeds the device timezone itself, so the form only
 * collects the password. Client-side validation (length + match) runs before
 * the async setup; failures are generic and non-oracle.
 */
export function SetupForm() {
	const { setup, error, busy } = useAuth();
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);

	const submit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
			setLocalError(`Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`);
			return;
		}
		if (password !== confirm) {
			setLocalError("Passwords do not match.");
			return;
		}
		setLocalError(null);
		void setup(password).catch(() => {});
	};

	const shownError = localError ?? error;

	return (
		<div className="auth-screen">
			<div className="card card-auth">
				<h1 className="auth-title">Set up your journal</h1>
				<p className="field-hint">
					This password protects this journal on this device only. It is never sent anywhere.
				</p>
				<form className="auth-form" onSubmit={submit} noValidate>
					<label className="field-label" htmlFor="setup-password">
						Password
					</label>
					<input
						id="setup-password"
						className="input"
						type="password"
						autoComplete="new-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
					<label className="field-label" htmlFor="setup-confirm">
						Confirm password
					</label>
					<input
						id="setup-confirm"
						className="input"
						type="password"
						autoComplete="new-password"
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
					/>
					{shownError !== null && (
						<p className="error-text" role="alert">
							{shownError}
						</p>
					)}
					<button className="btn btn-primary btn-size-lg" type="submit" disabled={busy}>
						{busy ? "Setting up…" : "Set up"}
					</button>
				</form>
			</div>
		</div>
	);
}
