/**
 * AppBootstrap — the fail-closed storage gate mounted once in `main.tsx`.
 *
 * On native Android it opens the app-private database and runs migrations
 * BEFORE any screen renders. Failure shows a clear, non-destructive error
 * screen (nothing is reset or deleted, no silent JS storage substitute) and
 * the app routes never mount.
 *
 * On web/test/dev (`attemptNative={false}`) storage is not attempted at all —
 * there is no browser/localStorage/IndexedDB persistence pretending to be the
 * real database. The shell renders for UI work, and any screen that needs
 * storage fails closed if it tries to use it.
 *
 * Phase 5 Task 1: semantic `.bootstrap-*`/`.error-screen-*` classes replace
 * Tailwind utilities (see global.css); DOM and accessibility are unchanged.
 */

import { Capacitor } from "@capacitor/core";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AuthProvider } from "@/auth/auth-context";
import { type DatabaseHandle, initDatabase } from "@/db/bootstrap";
import type { Appearance } from "@/db/settings";
import { StorageProvider } from "@/db/storage";
import { useSettings } from "@/db/use-settings";
import { applyTheme, onPrefersDarkChange, prefersDark, resolveTheme } from "@/lib/appearance";
import { WeeklyNotificationsProvider } from "@/notifications/WeeklyNotificationsProvider";
import type { WeeklyNotificationAdapter } from "@/notifications/weekly-notification-adapter";
import { isDeviceUnlockCancelled } from "@/security/device-unlock";

export interface AppearanceSyncProps {
	children: ReactNode;
	/**
	 * Appearance resolved by the bootstrap gate's pre-ready settings read.
	 * Bridges the async window before this component's own settings load, so
	 * the FIRST layout effect applies the stored theme instead of the
	 * "system" default — no divergent first paint.
	 */
	initialAppearance?: Appearance | null;
}

/**
 * Apply the stored appearance to `<html>` before children paint and keep it
 * in sync with the system dark-mode preference.
 *
 * Rendered INSIDE the ready path's providers (below StorageProvider, which
 * feeds {@link useSettings}) and above the routed `App`, so every screen —
 * auth gates included — inherits the resolved theme with no flash of the
 * light default and no theme swap after routes mount. `useLayoutEffect` (not
 * `useEffect`) runs before the browser paints the committed children. The
 * subscription is torn down and re-created on every `appearance` change, so
 * a stale `system` listener can never overwrite a newer explicit light/dark
 * setting, and unmount or StrictMode cleanup leaves no listener behind.
 */
export function AppearanceSync({ children, initialAppearance = null }: AppearanceSyncProps) {
	const { settings } = useSettings();
	// Live settings win once loaded (later changes re-sync); until then the
	// gate's pre-ready value keeps the stored theme authoritative.
	const appearance = settings?.appearance ?? initialAppearance ?? "system";

	useLayoutEffect(() => {
		applyTheme(resolveTheme(appearance, prefersDark()));
		return onPrefersDarkChange(() => applyTheme(resolveTheme(appearance, prefersDark())));
	}, [appearance]);

	return <>{children}</>;
}

export interface AppBootstrapProps {
	children: ReactNode;
	/**
	 * Database initializer. Production leaves this unset (the process-wide
	 * `initDatabase` singleton, so StrictMode's double effect run and any
	 * concurrent listener collapse into ONE underlying open). Tests inject a
	 * `node:sqlite`-backed initializer so the same migrations run against
	 * real SQLite.
	 */
	initializer?: () => Promise<DatabaseHandle>;
	/** True on native Android; false on web/test/dev. Defaults to the platform. */
	attemptNative?: boolean;
	/** Optional adapter injection for provider tests; production leaves this unset. */
	notificationAdapter?: WeeklyNotificationAdapter;
}

type GateState =
	| { status: "loading"; attempt: number }
	| { status: "ready"; database: DatabaseHandle | null; initialAppearance: Appearance | null }
	| { status: "cancelled"; attempt: number }
	| { status: "error"; message: string };

