import { type FormEvent, useState } from "react";
import { useAuth } from "@/auth/auth-context";

/**
 * Unlock form (Phase 5 Task 5).
 *
 * Plain native controls and semantic classes only; the gate renders this
 * INSTEAD of the shell when configured-but-locked. On submit it calls
 * `login(password)` (in-memory session; the stored verifier is never
 * touched). The server-less generic error is shown as-is on failure — wrong
 * password and absent config share the same message, so no oracle.
 */
export function LoginForm() {
	const { login, loginWithDevice, deviceUnlockAvailable, error, busy } = useAuth();
	const [password, setPassword] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);

	const submit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (password === "") {
			setLocalError("Enter your password.");
			return;
		}
		setLocalError(null);
		void login(password).catch(() => {});
	};

	const unlockWithDevice = () => {
		setLocalError(null);
		void loginWithDevice().catch(() => {});
	};

	const shownError = localError ?? error;

	return (
		<div className="auth-screen">
			<div className="card card-auth">
				<h1 className="auth-title">Unlock your journal</h1>
				<p className="field-hint">Enter your password to open this journal.</p>
				<form className="auth-form" onSubmit={submit} noValidate>
					<label className="field-label" htmlFor="login-password">
						Password
					</label>
					<input
						id="login-password"
						className="input"
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
					{shownError !== null && (
						<p className="error-text" role="alert">
							{shownError}
						</p>
					)}
					<button className="btn btn-primary btn-size-lg" type="submit" disabled={busy}>
						{busy ? "Unlocking…" : "Unlock"}
					</button>
					{deviceUnlockAvailable && (
						<button
							className="btn btn-secondary btn-size-lg"
							type="button"
							disabled={busy}
							onClick={unlockWithDevice}
						>
							{busy ? "Authenticating…" : "Use device unlock"}
						</button>
					)}
				</form>
			</div>
		</div>
	);
}
