import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { HashRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import AppBootstrap, { StartupErrorScreen } from "@/components/layout/AppBootstrap";
import { openAppDatabase } from "@/db/bootstrap";
import { createTestDb, createTestHandle } from "@/db/test-helper";
import { useSettings } from "@/db/use-settings";
import { DeviceUnlockCancelledError } from "@/security/device-unlock";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/**
 * Controllable matchMedia stub that records subscribed listeners (modern
 * addEventListener + legacy addListener) so tests can fire system
 * prefers-color-scheme changes and observe listener ownership.
 */
function stubMatchMedia(matches: boolean) {
	const modern: Array<() => void> = [];
	const legacy: Array<() => void> = [];
	vi.stubGlobal("matchMedia", () => ({
		matches,
		addEventListener: (_type: string, cb: () => void) => {
			modern.push(cb);
		},
		removeEventListener: (_type: string, cb: () => void) => {
			const index = modern.indexOf(cb);
			if (index >= 0) modern.splice(index, 1);
		},
		addListener: (cb: () => void) => {
			legacy.push(cb);
		},
		removeListener: (cb: () => void) => {
			const index = legacy.indexOf(cb);
			if (index >= 0) legacy.splice(index, 1);
		},
	}));
	return {
		modern,
		legacy,
		fireModern: () => {
			for (const cb of [...modern]) cb();
		},
		fireLegacy: () => {
			for (const cb of [...legacy]) cb();
		},
	};
}

/** A sibling consumer that persists an appearance change through ITS OWN hook. */
function AppearanceDriver() {
	const { settings, update } = useSettings();
	const current = settings?.appearance ?? "none";
	return (
		<button
			type="button"
			onClick={() => {
				void update({ appearance: "light" }).catch(() => {});
			}}
		>
			{`appearance:${current}`}
		</button>
	);
}

describe("AppBootstrap: native ready path", () => {
	it("opens + migrates the database, then renders children", async () => {
		const db = createTestDb();
		render(
			<AppBootstrap attemptNative initializer={() => openAppDatabase({ open: async () => db })}>
				<div>App content</div>
			</AppBootstrap>,
		);
		expect(await screen.findByText("App content")).toBeInTheDocument();
	});

	it("renders children when the initializer injects a ready handle directly", async () => {
		const db = createTestDb();
		const handle = await openAppDatabase({ open: async () => db });
		render(
			<AppBootstrap attemptNative initializer={async () => handle}>
				<div>App content</div>
			</AppBootstrap>,
		);
		expect(await screen.findByText("App content")).toBeInTheDocument();
	});

	it("bypasses the password form when startup already opened the trusted local session", async () => {
		const handle = await createTestHandle();
		await handle.auth.setup("a-secure-pass", "UTC");
		handle.auth.logout();
		await handle.auth.unlockWithDeviceCredential();
		render(
			<HashRouter>
				<AppBootstrap attemptNative initializer={async () => handle}>
					<App />
				</AppBootstrap>
			</HashRouter>,
		);
		expect(await screen.findByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: /unlock your journal/i })).not.toBeInTheDocument();
	});
});

