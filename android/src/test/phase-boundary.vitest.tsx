import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JOURNAL_CONTENT_MAX } from "@rememberme/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { AuthProvider, type AuthSession } from "@/auth/auth-context";
import AppBootstrap from "@/components/layout/AppBootstrap";
import type { DatabaseHandle } from "@/db/bootstrap";
import { openAppDatabase } from "@/db/bootstrap";
import { StorageProvider } from "@/db/storage";
import { createTestDb, createTestHandle } from "@/db/test-helper";

/**
 * Phase 5 phase-boundary integration.
 *
 * The boundary surface is the WHOLE of Phase 5: the capacitor config, the
 * committed Android manifest, the Android source tree, the canonical build
 * scripts, and the offline/API-24/WebView floors. These tests are mostly
 * static assertions over the finished surface — they fail when a later phase
 * (6–8) leaks in, or when a Phase 5 violation (a network call, a new native
 * permission, a modern-only API) appears.
 *
 * The storage-backed route tests drive a real in-memory migrated SQLite
 * database (createTestDb -> openAppDatabase) through the REAL component/provider
 * seams (HashRouter -> AppBootstrap -> StorageProvider -> AuthProvider ->
 * AppearanceSync -> App routes), exactly as main.tsx does on native. The
 * assertions run against real migration, real services, and real routes — not
 * mocks — so they cannot be tautological.
 *
 * The offline source sweep is intentionally broad across every owned module
 * under src/ — including the currently-dormant WeeklyReview placeholder — so
 * any module that later ships (Phase 6 weekly review and beyond) must remain
 * just as offline. The ONLY files exempted are the two explicit test-support
 * adapters under src/db/ (node-sqlite.ts + test-helper.ts): they import
 * `node:sqlite` and are never bundled into the app, so a strict network/
 * modern-API sweep over shipped source would false-positive on their test
 * plumbing. That exclusion is a deliberate, documented tradeoff — a future
 * non-test module that reuses the node:sqlite dialect would slip past the
 * sweep — accepted because these two are fixture-only and never reach the
 * Android bundle.
 */

// Package root (android/), two levels above src/test/.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readRoot(rel: string): string {
	return readFileSync(resolve(ROOT, rel), "utf8");
}

/**
 * The single source of truth for the offline contract over Android source.
 *
 * One entry per forbidden network channel. Shared by BOTH the production
 * source sweep (every shipped module must never use a channel) and the
 * mutation-sample assertion (each regex proves it can catch a real-world
 * occurrence of its own channel). If a later phase introduces a networking
 * primitive, it is added here once and both sides stay in lock-step.
 */
