import { describe, expect, test } from "bun:test";
import { formatTransferInstant, parseTransferInstant } from "./transfer-timestamp";

describe("transfer timestamps", () => {
	test("accepts canonical UTC instants with milliseconds", () => {
		expect(parseTransferInstant("2026-09-11T03:33:06.906Z", "timestamp")).toBe(
			"2026-09-11T03:33:06.906Z",
		);
	});

	test.each([
		"2026-09-11",
		"2026-09-11T03:33:06Z",
		"2026-09-11T03:33:06.906+00:00",
		"2026-09-10T23:33:06.906-04:00",
		"2026-09-11 03:33:06.906Z",
		"not-a-date",
	])("rejects noncanonical or invalid value %s", (value) => {
		expect(() => parseTransferInstant(value, "timestamp")).toThrow(
			"timestamp must be a canonical UTC instant",
		);
	});

	test("rejects non-string values without echoing them", () => {
		expect(() => parseTransferInstant({ secret: "do not echo" }, "timestamp")).toThrow(
			"timestamp must be a canonical UTC instant",
		);
	});

	test("formats valid Date values canonically", () => {
		expect(formatTransferInstant(new Date("2026-09-11T03:33:06.906Z"), "timestamp")).toBe(
			"2026-09-11T03:33:06.906Z",
		);
	});

	test("rejects invalid Date values", () => {
		expect(() => formatTransferInstant(new Date(Number.NaN), "timestamp")).toThrow(
			"timestamp must be a valid instant",
		);
	});
});