describe("AppBootstrap: fail-closed path", () => {
	it("shows cancellation as retryable and invokes exactly one new initialization attempt", async () => {
		const handle = await createTestHandle();
		const initializer = vi
			.fn<() => Promise<typeof handle>>()
			.mockRejectedValueOnce(new DeviceUnlockCancelledError())
			.mockResolvedValueOnce(handle);
		render(
			<AppBootstrap attemptNative initializer={initializer}>
				<div>App content</div>
			</AppBootstrap>,
		);

		expect(await screen.findByRole("heading", { name: /unlock cancelled/i })).toBeInTheDocument();
		expect(screen.queryByText("App content")).not.toBeInTheDocument();
		expect(initializer).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(await screen.findByText("App content")).toBeInTheDocument();
		expect(initializer).toHaveBeenCalledTimes(2);
	});

	it("keeps permanent startup failures non-retryable", async () => {
		const initializer = vi.fn(async () => Promise.reject(new Error("permanent failure")));
		render(
			<AppBootstrap attemptNative initializer={initializer}>
				<div>App content</div>
			</AppBootstrap>,
		);
		expect(await screen.findByText("Cannot open local database")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
		expect(screen.queryByText("App content")).not.toBeInTheDocument();
		expect(initializer).toHaveBeenCalledOnce();
	});

	it("shows the clear non-destructive startup screen instead of children", async () => {
		const failure =
			"CapacitorSQLite plugin unavailable at /data/user/0/rememberme/app.db: SELECT secret";
		const failing: () => Promise<never> = () => Promise.reject(new Error(failure));
		render(
			<AppBootstrap attemptNative initializer={failing}>
				<div>App content</div>
			</AppBootstrap>,
		);
		expect(await screen.findByText("Cannot open local database")).toBeInTheDocument();
		expect(screen.getByText("Please try again.")).toBeInTheDocument();
		expect(screen.queryByText(failure)).not.toBeInTheDocument();
		expect(screen.queryByText("App content")).not.toBeInTheDocument();
		// Non-destructive promise is part of the visible contract.
		expect(screen.getByText(/nothing was deleted or reset/i)).toBeInTheDocument();
	});
});

describe("AppBootstrap: non-native renders unchanged without storage", () => {
	it("renders children and never attempts a JS storage substitute", () => {
		const mustNotRun: () => Promise<never> = () =>
			Promise.reject(new Error("must not be called on web/test"));
		render(
			<AppBootstrap attemptNative={false} initializer={mustNotRun}>
				<div>App content</div>
			</AppBootstrap>,
		);
		expect(screen.getByText("App content")).toBeInTheDocument();
	});
});

describe("AppBootstrap: StrictMode double-mount opens once via the singleton initializer", () => {
	it("runs the underlying database open exactly once and renders children", async () => {
		// Fresh module registry so the initDatabase singleton starts empty.
		vi.resetModules();
		const { initDatabase } = await import("@/db/bootstrap");
		const { default: Bootstrap } = await import("@/components/layout/AppBootstrap");

		const db = createTestDb();
		const open = vi.fn(async () => db);
		const initializer = () => initDatabase({ open });

		render(
			<StrictMode>
				<Bootstrap attemptNative initializer={initializer}>
					<div>App content</div>
				</Bootstrap>
			</StrictMode>,
		);

		expect(await screen.findByText("App content")).toBeInTheDocument();
		// React 19 StrictMode double-invokes effects; the singleton initializer
		// must collapse both into one underlying open.
		expect(open).toHaveBeenCalledTimes(1);
		// The gate resolves to the singleton handle, not a second connection.
		const handle = await initDatabase({ open });
		expect(handle.schemaVersion).toBeDefined();
	});

	it("does not leave a stale cancelled effect behind after the double mount", async () => {
		vi.resetModules();
		const { initDatabase } = await import("@/db/bootstrap");
		const { default: Bootstrap } = await import("@/components/layout/AppBootstrap");

		const db = createTestDb();
		const open = vi.fn(async () => db);
		const initializer = () => initDatabase({ open });

		const { unmount } = render(
			<StrictMode>
				<Bootstrap attemptNative initializer={initializer}>
					<div>App content</div>
				</Bootstrap>
			</StrictMode>,
		);
		expect(await screen.findByText("App content")).toBeInTheDocument();
		unmount();
		// After unmount no further open happens and nothing re-renders.
		expect(open).toHaveBeenCalledTimes(1);
	});
});

describe("AppBootstrap: AppearanceSync applies the stored theme before children paint", () => {
	it("sets data-theme from settings ahead of the ready children", async () => {
		// dark system signal; the stored explicit light setting must win
		vi.stubGlobal("matchMedia", () => ({
			matches: true,
			addEventListener: vi.fn(),
			addListener: vi.fn(),
			removeEventListener: vi.fn(),
			removeListener: vi.fn(),
		}));
		const handle = await createTestHandle();
		await handle.settings.update({ appearance: "light" });
		render(
			<AppBootstrap attemptNative initializer={async () => handle}>
				<div>App content</div>
			</AppBootstrap>,
		);
		expect(await screen.findByText("App content")).toBeInTheDocument();
		// useLayoutEffect applies the theme before paint; the attribute is set
		// on <html> once the async settings load resolves
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
	});
});

describe("AppBootstrap: no divergent-theme first paint (post-open read + apply)", () => {
	it("applies the stored explicit-dark theme to <html> BEFORE the ready child renders", async () => {
		// Records order: the child's render must observe data-theme already set
		// from the post-open settings read, never a later async jump.
		const renderLog: string[] = [];
		const handle = await createTestHandle();
		await handle.settings.update({ appearance: "dark" });

		function Probe() {
			// NOTE: React may render children multiple times; record the FIRST
			// committed render only, but every observed value must already be dark.
			renderLog.push(document.documentElement.dataset.theme ?? "UNSET");
			return <div>App content</div>;
		}

		render(
			<AppBootstrap attemptNative initializer={async () => handle}>
				<Probe />
			</AppBootstrap>,
		);
		expect(await screen.findByText("App content")).toBeInTheDocument();
		// Every time the child rendered, the theme was already applied — no
		// divergent light/system default before the stored dark setting landed.
		expect(renderLog.length).toBeGreaterThan(0);
		for (const value of renderLog) {
			expect(value).toBe("dark");
		}
	});
});

describe("AppBootstrap: post-open settings read failure fails closed with a single close", () => {
	it("closes the opened handle exactly once and shows StartupError with cause", async () => {
		const handle = await createTestHandle();
		// Open + migrate succeed; the POST-OPEN validated settings read fails.
		const getSpy = vi.spyOn(handle.settings, "get");
		const failure = "SQLITE_ERROR: corrupt settings at /data/user/0/rememberme/app.db";
		getSpy.mockRejectedValueOnce(new Error(failure));
		const closeSpy = vi.spyOn(handle, "close");
		closeSpy.mockResolvedValue(undefined);

		render(
			<AppBootstrap attemptNative initializer={async () => handle}>
				<div>App content</div>
			</AppBootstrap>,
		);
		expect(await screen.findByText("Cannot open local database")).toBeInTheDocument();
		expect(screen.getByText("Please try again.")).toBeInTheDocument();
		expect(screen.queryByText(failure)).not.toBeInTheDocument();
		expect(screen.queryByText("App content")).not.toBeInTheDocument();
		// exactly one close of the opened handle — no duplicate close
		expect(closeSpy).toHaveBeenCalledTimes(1);
	});
});

describe("AppBootstrap: live appearance updates reach AppearanceSync with listener ownership replaced", () => {
	it("applies a sibling hook's appearance update immediately and drops the stale system listener (modern MQL)", async () => {
		const mql = stubMatchMedia(true); // system prefers dark
		const handle = await createTestHandle();
		render(
			<AppBootstrap attemptNative initializer={async () => handle}>
				<AppearanceDriver />
			</AppBootstrap>,
		);
		// Stored appearance is "system" -> resolves dark while the system prefers dark.
		await screen.findByRole("button", { name: /appearance:system/i });
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
		expect(mql.modern).toHaveLength(1);
		const systemListener = mql.modern[0];

		// The driver persists explicit light through a DIFFERENT useSettings
		// instance than the one AppearanceSync mounted. The theme must flip live
		// (no reload/app restart) as the update propagates to the sync hook.
		fireEvent.click(screen.getByRole("button", { name: /appearance:system/i }));
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));

		// Listener ownership replaced: the old system listener was removed and a
		// single light-bound listener is subscribed — never two.
		expect(mql.modern).toHaveLength(1);
		expect(mql.modern[0]).not.toBe(systemListener);

		// A system change arriving after the explicit choice cannot overwrite it:
		// even flipping the media to light and firing the live listener keeps the
		// explicit light theme (and a surviving stale system listener would have
		// been the one fired — it is gone).
		mql.fireModern();
		expect(document.documentElement.dataset.theme).toBe("light");
	});

	it("replaces the legacy system listener when appearance flips to explicit light", async () => {
		// Legacy-only engine: no addEventListener, only addListener/removeListener.
		const legacy: Array<() => void> = [];
		vi.stubGlobal("matchMedia", () => ({
			matches: true,
			addListener: (cb: () => void) => {
				legacy.push(cb);
			},
			removeListener: (cb: () => void) => {
				const index = legacy.indexOf(cb);
				if (index >= 0) legacy.splice(index, 1);
			},
		}));
		const handle = await createTestHandle();
		render(
			<AppBootstrap attemptNative initializer={async () => handle}>
				<AppearanceDriver />
			</AppBootstrap>,
		);
		await screen.findByRole("button", { name: /appearance:system/i });
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
		expect(legacy).toHaveLength(1);
		const systemListener = legacy[0];

		fireEvent.click(screen.getByRole("button", { name: /appearance:system/i }));
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));

		// One replaced legacy listener, not two; the stale one is unsubscribed.
		expect(legacy).toHaveLength(1);
		expect(legacy[0]).not.toBe(systemListener);
		for (const cb of [...legacy]) cb();
		expect(document.documentElement.dataset.theme).toBe("light");
	});
});

describe("StartupErrorScreen", () => {
	it("renders stable safe copy instead of the caught message", () => {
		const failure = "native plugin failure at /data/user/0/rememberme/app.db: SELECT secret";
		render(<StartupErrorScreen message={failure} />);
		expect(screen.getByText("Cannot open local database")).toBeInTheDocument();
		expect(screen.getByText("Please try again.")).toBeInTheDocument();
		expect(screen.queryByText(failure)).not.toBeInTheDocument();
	});
});
