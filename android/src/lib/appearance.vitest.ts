import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, onPrefersDarkChange, prefersDark, resolveTheme } from "@/lib/appearance";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("resolveTheme", () => {
	it("maps system+dark -> dark and system+light -> light", () => {
		expect(resolveTheme("system", true)).toBe("dark");
		expect(resolveTheme("system", false)).toBe("light");
	});

	it("maps explicit light/dark regardless of prefers-dark", () => {
		expect(resolveTheme("light", true)).toBe("light");
		expect(resolveTheme("dark", false)).toBe("dark");
	});
});

describe("applyTheme", () => {
	it("sets the data-theme attribute on <html>", () => {
		applyTheme("dark");
		expect(document.documentElement.dataset.theme).toBe("dark");
	});
});

describe("prefersDark", () => {
	it("returns false when prefers-color-scheme is unavailable", () => {
		vi.stubGlobal("matchMedia", undefined);
		expect(prefersDark()).toBe(false);
	});

	it("returns the media query result when available", () => {
		vi.stubGlobal("matchMedia", () => ({
			matches: true,
			addEventListener: vi.fn(),
			addListener: vi.fn(),
			removeEventListener: vi.fn(),
			removeListener: vi.fn(),
		}));
		expect(prefersDark()).toBe(true);
	});
});

describe("onPrefersDarkChange", () => {
	it("uses addEventListener when available and unsubscribes with removeEventListener", () => {
		const addEventListener = vi.fn();
		const removeEventListener = vi.fn();
		vi.stubGlobal("matchMedia", () => ({
			matches: false,
			addEventListener,
			addListener: vi.fn(),
			removeEventListener,
			removeListener: vi.fn(),
		}));
		const off = onPrefersDarkChange(() => {});
		expect(addEventListener).toHaveBeenCalledTimes(1);
		off();
		expect(removeEventListener).toHaveBeenCalledTimes(1);
	});

	it("re-applies the theme when the modern addEventListener callback fires, then cleans up", () => {
		let captured: (() => void) | undefined;
		const removeEventListener = vi.fn();
		vi.stubGlobal("matchMedia", () => ({
			matches: false,
			addEventListener: (_type: string, cb: () => void) => {
				captured = cb;
			},
			addListener: vi.fn(),
			removeEventListener,
			removeListener: vi.fn(),
		}));
		const listener = vi.fn(() => {
			applyTheme("dark");
		});
		const off = onPrefersDarkChange(listener);
		// simulate a real system preference change: the registered callback fires
		captured?.();
		expect(listener).toHaveBeenCalledTimes(1);
		expect(document.documentElement.dataset.theme).toBe("dark");
		// cleanup removes the SAME callback via removeEventListener
		off();
		expect(removeEventListener).toHaveBeenCalledWith("change", listener);
		expect(removeEventListener).toHaveBeenCalledTimes(1);
	});

	it("falls back to addListener/removeListener", () => {
		const mql = { addListener: vi.fn(), removeListener: vi.fn() };
		vi.stubGlobal("matchMedia", () => mql);
		const off = onPrefersDarkChange(() => {});
		expect(mql.addListener).toHaveBeenCalledTimes(1);
		off();
		expect(mql.removeListener).toHaveBeenCalledTimes(1);
	});

	it("re-applies the theme when the legacy addListener callback fires, then cleans up", () => {
		let captured: (() => void) | undefined;
		const removeListener = vi.fn();
		vi.stubGlobal("matchMedia", () => ({
			matches: false,
			addListener: (cb: () => void) => {
				captured = cb;
			},
			removeListener,
		}));
		const listener = vi.fn(() => {
			applyTheme("light");
		});
		const off = onPrefersDarkChange(listener);
		// simulate a real system preference change through the legacy API
		captured?.();
		expect(listener).toHaveBeenCalledTimes(1);
		expect(document.documentElement.dataset.theme).toBe("light");
		off();
		expect(removeListener).toHaveBeenCalledWith(listener);
		expect(removeListener).toHaveBeenCalledTimes(1);
	});
});
