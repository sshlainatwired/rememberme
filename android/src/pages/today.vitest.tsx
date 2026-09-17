import { formatWeekRange, mondayOfWeek, todayInTimezone } from "@rememberme/core";
import { render, screen } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { deviceTimezone } from "@/auth/device-timezone";
import type { DatabaseHandle } from "@/db/bootstrap";
import { StorageProvider } from "@/db/storage";
import { createTestHandle } from "@/db/test-helper";
import Today from "@/pages/Today";

/** Render Today inside the router + storage wiring it uses in the app. */
function renderToday(database: DatabaseHandle | null, now?: Date) {
	return render(
		<HashRouter>
			<StorageProvider database={database}>
				<Today now={now} />
			</StorageProvider>
		</HashRouter>,
	);
}

// A fixed instant where saved-zone date differs from the device-zone date,
// so a regression to the device fallback is observable.
const NOW = new Date("2026-08-10T23:30:00Z");

describe("Today: timezone source boundary", () => {
	it("shows the SAVED timezone date once settings load (no device-zone date)", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "America/New_York" });

		renderToday(handle, NOW);
		const weekday = (await screen.findByRole("link", { name: "Monday, August 10" })) as HTMLElement;
		// New York is UTC-4 in August: 23:30Z on the 10th is 19:30 on the 10th,
		// so the AUTHORITATIVE saved-zone date is Monday 2026-08-10 — never
		// Tuesday 2026-08-11, which is what a device on Istanbul time (UTC+3:
		// 02:30 on the 11th) would report. A regression to the device fallback
		// makes this assertion fail.
		expect(weekday).toHaveAttribute("aria-current", "date");
		// The saved-zone date must be the calendar date shown.
		expect(todayInTimezone("America/New_York", NOW)).toBe("2026-08-10");
	});

	it("renders an accessible loading state while a real storage read is pending (no device-zone date)", async () => {
		const handle = await createTestHandle();
		// The stored timezone is deliberately a different-zone value, but the
		// read never resolves — Today must fail closed, not fall back.
		await handle.settings.update({ timezone: "America/New_York" });
		vi.spyOn(handle.settings, "get").mockImplementation(() => new Promise<never>(() => {}));

		renderToday(handle, NOW);
		// accessible loading: the live status is a sibling outside the busy region,
		// while the busy region retains its fail-closed no-JournalView state.
		const status = screen.getByRole("status");
		const region = screen.getByRole("region", { name: /today/i });
		expect(status.textContent).toMatch(/loading your journal/i);
		expect(status.closest('[aria-busy="true"]')).toBeNull();
		expect(status.parentElement).toBe(region.parentElement);
		expect(region).toHaveAttribute("aria-busy", "true");
		expect(screen.queryByRole("link", { name: /previous week/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /next week/i })).not.toBeInTheDocument();
	});

	it("renders an accessible error state when the settings read fails (fail-closed, no device-zone date)", async () => {
		const handle = await createTestHandle();
		const failure = "SQLITE_ERROR: SELECT secret FROM settings at /data/user/0/rememberme/app.db";
		vi.spyOn(handle.settings, "get").mockRejectedValue(new Error(failure));

		renderToday(handle, NOW);
		await screen.findByRole("alert");
		expect(screen.getByRole("alert").textContent).toMatch(/couldn't load your journal/i);
		expect(screen.getByRole("alert").textContent).toMatch(/please try again/i);
		expect(screen.getByRole("alert").textContent).not.toContain(failure);
		expect(screen.queryByRole("link", { name: /previous week/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /next week/i })).not.toBeInTheDocument();
	});

	it("keeps the device fallback ONLY for the null-storage App-alone seam", () => {
		// No storage provider: settings stay null forever, so the device zone
		// is the honest App-only seam (web/test/dev) — a real date renders.
		const deviceDate = todayInTimezone(deviceTimezone(), NOW);
		renderToday(null, NOW);
		const monday = mondayOfWeek(deviceDate);
		expect(screen.getByRole("heading", { name: formatWeekRange(monday) })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /previous week/i })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /next week/i })).toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
