import { addDays, mondayOfWeek, todayInTimezone } from "@rememberme/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { HashRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import AppBootstrap from "@/components/layout/AppBootstrap";
import type { DatabaseHandle } from "@/db/bootstrap";
import { createTestHandle } from "@/db/test-helper";
import {
	createWeeklyNotificationAdapter,
	type WeeklyNotificationAction,
} from "@/notifications/weekly-notification-adapter";

// Renders the app inside a HashRouter, exactly as main.tsx does, so route
// matching and the shell render identically to production.
function renderApp(initialPath: string) {
	window.location.hash = `#${initialPath}`;
	return render(
		<HashRouter>
			<App />
		</HashRouter>,
	);
}

function actionPlugin(pending: WeeklyNotificationAction[] = []) {
	let listener: ((action: WeeklyNotificationAction) => void) | undefined;
	const actions = [...pending];
	const plugin = {
		reconcile: vi.fn(async () => ({ scheduled: true, caughtUp: false })),
		getPermissionStatus: vi.fn(async () => ({ status: "granted" as const, blockedAt: null })),
		requestPermission: vi.fn(async () => ({ status: "granted" as const, blockedAt: null })),
		openNotificationSettings: vi.fn(async () => {}),
		addListener: vi.fn(
			async (
				_event: "weeklyNotificationAction",
				next: (action: WeeklyNotificationAction) => void,
			) => {
				listener = next;
				return { remove: vi.fn(async () => {}) };
			},
		),
		consumePendingActions: vi.fn(async () => ({ actions: [...actions] })),
		acknowledgeAction: vi.fn(async ({ id }: { id: string }) => {
			const index = actions.findIndex((action) => action.id === id);
			if (index >= 0) actions.splice(index, 1);
		}),
	};
	return {
		plugin,
		emit(action: WeeklyNotificationAction) {
			listener?.(action);
		},
	};
}

function WeeklyRouteProbe({ onWeekly }: { onWeekly: () => void }) {
	const location = useLocation();
	useEffect(() => {
		if (location.pathname === "/weekly") onWeekly();
	}, [location.pathname, onWeekly]);
	return null;
}

const nativeHandles: DatabaseHandle[] = [];

afterEach(async () => {
	cleanup();
	await Promise.all(nativeHandles.map((handle) => handle.close().catch(() => {})));
	nativeHandles.length = 0;
	window.location.hash = "";
	vi.restoreAllMocks();
});

function renderNativeApp(
	handle: DatabaseHandle,
	adapter: ReturnType<typeof createWeeklyNotificationAdapter>,
	onWeekly: () => void,
) {
	nativeHandles.push(handle);
	return render(
		<HashRouter>
			<WeeklyRouteProbe onWeekly={onWeekly} />
			<AppBootstrap attemptNative initializer={async () => handle} notificationAdapter={adapter}>
				<App />
			</AppBootstrap>
		</HashRouter>,
	);
}

// Explicitly typed rows keep the it.each callback params string | RegExp
// (sound) instead of letting array widening collapse them to a union that
// vitest's Each typing may hand back as any.
const routeCases: ReadonlyArray<[path: string, heading: RegExp]> = [
	["/today", /write your entry/i],
	["/archive", /^archive$/i],
	["/settings", /preferences/i],
	["/weekly", /weekly review/i],
];

describe("journal date routes", () => {
	it("renders the selected calendar date on /journal/:date", () => {
		renderApp("/journal/2026-08-10");
		expect(screen.getByRole("heading", { name: /Monday · August 10, 2026/ })).toBeInTheDocument();
		// App-alone (storage null) renders the editor fail-closed copy: editing
		// needs the on-device database that only exists inside the Android app.
		expect(screen.getByText(/editing requires the on-device database/i)).toBeInTheDocument();
		expect(screen.queryByText(/until encrypted storage is added/i)).not.toBeInTheDocument();
	});

	it("shows the WeekStrip with journal-date day links and week navigation", () => {
		renderApp("/journal/2026-08-12");
		expect(
			screen.getByRole("heading", { name: "August 10 — August 16, 2026" }),
		).toBeInTheDocument();
		// day cells link into /journal/:date routes
		expect(screen.getByRole("link", { name: "Monday, August 10" })).toHaveAttribute(
			"href",
			"#/journal/2026-08-10",
		);
		expect(screen.getByRole("link", { name: "Sunday, August 16" })).toHaveAttribute(
			"href",
			"#/journal/2026-08-16",
		);
		// prev/next week navigation stays on journal-date routes
		expect(screen.getByRole("link", { name: /previous week/i })).toHaveAttribute(
			"href",
			"#/journal/2026-08-03",
		);
		expect(screen.getByRole("link", { name: /next week/i })).toHaveAttribute(
			"href",
			"#/journal/2026-08-17",
		);
	});

	it("redirects invalid dates on /journal/:date to Today", () => {
		renderApp("/journal/not-a-date");
		expect(screen.getByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
	});

	it("keeps Today at /today while its WeekStrip navigates by journal date", () => {
		renderApp("/today");
		expect(screen.getByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
		// App-alone (storage null) => the editor fails closed with the truthful
		// on-device-database copy (same heading, never the storage-ready copy).
		expect(screen.getByText(/editing requires the on-device database/i)).toBeInTheDocument();
		expect(screen.queryByText(/until encrypted storage is added/i)).not.toBeInTheDocument();
		// the strip on Today derives its week from the real today and links
		// days through journal-date routes (never /today?date=…)
		const monday = mondayOfWeek(todayInTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone));
		expect(screen.getByRole("link", { name: /previous week/i })).toHaveAttribute(
			"href",
			`#/journal/${addDays(monday, -7)}`,
		);
		expect(screen.getByRole("link", { name: /next week/i })).toHaveAttribute(
			"href",
			`#/journal/${addDays(monday, 7)}`,
		);
		expect(screen.queryByRole("link", { name: /today\?date=/i })).not.toBeInTheDocument();
	});
});

describe("journal date boundary weeks", () => {
	it.each(["0000-01-01", "0000-01-02"])(
		"redirects /journal/%s to Today when its week underflows the 0000 year floor",
		(date: string) => {
			renderApp(`/journal/${date}`);
			expect(screen.getByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
		},
	);

	it.each(["9999-12-27", "9999-12-28", "9999-12-29", "9999-12-30", "9999-12-31"])(
		"redirects /journal/%s to Today when its week overflows the 9999 year ceiling",
		(date: string) => {
			renderApp(`/journal/${date}`);
			expect(screen.getByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
		},
	);

	it("renders the selected date and strip at the lower boundary week /journal/0000-01-03", () => {
		renderApp("/journal/0000-01-03");
		expect(screen.getByRole("heading", { name: "Monday · January 3, 0000" })).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "January 3 — January 9, 0000" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /previous week/i })).not.toBeInTheDocument();
		expect(screen.getByRole("link", { name: /next week/i })).toHaveAttribute(
			"href",
			"#/journal/0000-01-10",
		);
	});

	it("renders the selected date and strip at the upper boundary week /journal/9999-12-26", () => {
		renderApp("/journal/9999-12-26");
		expect(screen.getByRole("heading", { name: "Sunday · December 26, 9999" })).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "December 20 — December 26, 9999" }),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /previous week/i })).toHaveAttribute(
			"href",
			"#/journal/9999-12-13",
		);
		expect(screen.queryByRole("link", { name: /next week/i })).not.toBeInTheDocument();
	});
});

