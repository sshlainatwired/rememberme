import { render, screen, waitFor } from "@testing-library/react";
import { HashRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/auth/auth-context";
import AppBootstrap from "@/components/layout/AppBootstrap";
import type { DatabaseHandle } from "@/db/bootstrap";
import { StorageProvider } from "@/db/storage";
import { createTestHandle } from "@/db/test-helper";
import {
	useWeeklyNotifications,
	WeeklyNotificationsProvider,
} from "@/notifications/WeeklyNotificationsProvider";
import type {
	WeeklyNotificationAction,
	WeeklyNotificationAdapter,
} from "@/notifications/weekly-notification-adapter";

function fakeAdapter() {
	let actionListener: ((action: WeeklyNotificationAction) => void | Promise<void>) | undefined;
	const remove = vi.fn(async () => {});
	const adapter: WeeklyNotificationAdapter = {
		reconcile: vi.fn(async () => ({ scheduled: true, caughtUp: false })),
		getPermissionStatus: vi.fn(async () => ({ status: "prompt" as const, blockedAt: null })),
		requestPermission: vi.fn(async () => ({ status: "prompt" as const, blockedAt: null })),
		openNotificationSettings: vi.fn(async () => {}),
		addActionListener: vi.fn(async (listener) => {
			actionListener = listener;
			return remove;
		}),
	};
	return {
		adapter,
		remove,
		emit(action: WeeklyNotificationAction) {
			return actionListener?.(action);
		},
	};
}

function ContextProbe() {
	const { status, navigateToWeekly } = useWeeklyNotifications();
	return (
		<>
			<output>{status ? `scheduled:${status.scheduled}` : "status:pending"}</output>
			<button type="button" onClick={navigateToWeekly}>
				open weekly
			</button>
		</>
	);
}

function LocationProbe() {
	const location = useLocation();
	return <output>{`path:${location.pathname}`}</output>;
}

function wrapped(handle: DatabaseHandle, adapter: WeeklyNotificationAdapter) {
	return (
		<HashRouter>
			<StorageProvider database={handle}>
				<AuthProvider auth={handle.auth}>
					<WeeklyNotificationsProvider adapter={adapter}>
						<ContextProbe />
						<LocationProbe />
					</WeeklyNotificationsProvider>
				</AuthProvider>
			</StorageProvider>
		</HashRouter>
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("WeeklyNotificationsProvider context", () => {
	it("keeps the exact provider nesting, injects the adapter, and reconciles current settings", async () => {
		const handle = await createTestHandle();
		const { adapter } = fakeAdapter();
		render(
			<HashRouter>
				<AppBootstrap attemptNative initializer={async () => handle} notificationAdapter={adapter}>
					<ContextProbe />
				</AppBootstrap>
			</HashRouter>,
		);
		expect(await screen.findByText("status:pending")).toBeInTheDocument();
		await waitFor(() => expect(screen.getByText("scheduled:true")).toBeInTheDocument());
		expect(adapter.reconcile).toHaveBeenCalledTimes(1);
	});

	it("navigates actions and context actions only to the literal weekly route", async () => {
		const handle = await createTestHandle();
		const { adapter, remove, emit } = fakeAdapter();
		render(wrapped(handle, adapter));
		await waitFor(() => expect(screen.getByText("scheduled:true")).toBeInTheDocument());
		await emit({ id: "tap", route: "/weekly" });
		await waitFor(() => expect(screen.getByText("path:/weekly")).toBeInTheDocument());
		expect(adapter.addActionListener).toHaveBeenCalledTimes(1);
		expect(remove).not.toHaveBeenCalled();
	});

	it("reuses one listener for owner changes and replaces the coordinator for adapter changes", async () => {
		const first = await createTestHandle();
		const second = await createTestHandle();
		const firstAdapter = fakeAdapter();
		const secondAdapter = fakeAdapter();
		const view = render(wrapped(first, firstAdapter.adapter));
		await waitFor(() => expect(firstAdapter.adapter.reconcile).toHaveBeenCalledTimes(1));
		view.rerender(wrapped(second, firstAdapter.adapter));
		await waitFor(() => expect(firstAdapter.adapter.reconcile).toHaveBeenCalledTimes(2));
		expect(firstAdapter.adapter.addActionListener).toHaveBeenCalledTimes(1);
		view.rerender(wrapped(second, secondAdapter.adapter));
		await waitFor(() => expect(secondAdapter.adapter.addActionListener).toHaveBeenCalledTimes(1));
		expect(firstAdapter.remove).toHaveBeenCalledTimes(1);
	});
});