export default function AppBootstrap({
	children,
	initializer = initDatabase,
	attemptNative = Capacitor.isNativePlatform(),
	notificationAdapter,
}: AppBootstrapProps) {
	const [state, setState] = useState<GateState>(() =>
		attemptNative
			? { status: "loading", attempt: 0 }
			: { status: "ready", database: null, initialAppearance: null },
	);
	const retryingRef = useRef(false);

	useEffect(() => {
		if (!attemptNative || state.status !== "loading") return;
		const attempt = state.attempt;
		let cancelled = false;
		initializer()
			.then(async (database) => {
				if (cancelled) return;
				try {
					// Pre-ready settings read: resolve the stored appearance and
					// apply it to <html> BEFORE the ready tree paints, so the first
					// child render never shows a divergent light/system default.
					// This read is also the fail-closed gate for corrupted
					// settings: on failure the opened handle is closed exactly once
					// and the startup screen renders instead of storage-backed
					// children.
					const initialSettings = await database.settings.get();
					if (cancelled) return;
					applyTheme(resolveTheme(initialSettings.appearance, prefersDark()));
					setState({
						status: "ready",
						database,
						initialAppearance: initialSettings.appearance,
					});
				} catch (error) {
					if (cancelled) return;
					try {
						await database.close();
					} catch {
						// A close failure must never mask the original cause.
					}
					setState({
						status: "error",
						message: error instanceof Error ? error.message : String(error),
					});
				}
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				if (isDeviceUnlockCancelled(error)) {
					retryingRef.current = false;
					setState({ status: "cancelled", attempt });
					return;
				}
				setState({
					status: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			});
		return () => {
			cancelled = true;
		};
	}, [attemptNative, initializer, state]);

	if (state.status === "loading") {
		return <div className="bootstrap-loading">Opening your journal…</div>;
	}

	if (state.status === "cancelled") {
		return (
			<StartupUnlockCancelledScreen
				onRetry={() => {
					if (retryingRef.current) return;
					retryingRef.current = true;
					setState({ status: "loading", attempt: state.attempt + 1 });
				}}
			/>
		);
	}

	if (state.status === "error") {
		return <StartupErrorScreen message={state.message} />;
	}

	// ready (native: database open + migrated; non-native: no storage layer)
	// AuthProvider wraps children with the DatabaseHandle's AuthService (null on
	// web/test/dev), so RequireAuth can gate the shell on the in-memory session.
	// AppearanceSync sits above the routed App so the resolved theme is in place
	// before any screen (auth gates included) paints.
	return (
		<StorageProvider database={state.database}>
			<AuthProvider
				auth={state.database?.auth ?? null}
				deviceUnlock={state.database?.security ?? null}
			>
				<WeeklyNotificationsProvider adapter={notificationAdapter}>
					<AppearanceSync initialAppearance={state.initialAppearance}>{children}</AppearanceSync>
				</WeeklyNotificationsProvider>
			</AuthProvider>
		</StorageProvider>
	);
}

/** Retry is offered only for typed pre-open system-authentication cancellation. */
export function StartupUnlockCancelledScreen({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="error-screen">
			<div className="error-screen-inner">
				<h1 className="error-screen-title">Unlock cancelled</h1>
				<p className="muted-text">Authenticate with your device to open this journal.</p>
				<button className="btn btn-primary" type="button" onClick={onRetry}>
					Try again
				</button>
				<p className="error-screen-note">
					Your journal stays safely on this device — nothing was deleted or reset.
				</p>
			</div>
		</div>
	);
}

/** Fail-closed startup screen: clear message, no destructive action offered. */
export function StartupErrorScreen(_props: { message: string }) {
	return (
		<div className="error-screen">
			<div className="error-screen-inner">
				<h1 className="error-screen-title">Cannot open local database</h1>
				<p className="muted-text">Please try again.</p>
				<p className="error-screen-note">
					Your journal stays safely on this device — nothing was deleted or reset. Restart the app
					to try again.
				</p>
			</div>
		</div>
	);
}
