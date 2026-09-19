import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JournalView from "@/components/journal/JournalView";
import type { DatabaseHandle } from "@/db/bootstrap";
import type { JournalEntry } from "@/db/journal";
import { StorageProvider } from "@/db/storage";
import { createTestHandle } from "@/db/test-helper";

async function settle() {
	for (let i = 0; i < 15; i += 1) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

/** A promise the test opens/fails by hand, to hold a marker load genuinely in flight. */
function makeGate(): {
	promise: Promise<void>;
	open: () => void;
	fail: (reason?: unknown) => void;
} {
	let open!: () => void;
	let fail!: (reason?: unknown) => void;
	const promise = new Promise<void>((resolve, reject) => {
		open = resolve;
		fail = reject;
	});
	return { promise, open, fail };
}

async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
	await settle();
}

function renderView(handle: DatabaseHandle | null, date: string) {
	return render(
		<MemoryRouter initialEntries={[`/journal/${date}`]}>
			<StorageProvider database={handle}>
				<JournalView date={date} />
			</StorageProvider>
		</MemoryRouter>,
	);
}

interface PaintSnapshot {
	value: string | null;
	status: string | null;
}

function PaintProbe({ onPaint }: { onPaint: () => void }) {
	useLayoutEffect(() => {
		onPaint();
	});
	return null;
}

function capturePaint(): PaintSnapshot {
	const textarea = document.querySelector<HTMLTextAreaElement>(
		"textarea[aria-label^='Journal entry']",
	);
	return {
		value: textarea?.value ?? null,
		status: document.querySelector('[role="status"]')?.textContent ?? null,
	};
}

function renderProbedView(handle: DatabaseHandle, date: string, onPaint: () => void) {
	return render(
		<MemoryRouter initialEntries={[`/journal/${date}`]}>
			<StorageProvider database={handle}>
				<JournalView date={date} />
				<PaintProbe onPaint={onPaint} />
			</StorageProvider>
		</MemoryRouter>,
	);
}

function weekdayLink(label: string) {
	return screen.getByRole("link", { name: label });
}

function expectNeutralWeekMarkers() {
	for (const name of [
		"Monday, August 10",
		"Tuesday, August 11",
		"Wednesday, August 12",
		"Thursday, August 13",
		"Friday, August 14",
		"Saturday, August 15",
		"Sunday, August 16",
	]) {
		const link = weekdayLink(name);
		expect(link).not.toHaveAttribute("data-has-entry");
		expect(link).not.toHaveAttribute("aria-describedby");
		expect(link.textContent).not.toMatch(/Entry saved|No entry/);
	}
}

