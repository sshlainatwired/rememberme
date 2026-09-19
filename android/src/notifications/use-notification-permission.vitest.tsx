import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NotificationPermissionCard from "@/components/notifications/NotificationPermissionCard";
import SettingsForm from "@/components/settings/SettingsForm";
import type { AppSettings } from "@/db/settings";
import { StorageProvider } from "@/db/storage";
import { createTestHandle } from "@/db/test-helper";
import {
	NotificationPermissionProvider,
	useNotificationPermission,
} from "./use-notification-permission";
import type {
	NotificationPermissionResult,
	WeeklyNotificationAdapter,
} from "./weekly-notification-adapter";

function fakeAdapter(
	status: NotificationPermissionResult = { status: "prompt", blockedAt: null },
): WeeklyNotificationAdapter {
	return {
		reconcile: vi.fn(async () => ({ scheduled: false, caughtUp: false })),
		getPermissionStatus: vi.fn(async () => ({ ...status })),
		requestPermission: vi.fn(async () => ({ ...status })),
		openNotificationSettings: vi.fn(async () => {}),
		addActionListener: vi.fn(async () => vi.fn()),
	};
}

function Probe() {
	const permission = useNotificationPermission();
	return (
		<div>
			<output>{permission.status ?? "loading"}</output>
			<output>{permission.blockedAt ?? "none"}</output>
			<output>{permission.loading ? "busy" : "idle"}</output>
			{permission.error && <p role="alert">{permission.error}</p>}
			<button type="button" onClick={() => void permission.requestIfPrompt()}>
				Request notifications
			</button>
			<button type="button" onClick={() => void permission.openSystemSettings()}>
				Open notification settings
			</button>
		</div>
	);
}

let capturedRequest: ReturnType<typeof useNotificationPermission>["requestIfPrompt"] | undefined;

function CapturingProbe() {
	const permission = useNotificationPermission();
	capturedRequest = permission.requestIfPrompt;
	return <output>{permission.status ?? "loading"}</output>;
}

