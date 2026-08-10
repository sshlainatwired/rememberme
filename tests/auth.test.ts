import { beforeAll, describe, expect, test } from "bun:test";
import * as schema from "../src/server/db/schema";
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

async function getSessionUser(cookie: string): Promise<{ id: string } | null> {
	const res = await api("/api/auth/get-session", { cookie });
	const data = (await res.json().catch(() => null)) as { user?: { id: string } } | null;
	return data?.user ?? null;
}

describe("auth flow", () => {
	test("setup creates a session and settings", async () => {
		const res = await api("/api/setup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				password: "hunter2secret",
				confirmPassword: "hunter2secret",
				timezone: "Europe/Istanbul",
			}),
		});
		expect(res.status).toBe(200);
		const cookie = cookieFromResponse(res);
		expect(cookie).not.toBeNull();

		const user = await getSessionUser(cookie as string);
		expect(user).not.toBeNull();

		const settingsRes = await api("/api/settings", { cookie });
		expect(settingsRes.status).toBe(200);
		const settings = (await settingsRes.json()) as { timezone: string };
		expect(settings.timezone).toBe("Europe/Istanbul");
	});

	test("second setup attempt is rejected", async () => {
		const res = await api("/api/setup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "another-pass", timezone: "UTC" }),
		});
		expect(res.status).toBe(400);
	});

	test("wrong password is rejected", async () => {
		const res = await api("/api/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "wrong-password" }),
		});
		expect(res.status).toBe(401);
	});

	test("correct password logs in and gets a session", async () => {
		const res = await api("/api/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "hunter2secret" }),
		});
		expect(res.status).toBe(200);
		const cookie = cookieFromResponse(res);
		expect(cookie).not.toBeNull();
		expect(await getSessionUser(cookie as string)).not.toBeNull();
	});

	test("logout invalidates the session", async () => {
		const login = await api("/api/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "hunter2secret" }),
		});
		const cookie = cookieFromResponse(login);
		expect(await getSessionUser(cookie as string)).not.toBeNull();

		await api("/api/logout", { method: "POST", cookie });
		expect(await getSessionUser(cookie as string)).toBeNull();
	});

	test("protected routes require a session", async () => {
		const res = await api("/api/settings");
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not signed in");
	});

	test("changing the password works and rejects a wrong current password", async () => {
		const login = await api("/api/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "hunter2secret" }),
		});
		const cookie = cookieFromResponse(login) as string;

		const wrong = await api("/api/settings/password", {
			method: "POST",
			cookie,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ currentPassword: "not-the-password", newPassword: "brand-new-pass" }),
		});
		expect(wrong.status).toBe(400);

		const ok = await api("/api/settings/password", {
			method: "POST",
			cookie,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ currentPassword: "hunter2secret", newPassword: "brand-new-pass" }),
		});
		expect(ok.status).toBe(200);

		// Old password no longer works.
		const oldLogin = await api("/api/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "hunter2secret" }),
		});
		expect(oldLogin.status).toBe(401);

		// New password works.
		const newLogin = await api("/api/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "brand-new-pass" }),
		});
		expect(newLogin.status).toBe(200);
	});

	test("expired session is rejected", async () => {
		// Insert a session row that is already expired, with a token the
		// server's session cache has never seen, then hit a protected route.
		const users = await ctx.db.select({ id: schema.user.id }).from(schema.user).limit(1);
		expect(users.length).toBe(1);
		const token = `expired-${crypto.randomUUID()}`;
		await ctx.db.insert(schema.session).values({
			id: crypto.randomUUID(),
			token,
			userId: users[0].id,
			expiresAt: new Date(Date.now() - 60_000),
			createdAt: new Date(Date.now() - 3_600_000),
			updatedAt: new Date(Date.now() - 3_600_000),
		});

		const res = await api("/api/settings", {
			cookie: `rememberme.session_token=${token}`,
		});
		expect(res.status).toBe(401);
	});

	test("raw better-auth sign-up is closed once the first user exists", async () => {
		// The shared context already has the owner from the setup test above.
		const res = await api("/api/auth/sign-up/email", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: "intruder@example.com", password: "attacker-pass-123" }),
		});
		expect(res.status).toBe(404);
		// No session cookie is minted for the would-be intruder.
		expect(res.headers.get("set-cookie")).toBeNull();

		// And they cannot log in: no such account exists.
		const intruderLogin = await api("/api/auth/sign-in/email", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: "intruder@example.com", password: "attacker-pass-123" }),
		});
		expect(intruderLogin.status).not.toBe(200);
	});
});

describe("raw better-auth sign-up gate (fresh database)", () => {
	let fresh: TestContext;

	beforeAll(async () => {
		fresh = await makeTestContext();
	});

	test("sign-up still works before the first user exists", async () => {
		const res = await fresh.app.request("/api/auth/sign-up/email", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "First", email: "first@example.com", password: "first-pass-123" }),
		});
		expect(res.status).toBe(200);
	});

	test("sign-up is rejected after the first user exists", async () => {
		const res = await fresh.app.request("/api/auth/sign-up/email", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Second", email: "second@example.com", password: "second-pass-123" }),
		});
		expect(res.status).toBe(404);
	});
});
