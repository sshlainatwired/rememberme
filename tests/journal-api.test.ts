import { beforeAll, describe, expect, test } from "bun:test";
import { getEntry, listEntryDates } from "../src/server/db/repo";
import { cookieFromResponse, makeTestContext, type TestContext } from "./helpers";

let ctx: TestContext;

beforeAll(async () => {
	ctx = await makeTestContext();
});

async function api(
	path: string,
	init: RequestInit & { cookie?: string | null } = {},
): Promise<Response> {
	const headers = new Headers(init.headers ?? {});
	if (init.cookie) headers.set("cookie", init.cookie);
	return ctx.app.request(path, { ...init, headers });
}

/** Session cookie for the freshly-set-up user (created once per test file). */
let sessionCookie: string | null = null;

async function ensureSetup(): Promise<string> {
	if (sessionCookie) return sessionCookie;
	const res = await api("/api/setup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			password: "correct-horse-9",
			confirmPassword: "correct-horse-9",
			timezone: "UTC",
		}),
	});
	expect(res.status).toBe(200);
	sessionCookie = cookieFromResponse(res);
	expect(sessionCookie).not.toBeNull();
	return sessionCookie as string;
}

/** Resolve the user id for a session cookie via Better Auth's endpoint. */
async function userIdFor(cookie: string): Promise<string> {
	const res = await api("/api/auth/get-session", { cookie });
	expect(res.status).toBe(200);
	const data = (await res.json()) as { user?: { id: string } } | null;
	const id = data?.user?.id;
	expect(id).toBeTruthy();
	return id as string;
}

describe("journal API", () => {
	test("requires authentication", async () => {
		const res = await api("/api/journal/2026-08-03");
		expect(res.status).toBe(401);
	});

	test("empty entry is stored as nothing", async () => {
		const cookie = await ensureSetup();
		const res = await api("/api/journal/2026-08-03", {
			method: "PUT",
			cookie,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ date: "2026-08-03", content: "" }),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()) as { deleted?: boolean };
		expect(data.deleted).toBe(true);
	});

	test("upsert then read round-trip", async () => {
		const cookie = await ensureSetup();
		const put = await api("/api/journal/2026-08-03", {
			method: "PUT",
			cookie,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ date: "2026-08-03", content: "A sunny day." }),
		});
		expect(put.status).toBe(200);

		const get = await api("/api/journal/2026-08-03", { cookie });
		expect(get.status).toBe(200);
		const data = (await get.json()) as { date: string; content: string };
		expect(data.date).toBe("2026-08-03");
		expect(data.content).toBe("A sunny day.");
	});

	test("content is encrypted at rest", async () => {
		const cookie = await ensureSetup();
		const userId = await userIdFor(cookie);
		await api("/api/journal/2026-08-04", {
			method: "PUT",
			cookie,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ date: "2026-08-04", content: "my top secret plan" }),
		});

		const row = await getEntry(ctx.db, userId, "2026-08-04");
		expect(row).not.toBeNull();
		const encrypted = row as NonNullable<typeof row>;
		expect(encrypted.encryptedContent).not.toContain("secret");
		expect(encrypted.iv.length).toBeGreaterThan(0);
		expect(encrypted.authTag.length).toBeGreaterThan(0);
		const all = JSON.stringify(encrypted);
		expect(all).not.toContain("top secret");
	});

	test("only one entry per (user, date) — update overwrites", async () => {
		const cookie = await ensureSetup();
		for (const content of ["first", "second"]) {
			await api("/api/journal/2026-08-05", {
				method: "PUT",
				cookie,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ date: "2026-08-05", content }),
			});
		}
		const get = await api("/api/journal/2026-08-05", { cookie });
		const data = (await get.json()) as { content: string };
		expect(data.content).toBe("second");
	});

	test("list endpoint returns dates only (no content)", async () => {
		const cookie = await ensureSetup();
		await api("/api/journal/2026-08-10", {
			method: "PUT",
			cookie,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ date: "2026-08-10", content: "week one" }),
		});
		const res = await api("/api/journal?from=2026-08-09&to=2026-08-15", { cookie });
		expect(res.status).toBe(200);
		const data = (await res.json()) as { dates: string[] };
		expect(data.dates).toContain("2026-08-10");
		expect(JSON.stringify(data)).not.toContain("week one");
	});

	test("rejects invalid dates and oversized content", async () => {
		const cookie = await ensureSetup();
		const badDate = await api("/api/journal/2026-13-01", { cookie });
		expect(badDate.status).toBe(400);

		const huge = await api("/api/journal/2026-08-06", {
			method: "PUT",
			cookie,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ date: "2026-08-06", content: "x".repeat(100_001) }),
		});
		expect(huge.status).toBe(400);
	});

	test("invalid date with no session is still 401 (auth first)", async () => {
		const res = await api("/api/journal/bad-date", {});
		expect(res.status).toBe(401);
	});

	test("delete removes the entry", async () => {
		const cookie = await ensureSetup();
		const userId = await userIdFor(cookie);
		await api("/api/journal/2026-08-20", {
			method: "PUT",
			cookie,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ date: "2026-08-20", content: "to delete" }),
		});
		await api("/api/journal/2026-08-20", {
			method: "PUT",
			cookie,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ date: "2026-08-20", content: "" }),
		});
		const row = await getEntry(ctx.db, userId, "2026-08-20");
		expect(row).toBeNull();
		const dates = await listEntryDates(ctx.db, userId);
		expect(dates).not.toContain("2026-08-20");
	});
});