describe("app shell and routes", () => {
	it.each(routeCases)("renders the %s page", (path: string, heading: RegExp) => {
		renderApp(path);
		expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
	});

	it("navigates the root path to Today", () => {
		renderApp("/");
		expect(screen.getByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
	});

	it("redirects unknown paths to Today", () => {
		renderApp("/does-not-exist");
		expect(screen.getByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
	});

	it("renders the Weekly Review route before the catch-all", () => {
		renderApp("/weekly");
		expect(screen.getByRole("heading", { name: /weekly review/i })).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: /write your entry/i })).not.toBeInTheDocument();
	});

	it("renders the Weekly Review link in the main navigation", () => {
		renderApp("/today");
		const nav = screen.getByRole("navigation", { name: /main/i });
		expect(nav).toBeInTheDocument();
		for (const label of ["Today", "Archive", "Settings", "Weekly Review"]) {
			expect(screen.getByRole("link", { name: new RegExp(label, "i") })).toBeInTheDocument();
		}
	});
});

describe("weekly notification navigation keeps auth gates and acknowledges each action once", () => {
	it("navigates a cold action to #/weekly while preserving the setup gate", async () => {
		const handle = await createTestHandle();
		const { plugin } = actionPlugin([{ id: "cold-1", route: "/weekly" }]);
		const adapter = createWeeklyNotificationAdapter(plugin);
		const onWeekly = vi.fn();

		renderNativeApp(handle, adapter, onWeekly);
		expect(
			await screen.findByRole("heading", { name: /set up your journal/i }),
		).toBeInTheDocument();
		await waitFor(() => expect(window.location.hash).toBe("#/weekly"));
		expect(screen.getByRole("heading", { name: /set up your journal/i })).toBeInTheDocument();
		expect(screen.queryByRole("navigation", { name: /main/i })).not.toBeInTheDocument();
		await waitFor(() => expect(onWeekly).toHaveBeenCalledTimes(1));
		expect(plugin.acknowledgeAction).toHaveBeenCalledTimes(1);
		expect(plugin.acknowledgeAction).toHaveBeenCalledWith({ id: "cold-1" });
	});

	it("navigates a warm action to #/weekly while preserving the login gate", async () => {
		const handle = await createTestHandle();
		await handle.auth.setup("correct-horse-battery", "UTC");
		await Promise.resolve(handle.auth.logout());
		const { plugin, emit } = actionPlugin();
		const adapter = createWeeklyNotificationAdapter(plugin);
		const onWeekly = vi.fn();

		renderNativeApp(handle, adapter, onWeekly);
		expect(
			await screen.findByRole("heading", { name: /unlock your journal/i }),
		).toBeInTheDocument();
		await waitFor(() => expect(plugin.addListener).toHaveBeenCalledTimes(1));
		emit({ id: "warm-1", route: "/weekly" });
		await waitFor(() => expect(window.location.hash).toBe("#/weekly"));
		expect(screen.getByRole("heading", { name: /unlock your journal/i })).toBeInTheDocument();
		expect(screen.queryByRole("navigation", { name: /main/i })).not.toBeInTheDocument();
		await waitFor(() => expect(onWeekly).toHaveBeenCalledTimes(1));
		expect(plugin.acknowledgeAction).toHaveBeenCalledTimes(1);
		expect(plugin.acknowledgeAction).toHaveBeenCalledWith({ id: "warm-1" });
	});
});
