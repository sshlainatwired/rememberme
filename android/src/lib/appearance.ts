/**
 * Appearance resolution + application for the Android app.
 *
 * Contract (Phase 5 Task 6): the resolved theme is applied to
 * `document.documentElement.dataset.theme` — `"dark"` toggles the
 * `[data-theme="dark"]` token overrides in global.css, any other value
 * (including `undefined` before the first sync) renders the light `:root`
 * defaults. Only two values are ever written: "light" and "dark".
 *
 * - `system` uses `prefers-color-scheme` via `window.matchMedia`; when the
 *   media query is unavailable or unsupported the resolved theme is
 *   deliberately `"light"` (the safe default — an old Chrome/WebView 60
 *   floor renders light rather than crashing).
 * - Explicit `light`/`dark` settings win regardless of the system signal.
 * - System changes re-apply the theme live through {@link
 *   onPrefersDarkChange}; the subscription is replaced (listener removed and
 *   re-added) whenever the resolved appearance changes, so a stale system
 *   listener can never overwrite a newer explicit setting.
 *
 * These functions are the stable export Surface the Settings screen (Task 9)
 * resyncs through after a settings update.
 */

import type { Appearance } from "@/db/settings";

export type ResolvedTheme = "light" | "dark";

/** Map a stored appearance over the current system preference to a theme. */
export function resolveTheme(appearance: Appearance, prefersDark: boolean): ResolvedTheme {
	if (appearance === "light" || appearance === "dark") return appearance;
	// system; no signal (or an unsupported query) resolves to light
	return prefersDark ? "dark" : "light";
}

/**
 * Whether the system prefers dark. Guarded: `window.matchMedia` may be
 * absent (old WebView) or throw (unsupported query); both resolve to `false`
 * so appearance resolution never crashes.
 */
export function prefersDark(): boolean {
	try {
		return window.matchMedia("(prefers-color-scheme: dark)").matches;
	} catch {
		return false;
	}
}

/** Apply the theme to `<html>` via the `data-theme` attribute. */
export function applyTheme(theme: ResolvedTheme): void {
	document.documentElement.dataset.theme = theme;
}

/**
 * Subscribe to system dark-mode changes. Returns an unsubscribe function.
 *
 * Uses `addEventListener` when the engine supports it (modern WebView);
 * falls back to the legacy `addListener` API (older Chromium/Safari). When
 * `matchMedia` is entirely absent the subscription is a no-op, mirroring
 * {@link prefersDark}'s graceful degradation.
 */
export function onPrefersDarkChange(listener: () => void): () => void {
	let mql: MediaQueryList | undefined;
	try {
		mql = window.matchMedia("(prefers-color-scheme: dark)");
	} catch {
		return () => {};
	}
	if (mql && typeof mql.addEventListener === "function") {
		mql.addEventListener("change", listener);
		return () => {
			mql?.removeEventListener("change", listener);
		};
	}
	if (mql && typeof mql.addListener === "function") {
		mql.addListener(listener);
		return () => {
			mql?.removeListener(listener);
		};
	}
	return () => {};
}