// 2026-08-10 is the Monday of the 2026-08-10..2026-08-16 week.
const MONDAY = "Monday, August 10";
const WEDNESDAY = "Wednesday, August 12";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("JournalView: week markers", () => {
	it("keeps markers neutral while the initial listDates request is deferred", async () => {
		const handle = await createTestHandle();
		const markerLoad = makeGate();
		const realList = handle.journal.listDates.bind(handle.journal);
		vi.spyOn(handle.journal, "listDates").mockImplementation(async (from?: string, to?: string) => {
			await markerLoad.promise;
			return realList(from, to);
		});

		renderView(handle, "2026-08-12");
		expectNeutralWeekMarkers();

		await act(async () => {
			markerLoad.open();
		});
		await settle();
	});

	it("keeps markers neutral when the current week's listDates rejects", async () => {
		const handle = await createTestHandle();
		vi.spyOn(handle.journal, "listDates").mockRejectedValue(
			new Error("native SQL path detail must stay hidden"),
		);

		renderView(handle, "2026-08-12");
		await settle();
		expectNeutralWeekMarkers();
	});

	it("invalidates the previous week's markers immediately on a deferred cross-week rerender", async () => {
		const handle = await createTestHandle();
		await handle.journal.upsert("2026-08-10", "week-a");
		const markerLoad = makeGate();
		const realList = handle.journal.listDates.bind(handle.journal);
		vi.spyOn(handle.journal, "listDates").mockImplementation(async (from?: string, to?: string) => {
			if (from === "2026-08-17") {
				await markerLoad.promise;
				return ["2026-08-19"];
			}
			return realList(from, to);
		});

		const { rerender } = renderView(handle, "2026-08-12");
		await settle();
		expect(weekdayLink(MONDAY)).toHaveAttribute("data-has-entry", "true");

		rerender(
			<MemoryRouter initialEntries={["/journal/2026-08-19"]}>
				<StorageProvider database={handle}>
					<JournalView date="2026-08-19" />
				</StorageProvider>
			</MemoryRouter>,
		);

		for (const name of [
			"Monday, August 17",
			"Tuesday, August 18",
			"Wednesday, August 19",
			"Thursday, August 20",
			"Friday, August 21",
			"Saturday, August 22",
			"Sunday, August 23",
		]) {
			const link = screen.getByRole("link", { name });
			expect(link).not.toHaveAttribute("data-has-entry");
			expect(link).not.toHaveAttribute("aria-describedby");
			expect(link.textContent).not.toMatch(/Entry saved|No entry/);
		}

		await act(async () => {
			markerLoad.open();
		});
		await settle();
		expect(screen.getByRole("link", { name: "Wednesday, August 19" })).toHaveAttribute(
			"data-has-entry",
			"true",
		);
	});

	it("shows week markers from stored entries and refreshes after a saved edit", async () => {
		const handle = await createTestHandle();
		await handle.journal.upsert("2026-08-10", "seed");

		renderView(handle, "2026-08-12");
		// Markers load asynchronously from storage.journal.listDates.
		await act(async () => {});
		await settle();
		expect(weekdayLink(MONDAY)).toHaveAttribute("data-has-entry", "true");
		expect(weekdayLink(WEDNESDAY)).toHaveAttribute("data-has-entry", "false");

		// Edit the open date's editor; after the debounced save the marker set
		// refreshes through listDates and now includes the edited date.
		const editor = screen.getByLabelText("Journal entry for 2026-08-12") as HTMLTextAreaElement;
		fireEvent.change(editor, { target: { value: "x" } });
		await advance(800);
		expect(weekdayLink(WEDNESDAY)).toHaveAttribute("data-has-entry", "true");
		expect(weekdayLink(MONDAY)).toHaveAttribute("data-has-entry", "true");
		expect((await handle.journal.get("2026-08-12"))?.content).toBe("x");
	});

	it("deleting an entry removes its week marker", async () => {
		const handle = await createTestHandle();
		await handle.journal.upsert("2026-08-12", "y");

		renderView(handle, "2026-08-12");
		await act(async () => {});
		await settle();
		expect(weekdayLink(WEDNESDAY)).toHaveAttribute("data-has-entry", "true");

		const editor = screen.getByLabelText("Journal entry for 2026-08-12") as HTMLTextAreaElement;
		fireEvent.change(editor, { target: { value: "" } });
		await advance(800);
		expect(weekdayLink(WEDNESDAY)).toHaveAttribute("data-has-entry", "false");
		expect(await handle.journal.get("2026-08-12")).toBeNull();
	});
});

describe("JournalView: fail closed without storage", () => {
	it("shows the fail-closed message when storage is absent", () => {
		renderView(null, "2026-08-12");
		expect(screen.getByText(/editing requires the on-device database/i)).toBeInTheDocument();
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});
});

