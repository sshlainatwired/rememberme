import { describe, expect, it } from "vitest";
import { constantTimeEqual, randomBytes, validatePassword, zeroBytes } from "@/auth/passwords";

describe("validatePassword", () => {
	it("rejects a 7-character password", () => {
		expect(() => validatePassword("a".repeat(7))).toThrow(/8\.\.128/);
	});

	it("rejects a 129-character password", () => {
		expect(() => validatePassword("a".repeat(129))).toThrow(/8\.\.128/);
	});

	it("rejects non-string values", () => {
		// Runtime guard contract: validatePassword throws for anything that is not a
		// string, even though the TS signature only admits strings. `any[]` keeps the
		// deliberate invalid inputs out of the type system (no casts needed).
		const nonStrings: any[] = [undefined, null, 42, {}, ["a", "b"], Symbol("pw")];
		for (const value of nonStrings) {
			expect(() => validatePassword(value)).toThrow();
		}
	});

	it("accepts 8- and 128-character passwords (exact inclusive bounds)", () => {
		expect(() => validatePassword("a".repeat(8))).not.toThrow();
		expect(() => validatePassword("a".repeat(128))).not.toThrow();
	});
});

describe("constantTimeEqual", () => {
	it("returns true for equal content, including separate buffer objects", () => {
		const a = new Uint8Array([1, 2, 3, 4]);
		expect(constantTimeEqual(a, new Uint8Array([1, 2, 3, 4]))).toBe(true);
		expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
	});

	it("returns false for different lengths and for same-length different content", () => {
		expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
		expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
		expect(constantTimeEqual(new Uint8Array([0, 0, 0]), new Uint8Array([0, 0, 1]))).toBe(false);
	});
});

describe("zeroBytes", () => {
	it("zeroes the buffer in place", () => {
		const bytes = new Uint8Array([9, 8, 7, 6]);
		zeroBytes(bytes);
		expect(bytes).toEqual(new Uint8Array(4));
	});
});

describe("randomBytes", () => {
	it("returns n bytes that are nonzero with overwhelming probability and differ across calls", () => {
		const a = randomBytes(16);
		const b = randomBytes(16);
		expect(a).toHaveLength(16);
		expect(a).toBeInstanceOf(Uint8Array);
		expect(a.some((byte) => byte !== 0)).toBe(true);
		expect(Array.from(b)).not.toEqual(Array.from(a));
	});
});
