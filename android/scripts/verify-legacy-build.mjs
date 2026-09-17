#!/usr/bin/env node
/**
 * Legacy build contract check (Android, Phase 3 Terra rerun).
 *
 * Verifies that the Vite build in `dist/` emits BOTH a modern
 * `<script type="module">` entry AND a non-module legacy bundle
 * (`<script nomodule>` core-js polyfills + a nomodule legacy entry chunk
 * transformed down to `chrome >= 60` — the Capacitor
 * DEFAULT_ANDROID_WEBVIEW_VERSION floor). A module-only output cannot be
 * parsed by Chrome/WebView 60 and must fail the gate.
 *
 * Pure reader: it never runs `vite`/`vitest`, so it can be part of the
 * canonical Android `build`/`cap sync` pipeline without recursive build or
 * test behavior. Exit 0 = contract met; exit 1 = contract violated (with a
 * precise reason).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const indexHtmlPath = join(distDir, "index.html");

function fail(message) {
	console.error(`LEGACY BUILD CONTRACT FAILED: ${message}`);
	process.exit(1);
}

if (!existsSync(indexHtmlPath)) {
	fail(`missing ${indexHtmlPath} — run "vite build" first`);
}

const html = readFileSync(indexHtmlPath, "utf8");

// 1. Modern entry must still exist (module builds are not removed).
if (!/<script[^>]*type="module"[^>]*>/.test(html)) {
	fail('index.html has no modern <script type="module"> entry');
}

// 2. At least one explicit `nomodule` script — the legacy chunk marker.
const nomoduleScripts = [...html.matchAll(/<script[^>]*nomodule[^>]*>/g)];
if (nomoduleScripts.length === 0) {
	fail(
		"index.html has no <script nomodule> entry — the build is module-only, which Chrome/WebView 60 (Capacitor's default) cannot parse",
	);
}

// 3. The nomodule legacy entry (plugin-legacy marks it with data-src).
const legacyEntry = html.match(/<script[^>]*nomodule[^>]*data-src="([^"]+)"/);
if (!legacyEntry) {
	fail('index.html has no nomodule legacy entry with a data-src attribute');
}

// 4. Legacy polyfills chunk (self-executing nomodule script with a src).
const hasLegacyPolyfills = [...html.matchAll(/<script[^>]*nomodule[^>]*src="([^"]+)"/g)].some(
	(match) => basename(match[1]).includes("-legacy-"),
);
if (!hasLegacyPolyfills) {
	fail('index.html has no nomodule "-legacy-" polyfills chunk');
}

// 5. Every referenced asset must actually exist on disk, and at least one
//    "-legacy-" artifact must be present in dist/assets.
const referenced = [
	...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g),
	...(legacyEntry[1] ? [[, legacyEntry[1]]] : []),
].map((match) => match[1]);

for (const asset of referenced) {
	if (!existsSync(join(distDir, asset))) {
		fail(`index.html references missing asset: ${asset}`);
	}
}

const assetsDir = join(distDir, "assets");
const legacyArtifacts = existsSync(assetsDir)
	? readdirSync(assetsDir).filter((name) => name.includes("-legacy-"))
	: [];
if (legacyArtifacts.length === 0) {
	fail("dist/assets contains no '-legacy-' build artifacts");
}

console.log(
	`LEGACY BUILD CONTRACT OK: ${nomoduleScripts.length} nomodule script(s), legacy entry ${legacyEntry[1]}, ${legacyArtifacts.length} legacy artifact(s)`,
);