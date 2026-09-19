import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { HashRouter } from "react-router-dom";
import { describe, expect, it, type Mock, vi } from "vitest";
import App from "@/App";
import {
	AUTH_PROVIDER_ERROR_MESSAGE,
	type AuthContextValue,
	AuthProvider,
	useAuth,
} from "@/auth/auth-context";
import type { AuthStatus } from "@/auth/auth-service";
import { AUTH_OK_MESSAGE } from "@/auth/auth-service";
import * as timezoneModule from "@/auth/device-timezone";

interface AuthGateMock {
	auth: {
		status: Mock<() => Promise<AuthStatus>>;
		setup: Mock<(password: string, timezone: string) => Promise<AuthStatus>>;
		login: Mock<(password: string) => Promise<AuthStatus>>;
		unlockWithDeviceCredential: Mock<() => Promise<AuthStatus>>;
		logout: Mock<() => Promise<void> | void>;
	};
	state: AuthStatus;
}

interface DeviceUnlockMock {
	getStatus: Mock<() => Promise<{ enabled: boolean; available: boolean }>>;
	authenticateSession: Mock<() => Promise<"authenticated" | "cancelled">>;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function deferredBeforePassiveCleanup<T>() {
	let settled = false;
	let value!: T;
	let fulfill: ((value: T) => void) | undefined;
	// Model a status completion during commit, before React runs passive cleanup.
	const promise = new Proxy(new Promise<T>(() => {}), {
		get(target, property, receiver) {
			if (property === "then") {
				return (onFulfilled: (value: T) => void) => {
					fulfill = onFulfilled;
					if (settled) onFulfilled(value);
					return Promise.resolve(value);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});

	return {
		promise,
		resolve(next: T) {
			settled = true;
			value = next;
			fulfill?.(next);
		},
	};
}

function mockAuth(initial: AuthStatus): AuthGateMock {
	let state: AuthStatus = initial;
	const auth: AuthGateMock["auth"] = {
		status: vi.fn(async () => state),
		setup: vi.fn(async (_password: string, _timezone: string) => {
			state = { configured: true, unlocked: true };
			return state;
		}),
		login: vi.fn(async () => {
			state = { configured: true, unlocked: true };
			return state;
		}),
		unlockWithDeviceCredential: vi.fn(async () => {
			state = { configured: true, unlocked: true };
			return state;
		}),
		logout: vi.fn(() => {
			state = { configured: true, unlocked: false };
		}),
	};
	return { auth, state };
}

const authRef: { current: AuthContextValue | null } = { current: null };
function AuthProbe() {
	authRef.current = useAuth();
	return null;
}

function ResolveOnLayout({ when, resolve }: { when: boolean; resolve: () => void }) {
	useLayoutEffect(() => {
		if (when) resolve();
	}, [resolve, when]);
	return null;
}

function mockDevice(enabled = true): DeviceUnlockMock {
	return {
		getStatus: vi.fn(async () => ({ enabled, available: true })),
		authenticateSession: vi.fn(async () => "authenticated"),
	};
}

function renderGate(
	initial: AuthStatus,
	mock: AuthGateMock = mockAuth(initial),
	deviceUnlock: DeviceUnlockMock | null = null,
) {
	return {
		...mock,
		...render(
			<HashRouter>
				<AuthProvider auth={mock.auth} deviceUnlock={deviceUnlock}>
					<AuthProbe />
					<App />
				</AuthProvider>
			</HashRouter>,
		),
	};
}

describe("auth gate renders setup/login/children", () => {
	it("shows the first-run setup form when auth is unconfigured", async () => {
		renderGate({ configured: false, unlocked: false });
		expect(
			await screen.findByRole("heading", { name: /set up your journal/i }),
		).toBeInTheDocument();
	});

	it("shows the unlock form when auth is configured but locked", async () => {
		renderGate({ configured: true, unlocked: false });
		expect(
			await screen.findByRole("heading", { name: /unlock your journal/i }),
		).toBeInTheDocument();
	});

	it("renders the routed children when auth is unlocked", async () => {
		renderGate({ configured: true, unlocked: true });
		expect(await screen.findByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
	});

	it("hides the shell tab bar on the lock screens", async () => {
		renderGate({ configured: false, unlocked: false });
		await screen.findByRole("heading", { name: /set up your journal/i });
		expect(screen.queryByRole("navigation", { name: /main/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /today/i })).not.toBeInTheDocument();
	});
});

describe("auth gate fail-closed loading/error (never reveals children)", () => {
	it("shows a loading status (and never children) before the initial status resolves", async () => {
		const pending: AuthGateMock["auth"] = {
			status: vi.fn(() => new Promise<AuthStatus>(() => {})),
			setup: vi.fn(async () => ({ configured: true, unlocked: true })),
			login: vi.fn(async () => ({ configured: true, unlocked: true })),
			unlockWithDeviceCredential: vi.fn(async () => ({ configured: true, unlocked: true })),
			logout: vi.fn(),
		};
		renderGate(
			{ configured: true, unlocked: true },
			{ auth: pending, state: { configured: true, unlocked: true } },
		);

		expect(await screen.findByRole("status")).toHaveTextContent(/opening your journal/i);
		expect(screen.queryByRole("heading", { name: /write your entry/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("navigation", { name: /main/i })).not.toBeInTheDocument();
	});

	it("fails closed with an auth error when status() rejects and never reveals children", async () => {
		const api = mockAuth({ configured: true, unlocked: true });
		api.auth.status.mockRejectedValueOnce(new Error("corrupt local auth"));
		renderGate({ configured: true, unlocked: true }, api);

		expect(await screen.findByRole("alert")).toHaveTextContent(/unavailable/i);
		expect(screen.queryByRole("heading", { name: /write your entry/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("navigation", { name: /main/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: /set up your journal/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: /unlock your journal/i })).not.toBeInTheDocument();
	});

	it("resets to a loading status on an auth identity change (never keeps the old unlocked status)", async () => {
		const unlocked = mockAuth({ configured: true, unlocked: true });
		const view = render(
			<HashRouter>
				<AuthProvider auth={unlocked.auth}>
					<AuthProbe />
					<App />
				</AuthProvider>
			</HashRouter>,
		);
		await screen.findByRole("heading", { name: /write your entry/i });

		const locked = mockAuth({ configured: true, unlocked: false });
		locked.auth.status.mockImplementation(() => new Promise<AuthStatus>(() => {}));
		view.rerender(
			<HashRouter>
				<AuthProvider auth={locked.auth}>
					<AuthProbe />
					<App />
				</AuthProvider>
			</HashRouter>,
		);

		expect(authRef.current?.status).toBeNull();
		expect(authRef.current?.busy).toBe(true);
		expect(screen.queryByRole("heading", { name: /write your entry/i })).not.toBeInTheDocument();
	});
});

describe("auth gate transitions", () => {
	it("keeps empty login validation local", async () => {
		const api = mockAuth({ configured: true, unlocked: false });
		renderGate({ configured: true, unlocked: false }, api);

		await screen.findByLabelText(/^password/i);
		fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

		expect(screen.getByRole("alert")).toHaveTextContent("Enter your password.");
		expect(api.auth.login).not.toHaveBeenCalled();
	});

	it("keeps setup length and mismatch validation local", async () => {
		const api = mockAuth({ configured: false, unlocked: false });
		renderGate({ configured: false, unlocked: false }, api);

		const password = await screen.findByLabelText(/^password/i);
		const confirm = screen.getByLabelText(/confirm password/i);
		fireEvent.change(password, { target: { value: "short" } });
		fireEvent.change(confirm, { target: { value: "short" } });
		fireEvent.click(screen.getByRole("button", { name: /set up/i }));
		expect(screen.getByRole("alert")).toHaveTextContent("Password must be 8–128 characters.");
		expect(api.auth.setup).not.toHaveBeenCalled();

		fireEvent.change(password, { target: { value: "correct-horse" } });
		fireEvent.change(confirm, { target: { value: "different-horse" } });
		fireEvent.click(screen.getByRole("button", { name: /set up/i }));
		expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match.");
		expect(api.auth.setup).not.toHaveBeenCalled();
	});

	it("maps a native or SQL login rejection to stable generic auth copy", async () => {
		const api = mockAuth({ configured: true, unlocked: false });
		const failure =
			"NativeSQLiteException: SQLCipher SELECT secret at /data/user/0/rememberme/app.db";
		api.auth.login.mockRejectedValueOnce(new Error(failure));
		renderGate({ configured: true, unlocked: false }, api);

		const password = await screen.findByLabelText(/^password/i);
		fireEvent.change(password, { target: { value: "not-the-password" } });
		fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Your journal is currently unavailable. Please try again.");
		expect(alert.textContent).not.toContain(failure);
		expect(alert.textContent).not.toContain("NativeSQLiteException");
		expect(alert.textContent).not.toContain("/data/user/0/rememberme/app.db");
		expect(alert.textContent).not.toContain("SQLCipher SELECT secret");
	});

	it("maps a native or SQL setup rejection to stable generic auth copy", async () => {
		const api = mockAuth({ configured: false, unlocked: false });
		const failure =
			"SQLiteException: INSERT failed near SECRET at /data/user/0/rememberme/auth.sqlite";
		api.auth.setup.mockRejectedValueOnce(new Error(failure));
		renderGate({ configured: false, unlocked: false }, api);

		const password = await screen.findByLabelText(/^password/i);
		const confirm = screen.getByLabelText(/confirm password/i);
		fireEvent.change(password, { target: { value: "correct-horse" } });
		fireEvent.change(confirm, { target: { value: "correct-horse" } });
		fireEvent.click(screen.getByRole("button", { name: /set up/i }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Your journal is currently unavailable. Please try again.");
		expect(alert.textContent).not.toContain(failure);
		expect(alert.textContent).not.toContain("SQLiteException");
		expect(alert.textContent).not.toContain("/data/user/0/rememberme/auth.sqlite");
		expect(alert.textContent).not.toContain("INSERT failed near SECRET");
	});

	it("shows the generic error on a failed login and stays locked", async () => {
		const api = mockAuth({ configured: true, unlocked: false });
		api.auth.login.mockRejectedValueOnce(new Error(AUTH_OK_MESSAGE));
		renderGate({ configured: true, unlocked: false }, api);

		const password = await screen.findByLabelText(/^password/i);
		fireEvent.change(password, { target: { value: "not-the-password" } });
		fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

		expect(await screen.findByText(AUTH_OK_MESSAGE)).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: /unlock your journal/i })).toBeInTheDocument();
	});

	it("transitions to the routed children after a successful login", async () => {
		renderGate({ configured: true, unlocked: false });
		const password = await screen.findByLabelText(/^password/i);
		fireEvent.change(password, { target: { value: "correct-password" } });
		fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

		expect(await screen.findByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
	});

	it("seeds setup with the validated device timezone", async () => {
		const api = mockAuth({ configured: false, unlocked: false });
		const spy = vi.spyOn(timezoneModule, "deviceTimezone").mockReturnValue("Europe/Istanbul");
		renderGate({ configured: false, unlocked: false }, api);

		const password = await screen.findByLabelText(/^password/i);
		const confirm = screen.getByLabelText(/confirm password/i);
		fireEvent.change(password, { target: { value: "correct-horse" } });
		fireEvent.change(confirm, { target: { value: "correct-horse" } });
		fireEvent.click(screen.getByRole("button", { name: /set up/i }));

		await waitFor(() =>
			expect(api.auth.setup).toHaveBeenCalledWith("correct-horse", "Europe/Istanbul"),
		);
		spy.mockRestore();
	});

	it("returns to the unlock form after logout", async () => {
		renderGate({ configured: true, unlocked: true });
		await screen.findByRole("heading", { name: /write your entry/i });

		act(() => {
			authRef.current?.logout();
		});

		expect(
			await screen.findByRole("heading", { name: /unlock your journal/i }),
		).toBeInTheDocument();
	});

	it("awaits logout and still locks the session when logout rejects (no unhandled rejection)", async () => {
		const api = mockAuth({ configured: true, unlocked: true });
		api.auth.logout.mockRejectedValueOnce(new Error("logout failed"));
		renderGate({ configured: true, unlocked: true }, api);
		await screen.findByRole("heading", { name: /write your entry/i });

		await act(async () => {
			await authRef.current?.logout();
		});

		expect(api.auth.logout).toHaveBeenCalled();
		expect(
			await screen.findByRole("heading", { name: /unlock your journal/i }),
		).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: /write your entry/i })).not.toBeInTheDocument();
	});

	it("locks immediately and blocks login while deferred logout rejects", async () => {
		const api = mockAuth({ configured: true, unlocked: true });
		const pendingLogout = deferred<void>();
		api.auth.logout.mockReturnValue(pendingLogout.promise);
		renderGate({ configured: true, unlocked: true }, api);
		await screen.findByRole("heading", { name: /write your entry/i });

		let logoutOperation: Promise<void> | undefined;
		act(() => {
			logoutOperation = authRef.current?.logout();
		});

		expect(api.auth.logout).toHaveBeenCalledTimes(1);
		expect(authRef.current?.status).toEqual({ configured: true, unlocked: false });
		expect(authRef.current?.busy).toBe(true);
		expect(screen.queryByRole("navigation", { name: /main/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: /write your entry/i })).not.toBeInTheDocument();
		expect(screen.getByRole("heading", { name: /unlock your journal/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /unlock/i })).toBeDisabled();

		act(() => {
			void authRef.current?.login("racing-password");
			void authRef.current?.setup("racing-password");
		});
		expect(api.auth.login).not.toHaveBeenCalled();
		expect(api.auth.setup).not.toHaveBeenCalled();

		await act(async () => {
			pendingLogout.reject(new Error("logout failed"));
			await logoutOperation;
		});

		expect(authRef.current?.status).toEqual({ configured: true, unlocked: false });
		expect(authRef.current?.busy).toBe(false);
		expect(screen.getByRole("button", { name: /unlock/i })).not.toBeDisabled();

		const password = screen.getByLabelText(/^password/i);
		fireEvent.change(password, { target: { value: "correct-password" } });
		fireEvent.click(screen.getByRole("button", { name: /unlock/i }));
		expect(await screen.findByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
	});

	it("does not let old status unlock a replacement before replacement status resolves", async () => {
		const old = mockAuth({ configured: true, unlocked: false });
		const oldStatus = deferredBeforePassiveCleanup<AuthStatus>();
		old.auth.status.mockReturnValue(oldStatus.promise);
		const replacement = mockAuth({ configured: true, unlocked: false });
		const replacementStatus = deferred<AuthStatus>();
		replacement.auth.status.mockReturnValue(replacementStatus.promise);

		const view = render(
			<HashRouter>
				<AuthProvider auth={old.auth}>
					<ResolveOnLayout
						when={false}
						resolve={() => oldStatus.resolve({ configured: true, unlocked: true })}
					/>
					<AuthProbe />
					<App />
				</AuthProvider>
			</HashRouter>,
		);

		await act(async () => {
			view.rerender(
				<HashRouter>
					<AuthProvider auth={replacement.auth}>
						<ResolveOnLayout
							when={true}
							resolve={() => oldStatus.resolve({ configured: true, unlocked: true })}
						/>
						<AuthProbe />
						<App />
					</AuthProvider>
				</HashRouter>,
			);
			await Promise.resolve();
		});

		expect(authRef.current?.status).toBeNull();
		expect(authRef.current?.busy).toBe(true);
		expect(screen.queryByRole("navigation", { name: /main/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: /write your entry/i })).not.toBeInTheDocument();

		await act(async () => {
			replacementStatus.resolve({ configured: true, unlocked: true });
			await Promise.resolve();
		});

		expect(await screen.findByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
	});

	it("does not let old logout lock an unlocked replacement identity", async () => {
		const old = mockAuth({ configured: true, unlocked: true });
		const oldLogout = deferred<void>();
		old.auth.logout.mockReturnValue(oldLogout.promise);
		const replacement = mockAuth({ configured: true, unlocked: false });
		const replacementStatus = deferred<AuthStatus>();
		replacement.auth.status.mockReturnValue(replacementStatus.promise);
		const view = renderGate({ configured: true, unlocked: true }, old);
		await screen.findByRole("heading", { name: /write your entry/i });

		let oldOperation: Promise<void> | undefined;
		act(() => {
			oldOperation = authRef.current?.logout();
		});
		view.rerender(
			<HashRouter>
				<AuthProvider auth={replacement.auth}>
					<AuthProbe />
					<App />
				</AuthProvider>
			</HashRouter>,
		);

		await act(async () => {
			replacementStatus.resolve({ configured: true, unlocked: true });
			await Promise.resolve();
		});
		await screen.findByRole("heading", { name: /write your entry/i });

		await act(async () => {
			oldLogout.resolve();
			await oldOperation;
		});

		expect(await screen.findByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: /unlock your journal/i })).not.toBeInTheDocument();
	});

	it("ignores a stale login after swapping to a replacement auth identity", async () => {
		const old = mockAuth({ configured: true, unlocked: false });
		const oldLogin = deferred<AuthStatus>();
		old.auth.login.mockReturnValue(oldLogin.promise);
		const replacement = mockAuth({ configured: true, unlocked: false });
		const replacementStatus = deferred<AuthStatus>();
		const replacementLogin = deferred<AuthStatus>();
		replacement.auth.status.mockReturnValue(replacementStatus.promise);
		replacement.auth.login.mockReturnValue(replacementLogin.promise);
		const view = renderGate({ configured: true, unlocked: false }, old);
		await screen.findByRole("heading", { name: /unlock your journal/i });

		let oldOperation: Promise<void> | undefined;
		act(() => {
			oldOperation = authRef.current?.login("old-password");
		});
		view.rerender(
			<HashRouter>
				<AuthProvider auth={replacement.auth}>
					<AuthProbe />
					<App />
				</AuthProvider>
			</HashRouter>,
		);
		expect(authRef.current?.status).toBeNull();
		expect(authRef.current?.busy).toBe(true);
		expect(screen.queryByRole("navigation", { name: /main/i })).not.toBeInTheDocument();

		await act(async () => {
			replacementStatus.resolve({ configured: true, unlocked: false });
			await Promise.resolve();
		});
		await screen.findByRole("heading", { name: /unlock your journal/i });
		let replacementOperation: Promise<void> | undefined;
		act(() => {
			replacementOperation = authRef.current?.login("replacement-password");
		});
		expect.soft(replacement.auth.login).toHaveBeenCalledWith("replacement-password");
		expect.soft(authRef.current?.busy).toBe(true);

		await act(async () => {
			oldLogin.resolve({ configured: true, unlocked: true });
			await oldOperation;
		});
		expect.soft(authRef.current?.status).toEqual({ configured: true, unlocked: false });
		expect.soft(authRef.current?.busy).toBe(true);
		expect.soft(screen.queryByRole("navigation", { name: /main/i })).not.toBeInTheDocument();
		expect
			.soft(screen.queryByRole("heading", { name: /write your entry/i }))
			.not.toBeInTheDocument();

		if (!replacementOperation) {
			act(() => {
				replacementOperation = authRef.current?.login("replacement-password");
			});
		}
		expect(replacement.auth.login).toHaveBeenCalledWith("replacement-password");
		await act(async () => {
			replacementLogin.resolve({ configured: true, unlocked: true });
			await replacementOperation;
		});
		expect(await screen.findByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
	});

	it("ignores a stale setup after swapping to a replacement auth identity", async () => {
		const old = mockAuth({ configured: false, unlocked: false });
		const oldSetup = deferred<AuthStatus>();
		old.auth.setup.mockReturnValue(oldSetup.promise);
		const replacement = mockAuth({ configured: false, unlocked: false });
		const replacementStatus = deferred<AuthStatus>();
		const replacementSetup = deferred<AuthStatus>();
		replacement.auth.status.mockReturnValue(replacementStatus.promise);
		replacement.auth.setup.mockReturnValue(replacementSetup.promise);
		const view = renderGate({ configured: false, unlocked: false }, old);
		await screen.findByRole("heading", { name: /set up your journal/i });

		let oldOperation: Promise<void> | undefined;
		act(() => {
			oldOperation = authRef.current?.setup("old-password");
		});
		view.rerender(
			<HashRouter>
				<AuthProvider auth={replacement.auth}>
					<AuthProbe />
					<App />
				</AuthProvider>
			</HashRouter>,
		);
		expect(authRef.current?.status).toBeNull();
		expect(authRef.current?.busy).toBe(true);
		expect(screen.queryByRole("navigation", { name: /main/i })).not.toBeInTheDocument();

		await act(async () => {
			replacementStatus.resolve({ configured: false, unlocked: false });
			await Promise.resolve();
		});
		await screen.findByRole("heading", { name: /set up your journal/i });
		let replacementOperation: Promise<void> | undefined;
		act(() => {
			replacementOperation = authRef.current?.setup("replacement-password");
		});
		expect
			.soft(replacement.auth.setup)
			.toHaveBeenCalledWith("replacement-password", expect.any(String));
		expect.soft(authRef.current?.busy).toBe(true);

		await act(async () => {
			oldSetup.resolve({ configured: true, unlocked: true });
			await oldOperation;
		});
		expect.soft(authRef.current?.status).toEqual({ configured: false, unlocked: false });
		expect.soft(authRef.current?.busy).toBe(true);
		expect.soft(screen.queryByRole("navigation", { name: /main/i })).not.toBeInTheDocument();
		expect
			.soft(screen.queryByRole("heading", { name: /write your entry/i }))
			.not.toBeInTheDocument();

		if (!replacementOperation) {
			act(() => {
				replacementOperation = authRef.current?.setup("replacement-password");
			});
		}
		expect(replacement.auth.setup).toHaveBeenCalledWith("replacement-password", expect.any(String));
		await act(async () => {
			replacementSetup.resolve({ configured: true, unlocked: true });
			await replacementOperation;
		});
		expect(await screen.findByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
	});

	it("does not double-submit when login is called twice in the same frame", async () => {
		const api = mockAuth({ configured: true, unlocked: false });
		api.auth.login.mockImplementation(() => new Promise<AuthStatus>(() => {}));
		renderGate({ configured: true, unlocked: false }, api);
		const password = await screen.findByLabelText(/^password/i);
		fireEvent.change(password, { target: { value: "correct-password" } });

		act(() => {
			void authRef.current?.login("correct-password");
			void authRef.current?.login("correct-password");
		});

		expect(api.auth.login).toHaveBeenCalledTimes(1);
	});
});

describe("in-process device unlock", () => {
	it("shows the device button only when native protection is enabled and available", async () => {
		renderGate(
			{ configured: true, unlocked: false },
			mockAuth({ configured: true, unlocked: false }),
			mockDevice(false),
		);
		await screen.findByRole("heading", { name: /unlock your journal/i });
		expect(screen.queryByRole("button", { name: /use device unlock/i })).not.toBeInTheDocument();
	});

	it("opens the session after successful native authentication", async () => {
		const api = mockAuth({ configured: true, unlocked: false });
		const device = mockDevice();
		renderGate({ configured: true, unlocked: false }, api, device);
		fireEvent.click(await screen.findByRole("button", { name: /use device unlock/i }));
		expect(await screen.findByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
		expect(device.authenticateSession).toHaveBeenCalledOnce();
		expect(api.auth.unlockWithDeviceCredential).toHaveBeenCalledOnce();
		expect(api.auth.login).not.toHaveBeenCalled();
	});

	it("leaves the form unchanged without an alert when device authentication is cancelled", async () => {
		const api = mockAuth({ configured: true, unlocked: false });
		const device = mockDevice();
		device.authenticateSession.mockResolvedValueOnce("cancelled");
		renderGate({ configured: true, unlocked: false }, api, device);
		fireEvent.click(await screen.findByRole("button", { name: /use device unlock/i }));
		await waitFor(() => expect(device.authenticateSession).toHaveBeenCalledOnce());
		expect(screen.getByRole("heading", { name: /unlock your journal/i })).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(api.auth.unlockWithDeviceCredential).not.toHaveBeenCalled();
	});

	it("masks native failure details and retains password fallback", async () => {
		const api = mockAuth({ configured: true, unlocked: false });
		const device = mockDevice();
		const raw = "KeyStoreException alias at /data/user/0 secret";
		device.authenticateSession.mockRejectedValueOnce(new Error(raw));
		renderGate({ configured: true, unlocked: false }, api, device);
		fireEvent.click(await screen.findByRole("button", { name: /use device unlock/i }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(AUTH_PROVIDER_ERROR_MESSAGE);
		expect(alert).not.toHaveTextContent(raw);
		expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^unlock$/i })).toBeInTheDocument();
	});

	it("blocks same-frame duplicate device authentication", async () => {
		const api = mockAuth({ configured: true, unlocked: false });
		const device = mockDevice();
		device.authenticateSession.mockImplementation(() => new Promise(() => {}));
		renderGate({ configured: true, unlocked: false }, api, device);
		await screen.findByRole("button", { name: /use device unlock/i });
		act(() => {
			void authRef.current?.loginWithDevice();
			void authRef.current?.loginWithDevice();
		});
		expect(device.authenticateSession).toHaveBeenCalledOnce();
	});

	it("ignores a stale device result after owner replacement", async () => {
		const old = mockAuth({ configured: true, unlocked: false });
		const oldDevice = mockDevice();
		const oldAuthentication = deferred<"authenticated" | "cancelled">();
		oldDevice.authenticateSession.mockReturnValue(oldAuthentication.promise);
		const replacement = mockAuth({ configured: true, unlocked: false });
		const replacementDevice = mockDevice();
		const view = renderGate({ configured: true, unlocked: false }, old, oldDevice);
		await screen.findByRole("button", { name: /use device unlock/i });
		act(() => {
			void authRef.current?.loginWithDevice();
		});

		view.rerender(
			<HashRouter>
				<AuthProvider auth={replacement.auth} deviceUnlock={replacementDevice}>
					<AuthProbe />
					<App />
				</AuthProvider>
			</HashRouter>,
		);
		await screen.findByRole("heading", { name: /unlock your journal/i });
		await act(async () => {
			oldAuthentication.resolve("authenticated");
			await Promise.resolve();
		});
		expect(old.auth.unlockWithDeviceCredential).not.toHaveBeenCalled();
		expect(replacement.auth.unlockWithDeviceCredential).not.toHaveBeenCalled();
		expect(screen.getByRole("heading", { name: /unlock your journal/i })).toBeInTheDocument();
	});

	it("invalidates a pending device result on unmount", async () => {
		const api = mockAuth({ configured: true, unlocked: false });
		const device = mockDevice();
		const authentication = deferred<"authenticated" | "cancelled">();
		device.authenticateSession.mockReturnValue(authentication.promise);
		const view = renderGate({ configured: true, unlocked: false }, api, device);
		await screen.findByRole("button", { name: /use device unlock/i });
		act(() => {
			void authRef.current?.loginWithDevice();
		});
		view.unmount();
		await act(async () => {
			authentication.resolve("authenticated");
			await Promise.resolve();
		});
		expect(api.auth.unlockWithDeviceCredential).not.toHaveBeenCalled();
	});
});
