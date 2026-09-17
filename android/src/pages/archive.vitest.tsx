import { todayInTimezone } from "@rememberme/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as timezoneModule from "@/auth/device-timezone";
import type { DatabaseHandle } from "@/db/bootstrap";
import { StorageProvider } from "@/db/storage";
import { createTestHandle } from "@/db/test-helper";
import Archive from "@/pages/Archive";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/**
 * A deferred promise lets the test resolve a `listDates` call AFTER a month
 * navigation has already started a newer load, so a stale previous-month
 * response can be made to arrive late and be observed doing (or not doing)
 * damage.
 */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Render Archive inside the router + storage wiring it uses in the app. */
function renderArchive(database: DatabaseHandle | null, now: Date) {
	return render(
		<HashRouter>
			<StorageProvider database={database}>
				<Archive now={now} />
			</StorageProvider>
		</HashRouter>,
	);
}

// A fixed instant where the DEVICE zone's civil month differs from the SAVED
// zone's civil month:
//   2026-09-01T00:30:00Z
//   - device zone Europe/Istanbul (UTC+3): 03:30 -> Tuesday 2026-09-01 (September)
//   - saved zone America/New_York (UTC-4): 20:30 -> Monday 2026-08-31 (August)
// So a regression that derives the default month from the DEVICE zone (or
// flashes it) is observable: it would render "September 2026", never "August 2026".
const NOW = new Date("2026-09-01T00:30:00Z");

describe("Archive: saved-timezone source of the first visible month", () => {
	it("derives the first visible month from the SAVED zone after settings resolve, never flashing the device month", async () => {
		// Mock the device zone to a different month than the saved zone.
		vi.spyOn(timezoneModule, "deviceTimezone").mockReturnValue("Europe/Istanbul");
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "America/New_York" });

		renderArchive(handle, NOW);

		// The saved-zone month for NOW is August 2026 (America/New_York).
		expect(todayInTimezone("America/New_York", NOW)).toBe("2026-08-31");
		// The device-zone month would be September — it must never render.
		expect(todayInTimezone("Europe/Istanbul", NOW)).toBe("2026-09-01");

		// The grid's first visible month is the SAVED-zone August, derived from
		// the async-resolved saved timezone — not the device fallback September.
		const title = await screen.findByText("August 2026");
		expect(title).toBeInTheDocument();
		// Never a device-month flash: September never appears, and the device
		// fallback is never consulted for the visible month.
		expect(screen.queryByText("September 2026")).not.toBeInTheDocument();
	});

	it("sets data-today to the saved-zone date (not the device-zone date)", async () => {
		vi.spyOn(timezoneModule, "deviceTimezone").mockReturnValue("Europe/Istanbul");
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "America/New_York" });

		renderArchive(handle, NOW);
		await screen.findByText("August 2026");

		// Saved-zone today is 2026-08-31 (a Monday) — marked as today. Wait for the
		// month read to settle (the initial ready render is the loading placeholder).
		const aug31 = await screen.findByRole("link", { name: "Monday, August 31, 2026" });
		expect(aug31).toHaveAttribute("data-today", "true");
		// The device-zone date (2026-09-01) is not in this month and never marked.
		expect(screen.queryByRole("link", { name: /September 2026/ })).not.toBeInTheDocument();
	});
});

