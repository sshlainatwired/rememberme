import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { AuthProvider } from "@/auth/auth-context";
import SettingsForm from "@/components/settings/SettingsForm";
import { type DatabaseHandle, openAppDatabase } from "@/db/bootstrap";
import { StorageProvider } from "@/db/storage";
import { createTestDb, createTestHandle } from "@/db/test-helper";
import { useSettings } from "@/db/use-settings";
import type { DeviceUnlockAdapter } from "@/security/device-unlock";

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Storage-backed render: SettingsForm directly inside the storage provider.
 * The real in-memory SQLite handle is the source of truth for persisted values.
 */
function renderForm(database: DatabaseHandle | null) {
	return render(
		<StorageProvider database={database}>
			<SettingsForm />
		</StorageProvider>,
	);
}

function SettingsMirrorProbe() {
	const { settings } = useSettings();
	return <output>{`security-mirror:${String(settings?.biometricEnabled ?? false)}`}</output>;
}

function nativeSecurityAdapter() {
	let enabled = false;
	const setEnabled = vi.fn(async (next: boolean) => {
		enabled = next;
		return { status: "changed" as const, enabled };
	});
	const adapter: DeviceUnlockAdapter = {
		prepare: vi.fn(async () => ({ enabled: false, authenticated: false })),
		status: vi.fn(async () => ({ enabled, available: true })),
		setEnabled,
		authenticate: vi.fn(async () => "authenticated" as const),
	};
	return { adapter, setEnabled };
}

describe("SettingsForm: persistence through the settings service", () => {
	it("persists a changed timezone", async () => {
		const handle = await createTestHandle();
		renderForm(handle);
		const timezone = await screen.findByLabelText(/timezone/i);

		fireEvent.change(timezone, { target: { value: "Europe/Istanbul" } });
		await waitFor(() => expect(screen.getByLabelText(/timezone/i)).toHaveValue("Europe/Istanbul"));
		expect((await handle.settings.get()).timezone).toBe("Europe/Istanbul");
	});

	it("persists appearance light/dark/system through the radio group", async () => {
		const handle = await createTestHandle();
		renderForm(handle);
		await screen.findByLabelText(/timezone/i);

		for (const appearance of ["light", "dark", "system"]) {
			fireEvent.click(screen.getByLabelText(new RegExp(`^${appearance}$`, "i")));
			await waitFor(async () => {
				expect((await handle.settings.get()).appearance).toBe(appearance);
			});
			await waitFor(() =>
				expect(screen.getByLabelText(new RegExp(`^${appearance}$`, "i"))).toBeChecked(),
			);
		}
	});

	it("persists weeklyReviewEnabled and weeklyReviewHour and shows current delivery copy", async () => {
		const handle = await createTestHandle();
		renderForm(handle);
		await screen.findByLabelText(/timezone/i);

		const toggle = await screen.findByLabelText(/enable weekly review/i);
		fireEvent.click(toggle);
		await waitFor(() => expect(screen.getByLabelText(/enable weekly review/i)).toBeChecked());
		expect((await handle.settings.get()).weeklyReviewEnabled).toBe(true);

		const hour = screen.getByLabelText(/^hour$/i);
		fireEvent.change(hour, { target: { value: "21" } });
		await waitFor(() => expect(screen.getByLabelText(/^hour$/i)).toHaveValue("21"));
		expect((await handle.settings.get()).weeklyReviewHour).toBe(21);

		expect(
			screen.getByText(
				"When enabled, your local reminder is scheduled for this hour each Sunday. The in-app Weekly Review stays available even if notifications are blocked.",
			),
		).toBeInTheDocument();
	});
});

describe("SettingsForm: security and backup controls", () => {
	it("shows an honest unavailable security control and keeps Phase 7 controls functional", async () => {
		const handle = await createTestHandle();
		renderForm(handle);
		await screen.findByLabelText(/timezone/i);

		expect(screen.queryByText(/arrives in Phase 8/i)).not.toBeInTheDocument();
		expect(await screen.findByRole("checkbox", { name: /require device unlock/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /Save encrypted backup/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Choose \.rmbak backup/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Choose legacy export/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /overwrite conflicts/i })).not.toBeInTheDocument();
	});

	it("enables and disables native protection, mirrors the committed setting, and leaves backup controls mounted", async () => {
		const native = nativeSecurityAdapter();
		const handle = await openAppDatabase({
			open: async () => createTestDb(),
			deviceUnlockAdapter: native.adapter,
		});
		render(
			<StorageProvider database={handle}>
				<SettingsForm />
				<SettingsMirrorProbe />
			</StorageProvider>,
		);
		const toggle = await screen.findByRole("checkbox", { name: /require device unlock/i });
		expect(toggle).not.toBeChecked();
		fireEvent.click(toggle);
		await waitFor(() => expect(toggle).toBeChecked());
		await waitFor(() => expect(screen.getByText("security-mirror:true")).toBeInTheDocument());
		expect((await handle.settings.get()).biometricEnabled).toBe(true);
		expect(native.setEnabled).toHaveBeenNthCalledWith(1, true);

		fireEvent.click(toggle);
		await waitFor(() => expect(toggle).not.toBeChecked());
		await waitFor(() => expect(screen.getByText("security-mirror:false")).toBeInTheDocument());
		expect((await handle.settings.get()).biometricEnabled).toBe(false);
		expect(native.setEnabled).toHaveBeenNthCalledWith(2, false);
		expect(screen.getByRole("button", { name: /Save encrypted backup/i })).toBeInTheDocument();
	});
});

