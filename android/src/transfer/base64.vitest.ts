// @vitest-environment node
import { describe, expect, test } from "vitest";
import { decodeBase64, decodeUtf8, encodeBase64, encodeUtf8, wipe } from "./base64";

describe("portable binary primitives", () => {
	test.each([
		["", ""],
		["f", "Zg=="],
		["fo", "Zm8="],
		["foo", "Zm9v"],
		["foobar", "Zm9vYmFy"],
	])("round-trips RFC 4648 vector %s", (plain, encoded) => {
		expect(encodeBase64(encodeUtf8(plain))).toBe(encoded);
		expect(decodeUtf8(decodeBase64(encoded, "value"), "value")).toBe(plain);
	});

	test.each(["Zg", "Zg=", "Zg===", "Zh==", "Zm9=", "Zm-8", "Zm_8", " Zg==", "Zg==\n", "Z=g="])(
		"rejects noncanonical base64 %s",
		(value) => {
			expect(() => decodeBase64(value, "archive field")).toThrow(
				"archive field must be canonical standard base64",
			);
		},
	);

	test("rejects non-string base64 without echoing it", () => {
		expect(() => decodeBase64({ secret: "do not echo" }, "archive field")).toThrow(
			"archive field must be canonical standard base64",
		);
	});

	test("UTF-8 decoding is fatal", () => {
		expect(() => decodeUtf8(new Uint8Array([0xff]), "payload")).toThrow(
			"payload must be valid UTF-8",
		);
	});

	test("wipe clears every supplied buffer", () => {
		const a = new Uint8Array([1, 2, 3]);
		const b = new Uint8Array([4]);
		wipe(a, undefined, b);
		expect([...a]).toEqual([0, 0, 0]);
		expect([...b]).toEqual([0]);
	});
});