function renderPermission(adapter: WeeklyNotificationAdapter) {
	return render(
		<NotificationPermissionProvider adapter={adapter}>
			<Probe />
		</NotificationPermissionProvider>,
	);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function renderSettings(
	handle: Awaited<ReturnType<typeof createTestHandle>>,
	adapter: WeeklyNotificationAdapter,
) {
	return render(
		<StorageProvider database={handle}>
			<NotificationPermissionProvider adapter={adapter}>
				<SettingsForm />
			</NotificationPermissionProvider>
		</StorageProvider>,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("notification permission UX", () => {
	it("loads status on mount without requesting permission", async () => {
		const adapter = fakeAdapter();
		renderPermission(adapter);

		await waitFor(() => expect(screen.getByText("prompt")).toBeInTheDocument());
		expect(adapter.getPermissionStatus).toHaveBeenCalledTimes(1);
		expect(adapter.requestPermission).not.toHaveBeenCalled();
	});

	it("reads once on mount and once on visible without requesting permission", async () => {
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		const adapter = fakeAdapter();
		renderPermission(adapter);

		await screen.findByText("prompt");
		fireEvent(document, new Event("visibilitychange"));
		await waitFor(() => expect(adapter.getPermissionStatus).toHaveBeenCalledTimes(2));
		expect(adapter.requestPermission).not.toHaveBeenCalled();
	});

	it("orders preflight, request, and post-result refresh", async () => {
		const events: string[] = [];
		const adapter = fakeAdapter();
		vi.mocked(adapter.getPermissionStatus).mockImplementation(async () => {
			const result =
				events.filter((event) => event.startsWith("read:")).length < 2
					? { status: "prompt" as const, blockedAt: null }
					: { status: "granted" as const, blockedAt: null };
			events.push(`read:${result.status}`);
			return result;
		});
		vi.mocked(adapter.requestPermission).mockImplementation(async () => {
			events.push("request");
			return { status: "denied", blockedAt: "runtime" };
		});
		renderPermission(adapter);
		await screen.findByText("prompt");

		fireEvent.click(screen.getByRole("button", { name: /request notifications/i }));
		await waitFor(() => expect(adapter.requestPermission).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(adapter.getPermissionStatus).toHaveBeenCalledTimes(3));
		expect(events).toEqual(["read:prompt", "read:prompt", "request", "read:granted"]);
	});

	it("masks native failures with stable copy and offers the recovery action", async () => {
		const adapter = fakeAdapter();
		vi.mocked(adapter.getPermissionStatus).mockRejectedValueOnce(
			new Error("CapacitorSQLite secret path /data/data/app.db"),
		);
		renderPermission(adapter);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Please try again.");
		expect(alert).not.toHaveTextContent("CapacitorSQLite");
		fireEvent.click(screen.getByRole("button", { name: /open notification settings/i }));
		await waitFor(() => expect(adapter.openNotificationSettings).toHaveBeenCalledTimes(1));
	});

	it("renders channel denial with channel-settings recovery copy", async () => {
		const adapter = fakeAdapter({ status: "denied", blockedAt: "channel" });
		render(
			<NotificationPermissionProvider adapter={adapter}>
				<NotificationPermissionCard />
			</NotificationPermissionProvider>,
		);

		expect(await screen.findByText(/weekly review notification channel/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /open notification settings/i })).toBeInTheDocument();
	});
});

describe("SettingsForm permission races", () => {
	it("renders current weekly review availability copy", async () => {
		const handle = await createTestHandle();
		renderSettings(handle, fakeAdapter());

		const copy =
			"When enabled, your local reminder is scheduled for this hour each Sunday. The in-app Weekly Review stays available even if notifications are blocked.";
		expect(await screen.findByText(copy, { exact: true })).toBeInTheDocument();
		expect(screen.queryByText(/arrives in Phase 6|will be honored then/i)).not.toBeInTheDocument();
	});

	it("keeps the app setting enabled when false-to-true native permission is denied", async () => {
		const handle = await createTestHandle();
		const adapter = fakeAdapter();
		vi.mocked(adapter.getPermissionStatus)
			.mockResolvedValueOnce({ status: "prompt", blockedAt: null })
			.mockResolvedValueOnce({ status: "prompt", blockedAt: null })
			.mockResolvedValueOnce({ status: "denied", blockedAt: "runtime" });
		vi.mocked(adapter.requestPermission).mockResolvedValueOnce({
			status: "denied",
			blockedAt: "runtime",
		});
		renderSettings(handle, adapter);

		const toggle = await screen.findByLabelText(/enable weekly review/i);
		expect(toggle).not.toBeChecked();
		fireEvent.click(toggle);
		await waitFor(() => expect(adapter.requestPermission).toHaveBeenCalledTimes(1));
		await waitFor(() => {
			expect(toggle).toBeChecked();
			expect(screen.getByText(/Android has blocked notification permission/i)).toBeInTheDocument();
		});
	});

	it("keeps an adapter-A request from refreshing or prompting after an adapter swap", async () => {
		const firstRead = deferred<NotificationPermissionResult>();
		const preflight = deferred<NotificationPermissionResult>();
		const request = deferred<NotificationPermissionResult>();
		const first = fakeAdapter();
		const second = fakeAdapter({ status: "denied", blockedAt: "app" });
		vi.mocked(first.getPermissionStatus)
			.mockReturnValueOnce(firstRead.promise)
			.mockReturnValueOnce(preflight.promise);
		vi.mocked(first.requestPermission).mockReturnValueOnce(request.promise);
		const view = render(
			<NotificationPermissionProvider adapter={first}>
				<CapturingProbe />
			</NotificationPermissionProvider>,
		);

		firstRead.resolve({ status: "prompt", blockedAt: null });
		await screen.findByText("prompt");
		const retiredRequest = capturedRequest;
		expect(retiredRequest).toBeDefined();
		if (!retiredRequest) throw new Error("request closure was not captured");
		const requestPromise = retiredRequest();
		preflight.resolve({ status: "prompt", blockedAt: null });
		await waitFor(() => expect(first.requestPermission).toHaveBeenCalledTimes(1));

		view.rerender(
			<NotificationPermissionProvider adapter={second}>
				<CapturingProbe />
			</NotificationPermissionProvider>,
		);
		await waitFor(() => expect(second.getPermissionStatus).toHaveBeenCalledTimes(1));
		request.resolve({ status: "granted", blockedAt: null });
		await requestPromise;
		await waitFor(() => expect(screen.getByText("denied")).toBeInTheDocument());
		expect(first.getPermissionStatus).toHaveBeenCalledTimes(2);

		await retiredRequest();
		expect(first.requestPermission).toHaveBeenCalledTimes(1);
	});

	it("does no post-unmount refresh or state work for a deferred request", async () => {
		const firstRead = deferred<NotificationPermissionResult>();
		const preflight = deferred<NotificationPermissionResult>();
		const request = deferred<NotificationPermissionResult>();
		const adapter = fakeAdapter();
		vi.mocked(adapter.getPermissionStatus)
			.mockReturnValueOnce(firstRead.promise)
			.mockReturnValueOnce(preflight.promise);
		vi.mocked(adapter.requestPermission).mockReturnValueOnce(request.promise);
		const view = render(
			<NotificationPermissionProvider adapter={adapter}>
				<CapturingProbe />
			</NotificationPermissionProvider>,
		);

		firstRead.resolve({ status: "prompt", blockedAt: null });
		await screen.findByText("prompt");
		if (!capturedRequest) throw new Error("request closure was not captured");
		const pendingRequest = capturedRequest();
		preflight.resolve({ status: "prompt", blockedAt: null });
		await waitFor(() => expect(adapter.requestPermission).toHaveBeenCalledTimes(1));
		view.unmount();
		request.resolve({ status: "granted", blockedAt: null });
		await pendingRequest;

		expect(adapter.getPermissionStatus).toHaveBeenCalledTimes(2);
	});

	it("awaits an authoritative enable write before requesting permission", async () => {
		const handle = await createTestHandle();
		const adapter = fakeAdapter();
		const pending = deferred<AppSettings>();
		const update = vi.spyOn(handle.settings, "update").mockReturnValue(pending.promise);
		renderSettings(handle, adapter);
		const toggle = await screen.findByLabelText(/enable weekly review/i);

		fireEvent.click(toggle);
		await waitFor(() => expect(update).toHaveBeenCalledWith({ weeklyReviewEnabled: true }));
		expect(adapter.requestPermission).not.toHaveBeenCalled();
		pending.resolve({
			...(await handle.settings.get()),
			weeklyReviewEnabled: true,
		});
		await waitFor(() => expect(adapter.requestPermission).toHaveBeenCalledTimes(1));
	});

	it("invalidates a pending enable on a real immediate disable click", async () => {
		const handle = await createTestHandle();
		const enableWrite = deferred<AppSettings>();
		const disableWrite = deferred<AppSettings>();
		vi.spyOn(handle.settings, "update").mockImplementation((patch) =>
			patch.weeklyReviewEnabled ? enableWrite.promise : disableWrite.promise,
		);
		const adapter = fakeAdapter();
		renderSettings(handle, adapter);
		const toggle = await screen.findByLabelText(/enable weekly review/i);

		fireEvent.click(toggle);
		await waitFor(() => expect(toggle).toBeChecked());
		fireEvent.click(toggle);
		await waitFor(() => expect(toggle).not.toBeChecked());
		expect(adapter.requestPermission).not.toHaveBeenCalled();

		enableWrite.resolve({
			...(await handle.settings.get()),
			weeklyReviewEnabled: true,
		});
		disableWrite.resolve({
			...(await handle.settings.get()),
			weeklyReviewEnabled: false,
		});
		await Promise.resolve();
		expect(adapter.requestPermission).not.toHaveBeenCalled();
	});

	it("does not prompt after an update failure", async () => {
		const handle = await createTestHandle();
		const adapter = fakeAdapter();
		const updateFailure = vi
			.spyOn(handle.settings, "update")
			.mockRejectedValueOnce(new Error("native settings write failed"));
		renderSettings(handle, adapter);
		const toggle = await screen.findByLabelText(/enable weekly review/i);
		fireEvent.click(toggle);
		await waitFor(() => expect(updateFailure).toHaveBeenCalled());
		expect(adapter.requestPermission).not.toHaveBeenCalled();
	});

	it("does not prompt when the authoritative status is no longer prompt", async () => {
		const handle = await createTestHandle();
		const adapter = fakeAdapter();
		vi.mocked(adapter.getPermissionStatus)
			.mockResolvedValueOnce({ status: "prompt", blockedAt: null })
			.mockResolvedValueOnce({ status: "denied", blockedAt: "runtime" });
		renderSettings(handle, adapter);
		fireEvent.click(await screen.findByLabelText(/enable weekly review/i));
		await waitFor(() => expect(adapter.getPermissionStatus).toHaveBeenCalledTimes(2));
		expect(adapter.requestPermission).not.toHaveBeenCalled();
	});

	it("drops a pending enable after storage replacement", async () => {
		const first = await createTestHandle();
		const second = await createTestHandle();
		const pending = deferred<AppSettings>();
		vi.spyOn(first.settings, "update").mockReturnValue(pending.promise);
		const adapter = fakeAdapter();
		const view = renderSettings(first, adapter);
		fireEvent.click(await screen.findByLabelText(/enable weekly review/i));
		view.rerender(
			<StorageProvider database={second}>
				<NotificationPermissionProvider adapter={adapter}>
					<SettingsForm />
				</NotificationPermissionProvider>
			</StorageProvider>,
		);
		pending.resolve({
			...(await first.settings.get()),
			weeklyReviewEnabled: true,
		});
		await Promise.resolve();
		expect(adapter.requestPermission).not.toHaveBeenCalled();
	});

	it("drops a pending enable after unmount", async () => {
		const handle = await createTestHandle();
		const pending = deferred<AppSettings>();
		vi.spyOn(handle.settings, "update").mockReturnValue(pending.promise);
		const adapter = fakeAdapter();
		const view = renderSettings(handle, adapter);
		fireEvent.click(await screen.findByLabelText(/enable weekly review/i));
		view.unmount();
		pending.resolve({
			...(await handle.settings.get()),
			weeklyReviewEnabled: true,
		});
		await Promise.resolve();
		expect(adapter.requestPermission).not.toHaveBeenCalled();
	});

	it("offers system settings recovery for a denied channel", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ weeklyReviewEnabled: true });
		const adapter = fakeAdapter({ status: "denied", blockedAt: "channel" });
		renderSettings(handle, adapter);
		await screen.findByText(/weekly review notification channel/i);
		fireEvent.click(screen.getByRole("button", { name: /open notification settings/i }));
		await waitFor(() => expect(adapter.openNotificationSettings).toHaveBeenCalledTimes(1));
	});
});