describe("SettingsForm: sign out returns to the login gate", () => {
	it("signs out via the auth context and returns to the login gate", async () => {
		const handle = await createTestHandle();
		// A fully-configured + unlocked session, so /settings renders behind the gate.
		await handle.auth.setup("a-secure-pass", "UTC");
		window.location.hash = "#/settings";
		render(
			<HashRouter>
				<StorageProvider database={handle}>
					<AuthProvider auth={handle.auth}>
						<App />
					</AuthProvider>
				</StorageProvider>
			</HashRouter>,
		);

		const signOut = await screen.findByRole("button", { name: /sign out/i });
		fireEvent.click(signOut);

		// The protected route locks: the login form replaces the settings screen.
		expect(
			await screen.findByRole("heading", { name: /unlock your journal/i }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
	});
});

describe("SettingsForm: failure + absence fail closed", () => {
	it("masks a failed settings update behind stable copy (never raw error detail)", async () => {
		const handle = await createTestHandle();
		renderForm(handle);
		await screen.findByLabelText(/timezone/i);

		vi.spyOn(handle.settings, "update").mockRejectedValueOnce(
			new Error("disk full: /data/user/0/db/settings.sqlite"),
		);
		fireEvent.change(screen.getByLabelText(/timezone/i), {
			target: { value: "Europe/Istanbul" },
		});

		const alert = await screen.findByRole("alert");
		// Stable, safe user copy — the raw internal message/path/SQL must never
		// reach the DOM (the hook keeps the message for control flow only).
		expect(alert.textContent).toMatch(/couldn't save your settings/i);
		expect(alert.textContent).not.toMatch(/disk full|sqlite/i);
	});

	it("offers Try again after an initial read failure and recovers without raw error detail", async () => {
		const handle = await createTestHandle();
		// The first (mount) read rejects with an internal-sounding engine error;
		// the UI must mask it and offer a retry that recovers once the read works.
		vi.spyOn(handle.settings, "get").mockRejectedValueOnce(
			new Error("SQLITE_ERROR: no such table: settings (code 1)"),
		);
		renderForm(handle);

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/couldn't load your settings/i);
		expect(alert.textContent).not.toMatch(/SQLITE_ERROR|no such table|sqlite/i);
		const retry = screen.getByRole("button", { name: /try again/i });
		expect(retry).toBeInTheDocument();
		expect(screen.queryByLabelText(/timezone/i)).not.toBeInTheDocument();

		// The retry re-reads storage (the once-rejection is spent) and the ready
		// form replaces the failure alert.
		fireEvent.click(retry);
		await screen.findByLabelText(/timezone/i);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("renders the storage-absent fail-closed copy without a database", () => {
		renderForm(null);
		expect(screen.getByText(/Settings require the on-device database/i)).toBeInTheDocument();
		expect(screen.queryByLabelText(/timezone/i)).not.toBeInTheDocument();
	});
});

describe("SettingsForm: control contents and label association", () => {
	it("lists UTC and a sample IANA zone in the timezone select", async () => {
		const handle = await createTestHandle();
		renderForm(handle);
		const select = await screen.findByLabelText(/timezone/i);
		const zones = [...select.querySelectorAll("option")].map((o) => o.getAttribute("value"));
		expect(zones).toContain("UTC");
		expect(zones).toContain("Europe/Istanbul");
	});

	it("covers hours 0..23 in the weekly hour select", async () => {
		const handle = await createTestHandle();
		renderForm(handle);
		await screen.findByLabelText(/timezone/i);
		const select = await screen.findByLabelText(/^hour$/i);
		const hours = [...select.querySelectorAll("option")].map((o) =>
			Number(o.getAttribute("value")),
		);
		expect(hours[0]).toBe(0);
		expect(hours[hours.length - 1]).toBe(23);
		expect(hours).toHaveLength(24);
		expect(hours.every((h) => Number.isInteger(h) && h >= 0 && h <= 23)).toBe(true);
	});

	it("associates control labels via htmlFor/id (getByLabelText resolves through real labels)", async () => {
		const handle = await createTestHandle();
		renderForm(handle);

		const timezone = await screen.findByLabelText(/timezone/i);
		expect(timezone.tagName).toBe("SELECT");
		const tzLabel = document.querySelector(`label[for="${timezone.id}"]`);
		expect(tzLabel).not.toBeNull();
		expect(tzLabel?.textContent).toMatch(/timezone/i);

		const hour = screen.getByLabelText(/^hour$/i);
		expect(hour.tagName).toBe("SELECT");
		const hourLabel = document.querySelector(`label[for="${hour.id}"]`);
		expect(hourLabel).not.toBeNull();
		expect(hourLabel?.textContent).toMatch(/^hour$/i);
	});
});