describe("JournalView: date-keyed workspace", () => {
	it("does not paint the old date's editor before a deferred new-date read resolves", async () => {
		const handle = await createTestHandle();
		await handle.journal.upsert("2026-08-10", "distinctive-date-a");
		await handle.journal.upsert("2026-08-11", "distinctive-date-b");
		const oldDate = "2026-08-10";
		const newDate = "2026-08-11";
		const realGet = handle.journal.get.bind(handle.journal);
		let releaseNewDate!: (entry: JournalEntry | null) => void;
		const deferredNewDate = new Promise<JournalEntry | null>((resolve) => {
			releaseNewDate = resolve;
		});
		vi.spyOn(handle.journal, "get").mockImplementation(async (date: string) =>
			date === newDate ? deferredNewDate : realGet(date),
		);
		const paints: PaintSnapshot[] = [];

		const view = renderProbedView(handle, oldDate, () => paints.push(capturePaint()));
		await settle();
		expect(screen.getByDisplayValue("distinctive-date-a")).toBeInTheDocument();
		const paintsBeforeDateChange = paints.length;

		view.rerender(
			<MemoryRouter initialEntries={[`/journal/${newDate}`]}>
				<StorageProvider database={handle}>
					<JournalView date={newDate} />
					<PaintProbe onPaint={() => paints.push(capturePaint())} />
				</StorageProvider>
			</MemoryRouter>,
		);

		expect(screen.getByRole("status").textContent).toMatch(/loading/i);
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		expect(screen.queryByDisplayValue("distinctive-date-a")).not.toBeInTheDocument();
		expect(paints.slice(paintsBeforeDateChange)).not.toContainEqual({
			value: "distinctive-date-a",
			status: "Saved",
		});

		await act(async () => {
			releaseNewDate(await realGet(newDate));
		});
		await settle();
		expect(screen.getByDisplayValue("distinctive-date-b")).toBeInTheDocument();
	});

	it("switching dates remounts a fresh workspace (keyed) and loads that date's entry", async () => {
		const handle = await createTestHandle();
		await handle.journal.upsert("2026-08-10", "content-a");
		await handle.journal.upsert("2026-08-11", "content-b");

		const { rerender } = renderView(handle, "2026-08-10");
		await act(async () => {});
		await settle();
		expect(
			(screen.getByLabelText("Journal entry for 2026-08-10") as HTMLTextAreaElement).value,
		).toBe("content-a");

		rerender(
			<MemoryRouter initialEntries={["/journal/2026-08-11"]}>
				<StorageProvider database={handle}>
					<JournalView date="2026-08-11" />
				</StorageProvider>
			</MemoryRouter>,
		);
		await act(async () => {});
		await settle();
		const editor = screen.getByLabelText("Journal entry for 2026-08-11") as HTMLTextAreaElement;
		expect(editor.value).toBe("content-b");
	});

	it("an old date's in-flight load cannot overwrite the new date's editor", async () => {
		const handle = await createTestHandle();
		await handle.journal.upsert("2026-08-10", "real-a");
		await handle.journal.upsert("2026-08-11", "real-b");

		let resolveOld!: (row: {
			date: string;
			content: string;
			createdAt: string;
			updatedAt: string;
		}) => void;
		const oldGate = new Promise<{
			date: string;
			content: string;
			createdAt: string;
			updatedAt: string;
		}>((resolve) => {
			resolveOld = resolve;
		});
		// Slow the OLD date's get(); the new date's load resolves normally.
		const realGet = handle.journal.get.bind(handle.journal);
		vi.spyOn(handle.journal, "get").mockImplementation(async (date: string) => {
			if (date === "2026-08-10") return oldGate;
			return realGet(date);
		});

		const { rerender } = renderView(handle, "2026-08-10");
		// Switch to 2026-08-11 while 2026-08-10's load is still in flight.
		rerender(
			<MemoryRouter initialEntries={["/journal/2026-08-11"]}>
				<StorageProvider database={handle}>
					<JournalView date="2026-08-11" />
				</StorageProvider>
			</MemoryRouter>,
		);
		await act(async () => {});
		await settle();
		const editor = screen.getByLabelText("Journal entry for 2026-08-11") as HTMLTextAreaElement;
		expect(editor.value).toBe("real-b");

		// Resolve the stale load late; it must not overwrite the new editor.
		await act(async () => {
			resolveOld({
				date: "2026-08-10",
				content: "stale-a",
				createdAt: "2026-08-10T00:00:00.000Z",
				updatedAt: "2026-08-10T00:00:00.000Z",
			});
		});
		await settle();
		expect(
			(screen.getByLabelText("Journal entry for 2026-08-11") as HTMLTextAreaElement).value,
		).toBe("real-b");
	});

	it("does not paint or write A's same-date entry while storage handle B is deferred", async () => {
		const date = "2026-08-12";
		const handleA = await createTestHandle();
		const handleB = await createTestHandle();
		await handleA.journal.upsert(date, "distinctive-handle-a");
		await handleB.journal.upsert(date, "distinctive-handle-b");
		const realBGet = handleB.journal.get.bind(handleB.journal);
		const expectedB = await realBGet(date);
		let releaseB!: (entry: JournalEntry | null) => void;
		const deferredB = new Promise<JournalEntry | null>((resolve) => {
			releaseB = resolve;
		});
		vi.spyOn(handleB.journal, "get").mockReturnValue(deferredB);
		const bUpsert = vi.spyOn(handleB.journal, "upsert");
		const paints: PaintSnapshot[] = [];
		let database: DatabaseHandle = handleA;
		const view = renderProbedView(handleA, date, () => {
			const paint = capturePaint();
			paints.push(paint);
			if (database === handleB && paint.value === "distinctive-handle-a") {
				const textarea = document.querySelector<HTMLTextAreaElement>(
					"textarea[aria-label^='Journal entry']",
				);
				if (textarea) {
					fireEvent.change(textarea, { target: { value: "distinctive-handle-a-edited" } });
				}
			}
		});
		await settle();
		expect(screen.getByDisplayValue("distinctive-handle-a")).toBeInTheDocument();
		const paintsBeforeRebind = paints.length;

		database = handleB;
		view.rerender(
			<MemoryRouter initialEntries={[`/journal/${date}`]}>
				<StorageProvider database={database}>
					<JournalView date={date} />
					<PaintProbe
						onPaint={() => {
							const paint = capturePaint();
							paints.push(paint);
							if (paint.value === "distinctive-handle-a") {
								const textarea = document.querySelector<HTMLTextAreaElement>(
									"textarea[aria-label^='Journal entry']",
								);
								if (textarea) {
									fireEvent.change(textarea, {
										target: { value: "distinctive-handle-a-edited" },
									});
								}
							}
						}}
					/>
				</StorageProvider>
			</MemoryRouter>,
		);

		expect(screen.getByRole("status").textContent).toMatch(/loading/i);
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		expect(screen.queryByDisplayValue("distinctive-handle-a")).not.toBeInTheDocument();
		expect(paints.slice(paintsBeforeRebind)).not.toContainEqual({
			value: "distinctive-handle-a",
			status: "Saved",
		});
		await advance(800);
		expect(bUpsert).not.toHaveBeenCalled();
		expect(await realBGet(date)).toMatchObject({ content: "distinctive-handle-b" });

		await act(async () => {
			releaseB(expectedB);
		});
		await settle();
		expect(screen.getByDisplayValue("distinctive-handle-b")).toBeInTheDocument();
		view.unmount();
	});
});