const FORBIDDEN_NETWORK: ReadonlyArray<{
	channel: string;
	re: RegExp;
	/** Mutation samples — at least one per entry, attached so a list addition can
	 * never silently go unsampled. The self-catch test asserts every entry owns
	 * ≥1 sample AND that every one of its samples matches this entry's regex. */
	samples: readonly string[];
}> = [
	{
		channel: "fetch",
		re: /\bfetch\b/,
		samples: [
			"const res = await fetch('/api/sync')",
			"const f = fetch; await f(url)",
			"globalThis.fetch?.(url)",
		],
	},
	{
		channel: "XMLHttpRequest",
		re: /XMLHttpRequest/,
		samples: ["const xhr = new XMLHttpRequest()"],
	},
	// Generic word-bounded guard: catches the bare WebSocket identifier no matter
	// how a later phase reaches it — `new WebSocket`, `new window.WebSocket`, or
	// an aliased import (`import { WebSocket as WS }`).
	{
		channel: "WebSocket",
		re: /\bWebSocket\b/,
		samples: [
			"const ws = new WebSocket('wss://x.example')",
			"const ws = new window.WebSocket('wss://x.example')",
			"import { WebSocket as NetSocket } from 'somewhere'",
		],
	},
	// Generic word-bounded guard, as with WebSocket: bare identifier, any call form.
	{
		channel: "EventSource",
		re: /\bEventSource\b/,
		samples: [
			"const es = new EventSource('/events')",
			"const es = new window.EventSource('/events')",
			"import { EventSource as Source } from 'somewhere'",
		],
	},
	// Capacitor's native HTTP bridge — the classic covert channel that bypasses
	// the WebView's fetch/XHR. Generic word-bounded guard catches the bare
	// `CapacitorHttp` identifier: any method (`request`, `get`, `post`, …) or an
	// aliased import (`import { CapacitorHttp as Http }`) is an outbound call.
	{
		channel: "CapacitorHttp",
		re: /\bCapacitorHttp\b/,
		samples: [
			"const { data } = await CapacitorHttp.request({ url: 'https://api.example.com' })",
			"await CapacitorHttp.get({ url: 'https://api.example.com' })",
			"import { CapacitorHttp as Http } from '@capacitor/core'",
		],
	},
	// navigator.sendBeacon: fire-and-forget background network, invisible to a
	// fetch/WebSocket sweep.
	{
		channel: "sendBeacon",
		re: /\bsendBeacon\b/,
		samples: [
			"navigator.sendBeacon('/beacon', payload)",
			"const beacon = navigator.sendBeacon; beacon('/beacon', payload)",
		],
	},
	// Any remote URL literal can create an outbound channel through dynamic
	// imports, JSX resources, CSS assets, navigation, or a future native bridge.
	{
		channel: "remote http(s) URL",
		re: /https?:\/\//,
		samples: [
			'await import("http://cdn.example.com/mod.js")',
			'<img src="https://cdn.example.com/image.png" />',
			"background-image: url('https://cdn.example.com/image.png')",
		],
	},
];

/**
 * Explicit test-support files under src/ that are NEVER bundled into the app
 * and are only imported by the Vitest suite. They are exempted from the
 * strict source sweep so a future broadening of the pattern list does not
 * false-positive on their `node:sqlite` test plumbing. Tradeoff (kept on
 * purpose): a future non-test module that imports node:sqlite would bypass
 * the sweep — accepted because these two are fixture-only adapters.
 */
const TEST_SUPPORT_FILES = new Set([
	resolve(ROOT, "src/db/node-sqlite.ts"),
	resolve(ROOT, "src/db/test-helper.ts"),
]);

/**
 * Handles opened by tests in this suite, closed in `afterEach` AFTER the
 * React tree is unmounted (so cleanup runs against live providers and the
 * database connection is released only once no component may touch it).
 */
const openHandles: DatabaseHandle[] = [];

/**
 * Production Android source files (under src/, EXCLUDING the test directory,
 * which is never built into the bundle) for the offline + API-24 sweep. The
 * forbidden-network contracts scope to real shipped source, so the assertions
 * are not tautological against this file's own regexes. Deliberately broad:
 * every owned module (including dormant WeeklyReview) is swept so anything
 * that later ships must remain offline — only the two explicit test-support
 * fixtures are exempted.
 */
function listSourceFiles(): string[] {
	const srcDir = join(ROOT, "src");
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				if (entry === "test") continue; // not part of the production bundle
				walk(full);
			} else if (
				(/\.[tj]sx?$/.test(entry) || entry.endsWith(".css")) &&
				!/\.vitest\.[tj]sx?$/.test(entry)
			) {
				// Colocated *.vitest.ts/tsx tests are never built into the bundle.
				if (TEST_SUPPORT_FILES.has(full)) continue; // test-only fixture, never ships
				out.push(full);
			}
		}
	};
	walk(srcDir);
	return out;
}

