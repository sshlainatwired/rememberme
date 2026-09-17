import { act, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/auth/auth-context";
import { AppearanceSync } from "@/components/layout/AppBootstrap";
import SettingsForm from "@/components/settings/SettingsForm";
import type { DatabaseHandle } from "@/db/bootstrap";
import { type AppSettings, DEFAULT_SETTINGS } from "@/db/settings";
import { StorageProvider } from "@/db/storage";
import { createTestHandle } from "@/db/test-helper";
import { useSettings } from "@/db/use-settings";
import Archive from "@/pages/Archive";
import Today from "@/pages/Today";

const NOW = new Date("2026-09-01T00:30:00Z");

function DirectSettingsProbe() {
	const { settings, error } = useSettings();
	return (
		<div data-testid="direct-settings">
			{settings?.timezone ?? "null"}:{error ?? "null"}
		</div>
	);
}

function RebindConsumers() {
	return (
		<HashRouter>
			<AppearanceSync>
				<DirectSettingsProbe />
				<Today now={NOW} />
				<Archive now={NOW} />
				<SettingsForm />
			</AppearanceSync>
		</HashRouter>
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("storage identity rebind fail-closed consumers", () => {
	it("clears every owner-bound consumer before deferred handle B settings resolve", async () => {
		vi.stubGlobal("matchMedia", () => ({
			matches: true,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
		}));
		const handleA = await createTestHandle();
		const handleB = await createTestHandle();
		await handleA.settings.update({
			timezone: "America/New_York",
			appearance: "light",
			weeklyReviewEnabled: true,
			weeklyReviewHour: 7,
		});
		await handleB.settings.update({ timezone: "Asia/Tokyo", appearance: "dark" });

		let releaseB!: (value: AppSettings) => void;
		const deferredB = new Promise<AppSettings>((resolve) => {
			releaseB = resolve;
		});
		const getBSpy = vi.spyOn(handleB.settings, "get").mockReturnValue(deferredB);

		let database: DatabaseHandle | null = handleA;
		const view = render(
			<StorageProvider database={database}>
				<AuthProvider auth={null}>
					<RebindConsumers />
				</AuthProvider>
			</StorageProvider>,
		);
		await screen.findByLabelText(/timezone/i);
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
		expect(screen.getByLabelText(/timezone/i)).toHaveValue("America/New_York");
		expect(screen.getByLabelText(/^hour$/i)).toHaveValue("7");
		expect(screen.getByRole("heading", { name: /write your entry/i })).toBeInTheDocument();
		expect(screen.getByText("August 2026")).toBeInTheDocument();

		database = handleB;
		view.rerender(
			<StorageProvider database={database}>
				<AuthProvider auth={null}>
					<RebindConsumers />
				</AuthProvider>
			</StorageProvider>,
		);

		// This is intentionally synchronous: B's settings read is still deferred.
		expect(getBSpy).toHaveBeenCalled();
		expect(screen.getByTestId("direct-settings")).toHaveTextContent("null:null");
		expect(screen.queryByLabelText(/timezone/i)).not.toBeInTheDocument();
		expect(screen.queryByLabelText(/^hour$/i)).not.toBeInTheDocument();
		expect(document.documentElement.dataset.theme).not.toBe("light");
		expect(screen.queryByRole("heading", { name: /write your entry/i })).not.toBeInTheDocument();
		expect(screen.queryByText("August 2026")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /Monday, August 31, 2026/i }),
		).not.toBeInTheDocument();

		await act(async () => {
			releaseB({
				...DEFAULT_SETTINGS,
				timezone: "Asia/Tokyo",
				appearance: "dark",
			});
			await Promise.resolve();
		});
		await screen.findByLabelText(/timezone/i);
		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
		expect(screen.getByLabelText(/timezone/i)).toHaveValue("Asia/Tokyo");
		view.unmount();
	});
});
