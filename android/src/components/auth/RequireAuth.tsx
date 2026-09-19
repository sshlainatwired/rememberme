import type { ReactNode } from "react";
import { useAuth } from "@/auth/auth-context";
import { LoginForm } from "@/components/auth/LoginForm";
import { SetupForm } from "@/components/auth/SetupForm";

/**
 * Route gate: renders `children` when authenticated (or off-native), Setup when
 * unconfigured, Login when configured-but-locked, and a loading status while
 * the first status() is still resolving.
 *
 * Security contract: on-native, the gate FAILS CLOSED — the shell (and thus
 * Today/Journal/Archive/Settings) never renders until `status.unlocked` is
 * true. While `auth` is non-null, `status === null` (not yet resolved, OR the
 * initial status() rejected) NEVER falls through to children: it shows a busy
 * `role="status"` loading state or, once the failure is known, an accessible
 * `role="alert"` fail-closed error. `auth === null` is the App-alone seam the
 * brief mandates (pages render as-is, honest non-native state).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
	const { status, busy, auth } = useAuth();
	if (auth === null) return <>{children}</>;
	if (status === null) {
		if (busy) {
			return (
				<div className="loading-text" role="status">
					Opening your journal…
				</div>
			);
		}
		return (
			<div className="error-text" role="alert">
				Your journal is currently unavailable. Please try again.
			</div>
		);
	}
	if (!status.configured) return <SetupForm />;
	if (!status.unlocked) return <LoginForm />;
	return <>{children}</>;
}
