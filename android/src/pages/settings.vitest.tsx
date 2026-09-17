import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageProvider } from "@/db/storage";
import { createTestHandle } from "@/db/test-helper";
import Settings from "@/pages/Settings";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Settings page", () => {
	it("describes only the live preference controls — never claims future security/backup controls", async () => {
		const handle = await createTestHandle();
		render(
			<StorageProvider database={handle}>
				<Settings />
			</StorageProvider>,
		);
		// Ready form (real storage) mounted under the page framing.
		await screen.findByLabelText(/timezone/i);

		expect(screen.getByRole("heading", { name: /^settings$/i })).toBeInTheDocument();
		// Truthful framing: the on-device controls TODAY are timezone, weekly
		// review and appearance. Security and backup are later-phase placeholders
		// (they render their own Phase 7/8 copy inside the form) and must not be
		// advertised as current controls in the page description.
		expect(
			screen.getByText(
				/Timezone, weekly review and appearance preferences — all stored on-device/i,
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/security, backup and appearance controls/i)).not.toBeInTheDocument();
	});
});