describe("JournalView: cross-week stale marker loads", () => {
	it("a stale previous-week marker load resolving after a week change never overwrites the visible week's markers", async () => {
		const handle = await createTestHandle();
		await handle.journal.upsert("2026-08-10", "a"); // week A marker
		await handle.journal.upsert("2026-08-19", "b"); // week B marker
		const realList = handle.journal.listDates.bind(handle.journal);
		const staleA = makeGate();
		// Week A's marker response is held in flight; later weeks load normally.
		vi.spyOn(handle.journal, "listDates").mockImplementation(async (from?: string, to?: string) => {
			if (from === "2026-08-10") {
				await staleA.promise;
				return ["2026-08-10"]; // week A's own marker set
			}
			return realList(from, to);
		});

		const { rerender } = renderView(handle, "2026-08-10");
		await act(async () => {});
		await settle();

		// Move to a DIFFERENT week while week A's marker load is still in flight.
		rerender(
			<MemoryRouter initialEntries={["/journal/2026-08-19"]}>
				<StorageProvider database={handle}>
					<JournalView date="2026-08-19" />
				</StorageProvider>
			</MemoryRouter>,
		);
		await act(async () => {});
		await settle();
		// Week B loaded its own entry AND its own markers.
		const editorB = screen.getByLabelText("Journal entry for 2026-08-19") as HTMLTextAreaElement;
		expect(editorB.value).toBe("b");
		expect(weekdayLink("Wednesday, August 19")).toHaveAttribute("data-has-entry", "true");

		// A's stale response resolves AFTER week B is visible — it must never
		// replace B's marker set (which would drop B's marker).
		await act(async () => {
			staleA.open();
		});
		await settle();
		expect(weekdayLink("Wednesday, August 19")).toHaveAttribute("data-has-entry", "true");
		expect(weekdayLink("Monday, August 17")).toHaveAttribute("data-has-entry", "false");
		expect(weekdayLink("Sunday, August 23")).toHaveAttribute("data-has-entry", "false");
		expect(
			(screen.getByLabelText("Journal entry for 2026-08-19") as HTMLTextAreaElement).value,
		).toBe("b");
	});

	it("a stale previous-week marker load failing after a week change can never clear the visible week's markers", async () => {
		const handle = await createTestHandle();
		await handle.journal.upsert("2026-08-19", "b"); // week B marker
		const realList = handle.journal.listDates.bind(handle.journal);
		const staleA = makeGate();
		vi.spyOn(handle.journal, "listDates").mockImplementation(async (from?: string, to?: string) => {
			if (from === "2026-08-10") {
				await staleA.promise;
				throw new Error("db busy");
			}
			return realList(from, to);
		});

		const { rerender } = renderView(handle, "2026-08-10");
		await act(async () => {});
		await settle();
		rerender(
			<MemoryRouter initialEntries={["/journal/2026-08-19"]}>
				<StorageProvider database={handle}>
					<JournalView date="2026-08-19" />
				</StorageProvider>
			</MemoryRouter>,
		);
		await act(async () => {});
		await settle();
		expect(weekdayLink("Wednesday, August 19")).toHaveAttribute("data-has-entry", "true");
		// Week A's stale FAILURE must not clear week B's marker set.
		await act(async () => {
			staleA.fail(new Error("db busy"));
		});
		await settle();
		expect(weekdayLink("Wednesday, August 19")).toHaveAttribute("data-has-entry", "true");
		expect(weekdayLink("Monday, August 17")).toHaveAttribute("data-has-entry", "false");
	});
});

