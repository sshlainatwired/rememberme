import { describe, expect, test } from "bun:test";
import { changePasswordSchema, loginSchema, setupSchema } from "../src/shared/schemas/auth";
import {
	journalContentSchema,
	journalDateSchema,
	journalRangeSchema,
	journalUpsertSchema,
} from "../src/shared/schemas/journal";
import {
	digestHourSchema,
	emailSchema,
	settingsSchema,
	timezoneSchema,
} from "../src/shared/schemas/settings";

describe("journal schemas", () => {
	test("accepts YYYY-MM-DD dates", () => {
		for (const d of ["2026-08-03", "2024-02-29", "1970-01-01", "2026-12-31"]) {
			expect(journalDateSchema.safeParse(d).success).toBe(true);
		}
	});

	test("rejects malformed dates", () => {
		for (const d of [
			"2026-13-01",
			"2026-00-10",
			"2026-1-1",
			"2026/08/03",
			"not-a-date",
			"",
			"2026-08-32",
			"2026-02-30",
		]) {
			expect(journalDateSchema.safeParse(d).success).toBe(false);
		}
	});

	test("content is a trimmed string up to 100k chars", () => {
		expect(journalContentSchema.safeParse("hello").success).toBe(true);
		expect(journalContentSchema.safeParse("").success).toBe(true);
		expect(journalContentSchema.safeParse("a".repeat(100_000)).success).toBe(true);
		expect(journalContentSchema.safeParse("a".repeat(100_001)).success).toBe(false);
		expect(journalContentSchema.safeParse(42).success).toBe(false);
		expect(journalContentSchema.safeParse(null).success).toBe(false);
	});

	test("upsert requires content only (date is the route param)", () => {
		expect(journalUpsertSchema.safeParse({ content: "x" }).success).toBe(true);
		expect(journalUpsertSchema.safeParse({ date: "2026-08-03", content: "x" }).success).toBe(true); // date is stripped, schema stays permissive
		expect(journalUpsertSchema.safeParse({}).success).toBe(false);
		expect(journalUpsertSchema.safeParse({ content: 42 }).success).toBe(false);
	});

	test("range requires ISO dates", () => {
		expect(journalRangeSchema.safeParse({ from: "2026-08-03", to: "2026-08-09" }).success).toBe(
			true,
		);
		expect(journalRangeSchema.safeParse({ from: "bad", to: "2026-08-09" }).success).toBe(false);
	});
});

describe("settings schemas", () => {
	test("timezone accepts IANA names and rejects junk", () => {
		expect(timezoneSchema.safeParse("Europe/Istanbul").success).toBe(true);
		expect(timezoneSchema.safeParse("America/New_York").success).toBe(true);
		expect(timezoneSchema.safeParse("UTC").success).toBe(true);
		expect(timezoneSchema.safeParse("Mars/Olympus_Mons").success).toBe(false);
		expect(timezoneSchema.safeParse("").success).toBe(false);
	});

	test("digest hour is 0-23", () => {
		for (const h of [0, 1, 12, 23]) expect(digestHourSchema.safeParse(h).success).toBe(true);
		for (const h of [-1, 24, 2.5, "8", NaN])
			expect(digestHourSchema.safeParse(h).success).toBe(false);
	});

	test("email accepts valid or empty", () => {
		expect(emailSchema.safeParse("").success).toBe(true);
		expect(emailSchema.safeParse("a@b.co").success).toBe(true);
		expect(emailSchema.safeParse("not-an-email").success).toBe(false);
		expect(emailSchema.safeParse("a@b").success).toBe(false);
	});

	test("full settings object", () => {
		const ok = {
			email: "me@example.com",
			timezone: "Europe/Istanbul",
			weeklyDigestEnabled: true,
			weeklyDigestHour: 20,
		};
		expect(settingsSchema.safeParse(ok).success).toBe(true);
		expect(settingsSchema.safeParse({ ...ok, timezone: "Nope" }).success).toBe(false);
		expect(settingsSchema.safeParse({ ...ok, weeklyDigestHour: 99 }).success).toBe(false);
		expect(settingsSchema.safeParse({ ...ok, weeklyDigestEnabled: "yes" }).success).toBe(false);
	});
});

describe("auth schemas", () => {
	test("passwords are 8-128 chars and must match", () => {
		const ok = { password: "12345678", confirmPassword: "12345678" };
		expect(setupSchema.safeParse({ ...ok, timezone: "UTC" }).success).toBe(true);
		expect(setupSchema.safeParse(ok).success).toBe(true); // timezone defaults to UTC
		expect(setupSchema.safeParse({ ...ok, confirmPassword: "different!" }).success).toBe(false);
		expect(setupSchema.safeParse({ password: "short", confirmPassword: "short" }).success).toBe(
			false,
		);
		expect(
			setupSchema.safeParse({ password: "a".repeat(129), confirmPassword: "a".repeat(129) })
				.success,
		).toBe(false);
		expect(loginSchema.safeParse({ password: "12345678" }).success).toBe(true);
		expect(loginSchema.safeParse({}).success).toBe(false);
	});

	test("password change requires both fields", () => {
		expect(
			changePasswordSchema.safeParse({ currentPassword: "old12345", newPassword: "new123456" })
				.success,
		).toBe(true);
		expect(changePasswordSchema.safeParse({ currentPassword: "old12345" }).success).toBe(false);
		expect(changePasswordSchema.safeParse({ newPassword: "new123456" }).success).toBe(false);
	});
});