describe("Archive: real-storage fail-closed tiers", () => {
	it("shows an accessible loading state while a real storage settings read is pending", async () => {
		vi.spyOn(timezoneModule, "deviceTimezone").mockReturnValue("Europe/Istanbul");
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "America/New_York" });
		vi.spyOn(handle.settings, "get").mockImplementation(() => new Promise<never>(() => {}));

		renderArchive(handle, NOW);
		expect(screen.getByRole("status").textContent).toMatch(/loading your journal/i);
		expect(screen.getByRole("region", { name: /archive/i })).toHaveAttribute("aria-busy", "true");
		// No grid (no device-month flash) while settings are still loading.
		expect(screen.queryByText("August 2026")).not.toBeInTheDocument();
		expect(screen.queryByText("September 2026")).not.toBeInTheDocument();
	});

	it("keeps the settings-tier loading announcement OUTSIDE any aria-busy ancestor", async () => {
		vi.spyOn(timezoneModule, "deviceTimezone").mockReturnValue("Europe/Istanbul");
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "America/New_York" });
		vi.spyOn(handle.settings, "get").mockImplementation(() => new Promise<never>(() => {}));

		renderArchive(handle, NOW);
		const status = await screen.findByRole("status");
		expect(status.textContent).toMatch(/loading your journal/i);
		// The live announcement must not be deferred by a busy ancestor: a
		// role=status nested inside an aria-busy element would never be read
		// until busy cleared (and busy clears only by replacing the status).
		expect(status.closest('[aria-busy="true"]')).toBeNull();
		// The outer region still reports the settings tier as busy.
		expect(screen.getByRole("region", { name: /archive/i })).toHaveAttribute("aria-busy", "true");
	});

	it("shows an accessible error state when the settings read fails (fail-closed, no grid)", async () => {
		vi.spyOn(timezoneModule, "deviceTimezone").mockReturnValue("Europe/Istanbul");
		const handle = await createTestHandle();
		const failure = "SQLITE_ERROR: settings at /data/user/0/rememberme/app.db";
		vi.spyOn(handle.settings, "get").mockRejectedValue(new Error(failure));

		renderArchive(handle, NOW);
		await screen.findByRole("alert");
		expect(screen.getByRole("alert").textContent).toMatch(/couldn't load your archive/i);
		expect(screen.getByRole("alert").textContent).toMatch(/please try again/i);
		expect(screen.getByRole("alert").textContent).not.toContain(failure);
		expect(screen.queryByText("August 2026")).not.toBeInTheDocument();
	});

	it("keeps the device fallback ONLY for the null-storage App-alone seam", async () => {
		vi.spyOn(timezoneModule, "deviceTimezone").mockReturnValue("Europe/Istanbul");
		// No storage provider: settings stay null, so the device zone is the honest
		// App-only seam — but Archive fail-closes with the on-device-database
		// message and never renders a grid.
		renderArchive(null, NOW);
		expect(screen.getByText(/editing requires the on-device database/i)).toBeInTheDocument();
		expect(screen.queryByText("September 2026")).not.toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});

describe("Archive: listDates exact visible-month bounds", () => {
	it("queries storage with the visible month's first and last civil date (inclusive)", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });

		renderArchive(handle, new Date("2026-08-10T12:00:00Z"));
		const listDates = vi.spyOn(handle.journal, "listDates");
		await screen.findByText("August 2026");

		await vi.waitFor(() => {
			expect(listDates).toHaveBeenCalledWith("2026-08-01", "2026-08-31");
		});
	});
});

