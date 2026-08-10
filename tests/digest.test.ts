import { describe, expect, test } from "bun:test";
import { DateTime } from "luxon";
import { mondayOfWeek, mostRecentSunday, runWeeklyDigest } from "../src/server/jobs/weekly-digest";
import { cookieFromResponse, makeTestContext, type TestContext } from "./helpers";

const TZ = "Europe/Istanbul";

/** Fresh context with SMTP configured so delivery is attempted. */
async function makeCtx(): Promise<TestContext> {
	return makeTestContext({ SMTP_HOST: "smtp.test" });
}

/** Request with an optional session cookie. */
async function request(
	ctx: TestContext,
	path: string,
	init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
	const headers = new Headers(init.headers ?? {});
	if (init.cookie) headers.set("cookie", init.cookie);
	return ctx.app.request(path, { ...init, headers });
}

/** Setup a user, enable the digest, and write the given entries. */
async function seed(
	ctx: TestContext,
	entries: Record<string, string>,
	timezone = TZ,
): Promise<string> {
	const setup = await request(ctx, "/api/setup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			password: "digest-pass-9",
			confirmPassword: "digest-pass-9",
			timezone,
		}),
	});
	const cookie = cookieFromResponse(setup) as string;

	for (const [date, content] of Object.entries(entries)) {
		const put = await request(ctx, `/api/journal/${date}`, {
			method: "PUT",
			cookie,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ date, content }),
		});
		expect(put.status).toBe(200);
	}

	const settings = await request(ctx, "/api/settings", {
		method: "PUT",
		cookie,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			email: "me@example.com",
			timezone,
			weeklyDigestEnabled: true,
			weeklyDigestHour: 20,
		}),
	});
	expect(settings.status).toBe(200);
	return cookie;
}

function sundayAt(iso: string): DateTime {
	return DateTime.fromISO(iso, { zone: TZ });
}

describe("week boundary math", () => {
	test("mostRecentSunday finds the current week's Sunday", () => {
		const now = sundayAt("2026-08-09T20:00:00");
		const sunday = mostRecentSunday(now);
		expect(sunday.toFormat("yyyy-MM-dd")).toBe("2026-08-09");
	});

	test("mostRecentSunday for mid-week is the previous Sunday", () => {
		const now = sundayAt("2026-08-06T12:00:00"); // Thursday
		expect(mostRecentSunday(now).toFormat("yyyy-MM-dd")).toBe("2026-08-02");
	});

	test("mondayOfWeek returns Monday of the containing week", () => {
		const monday = mondayOfWeek(sundayAt("2026-08-09T20:00:00"));
		expect(monday.toFormat("yyyy-MM-dd")).toBe("2026-08-03");
	});
});

