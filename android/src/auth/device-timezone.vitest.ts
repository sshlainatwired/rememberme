import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceTimezone } from "./device-timezone";

/**
 * Constructable fake for `Intl.DateTimeFormat`, used under `new` by
 * `deviceTimezone()`. A plain arrow implementation cannot be `new`ed, so the
 * fake is a real class: the spy replaces the constructor, `new` returns a
 * `FakeDateTimeFormat` instance, and `resolvedOptions()` reports the stubbed
 * zone (or an empty options object when the zone is missing).
 */
class FakeDateTimeFormat {
	constructor(private readonly zone: string | undefined) {}

	resolvedOptions(): Intl.DateTimeFormatOptions {
		return this.zone === undefined ? {} : { timeZone: this.zone };
	}
}

/** Stub `Intl.DateTimeFormat` so `new` yields the given zone (or none). */
function mockIntlZone(zone: string | undefined): void {
	// SAFETY: `deviceTimezone()` only calls `resolvedOptions().timeZone` on the
	// constructed instance, so the fake only needs that member; TypeScript
	// cannot know the class satisfies the full Intl.DateTimeFormat interface.
	const fake = new FakeDateTimeFormat(zone) as unknown as Intl.DateTimeFormat;
	vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function DateTimeFormatMock() {
		return fake;
	});
}

/** Restore the stubbed Intl.DateTimeFormat after each test. */
afterEach(() => {
	vi.restoreAllMocks();
});

describe("deviceTimezone", () => {
	it("returns the validated device IANA zone", () => {
		mockIntlZone("Europe/Istanbul");
		expect(deviceTimezone()).toBe("Europe/Istanbul");
	});

	it("falls back to UTC when the resolved zone is not supported", () => {
		mockIntlZone("Not/AZone");
		expect(deviceTimezone()).toBe("UTC");
	});

	it("falls back to UTC when timeZone is missing", () => {
		mockIntlZone(undefined);
		expect(deviceTimezone()).toBe("UTC");
	});

	it("falls back to UTC when Intl throws", () => {
		vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
			throw new Error("Intl unavailable");
		});
		expect(deviceTimezone()).toBe("UTC");
	});
});