describe("JournalView: unmount flush and marker refresh", () => {
	it("a successful same-week unmount flush refreshes the flushed date's marker", async () => {
		const handle = await createTestHandle();
		const { rerender } = renderView(handle, "2026-08-10");
		await act(async () => {});
		await settle();
		const monday = screen.getByLabelText("Journal entry for 2026-08-10") as HTMLTextAreaElement;
		fireEvent.change(monday, { target: { value: "x" } });
		expect(weekdayLink(MONDAY)).toHaveAttribute("data-has-entry", "false");
		// Switch to another day in the SAME week before the debounce elapses:
		// the dirty editor unmounts and flushes 2026-08-10.
		rerender(
			<MemoryRouter initialEntries={["/journal/2026-08-11"]}>
				<StorageProvider database={handle}>
					<JournalView date="2026-08-11" />
				</StorageProvider>
			</MemoryRouter>,
		);
		await act(async () => {});
		await settle();
		expect(await handle.journal.get("2026-08-10")).toMatchObject({ content: "x" });
		// The flush landed 2026-08-10 and its parent refresh re-lit the marker.
		expect(weekdayLink(MONDAY)).toHaveAttribute("data-has-entry", "true");
	});
});

describe("JournalView: fail-closed entry load", () => {
	it("shows an accessible loading status while the entry read is pending", async () => {
		const handle = await createTestHandle();
		// The entry read never settles: the view must stay in its accessible
		// loading state (role=status), never a bare paragraph or an editor.
		vi.spyOn(handle.journal, "get").mockImplementation(() => new Promise<never>(() => {}));
		renderView(handle, "2026-08-12");
		expect(screen.getByRole("status").textContent).toMatch(/loading/i);
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		await settle();
		expect(screen.getByRole("status").textContent).toMatch(/loading/i);
	});

	it("a journal.get rejection fails closed with an accessible alert and no editor", async () => {
		const handle = await createTestHandle();
		const failure =
			"CapacitorSQLite plugin failure at /data/user/0/rememberme/app.db: SELECT secret";
		vi.spyOn(handle.journal, "get").mockRejectedValue(new Error(failure));
		renderView(handle, "2026-08-12");
		await act(async () => {});
		await settle();
		// Fail closed: an accessible alert with the retained reason, and NO
		// textarea (typing must not overwrite an entry the view failed to read).
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toMatch(/couldn't load this entry/i);
		expect(alert.textContent).toMatch(/please try again/i);
		expect(alert.textContent).not.toContain(failure);
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});
});

describe("JournalView: week strip navigation", () => {
	it("renders the week strip with prev/next navigation for the given date", async () => {
		const handle = await createTestHandle();
		renderView(handle, "2026-08-12");
		await act(async () => {});
		await settle();
		expect(weekdayLink(MONDAY)).toHaveAttribute("href", "/journal/2026-08-10");
		expect(weekdayLink("Sunday, August 16")).toHaveAttribute("href", "/journal/2026-08-16");
		expect(screen.getByRole("link", { name: "Previous week" })).toHaveAttribute(
			"href",
			"/journal/2026-08-03",
		);
		expect(screen.getByRole("link", { name: "Next week" })).toHaveAttribute(
			"href",
			"/journal/2026-08-17",
		);
	});
});