describe("weekly digest job", () => {
	test("delivers on Sunday evening in the user's timezone", async () => {
		const ctx = await makeCtx();
		await seed(ctx, {
			"2026-08-03": "Monday thoughts",
			"2026-08-05": "Wednesday things",
		});

		const result = await runWeeklyDigest(
			{ db: ctx.db, cipher: ctx.cipher, mailer: ctx.mailer, config: ctx.config },
			sundayAt("2026-08-09T20:00:00"),
			true,
		);

		expect(result.attempted).toBe(1);
		expect(result.sent).toBe(1);
		expect(result.errors).toEqual([]);
		expect(ctx.mailer.sent).toHaveLength(1);

		const message = ctx.mailer.sent[0];
		expect(message.to).toBe("me@example.com");
		expect(message.subject).toBe("Your week — August 3 — August 9, 2026");
		expect(message.html).toContain("Monday thoughts");
		expect(message.html).toContain("Wednesday things");
		expect(message.text).toContain("No entry.");
		expect(message.html).toContain("7 days · 2 entries");
	});

	test("does not send when it is not Sunday at the digest hour", async () => {
		const ctx = await makeCtx();
		await seed(ctx, { "2026-08-03": "Monday thoughts" });

		const result = await runWeeklyDigest(
			{ db: ctx.db, cipher: ctx.cipher, mailer: ctx.mailer, config: ctx.config },
			sundayAt("2026-08-08T20:00:00"), // Saturday
			true,
		);

		expect(result.sent).toBe(0);
		expect(ctx.mailer.sent).toHaveLength(0);
	});

	test("does not send outside the configured hour", async () => {
		const ctx = await makeCtx();
		await seed(ctx, { "2026-08-03": "Monday thoughts" });

		const result = await runWeeklyDigest(
			{ db: ctx.db, cipher: ctx.cipher, mailer: ctx.mailer, config: ctx.config },
			sundayAt("2026-08-09T08:00:00"), // Sunday morning
			true,
		);

		expect(result.sent).toBe(0);
	});

	test("digest is timezone-aware: same instant, different local day", async () => {
		const ctx = await makeCtx();
		await seed(ctx, { "2026-08-03": "Monday thoughts" }, "America/New_York");

		// 2026-08-09T20:00 Europe/Istanbul is 2026-08-09 13:00 New York — Sunday, before 20:00.
		const result = await runWeeklyDigest(
			{ db: ctx.db, cipher: ctx.cipher, mailer: ctx.mailer, config: ctx.config },
			sundayAt("2026-08-09T20:00:00"),
			true,
		);
		expect(result.sent).toBe(0);

		// At 20:00 New York (which is 2026-08-10 03:00 Istanbul) it is due.
		const nyNow = DateTime.fromISO("2026-08-09T20:00:00", { zone: "America/New_York" });
		const result2 = await runWeeklyDigest(
			{ db: ctx.db, cipher: ctx.cipher, mailer: ctx.mailer, config: ctx.config },
			nyNow,
			true,
		);
		expect(result2.sent).toBe(1);
	});

	test("is idempotent — a week is never delivered twice", async () => {
		const ctx = await makeCtx();
		await seed(ctx, { "2026-08-03": "Monday thoughts" });

		const deps = { db: ctx.db, cipher: ctx.cipher, mailer: ctx.mailer, config: ctx.config };
		const now = sundayAt("2026-08-09T20:00:00");
		const first = await runWeeklyDigest(deps, now, true);
		const second = await runWeeklyDigest(deps, now, true);

		expect(first.sent).toBe(1);
		expect(second.sent).toBe(0);
		expect(second.alreadyDelivered).toBe(1);
		expect(ctx.mailer.sent).toHaveLength(1);
	});

	test("manual mode sends the most recently completed week regardless of day", async () => {
		const ctx = await makeCtx();
		await seed(ctx, {
			"2026-07-27": "last week monday",
			"2026-08-02": "last week sunday",
		});

		const result = await runWeeklyDigest(
			{ db: ctx.db, cipher: ctx.cipher, mailer: ctx.mailer, config: ctx.config },
			sundayAt("2026-08-06T12:00:00"), // Thursday
			false,
		);

		expect(result.sent).toBe(1);
		const message = ctx.mailer.sent[0];
		expect(message.subject).toBe("Your week — July 27 — August 2, 2026");
		expect(message.html).toContain("last week monday");
		expect(message.html).toContain("last week sunday");
	});

	test("escapes user content in the HTML email", async () => {
		const ctx = await makeCtx();
		await seed(ctx, { "2026-08-03": "<script>alert('xss')</script> & more" });

		const result = await runWeeklyDigest(
			{ db: ctx.db, cipher: ctx.cipher, mailer: ctx.mailer, config: ctx.config },
			sundayAt("2026-08-09T20:00:00"),
			true,
		);

		expect(result.sent).toBe(1);
		const html = ctx.mailer.sent[0].html;
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&amp; more");
	});

	test("delivers when a mailer is injected even without SMTP env", async () => {
		const ctx = await makeTestContext(); // SMTP_HOST empty
		await seed(ctx, { "2026-08-03": "Monday thoughts" });

		const result = await runWeeklyDigest(
			{ db: ctx.db, cipher: ctx.cipher, mailer: ctx.mailer, config: ctx.config },
			sundayAt("2026-08-09T20:00:00"),
			true,
		);

		expect(result.sent).toBe(1);
		expect(result.errors).toEqual([]);
		expect(ctx.mailer.sent).toHaveLength(1);
	});

	test("manual endpoint returns 503 when no mailer is available", async () => {
		const ctx = await makeTestContext({ SMTP_HOST: "" });
		const cookie = await seed(ctx, { "2026-08-03": "Monday thoughts" });
		// Simulate production-without-SMTP: the app wires mailer=null.
		const { createApp } = await import("../src/server/api");
		const noMailerApp = createApp({
			db: ctx.db,
			auth: ctx.auth,
			cipher: ctx.cipher,
			mailer: null,
			config: ctx.config,
		});

		const res = await noMailerApp.request("/api/jobs/weekly-digest", {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
		});
		expect(res.status).toBe(503);
	});

	test("users with digest disabled are not subscribers", async () => {
		const ctx = await makeCtx();
		const setup = await request(ctx, "/api/setup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				password: "digest-pass-9",
				confirmPassword: "digest-pass-9",
				timezone: TZ,
			}),
		});
		const cookie = cookieFromResponse(setup) as string;
		// Enabled flag left at default false.
		const settings = await request(ctx, "/api/settings", {
			method: "PUT",
			cookie,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				email: "me@example.com",
				timezone: TZ,
				weeklyDigestEnabled: false,
				weeklyDigestHour: 20,
			}),
		});
		expect(settings.status).toBe(200);

		const result = await runWeeklyDigest(
			{ db: ctx.db, cipher: ctx.cipher, mailer: ctx.mailer, config: ctx.config },
			sundayAt("2026-08-09T20:00:00"),
			true,
		);

		expect(result.attempted).toBe(0);
		expect(ctx.mailer.sent).toHaveLength(0);
	});
});
