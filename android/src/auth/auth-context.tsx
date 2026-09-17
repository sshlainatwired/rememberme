import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { AUTH_OK_MESSAGE, type AuthStatus } from "@/auth/auth-service";
import { deviceTimezone } from "@/auth/device-timezone";
import { LoginForm } from "@/components/auth/LoginForm";
import { SetupForm } from "@/components/auth/SetupForm";
import { isDeviceUnlockCancelled } from "@/security/device-unlock";

/**
 * The structural subset of `AuthService` the session/gate relies on.
 *
 * Declared structurally (not `Pick<AuthService, …>`, which is fine too, but a
 * list of method shapes is the honest seam): production `AuthService` satisfies
 * it, and tests can pass a full-typed fake WITHOUT `as never`. Only the public
 * session calls are needed here — corrup-close internals (validateStored) and
 * the unlock probe (isUnlocked) are intentionally not part of the contract.
 */
export interface AuthSession {
	status(): Promise<AuthStatus>;
	setup(password: string, timezone: string): Promise<AuthStatus>;
	login(password: string): Promise<AuthStatus>;
	unlockWithDeviceCredential(): Promise<AuthStatus>;
	logout(): Promise<void> | void;
}

/** Structural security-service seam used by the lock screen. */
export interface DeviceUnlockSession {
	getStatus(): Promise<{ enabled: boolean; available: boolean }>;
	authenticateSession(): Promise<"authenticated" | "cancelled">;
}

/**
 * Session + route-gate context (Phase 5 Task 5).
 *
 * Holds the single in-memory auth session for the routed screens: the live
 * auth status (configured/unlocked), a `busy` flag while the async status/
 * setup/login calls run, and a generic `error` surfaced on the lock forms.
 *
 * The session is IN-MEMORY only: `logout()` clears the unlocked flag locally
 * and the gate re-locks; nothing here persists or exports secrets.
 *
 * `auth` is the DatabaseHandle's AuthService on native; it is `null` on
 * web/test/dev (App-alone), which `RequireAuth` treats as "pages render as-is"
 * — the honest non-native state where screens fail closed on missing storage.
 *
 * Fail-closed discipline: while `auth` is non-null, the gate NEVER renders
 * children until a resolved status says `unlocked: true`. A fresh non-null auth
 * starts `busy` (loading) BEFORE the status effect, and an identity change
 * resets status back to null + loading so a previous unlocked session can never
 * transiently re-reveal children.
 */
export interface AuthContextValue {
	/** The auth service, or null off-native (App-alone). */
	auth: AuthSession | null;
	/** The latest auth status, or null until the first status() resolves. */
	status: AuthStatus | null;
	/** True while status/setup/login/logout are in flight (gate shows a spinner). */
	busy: boolean;
	/** Generic error surfaced on the lock forms (never a password oracle). */
	error: string | null;
	/** True only when native protection is enabled and system auth is available. */
	deviceUnlockAvailable: boolean;
	setup(password: string): Promise<void>;
	login(password: string): Promise<void>;
	loginWithDevice(): Promise<void>;
	logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
	auth: null,
	status: null,
	busy: false,
	error: null,
	deviceUnlockAvailable: false,
	setup: async () => {},
	login: async () => {},
	loginWithDevice: async () => {},
	logout: async () => {},
});

/** Stable copy for provider failures; never expose lower-layer rejection details. */
export const AUTH_PROVIDER_ERROR_MESSAGE =
	"Your journal is currently unavailable. Please try again.";

function authErrorCopy(error: unknown): string {
	// AuthService's wrong-password result is already stable generic copy and is
	// intentionally preserved; every other provider rejection is normalized.
	if (error instanceof Error && error.message === AUTH_OK_MESSAGE) return AUTH_OK_MESSAGE;
	return AUTH_PROVIDER_ERROR_MESSAGE;
}

export interface AuthProviderProps {
	children: ReactNode;
	/** The auth service from the DatabaseHandle (AuthService satisfies AuthSession); null off-native. */
	auth: AuthSession | null;
	/** The same handle's native device-auth service; null off-native. */
	deviceUnlock?: DeviceUnlockSession | null;
}