afterEach(async () => {
	// Teardown runs even when a test fails: unmount every rendered tree first
	// (against the live providers), THEN close the opened database handles so
	// no pending effect/route can touch a closed connection, reset the hash
	// router, and finally restore every stub so a failing test can't leak a
	// stubbed fetch/WebSocket into the next one.
	cleanup();
	await Promise.all(openHandles.map((handle) => handle.close().catch(() => {})));
	openHandles.length = 0;
	window.location.hash = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Phase 5 phase-boundary preservation", () => {
	it("keeps SQLCipher encryption on and biometric auth off in capacitor.config.ts", () => {
		const src = readRoot("capacitor.config.ts");
		expect(src).toContain("androidIsEncryption: true");
		expect(src).toContain("biometricAuth: false");
	});

	it("keeps Phase 6 permissions exact while forbidding exact alarms and biometrics", () => {
		const manifest = readRoot("android/app/src/main/AndroidManifest.xml");
		const permissions = [...manifest.matchAll(/<uses-permission[^>]+android:name="([^"]+)"/g)].map(
			(match) => match[1],
		);
		expect(permissions).toEqual([
			"android.permission.POST_NOTIFICATIONS",
			"android.permission.RECEIVE_BOOT_COMPLETED",
		]);
		for (const forbidden of [
			"android.permission.INTERNET",
			"SCHEDULE_EXACT_ALARM",
			"USE_EXACT_ALARM",
			"USE_BIOMETRIC",
			"USE_FINGERPRINT",
		]) {
			expect(manifest).not.toContain(forbidden);
		}
		expect(manifest).toContain('android:allowBackup="false"');
	});

	it("introduces no network calls from Android source", () => {
		// The walker must actually enumerate shipped source before we trust any
		// all-clear: it must be nonempty and must include the two entry points a
		// later phase is most likely to touch first.
		const files = listSourceFiles();
		expect(files.length).toBeGreaterThan(0);
		expect(files).toContain(resolve(ROOT, "src/main.tsx"));
		expect(files).toContain(resolve(ROOT, "src/App.tsx"));
		for (const f of files) {
			const src = readFileSync(f, "utf8");
			if (f === resolve(ROOT, "src/main.tsx")) {
				expect(src).toMatch(
					/<HashRouter>\s*<AppBootstrap[^>]*>\s*<App \/>\s*<\/AppBootstrap>\s*<\/HashRouter>/,
				);
			}
			for (const forbidden of FORBIDDEN_NETWORK) {
				expect(src, `${f}: forbidden network channel "${forbidden.channel}"`).not.toMatch(
					forbidden.re,
				);
			}
		}
	});

	it("proves each forbidden network regex catches every mutation sample of itself", () => {
		// Mutation samples are attached to each FORBIDDEN_NETWORK entry, so a list
		// addition CANNOT lack samples. Assert every entry owns at least one
		// sample and every sample is caught by that entry's own regex. Samples may
		// intentionally overlap when a remote URL uses another network channel.
		for (const entry of FORBIDDEN_NETWORK) {
			expect(
				entry.samples.length,
				`channel "${entry.channel}" must own ≥1 mutation sample`,
			).toBeGreaterThan(0);
			for (const sample of entry.samples) {
				expect(
					entry.re.test(sample),
					`mutation sample "${sample}" must match its own channel "${entry.channel}"`,
				).toBe(true);
			}
		}
	});

	it("serves the auth-gated /weekly route and keeps it before the catch-all", async () => {
		const handle = await openAppDatabase({ open: async () => createTestDb() });
		openHandles.push(handle);
		await handle.auth.setup("correct-horse-battery", "UTC");
		renderApp("/weekly", handle);
		expect(await screen.findByRole("heading", { name: /weekly review/i })).toBeInTheDocument();
		expect(
			await screen.findByRole("heading", { name: /this week, at a glance/i }),
		).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: /write your entry/i })).not.toBeInTheDocument();
	});

	it("renders Phase 8 security without prompts and preserves Phase 7 backup controls", async () => {
		const handle = await openAppDatabase({ open: async () => createTestDb() });
		openHandles.push(handle);
		await handle.auth.setup("correct-horse-battery", "UTC");
		renderApp("/settings", handle);
		await screen.findByLabelText(/timezone/i);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		expect(await screen.findByRole("checkbox", { name: /require device unlock/i })).toBeDisabled();
		expect(screen.queryByText(/arrives in Phase 8/i)).not.toBeInTheDocument();
		expect(screen.getByRole("link", { name: /weekly review/i })).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: /enable weekly review/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Save encrypted backup/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Choose \.rmbak backup/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /overwrite conflicts/i })).not.toBeInTheDocument();
	});

	it("keeps the legacy bundle plus the CSS gate wired in the canonical build scripts", () => {
		const pkg = JSON.parse(readRoot("package.json")) as { scripts: Record<string, string> };
		expect(pkg.scripts.build).toContain("verify-legacy-build.mjs");
		expect(pkg.scripts.build).toContain("verify-legacy-css.mjs");
		// cap:sync must run BOTH verifiers in legacy->css order, and both must
		// complete BEFORE `cap sync android` rebuilds the native project from
		// dist — so a broken legacy bundle or CSS floor is caught pre-sync.
		const capSync = pkg.scripts["cap:sync"];
		expect(capSync).toContain("verify:legacy");
		expect(capSync).toContain("verify:css");
		expect(capSync.indexOf("verify:legacy")).toBeLessThan(capSync.indexOf("verify:css"));
		expect(capSync.indexOf("verify:css")).toBeLessThan(capSync.indexOf("cap sync android"));
	});

	it("preserves the API-24 habit: no Array.prototype.at anywhere in Android source", () => {
		for (const f of listSourceFiles()) {
			const src = readFileSync(f, "utf8");
			// `.at(` as a property access (not index-of-a-string "at"): the
			// Array.prototype.at polyfill gap on API 24 is a contract we keep.
			expect(src).not.toMatch(/\.at\s*\(/);
		}
	});

	it("large-entry boundary: 100,000-char save round-trips while 100,001 rejects client-side", async () => {
		const db = createTestDb();
		const handle = await openAppDatabase({ open: async () => db });
		openHandles.push(handle);
		await handle.auth.setup("correct-horse-battery", "UTC");
		renderApp("/today", handle);
		// Wait for the storage-backed editor to mount on Today.
		const textarea = (await screen.findByLabelText(/Journal entry for/i)) as HTMLTextAreaElement;

		// 100,000-char value is accepted and persisted to real storage.
		fireEvent.change(textarea, { target: { value: "x".repeat(JOURNAL_CONTENT_MAX) } });
		expect(textarea.value).toHaveLength(JOURNAL_CONTENT_MAX);
		await waitFor(async () => {
			const entries = await handle.journal.list();
			expect(entries.some((e) => e.content.length === JOURNAL_CONTENT_MAX)).toBe(true);
		});
		// The settled accepted row, captured for the post-rejection comparison.
		const acceptedBefore = await handle.journal.list();

		// 100,001-char value is rejected client-side: the DOM snaps back and the
		// repository never stores it. Rejection is flushed through the real
		// debounced editor, so we waitFor the snap-back + alert.
		fireEvent.change(textarea, {
			target: { value: "x".repeat(JOURNAL_CONTENT_MAX + 1) },
		});
		await waitFor(() => {
			expect(textarea.value).toHaveLength(JOURNAL_CONTENT_MAX);
			expect(screen.getByRole("alert").textContent).toMatch(/100,000 characters/i);
		});
		// The rejected 100,001-char value is never persisted: the journal keeps
		// exactly the accepted rows, unchanged in row count AND content.
		const after = await handle.journal.list();
		expect(after).toHaveLength(acceptedBefore.length);
		expect(after.every((e) => e.content.length <= JOURNAL_CONTENT_MAX)).toBe(true);
		const accepted = acceptedBefore.find((e) => e.content.length === JOURNAL_CONTENT_MAX);
		const kept = after.find((e) => e.content.length === JOURNAL_CONTENT_MAX);
		expect(kept?.content).toBe(accepted?.content);
	});
});