describe("Archive: listDates failure is fail-closed with no empty-month copy", () => {
	it("shows an accessible alert and never claims 'no entries' when the month read fails", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });
		const failure = "CapacitorSQLite plugin failure: /data/user/0/rememberme/app.db SELECT secret";
		vi.spyOn(handle.journal, "listDates").mockRejectedValue(new Error(failure));

		renderArchive(handle, new Date("2026-08-10T12:00:00Z"));
		await screen.findByRole("alert");
		expect(screen.getByRole("alert").textContent).toMatch(/couldn't load this month's entries/i);
		expect(screen.getByRole("alert").textContent).toMatch(/please try again/i);
		expect(screen.getByRole("alert").textContent).not.toContain(failure);
		// No grid and no empty-month copy on a failed read.
		expect(screen.queryByText("No entries this month.")).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /August 2026/ })).not.toBeInTheDocument();
	});

	it("renders the empty-month copy when the visible month genuinely has no entries", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });

		renderArchive(handle, new Date("2026-08-10T12:00:00Z"));
		const copy = await screen.findByText("No entries this month.");
		expect(copy).toBeInTheDocument();
		// The grid still renders even though there are no entries.
		expect(screen.getByText("August 2026")).toBeInTheDocument();
	});

	it("leaves the outer Archive region not busy when the visible-month read fails (alert announced promptly)", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });
		const failure = "SQLITE_ERROR: listDates at /data/user/0/rememberme/app.db SELECT secret";
		vi.spyOn(handle.journal, "listDates").mockRejectedValue(new Error(failure));

		renderArchive(handle, new Date("2026-08-10T12:00:00Z"));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/couldn't load this month's entries/i);
		expect(alert.textContent).toMatch(/please try again/i);
		expect(alert.textContent).not.toContain(failure);
		// Fail-closed with no busy region left behind: an aria-busy ancestor
		// would defer the alert's announcement until busy cleared. The month
		// read's busy is owned by MonthGrid (which unmounts on failure); the
		// outer region's aria-busy covers only the settings tier.
		expect(screen.getByRole("region", { name: /archive/i })).not.toHaveAttribute("aria-busy");
	});

	it("sets aria-busy while the visible month list is loading and never claims empty", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });
		// A listDates call that never resolves keeps the month read in flight.
		vi.spyOn(handle.journal, "listDates").mockImplementation(() => new Promise<never>(() => {}));

		renderArchive(handle, new Date("2026-08-10T12:00:00Z"));
		await screen.findByText("August 2026");
		// The MONTH region is busy while its read is in flight (MonthGrid owns
		// month-read busy); the outer Archive region is NOT — outer aria-busy
		// covers only the settings tier. The grid stays mounted (no false
		// empty-month claim, no false entry markers).
		await vi.waitFor(() =>
			expect(screen.getByRole("region", { name: "August 2026" })).toHaveAttribute(
				"aria-busy",
				"true",
			),
		);
		expect(screen.getByRole("region", { name: /archive/i })).not.toHaveAttribute("aria-busy");
		expect(screen.queryByText("No entries this month.")).not.toBeInTheDocument();
		// Navigation stays available while loading (rapid nav is real).
		expect(screen.getByRole("button", { name: /previous month/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /next month/i })).toBeInTheDocument();
	});
});

describe("Archive: ready-month pending listDates renders a distinct loading grid", () => {
	it("keeps nav usable but shows no day links/markers/sr-only/empty copy, with role=status and region aria-busy", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });
		// A listDates call that never resolves keeps the visible-month read in flight.
		vi.spyOn(handle.journal, "listDates").mockImplementation(() => new Promise<never>(() => {}));

		renderArchive(handle, new Date("2026-08-10T12:00:00Z"));
		await screen.findByText("August 2026");

		// The MONTH region reports busy while its visible-month read is pending;
		// the outer Archive region is not (month-read busy is owned by MonthGrid).
		await vi.waitFor(() =>
			expect(screen.getByRole("region", { name: "August 2026" })).toHaveAttribute(
				"aria-busy",
				"true",
			),
		);
		expect(screen.getByRole("region", { name: /archive/i })).not.toHaveAttribute("aria-busy");
		// An accessible loading announcement is present.
		expect(screen.getByRole("status").textContent).toMatch(/loading your journal/i);

		// No per-day journal links, no entry/today markers, no sr-only text, and no
		// empty-month copy while loading — we never claim an entry exists or is absent.
		expect(screen.queryAllByRole("link")).toHaveLength(0);
		expect(screen.queryByRole("link", { name: /August \d, 2026/ })).not.toBeInTheDocument();
		expect(document.querySelector("[data-has-entry]")).toBeNull();
		expect(document.querySelector("[data-today]")).toBeNull();
		expect(screen.queryByText(/no entry/i)).not.toBeInTheDocument();
		expect(screen.queryByText("No entries this month.")).not.toBeInTheDocument();

		// Navigation stays usable for rapid nav even while the read never settles:
		// clicking Next switches the visible month to the next loading month.
		fireEvent.click(screen.getByRole("button", { name: /next month/i }));
		expect(await screen.findByText("September 2026")).toBeInTheDocument();
		// The new loading month also has no day links.
		expect(screen.queryAllByRole("link")).toHaveLength(0);
	});

	it("exposes no stale day-marker/link semantics when navigating into a still-pending month", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });
		await handle.journal.upsert("2026-08-03", "entry in august");

		// The visible August read resolves with a marker; the next (September)
		// read never settles, so September stays pending while we arrive.
		const calls = vi.spyOn(handle.journal, "listDates");
		calls
			.mockResolvedValueOnce(["2026-08-03"])
			.mockImplementationOnce(() => new Promise<never>(() => {}));

		renderArchive(handle, new Date("2026-08-10T12:00:00Z"));
		const aug3 = await screen.findByRole("link", { name: "Monday, August 3, 2026" });
		expect(aug3).toHaveAttribute("data-has-entry", "true");

		// Navigate into the pending September month: the visible commit must
		// expose loading placeholders, never August's resolved marker set
		// re-rendered against September's dates (false "No entry"/links).
		fireEvent.click(screen.getByRole("button", { name: /next month/i }));
		expect(await screen.findByText("September 2026")).toBeInTheDocument();
		expect(screen.queryAllByRole("link")).toHaveLength(0);
		expect(document.querySelector("[data-has-entry]")).toBeNull();
		expect(document.querySelector("[data-today]")).toBeNull();
		expect(screen.queryByText(/no entry/i)).not.toBeInTheDocument();
		expect(screen.queryByText("No entries this month.")).not.toBeInTheDocument();
	});
});