export function AuthProvider({ children, auth, deviceUnlock = null }: AuthProviderProps) {
	const [status, setStatus] = useState<AuthStatus | null>(null);
	// A non-null auth starts BUSY so the very first render (before the effect)
	// shows loading and never a pre-effect child frame.
	const [busy, setBusy] = useState(auth !== null);
	const [error, setError] = useState<string | null>(null);
	const [deviceUnlockAvailable, setDeviceUnlockAvailable] = useState(false);

	// Synchronous ref guard: prevents a same-frame double submit (a second
	// setup/login arriving before the `busy` state re-renders the form).
	// Starts false (a submit-in-flight WE started, not the initial status()
	// loading), so the first user submit isn't dropped by the loading flag.
	const busyRef = useRef(false);
	const mountedRef = useRef(true);
	const activeAuthRef = useRef<AuthSession | null>(auth);
	const activeDeviceUnlockRef = useRef<DeviceUnlockSession | null>(deviceUnlock);
	const authEpochRef = useRef(0);

	// Reset the session and invalidate pending operations the instant the auth
	// IDENTITY changes (new service instance / device). Derived state from props
	// (getDerivedStateFromProps equivalent) clears any previous unlocked status
	// and re-enters loading BEFORE the status effect runs, so a swapped-in auth
	// can never transiently reveal children from the prior session.
	const [prevAuth, setPrevAuth] = useState(auth);
	const [prevDeviceUnlock, setPrevDeviceUnlock] = useState(deviceUnlock);
	if (prevAuth !== auth || prevDeviceUnlock !== deviceUnlock) {
		setPrevAuth(auth);
		setPrevDeviceUnlock(deviceUnlock);
		activeAuthRef.current = auth;
		activeDeviceUnlockRef.current = deviceUnlock;
		authEpochRef.current += 1;
		busyRef.current = false;
		setStatus(null);
		setError(null);
		setDeviceUnlockAvailable(false);
		setBusy(auth !== null);
	}

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			authEpochRef.current += 1;
		};
	}, []);

	useEffect(() => {
		if (auth === null) {
			setStatus(null);
			setDeviceUnlockAvailable(false);
			setBusy(false);
			return;
		}
		let cancelled = false;
		const operationAuth = auth;
		const operationDeviceUnlock = deviceUnlock;
		const operationEpoch = authEpochRef.current;
		const isCurrentOperation = () =>
			!cancelled &&
			mountedRef.current &&
			activeAuthRef.current === operationAuth &&
			activeDeviceUnlockRef.current === operationDeviceUnlock &&
			authEpochRef.current === operationEpoch;
		if (isCurrentOperation()) setBusy(true);
		Promise.all([
			operationAuth.status(),
			operationDeviceUnlock?.getStatus().catch(() => null) ?? Promise.resolve(null),
		])
			.then(([nextStatus, deviceStatus]) => {
				if (isCurrentOperation()) {
					setStatus(nextStatus);
					setDeviceUnlockAvailable(
						deviceStatus?.enabled === true && deviceStatus.available === true,
					);
					setBusy(false);
				}
			})
			.catch(() => {
				if (isCurrentOperation()) {
					setError(AUTH_PROVIDER_ERROR_MESSAGE);
					setBusy(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [auth, deviceUnlock]);

	const setup = useCallback(
		async (password: string): Promise<void> => {
			if (!auth) return;
			if (busyRef.current) return; // same-frame double-submit guard
			const operationAuth = auth;
			const operationEpoch = authEpochRef.current;
			busyRef.current = true;
			setBusy(true);
			setError(null);
			try {
				const nextStatus = await operationAuth.setup(password, deviceTimezone());
				if (activeAuthRef.current === operationAuth && authEpochRef.current === operationEpoch) {
					setStatus(nextStatus);
				}
			} catch (e) {
				if (activeAuthRef.current === operationAuth && authEpochRef.current === operationEpoch) {
					setError(authErrorCopy(e));
				}
				throw e;
			} finally {
				if (activeAuthRef.current === operationAuth && authEpochRef.current === operationEpoch) {
					busyRef.current = false;
					setBusy(false);
				}
			}
		},
		[auth],
	);

	const login = useCallback(
		async (password: string): Promise<void> => {
			if (!auth) return;
			if (busyRef.current) return; // same-frame double-submit guard
			const operationAuth = auth;
			const operationEpoch = authEpochRef.current;
			busyRef.current = true;
			setBusy(true);
			setError(null);
			try {
				const nextStatus = await operationAuth.login(password);
				if (activeAuthRef.current === operationAuth && authEpochRef.current === operationEpoch) {
					setStatus(nextStatus);
				}
			} catch (e) {
				if (activeAuthRef.current === operationAuth && authEpochRef.current === operationEpoch) {
					setError(authErrorCopy(e));
				}
				throw e;
			} finally {
				if (activeAuthRef.current === operationAuth && authEpochRef.current === operationEpoch) {
					busyRef.current = false;
					setBusy(false);
				}
			}
		},
		[auth],
	);

	const loginWithDevice = useCallback(async (): Promise<void> => {
		if (!auth || !deviceUnlock || !deviceUnlockAvailable || busyRef.current) return;
		const operationAuth = auth;
		const operationDeviceUnlock = deviceUnlock;
		const operationEpoch = authEpochRef.current;
		const isCurrentOperation = () =>
			mountedRef.current &&
			activeAuthRef.current === operationAuth &&
			activeDeviceUnlockRef.current === operationDeviceUnlock &&
			authEpochRef.current === operationEpoch;
		busyRef.current = true;
		setBusy(true);
		setError(null);
		try {
			const result = await operationDeviceUnlock.authenticateSession();
			if (!isCurrentOperation() || result === "cancelled") return;
			const nextStatus = await operationAuth.unlockWithDeviceCredential();
			if (isCurrentOperation()) setStatus(nextStatus);
		} catch (cause) {
			if (isDeviceUnlockCancelled(cause)) return;
			if (isCurrentOperation()) setError(AUTH_PROVIDER_ERROR_MESSAGE);
			throw cause;
		} finally {
			if (isCurrentOperation()) {
				busyRef.current = false;
				setBusy(false);
			}
		}
	}, [auth, deviceUnlock, deviceUnlockAvailable]);

	const logout = useCallback(async (): Promise<void> => {
		const operationAuth = auth;
		const operationEpoch = authEpochRef.current;
		const isCurrentOperation = () =>
			mountedRef.current &&
			activeAuthRef.current === operationAuth &&
			authEpochRef.current === operationEpoch;
		if (!operationAuth || busyRef.current || !isCurrentOperation()) return;

		busyRef.current = true;
		setBusy(true);
		setStatus((s) => (s ? { ...s, unlocked: false } : s));
		// Await the underlying logout and keep the session locked only while this
		// operation still belongs to the active auth identity. The rejection is
		// swallowed so it never escapes as an unhandled rejection to the caller.
		try {
			await operationAuth.logout();
		} catch {
			// swallow: re-locking in `finally` is the only required outcome
		} finally {
			if (isCurrentOperation()) {
				setStatus((s) => (s ? { ...s, unlocked: false } : s));
				busyRef.current = false;
				setBusy(false);
			}
		}
	}, [auth]);

	const value: AuthContextValue = {
		auth,
		status,
		busy,
		error,
		deviceUnlockAvailable,
		setup,
		login,
		loginWithDevice,
		logout,
	};

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Access the auth session context (falls back to the default null state). */
export function useAuth(): AuthContextValue {
	return useContext(AuthContext);
}

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
	if (auth === null) return <>{children}</>; // non-native / App-alone: pages render as-is (brief)
	if (status === null) {
		// Fail closed: no shell/children until a resolved status says unlocked.
		if (busy) {
			return (
				<div className="loading-text" role="status">
					Opening your journal…
				</div>
			);
		}
		// status() rejected (or never produced a status): accessible generic error.
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
