import { formatWeekRange, mondayOfWeek, mostRecentSunday, todayInTimezone } from "@rememberme/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseHandle } from "@/db/bootstrap";
import { StorageProvider } from "@/db/storage";
import { createTestHandle } from "@/db/test-helper";
import { useSettings } from "@/db/use-settings";
import WeeklyReview from "@/pages/WeeklyReview";

const NOW = new Date("2026-08-16T12:00:00Z");
const MASKED_ERROR = "We couldn't load your weekly review. Please try again.";

function renderWeekly(database: DatabaseHandle | null, now: Date = NOW) {
	return render(
		<HashRouter>
			<StorageProvider database={database}>
				<WeeklyReview now={now} />
			</StorageProvider>
		</HashRouter>,
	);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function SettingsChangeDriver() {
	const { settings, update } = useSettings();
	return (
		<>
			<span data-testid="settings-driver">{settings?.timezone ?? "loading"}</span>
			<button type="button" onClick={() => void update({ appearance: "light" })}>
				Change settings
			</button>
		</>
	);
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("WeeklyReview storage-backed week", () => {
	it("renders the saved-zone Monday–Sunday digest with exact content, missing days, and count", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });
		await handle.journal.upsert("2026-08-10", "Monday exact\nline 2 <&> \\u{1F4D3}");
		await handle.journal.upsert("2026-08-13", "   ");
		const list = vi.spyOn(handle.journal, "list");

		renderWeekly(handle);

		const monday = mondayOfWeek(mostRecentSunday(todayInTimezone("UTC", NOW)));
		expect(
			await screen.findByRole("heading", { name: /this week, at a glance/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: formatWeekRange(monday) })).toBeInTheDocument();
		expect(screen.getByTestId("weekly-entry-2026-08-10").textContent).toBe(
			"Monday exact\nline 2 <&> \\u{1F4D3}",
		);
		expect(screen.getByTestId("weekly-entry-2026-08-11")).toHaveTextContent("No entry.");
		expect(screen.getByTestId("weekly-entry-2026-08-13").textContent).toBe("   ");
		expect(screen.getByText("2 entries")).toBeInTheDocument();
		expect(list).toHaveBeenCalledWith("2026-08-10", "2026-08-16");
	});

	it("selects the week from the saved timezone near UTC midnight", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "America/New_York" });
		const list = vi.spyOn(handle.journal, "list").mockResolvedValue([]);

		renderWeekly(handle, new Date("2026-09-01T00:30:00Z"));

		expect(
			await screen.findByRole("heading", { name: "August 24 — August 30, 2026" }),
		).toBeInTheDocument();
		expect(list).toHaveBeenCalledWith("2026-08-24", "2026-08-30");
	});

	it("masks synchronous invalid-date failures exactly like list failures", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });

		renderWeekly(handle, new Date("invalid"));
		expect(await screen.findByRole("alert")).toHaveTextContent(MASKED_ERROR);
		expect(screen.queryByTestId("weekly-entry-2026-08-10")).not.toBeInTheDocument();
	});

	it("masks journal.list rejection without rendering day content", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });
		vi.spyOn(handle.journal, "list").mockRejectedValue(
			new Error("SQLITE_ERROR: SELECT secret from /data/user/0/rememberme/app.db"),
		);

		renderWeekly(handle);
		expect(await screen.findByRole("alert")).toHaveTextContent(MASKED_ERROR);
		expect(screen.queryByText(/SQLITE_ERROR|SELECT secret/)).not.toBeInTheDocument();
		expect(screen.queryByTestId("weekly-entry-2026-08-10")).not.toBeInTheDocument();
	});

	it("masks a cached ready review when a settings reload rejects", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });
		await handle.journal.upsert("2026-08-10", "PRIOR REVIEW");
		await handle.journal.upsert("2026-08-13", "SECOND PRIOR REVIEW");
		const get = vi.spyOn(handle.settings, "get");

		const view = render(
			<HashRouter>
				<StorageProvider database={handle}>
					<WeeklyReview now={NOW} />
					<SettingsChangeDriver />
				</StorageProvider>
			</HashRouter>,
		);

		expect(
			await screen.findByRole("heading", { name: /this week, at a glance/i }),
		).toBeInTheDocument();
		expect(screen.getByTestId("settings-driver")).toHaveTextContent("UTC");
		get.mockRejectedValue(new Error("settings reload failed"));

		fireEvent.click(screen.getByRole("button", { name: "Change settings" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(MASKED_ERROR);
		expect(screen.queryByTestId("weekly-entry-2026-08-10")).not.toBeInTheDocument();
		expect(screen.queryByText("PRIOR REVIEW")).not.toBeInTheDocument();
		expect(screen.queryByText("2 entries")).not.toBeInTheDocument();
		expect(screen.queryByText("settings reload failed")).not.toBeInTheDocument();
		view.unmount();
	});

	it("drops a stale same-owner response after the displayed week changes", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });
		const oldRead = deferred<Awaited<ReturnType<DatabaseHandle["journal"]["list"]>>>();
		const list = vi.spyOn(handle.journal, "list");
		list
			.mockImplementationOnce(() => oldRead.promise)
			.mockResolvedValueOnce([
				{
					date: "2026-08-24",
					content: "CURRENT WEEK",
					createdAt: "2026-08-24T00:00:00.000Z",
					updatedAt: "2026-08-24T00:00:00.000Z",
				},
			]);

		const view = renderWeekly(handle, new Date("2026-08-16T12:00:00Z"));
		await waitFor(() => expect(list).toHaveBeenCalledWith("2026-08-10", "2026-08-16"));
		view.rerender(
			<HashRouter>
				<StorageProvider database={handle}>
					<WeeklyReview now={new Date("2026-08-30T12:00:00Z")} />
				</StorageProvider>
			</HashRouter>,
		);

		expect(await screen.findByTestId("weekly-entry-2026-08-24")).toHaveTextContent("CURRENT WEEK");
		oldRead.resolve([
			{
				date: "2026-08-10",
				content: "STALE SAME OWNER",
				createdAt: "2026-08-10T00:00:00.000Z",
				updatedAt: "2026-08-10T00:00:00.000Z",
			},
		]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.getByTestId("weekly-entry-2026-08-24")).toHaveTextContent("CURRENT WEEK");
		expect(screen.queryByText("STALE SAME OWNER")).not.toBeInTheDocument();
	});

	it("drops a stale A response after the storage owner changes to B", async () => {
		const first = await createTestHandle();
		const second = await createTestHandle();
		await first.settings.update({ timezone: "UTC" });
		await second.settings.update({ timezone: "UTC" });
		const oldRead = deferred<Awaited<ReturnType<DatabaseHandle["journal"]["list"]>>>();
		vi.spyOn(first.journal, "list").mockReturnValue(oldRead.promise);
		vi.spyOn(second.journal, "list").mockResolvedValue([
			{
				date: "2026-08-10",
				content: "B is current",
				createdAt: "2026-08-10T00:00:00.000Z",
				updatedAt: "2026-08-10T00:00:00.000Z",
			},
		]);

		const view = renderWeekly(first);
		await waitFor(() =>
			expect(first.journal.list).toHaveBeenCalledWith("2026-08-10", "2026-08-16"),
		);
		view.rerender(
			<HashRouter>
				<StorageProvider database={second}>
					<WeeklyReview now={NOW} />
				</StorageProvider>
			</HashRouter>,
		);

		expect(await screen.findByTestId("weekly-entry-2026-08-10")).toHaveTextContent("B is current");
		oldRead.resolve([
			{
				date: "2026-08-10",
				content: "STALE A",
				createdAt: "2026-08-10T00:00:00.000Z",
				updatedAt: "2026-08-10T00:00:00.000Z",
			},
		]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.getByTestId("weekly-entry-2026-08-10")).toHaveTextContent("B is current");
		expect(screen.queryByText("STALE A")).not.toBeInTheDocument();
	});

	it("fails closed without day content when storage is absent", () => {
		renderWeekly(null);
		expect(screen.getByRole("heading", { name: /weekly review/i })).toBeInTheDocument();
		expect(screen.getByText(/on-device database/i)).toBeInTheDocument();
		expect(screen.queryByTestId("weekly-entry-2026-08-10")).not.toBeInTheDocument();
		expect(screen.queryByText("No entry.")).not.toBeInTheDocument();
	});
});