describe("Archive: rapid navigation cannot let a stale previous-month response win", () => {
	it("deferred OLD SUCCESS cannot overwrite the current month's markers", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });
		await handle.journal.upsert("2026-08-03", "entry in august");

		// August load #1 resolves; the July load (the "old" month we leave) is
		// deferred so it can arrive AFTER we navigate back to August; the second
		// August load resolves with a fuller marker set.
		const calls = vi.spyOn(handle.journal, "listDates");
		const staleJuly = deferred<string[]>();
		calls
			.mockResolvedValueOnce(["2026-08-03"])
			.mockImplementationOnce(() => staleJuly.promise)
			.mockResolvedValueOnce(["2026-08-03", "2026-08-14"]);

		renderArchive(handle, new Date("2026-08-10T12:00:00Z"));
		await screen.findByRole("link", { name: "Monday, August 3, 2026" });

		// Rapid: navigate to July (deferred), then immediately back to August
		// (resolves) — the current visible month is August with its two markers.
		fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
		fireEvent.click(screen.getByRole("button", { name: /next month/i }));
		const aug14 = await screen.findByRole("link", { name: "Friday, August 14, 2026" });
		expect(aug14).toHaveAttribute("data-has-entry", "true");
		expect(screen.getByText("August 2026")).toBeInTheDocument();

		// NOW the stale July load resolves late with its own markers. It must not
		// overwrite the currently-visible August month.
		staleJuly.resolve(["2026-07-05"]);
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.getByText("August 2026")).toBeInTheDocument();
		expect(screen.queryByText("July 2026")).not.toBeInTheDocument();
		// August 14 keeps its entry marker; July 5 never appears.
		expect(screen.getByRole("link", { name: "Friday, August 14, 2026" })).toHaveAttribute(
			"data-has-entry",
			"true",
		);
		expect(screen.queryByRole("link", { name: "Sunday, July 5, 2026" })).not.toBeInTheDocument();
	});

	it("deferred OLD FAILURE cannot clear the current month's markers or status", async () => {
		const handle = await createTestHandle();
		await handle.settings.update({ timezone: "UTC" });
		await handle.journal.upsert("2026-08-03", "entry in august");

		// August load #1 resolves; the July load is deferred so it can reject
		// AFTER we navigate back to August; the second August load resolves.
		const calls = vi.spyOn(handle.journal, "listDates");
		const staleJuly = deferred<string[]>();
		calls
			.mockResolvedValueOnce(["2026-08-03"])
			.mockImplementationOnce(() => staleJuly.promise)
			.mockResolvedValueOnce(["2026-08-03", "2026-08-14"]);

		renderArchive(handle, new Date("2026-08-10T12:00:00Z"));
		await screen.findByRole("link", { name: "Monday, August 3, 2026" });

		// Rapid: navigate to July (deferred), then immediately back to August
		// (resolves) — the current visible month is August.
		fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
		fireEvent.click(screen.getByRole("button", { name: /next month/i }));
		await screen.findByRole("link", { name: "Friday, August 14, 2026" });
		expect(screen.getByText("August 2026")).toBeInTheDocument();

		// NOW the stale July load FAILS. It must not clear August's markers or
		// replace its grid with an alert.
		staleJuly.reject(new Error("stale failure"));
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.getByText("August 2026")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Friday, August 14, 2026" })).toHaveAttribute(
			"data-has-entry",
			"true",
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