/**
 * Phase 5 supported end-to-end flow — the REAL offline contract, keep-green.
 *
 * Drives a real migrated in-memory handle through the REAL UI seams exactly
 * as main.tsx does (HashRouter -> AppBootstrap -> StorageProvider ->
 * AuthProvider -> AppearanceSync -> App routes): setup password, persist a
 * deterministic journal entry, update Settings, sign out, verify auth stays
 * configured-but-locked with settings + journal rows intact via the services
 * (no raw DB access, no wipe), log back in with the same password, and assert
 * the content is restored. The whole flow runs under fetch / XMLHttpRequest /
 * WebSocket / EventSource sentinels with zero calls/constructions, and the
 * rendered app never uses remote/account/server language.
 */
describe("Phase 5 supported end-to-end flow (offline, no-wipe)", () => {
	it("setup -> journal persist -> settings -> sign out (no wipe) -> login -> content restored, fully offline", async () => {
		// Offline sentinels installed for the ENTIRE flow; every screen driving
		// real providers/routes/services must never touch the network. The
		// constructors are replaced with spies so any `new XHR/WebSocket/EventSource`
		// would be recorded as a call; fetch is replaced so any call is recorded.
		const fetchSpy = vi.fn();
		const xhrSpy = vi.fn();
		const wsSpy = vi.fn();
		const esSpy = vi.fn();
		const body = document.body;
		const bodyText = () => (body.textContent ?? "").toLowerCase();
		const expectNoRemoteLanguage = () => {
			const text = bodyText();
			// Word-bounded: `remote`/`account`/`server` as whole words only, so
			// legitimate words like “unaccounted” or “serverless” don't trip it,
			// while exact remote/account/server phrases are still banned.
			expect(text).not.toMatch(/\b(?:remote|account|server)\b/);
		};

		vi.stubGlobal("fetch", fetchSpy);
		vi.stubGlobal("XMLHttpRequest", xhrSpy);
		vi.stubGlobal("WebSocket", wsSpy);
		vi.stubGlobal("EventSource", esSpy);

		// The `try` begins BEFORE opening the handle and rendering, so the
		// `finally` sentinels below also cover those first two operations — if
		// opening the DB or mounting the tree ever touched the network or showed
		// remote/account/server language, the finally would already catch it.
		try {
			const handle = await openAppDatabase({ open: async () => createTestDb() });
			openHandles.push(handle);
			renderApp("/journal/2026-08-10", handle);

			// 1. Drive Setup (real SetupForm UI) with the documented password.
			await screen.findByRole("heading", { name: /set up your journal/i });
			expect(
				screen.getByText(/This password protects this journal on this device only/i),
			).toBeInTheDocument();
			fireEvent.change(screen.getByLabelText(/^password$/i), {
				target: { value: "correct-horse-battery" },
			});
			fireEvent.change(screen.getByLabelText(/confirm password/i), {
				target: { value: "correct-horse-battery" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Set up" }));

			// Gate unlocks and the deterministic /journal/2026-08-10 editor mounts.
			const textarea = (await screen.findByLabelText(
				/Journal entry for 2026-08-10/i,
			)) as HTMLTextAreaElement;

			// 2. Persist content through the real debounced editor. Persistence proof
			// is the REAL journal row, never possibly pre-existing/stale "Saved"
			// text: waitFor the stored content to equal what we typed, THEN assert
			// the editor's Saved indicator (test synchronization only).
			const content = "Remembered offline: timezone + weekly setting survived sign-out.";
			fireEvent.change(textarea, { target: { value: content } });
			await waitFor(async () => {
				expect((await handle.journal.get("2026-08-10"))?.content).toBe(content);
			});
			expect(screen.getByText("Saved")).toBeInTheDocument();
			expectNoRemoteLanguage();

			// 3. Update Settings through the real SettingsForm UI (real tab nav).
			fireEvent.click(screen.getByRole("link", { name: /settings/i }));
			const timezone = await screen.findByLabelText(/timezone/i);
			fireEvent.change(timezone, { target: { value: "Europe/Istanbul" } });
			await waitFor(() =>
				expect(screen.getByLabelText(/timezone/i)).toHaveValue("Europe/Istanbul"),
			);
			const weekly = screen.getByLabelText(/enable weekly review/i);
			fireEvent.click(weekly);
			await waitFor(() => expect(screen.getByLabelText(/enable weekly review/i)).toBeChecked());
			expect((await handle.settings.get()).timezone).toBe("Europe/Istanbul");
			expect((await handle.settings.get()).weeklyReviewEnabled).toBe(true);
			// Settings visible: the rendered phase copy must stay offline-clean
			// (no remote/account/server language) even on this screen.
			expectNoRemoteLanguage();

			// 4. Sign out via the real button; the gate re-locks to Login.
			fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
			await screen.findByRole("heading", { name: /unlock your journal/i });

			// 5. Auth remains CONFIGURED but LOCKED; settings + journal rows persist
			// via the services (no raw DB, no wipe).
			const status = await handle.auth.status();
			expect(status.configured).toBe(true);
			expect(status.unlocked).toBe(false);
			const persistedSettings = await handle.settings.get();
			expect(persistedSettings.timezone).toBe("Europe/Istanbul");
			expect(persistedSettings.weeklyReviewEnabled).toBe(true);
			expect((await handle.journal.get("2026-08-10"))?.content).toBe(content);
			expectNoRemoteLanguage();

			// 6. Login with the SAME password through the real Login form.
			fireEvent.change(screen.getByLabelText(/^password$/i), {
				target: { value: "correct-horse-battery" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

			// 7. Navigate back to the journal and assert the content is restored.
			window.location.hash = "#/journal/2026-08-10";
			const restored = (await screen.findByLabelText(
				/Journal entry for 2026-08-10/i,
			)) as HTMLTextAreaElement;
			await waitFor(() => expect(restored).toHaveValue(content));
			expectNoRemoteLanguage();
		} finally {
			// Offline + no-remote contract holds even if a step above fails
			// early: the network sentinels must still report zero
			// calls/constructions, and no screen that rendered may have shown
			// remote/account/server language.
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(xhrSpy).not.toHaveBeenCalled();
			expect(wsSpy).not.toHaveBeenCalled();
			expect(esSpy).not.toHaveBeenCalled();
			expectNoRemoteLanguage();
		}
	});

	it("re-locks the gate even when logout rejects, via the auth-context seam (no wipe)", async () => {
		// A real handle supplies storage/settings copy; the auth seam is a fake
		// AuthSession whose logout REJECTS (real AuthService.logout never does).
		// The context contract (auth-context.tsx) must still lock the session
		// back and let a rejected logout never escape as an unhandled rejection.
		const rejectingLogout: AuthSession = {
			status: async () => ({ configured: true, unlocked: true }),
			setup: async () => ({ configured: true, unlocked: true }),
			login: async () => ({ configured: true, unlocked: true }),
			unlockWithDeviceCredential: async () => ({ configured: true, unlocked: true }),
			logout: async () => {
				throw new Error("underlying logout failed");
			},
		};
		const handle = await createTestHandle();
		openHandles.push(handle);
		await handle.auth.setup("correct-horse-battery", "UTC");
		window.location.hash = "#/settings";
		render(
			<HashRouter>
				<StorageProvider database={handle}>
					<AuthProvider auth={rejectingLogout}>
						<App />
					</AuthProvider>
				</StorageProvider>
			</HashRouter>,
		);

		const signOut = await screen.findByRole("button", { name: /sign out/i });
		fireEvent.click(signOut);

		// The rejecting logout still re-locks to the Login gate; nothing wipes
		// the stored settings/auth; no error leaks onto the page.
		expect(
			await screen.findByRole("heading", { name: /unlock your journal/i }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
		expect((await handle.settings.get()).timezone).toBe("UTC");
		expect((await handle.auth.status()).configured).toBe(true);
	});
});

/**
 * Render the real router + bootstrap gate + App, exactly as main.tsx does,
 * against a real in-memory migrated handle, at the given hash path. This is the
 * honest phase-boundary seam: real providers, real migration, real routes.
 */
function renderApp(path: string, handle: DatabaseHandle) {
	window.location.hash = `#${path}`;
	return render(
		<HashRouter>
			<AppBootstrap attemptNative initializer={async () => handle}>
				<App />
			</AppBootstrap>
		</HashRouter>,
	);
}
