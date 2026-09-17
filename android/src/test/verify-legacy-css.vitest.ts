import { describe, expect, it } from "vitest";
import {
	findForbiddenCssTokens,
	missingRequiredSelectors,
} from "../../scripts/verify-legacy-css.mjs";

const FORBIDDEN: ReadonlyArray<[sample: string, needle: string]> = [
	["@layer base { .a { color: #000; } }", "@layer"],
	["@property --x { syntax: '<length>'; }", "@property"],
	['@import "tailwindcss";', "@import"],
	[".a:where(.b) { color: #000; }", ":where("],
	[".a:is(.b, .c) { color: #000; }", ":is("],
	[".a:has(.b) { color: #000; }", ":has("],
	[".a:focus-visible { outline: 2px solid #000; }", ":focus-visible"],
	[".a { color: oklch(0.5 0 0); }", "oklch("],
	[".a { color: lab(50% 0 0); }", "lab("],
	[".a { color: color-mix(in srgb, red, blue); }", "color-mix("],
	[".a { margin-inline: 4px; }", "logical property"],
	[".a { padding-block: 4px; }", "logical property"],
	[".a { inline-size: 100%; }", "logical block/inline"],
	[".a { display: flex; gap: 4px; }", "gap property"],
	[".a { width: min(100%, 40px); }", "min()/max()/clamp()"],
	[".a { font-size: 1.2lh; }", "lh/rlh/ic/cap units"],
	[".a { translate: 2px 2px; }", "individual transform"],
	[".a { aspect-ratio: 1 / 1; }", "aspect-ratio"],
	[".a { text-underline-offset: 4px; }", "text-underline-offset"],
	["html { scroll-behavior: smooth; }", "scroll-behavior"],
	["& .child { color: #000; }", "CSS nesting"],
	[".a{color:red;&:hover{color:blue}}", "CSS nesting"],
	[".a { margin-inline-start: 4px; }", "logical property"],
	[".a { padding-block-end: 4px; }", "logical property"],
	[".a { inset-inline-end: 4px; }", "logical property"],
	[".a { border-block-start: 4px; }", "logical property"],
	[".a { color: lch(50% 20 30); }", "lch("],
];

describe("findForbiddenCssTokens", () => {
	it.each(FORBIDDEN)("denies %s", (sample, needle) => {
		const hits = findForbiddenCssTokens(sample);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.some((h) => h.includes(needle))).toBe(true);
	});

	it("accepts a clean Chrome-60-safe stylesheet", () => {
		const clean = [
			":root { --background: #ffffff; --foreground: #141414; }",
			".a { display: -webkit-box; display: flex; -webkit-box-pack: justify; justify-content: space-between; }",
			".a:hover, .a:focus { background-color: #f0f0f0; }",
			"@media (prefers-reduced-motion: reduce) { * { transition-duration: 0.01ms; } }",
		].join("\n");
		expect(findForbiddenCssTokens(clean)).toEqual([]);
	});

	it("still accepts transform: rotate(...)", () => {
		expect(findForbiddenCssTokens(".a { transform: rotate(45deg); }")).toEqual([]);
	});
});

describe("missingRequiredSelectors", () => {
	it("reports each missing semantic selector", () => {
		const missing = missingRequiredSelectors(".card { color: #000; }");
		for (const needle of [".editor", ".weekday-link", ".tab-bar", ".btn", ".sr-only"]) {
			expect(missing.some((m) => m.includes(needle))).toBe(true);
		}
		expect(missing.some((m) => m.includes("[data-theme"))).toBe(true);
		expect(missing.some((m) => m.includes(":focus"))).toBe(true);
	});

	it("reports nothing when every required selector is present", () => {
		const full = [
			".card, .btn { color: #000; }",
			".tab-bar, .weekday-link, .editor, .sr-only { color: #000; }",
			":focus { outline: 2px solid #000; }",
			'[data-theme="dark"] .card { background-color: #141414; }',
		].join("\n");
		expect(missingRequiredSelectors(full)).toEqual([]);
	});
});
