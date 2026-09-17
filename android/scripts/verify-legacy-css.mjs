#!/usr/bin/env node
/**
 * Legacy CSS contract check (Android, Phase 5 Task 1 — CSS compatibility
 * baseline).
 *
 * Chrome/WebView 60 (Capacitor's DEFAULT_ANDROID_WEBVIEW_VERSION) predates a
 * whole generation of CSS: `@layer`/`@property`/CSS nesting, `:where()`/`:is(`/
 * `:has(`/`:focus-visible`, `oklch()`/`lab()`/`lch()`/`color-mix()`, logical
 * properties, flex/grid `gap`, `min()/max()/clamp()`, `lh`-family units,
 * individual transform properties, `aspect-ratio`, `text-underline-offset`,
 * and `scroll-behavior`. The Android stylesheet
 * must be written in plain dependency-free CSS that this floor can parse —
 * this gate denies every listed token class in the built CSS and requires the
 * semantic selector vocabulary that the components rely on.
 *
 * Pure reader (like `verify-legacy-build.mjs`): it never runs `vite`/`vitest`,
 * so it can join the canonical Android `build`/`cap sync` pipeline without
 * recursive build or test behavior. Imports only `node:fs`/`node:path`.
 * Exit 0 = contract met; exit 1 = contract violated (with a precise reason).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FORBIDDEN_RULES = [
	[/@layer\b/, "@layer at-rules"],
	[/@property\b/, "@property at-rules"],
	[/@import\b/, "@import at-rules"],
	[/:where\(/, ":where()"],
	[/:is\(/, ":is()"],
	[/:has\(/, ":has()"],
	[/:focus-visible/, ":focus-visible (use :focus on Chrome/WebView 60)"],
	[/\boklch\(/, "oklch() color"],
	[/\blab\(/, "lab() color"],
	[/\blch\(/, "lch() color"],
	[/\bcolor-mix\(/, "color-mix()"],
	[
		/(?:^|[;{\s])(?:margin|padding|inset|border|top|right|bottom|left|width|height)-(?:inline|block)(?:-(?:start|end))?\s*:/,
		"logical property",
	],
	[/(?:^|[;{\s])(?:block|inline)-(?:size|start|end)\s*:/, "logical block/inline property"],
	[
		/(?:^|[;{\s}])(?:gap|row-gap|column-gap)\s*:/,
		"gap property (flex/grid gap unsupported in Chrome 60)",
	],
	[/\b(?:min|max|clamp)\(/, "min()/max()/clamp()"],
	[/(?:^|[^-\w])\d+(?:\.\d+)?(?:lh|rlh|ic|cap)(?=$|[;\s}])/, "lh/rlh/ic/cap units"],
	[/(?:^|[;{\s}])(?:translate|scale|rotate)\s*:/, "individual transform property"],
	[/\baspect-ratio\s*:/, "aspect-ratio"],
	[/\btext-underline-offset\s*:/, "text-underline-offset (Chrome/WebView 60)"],
	[/\bscroll-behavior\s*:/, "scroll-behavior (Chrome/WebView 60)"],
	[/(?:^|[{};])\s*&(?=\s*(?:[.:#[\w>+~*&]|\{))/, "CSS nesting (&)"],
];

/**
 * Scan stylesheet text for tokens that Chrome/WebView 60 cannot parse.
 * @param {string} css
 * @returns {string[]} human-readable per-line violations (empty = clean).
 */
export function findForbiddenCssTokens(css) {
	const hits = [];
	for (const line of String(css).split("\n")) {
		for (const [re, label] of FORBIDDEN_RULES) {
			if (re.test(line)) hits.push(`${label} (line: ${line.trim().slice(0, 80)})`);
		}
	}
	return hits;
}

const REQUIRED_SELECTORS = [
	[/\[data-theme/, "[data-theme] attribute selector"],
	[/\.weekday-link/, ".weekday-link"],
	[/\.editor\b/, ".editor"],
	[/\.tab-bar/, ".tab-bar"],
	[/\.card\b/, ".card"],
	[/\.btn\b/, ".btn"],
	[/\.sr-only/, ".sr-only"],
	[/:focus\b/, ":focus fallback"],
];

/**
 * Report which required semantic selectors are absent from the stylesheet.
 * @param {string} css
 * @returns {string[]} labels of missing selectors (empty = all present).
 */
export function missingRequiredSelectors(css) {
	return REQUIRED_SELECTORS.filter(([re]) => !re.test(String(css))).map(([, label]) => label);
}

function fail(message) {
	console.error(`CSS CONTRACT FAILED: ${message}`);
	process.exit(1);
}

// CLI entry only when invoked directly (import-main guard) — the exported
// functions stay importable by the vitest fixture suite without side effects.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
	const assetsDir = join(distDir, "assets");

	if (!existsSync(assetsDir)) {
		fail(`missing ${assetsDir} — run "vite build" first`);
	}

	const cssFiles = readdirSync(assetsDir).filter((name) => name.endsWith(".css"));
	const violations = [];
	const totalLines = cssFiles.reduce(
		(sum, file) => sum + readFileSync(join(assetsDir, file), "utf8").split("\n").length,
		0,
	);

	for (const file of cssFiles) {
		const css = readFileSync(join(assetsDir, file), "utf8");
		for (const hit of findForbiddenCssTokens(css)) {
			violations.push(`${file}: ${hit}`);
		}
	}
	if (violations.length > 0) {
		for (const violation of violations) console.error(`  ${violation}`);
		fail(`${violations.length} forbidden CSS token(s) in dist/assets`);
	}

	const combined = cssFiles
		.map((file) => readFileSync(join(assetsDir, file), "utf8"))
		.join("\n");
	const missing = missingRequiredSelectors(combined);
	if (missing.length > 0) {
		fail(`missing required selector group(s): ${missing.join(", ")}`);
	}

	console.log(
		`CSS CONTRACT OK: ${cssFiles.length} css file(s), ${totalLines} lines, ${missing.length} missing selector group(s)`,
	);
}