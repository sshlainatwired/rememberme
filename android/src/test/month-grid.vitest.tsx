import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import MonthGrid from "@/components/archive/MonthGrid";

function renderGrid(
	props: Partial<Parameters<typeof MonthGrid>[0]> & { initialPath?: string } = {},
) {
	const { initialPath = "/archive", ...rest } = props;
	return render(
		<MemoryRouter initialEntries={[initialPath]}>
			<MonthGrid year={2026} month={8} {...rest} />
		</MemoryRouter>,
	);
}

// August 2026: Aug 1 is a Saturday; the month has 31 days.
const AUG_1_LABEL = "Saturday, August 1, 2026";
const AUG_31_LABEL = "Monday, August 31, 2026";

describe("MonthGrid: header and day links", () => {
	it("renders a 7-weekday header row with abbreviations", () => {
		renderGrid();
		const abbrs = document.querySelectorAll(".month-weekday-header abbr");
		expect(abbrs).toHaveLength(7);
	});

	it("links every day to /journal/:date with a full aria-label including the year", () => {
		renderGrid();
		expect(screen.getByRole("link", { name: AUG_1_LABEL })).toHaveAttribute(
			"href",
			"/journal/2026-08-01",
		);
		expect(screen.getByRole("link", { name: AUG_31_LABEL })).toHaveAttribute(
			"href",
			"/journal/2026-08-31",
		);
	});
});

describe("MonthGrid: entry markers", () => {
	it("marks entry dates with data-has-entry and shows sr-only entry text", () => {
		renderGrid({ entryDates: new Set(["2026-08-03", "2026-08-14"]) });
		const aug3 = screen.getByRole("link", { name: "Monday, August 3, 2026" });
		const aug14 = screen.getByRole("link", { name: "Friday, August 14, 2026" });
		const aug7 = screen.getByRole("link", { name: "Friday, August 7, 2026" });
		expect(aug3).toHaveAttribute("data-has-entry", "true");
		expect(aug14).toHaveAttribute("data-has-entry", "true");
		expect(aug7).toHaveAttribute("data-has-entry", "false");
		expect(aug3.querySelector(".sr-only")?.textContent).toContain("Entry saved");
		expect(aug14.querySelector(".sr-only")?.textContent).toContain("Entry saved");
		expect(aug7.querySelector(".sr-only")?.textContent).toContain("No entry");
	});
});

describe("MonthGrid: current-day marker", () => {
	it("marks the day equal to the page's today with data-today", () => {
		renderGrid({ today: "2026-08-14" });
		expect(screen.getByRole("link", { name: "Friday, August 14, 2026" })).toHaveAttribute(
			"data-today",
			"true",
		);
		expect(screen.getByRole("link", { name: AUG_1_LABEL })).toHaveAttribute("data-today", "false");
	});
});

describe("MonthGrid: newest-first navigation with boundary clamping", () => {
	it("puts the newer month on the top nav and the earlier month on the bottom nav", () => {
		const onPrev = vi.fn();
		const onNext = vi.fn();
		renderGrid({ onPrevious: onPrev, onNext });
		fireEvent.click(screen.getByRole("button", { name: /next month/i }));
		expect(onNext).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
		expect(onPrev).toHaveBeenCalledTimes(1);
	});

	it("disables next-month navigation at 9999-12 and previous at 0000-01 (buttons, never links)", () => {
		const { rerender } = renderGrid({ year: 9999, month: 12 });
		expect(screen.getByRole("button", { name: /next month/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /previous month/i })).not.toBeDisabled();

		rerender(
			<MemoryRouter initialEntries={["/archive"]}>
				<MonthGrid year={0} month={1} />
			</MemoryRouter>,
		);
		expect(screen.getByRole("button", { name: /next month/i })).not.toBeDisabled();
		expect(screen.getByRole("button", { name: /previous month/i })).toBeDisabled();
		expect(screen.queryByRole("link", { name: /next month/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /previous month/i })).not.toBeInTheDocument();
	});
});

describe("MonthGrid: deterministic 6-week layout", () => {
	it("renders exactly 42 day cells (6 weeks x 7) plus 7 weekday headers", () => {
		renderGrid();
		// August 2026 has 5 leading blanks + 31 days + 6 trailing blanks = 42
		const blankCells = document.querySelectorAll("[data-blank='true']");
		expect(blankCells).toHaveLength(11);
		expect(screen.getAllByRole("link")).toHaveLength(31);
	});
});

describe("MonthGrid: nullable entryDates loading mode", () => {
	it("explicit entryDates null renders a loading placeholder body (no day links, no markers)", () => {
		renderGrid({ entryDates: null, today: "2026-08-14" });
		// Month heading and navigation remain available.
		expect(screen.getByText("August 2026")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /next month/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /previous month/i })).toBeInTheDocument();

		// No per-day journal links at all.
		expect(screen.queryAllByRole("link")).toHaveLength(0);
		expect(screen.queryByRole("link", { name: /August \d, 2026/ })).not.toBeInTheDocument();
		// No per-day entry/today status semantics.
		expect(document.querySelector("[data-has-entry]")).toBeNull();
		expect(document.querySelector("[data-today]")).toBeNull();
		// No sr-only entry text (neither "Entry saved" nor "No entry").
		expect(screen.queryByText(/no entry/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/entry saved/i)).not.toBeInTheDocument();

		// The deterministic 42-slot body is still rendered (7 headers + 42 cells).
		const blankCells = document.querySelectorAll("[data-blank='true']");
		expect(blankCells).toHaveLength(11);

		// An accessible loading announcement and an aria-busy region.
		expect(screen.getByRole("status").textContent).toMatch(/loading your journal/i);
		expect(screen.getByRole("region", { name: "August 2026" })).toHaveAttribute(
			"aria-busy",
			"true",
		);
	});

	it("loading role=status has no aria-busy ancestor (announcement not deferred)", () => {
		renderGrid({ entryDates: null });
		// The named month region stays busy (its content is still being replaced
		// by the settled read)…
		expect(screen.getByRole("region", { name: "August 2026" })).toHaveAttribute(
			"aria-busy",
			"true",
		);
		// …but the polite loading announcement must sit OUTSIDE any busy
		// ancestor. An aria-busy ancestor defers a live region's reading until
		// busy clears, so a nested role=status "Loading…" would never be spoken
		// while the month read is in flight.
		const status = screen.getByRole("status");
		expect(status.textContent).toMatch(/loading your journal/i);
		expect(status.closest("[aria-busy='true']")).toBeNull();
	});

	it("omitted entryDates keeps normal linked empty semantics (backcompat NO_ENTRIES)", () => {
		renderGrid({ today: "2026-08-14" });
		// Normal empty month: every day is a link with explicit false markers.
		expect(screen.getAllByRole("link")).toHaveLength(31);
		expect(screen.getByRole("link", { name: AUG_1_LABEL })).toHaveAttribute(
			"data-has-entry",
			"false",
		);
		expect(screen.getByRole("link", { name: AUG_1_LABEL })).toHaveAttribute("data-today", "false");
		// The today day is still marked, and sr-only "No entry" is present.
		expect(screen.getByRole("link", { name: "Friday, August 14, 2026" })).toHaveAttribute(
			"data-today",
			"true",
		);
		expect(
			screen.getByRole("link", { name: AUG_1_LABEL }).querySelector(".sr-only")?.textContent,
		).toContain("No entry");
		// No loading announcement, not aria-busy.
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.getByRole("region", { name: "August 2026" })).not.toHaveAttribute("aria-busy");
	});
});
