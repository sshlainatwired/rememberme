import { mondayOfWeek, weekDates } from "@rememberme/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import WeekStrip from "@/components/journal/WeekStrip";

function renderStrip(
	props: Partial<Parameters<typeof WeekStrip>[0]> & { initialPath?: string } = {},
) {
	const { initialPath = "/today", currentDate = "2026-08-10", ...rest } = props;
	return render(
		<MemoryRouter initialEntries={[initialPath]}>
			<WeekStrip currentDate={currentDate} {...rest} />
		</MemoryRouter>,
	);
}

const DAY_NAMES = [
	"Monday, August 10",
	"Tuesday, August 11",
	"Wednesday, August 12",
	"Thursday, August 13",
	"Friday, August 14",
	"Saturday, August 15",
	"Sunday, August 16",
];

describe("WeekStrip range and dates", () => {
	it("renders exactly seven day links, Monday through Sunday, of the current week, plus week nav", () => {
		renderStrip({ currentDate: "2026-08-10" });
		expect(screen.getAllByRole("link")).toHaveLength(9); // 7 days + prev/next week
		for (const name of DAY_NAMES) {
			expect(screen.getByRole("link", { name })).toBeInTheDocument();
		}
	});

	it("defaults to the week of the currentDate when weekStart is omitted", () => {
		renderStrip({ currentDate: "2026-08-12" }); // Wednesday
		expect(screen.getByRole("link", { name: "Monday, August 10" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Sunday, August 16" })).toBeInTheDocument();
		// matches the shared calendar helper's own week
		expect(weekDates(mondayOfWeek("2026-08-12"))).toHaveLength(7);
	});

	it("shows a readable week-range heading derived from the shared helper", () => {
		renderStrip({ currentDate: "2026-08-10" });
		expect(
			screen.getByRole("heading", { name: "August 10 — August 16, 2026" }),
		).toBeInTheDocument();
	});

	it("spans month boundaries in the range label", () => {
		renderStrip({ currentDate: "2026-08-02" }); // Sunday; week starts 2026-07-27
		expect(screen.getByRole("heading", { name: "July 27 — August 2, 2026" })).toBeInTheDocument();
	});
});

describe("WeekStrip current-day semantics", () => {
	it("marks exactly the currentDate cell with aria-current", () => {
		renderStrip({ currentDate: "2026-08-12" });
		const current = screen.getByRole("link", { name: "Wednesday, August 12" });
		expect(current).toHaveAttribute("aria-current", "date");
		expect(screen.getByRole("link", { name: "Monday, August 10" })).not.toHaveAttribute(
			"aria-current",
		);
	});

	it("keeps the current highlight when the strip shows an explicit weekStart", () => {
		renderStrip({ currentDate: "2026-08-12", weekStart: "2026-08-10" });
		expect(screen.getByRole("link", { name: "Wednesday, August 12" })).toHaveAttribute(
			"aria-current",
			"date",
		);
	});

	it("honors a custom link builder for day navigation", () => {
		renderStrip({
			currentDate: "2026-08-10",
			linkForDate: (date) => `/journal/${date}`,
		});
		expect(screen.getByRole("link", { name: "Wednesday, August 12" })).toHaveAttribute(
			"href",
			"/journal/2026-08-12",
		);
	});
});

describe("WeekStrip entry markers", () => {
	it("keeps explicit unknown entry dates neutral", () => {
		renderStrip({ currentDate: "2026-08-10", entryDates: null });
		for (const name of DAY_NAMES) {
			const link = screen.getByRole("link", { name });
			expect(link).not.toHaveAttribute("data-has-entry");
			expect(link).not.toHaveAttribute("aria-describedby");
			expect(link.textContent).not.toMatch(/Entry saved|No entry/);
		}
	});

	it("marks dates with entries and leaves empty days plain", () => {
		renderStrip({
			currentDate: "2026-08-10",
			entryDates: new Set(["2026-08-11", "2026-08-14"]),
		});
		const tue = screen.getByRole("link", { name: "Tuesday, August 11" });
		const thu = screen.getByRole("link", { name: "Thursday, August 13" });
		const fri = screen.getByRole("link", { name: "Friday, August 14" });
		expect(tue).toHaveAttribute("data-has-entry", "true");
		expect(fri).toHaveAttribute("data-has-entry", "true");
		expect(thu).toHaveAttribute("data-has-entry", "false");
		expect(tue.textContent).toContain("✓");
		expect(thu.textContent).toContain("—");
	});

	it("defaults to no entries (empty set) without pretending persistence", () => {
		renderStrip({ currentDate: "2026-08-10" });
		for (const name of DAY_NAMES) {
			expect(screen.getByRole("link", { name })).toHaveAttribute("data-has-entry", "false");
		}
	});

	it("exposes entry status as an accessible description without changing day names", () => {
		renderStrip({
			currentDate: "2026-08-10",
			entryDates: new Set(["2026-08-11", "2026-08-14"]),
		});
		const tue = screen.getByRole("link", { name: "Tuesday, August 11" });
		const thu = screen.getByRole("link", { name: "Thursday, August 13" });
		const fri = screen.getByRole("link", { name: "Friday, August 14" });
		expect(tue).toHaveAccessibleDescription("Entry saved");
		expect(fri).toHaveAccessibleDescription("Entry saved");
		expect(thu).toHaveAccessibleDescription("No entry");
		// accessible names stay exactly the long day labels
		expect(tue).toHaveAccessibleName("Tuesday, August 11");
		expect(thu).toHaveAccessibleName("Thursday, August 13");
		expect(fri).toHaveAccessibleName("Friday, August 14");
	});

	it("describes each day with a unique per-date aria-describedby id to sr-only text", () => {
		renderStrip({
			currentDate: "2026-08-10",
			entryDates: new Set(["2026-08-11"]),
		});
		const ids = DAY_NAMES.map((name) =>
			screen.getByRole("link", { name }).getAttribute("aria-describedby"),
		);
		expect(ids.every(Boolean)).toBe(true);
		expect(new Set(ids).size).toBe(7); // one unique id per date
		const tueId = ids[1] ?? "";
		const described = tueId
			.split(/\s+/)
			.map((id) => document.getElementById(id))
			.filter((el): el is HTMLElement => el !== null);
		expect(described).toHaveLength(1);
		expect(described[0]).toHaveClass("sr-only");
		expect(described[0]).toHaveTextContent("Entry saved");
		const monId = ids[0] ?? "";
		expect(document.getElementById(monId)).toHaveTextContent("No entry");
	});

	it("keeps the visible day markers (✓/—) as before", () => {
		renderStrip({
			currentDate: "2026-08-10",
			entryDates: new Set(["2026-08-11"]),
		});
		const tue = screen.getByRole("link", { name: "Tuesday, August 11" });
		const mon = screen.getByRole("link", { name: "Monday, August 10" });
		expect(tue.textContent).toContain("✓");
		expect(mon.textContent).toContain("—");
		// sr-only status text stays visually hidden
		expect(tue.querySelector(".sr-only")).toHaveClass("sr-only");
	});

	it("gives day cells the semantic weekday-link classes (44px/56px minima live in global.css)", () => {
		renderStrip({ currentDate: "2026-08-10" });
		for (const name of DAY_NAMES) {
			const link = screen.getByRole("link", { name });
			expect(link).toHaveClass("weekday-link");
		}
		// the open day carries the current class; the rest are idle
		expect(screen.getByRole("link", { name: "Monday, August 10" })).toHaveClass(
			"weekday-link-current",
		);
		expect(screen.getByRole("link", { name: "Tuesday, August 11" })).toHaveClass(
			"weekday-link-idle",
		);
	});
});

describe("WeekStrip navigation links", () => {
	it("builds prev/next week hrefs via the shared calendar helpers", () => {
		renderStrip({
			initialPath: "/",
			currentDate: "2026-08-10",
			linkForDate: (date) => `/journal/${date}`,
		});
		// 7 day links + the two week-navigation links
		expect(screen.getAllByRole("link")).toHaveLength(9);
		expect(screen.getByRole("link", { name: /previous week/i })).toHaveAttribute(
			"href",
			"/journal/2026-08-03",
		);
		expect(screen.getByRole("link", { name: /next week/i })).toHaveAttribute(
			"href",
			"/journal/2026-08-17",
		);
	});

	it("defaults day and week links to journal-date routes when no builder is given", () => {
		renderStrip({ currentDate: "2026-08-10" });
		expect(screen.getAllByRole("link")).toHaveLength(9);
		expect(screen.getByRole("link", { name: "Wednesday, August 12" })).toHaveAttribute(
			"href",
			"/journal/2026-08-12",
		);
		expect(screen.getByRole("link", { name: /previous week/i })).toHaveAttribute(
			"href",
			"/journal/2026-08-03",
		);
		expect(screen.getByRole("link", { name: /next week/i })).toHaveAttribute(
			"href",
			"/journal/2026-08-17",
		);
	});

	it("gives prev/next week links the semantic week-nav-link class (44px minima in CSS)", () => {
		renderStrip({ currentDate: "2026-08-10" });
		for (const name of [/previous week/i, /next week/i]) {
			expect(screen.getByRole("link", { name })).toHaveClass("week-nav-link");
		}
	});

	it("honors an explicit custom link builder over the default", () => {
		renderStrip({
			currentDate: "2026-08-10",
			linkForDate: (date) => `/today?date=${date}`,
		});
		expect(screen.getByRole("link", { name: "Wednesday, August 12" })).toHaveAttribute(
			"href",
			"/today?date=2026-08-12",
		);
		expect(screen.getByRole("link", { name: /previous week/i })).toHaveAttribute(
			"href",
			"/today?date=2026-08-03",
		);
	});
});

describe("WeekStrip responsive layout contract", () => {
	it("uses the semantic week-strip class for the full-bleed base strip within AppShell", () => {
		renderStrip({ currentDate: "2026-08-10" });
		// The full-bleed edge bleed (-16px margins on mobile, reset at the
		// 640px breakpoint, 4px/16px padding) lives in global.css `.week-strip`
		// so seven 44px cells fit at 320px; the build-time CSS gate verifies the
		// shipped stylesheet, not a string spelling in the component.
		const section = screen.getByRole("region", { name: "August 10 — August 16, 2026" });
		expect(section).toHaveClass("week-strip");
	});

	it("keeps the semantic week-grid/day classes (seven equal flex cells in CSS)", () => {
		renderStrip({ currentDate: "2026-08-10" });
		// The grid is a flex row of equal cells with no base gap in global.css
		// `.week-grid`/`.weekday-cell` (maximum cell width at 320px); the 44px/
		// 56px minima live in `.weekday-link`.
		const grid = screen.getByRole("list");
		expect(grid).toHaveClass("week-grid");
		for (const name of DAY_NAMES) {
			expect(screen.getByRole("link", { name })).toHaveClass("weekday-link");
		}
	});
});
