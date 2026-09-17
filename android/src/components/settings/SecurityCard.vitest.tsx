import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SecurityCard, { type SecurityController } from "@/components/settings/SecurityCard";

function controller(overrides: Partial<SecurityController> = {}): SecurityController {
	return {
		getStatus: vi.fn(async () => ({ enabled: false, available: true })),
		setEnabled: vi.fn(async (enabled: boolean) => ({ status: "changed" as const, enabled })),
		...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("SecurityCard", () => {
	it("renders native-authoritative enabled state and recovery guidance", async () => {
		const security = controller({
			getStatus: vi.fn(async () => ({ enabled: true, available: true })),
		});
		render(<SecurityCard security={security} />);
		expect(await screen.findByRole("checkbox", { name: /require device unlock/i })).toBeChecked();
		expect(screen.getByText(/cold start/i)).toBeInTheDocument();
		expect(screen.getByText(/encrypted \.rmbak backup/i)).toBeInTheDocument();
	});

	it("disables the control with clear copy when system authentication is unavailable", async () => {
		const security = controller({
			getStatus: vi.fn(async () => ({ enabled: false, available: false })),
		});
		render(<SecurityCard security={security} />);
		expect(await screen.findByRole("checkbox", { name: /require device unlock/i })).toBeDisabled();
		expect(screen.getByText(/set up a device screen lock/i)).toBeInTheDocument();
	});

	it("enables and disables through authenticated native transitions", async () => {
		let enabled = false;
		const setEnabled = vi.fn(async (next: boolean) => {
			enabled = next;
			return { status: "changed", enabled: next } as const;
		});
		const security = controller({
			getStatus: vi.fn(async () => ({ enabled, available: true })),
			setEnabled,
		});
		render(<SecurityCard security={security} />);
		const toggle = await screen.findByRole("checkbox", { name: /require device unlock/i });
		fireEvent.click(toggle);
		await waitFor(() => expect(toggle).toBeChecked());
		expect(setEnabled).toHaveBeenNthCalledWith(1, true);
		fireEvent.click(toggle);
		await waitFor(() => expect(toggle).not.toBeChecked());
		expect(setEnabled).toHaveBeenNthCalledWith(2, false);
	});

	it("treats cancellation as no change without an alert", async () => {
		const security = controller({
			setEnabled: vi.fn(async () => ({ status: "cancelled" as const, enabled: false })),
		});
		render(<SecurityCard security={security} />);
		const toggle = await screen.findByRole("checkbox", { name: /require device unlock/i });
		fireEvent.click(toggle);
		await waitFor(() => expect(security.setEnabled).toHaveBeenCalledOnce());
		expect(toggle).not.toBeChecked();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("masks native failure detail and can reload authoritative status", async () => {
		const raw = "KeyStoreException alias at /data/user/0 secret";
		const security = controller({
			setEnabled: vi.fn(async () => Promise.reject(new Error(raw))),
		});
		render(<SecurityCard security={security} />);
		fireEvent.click(await screen.findByRole("checkbox", { name: /require device unlock/i }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/couldn't update device unlock/i);
		expect(alert).not.toHaveTextContent(raw);
		fireEvent.click(screen.getByRole("button", { name: /reload security status/i }));
		await waitFor(() => expect(security.getStatus).toHaveBeenCalledTimes(2));
	});

	it("uses the post-transition native reload as authority", async () => {
		const getStatus = vi
			.fn()
			.mockResolvedValueOnce({ enabled: false, available: true })
			.mockResolvedValueOnce({ enabled: false, available: true });
		const security = controller({ getStatus });
		render(<SecurityCard security={security} />);
		const toggle = await screen.findByRole("checkbox", { name: /require device unlock/i });
		fireEvent.click(toggle);
		await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
		expect(toggle).not.toBeChecked();
	});

	it("permits only one active transition", async () => {
		const pending = deferred<{ status: "cancelled"; enabled: false }>();
		const setEnabled = vi.fn(() => pending.promise);
		const security = controller({ setEnabled });
		render(<SecurityCard security={security} />);
		const toggle = await screen.findByRole("checkbox", { name: /require device unlock/i });
		fireEvent.click(toggle);
		fireEvent.click(toggle);
		expect(setEnabled).toHaveBeenCalledOnce();
		await act(async () => pending.resolve({ status: "cancelled", enabled: false }));
	});

	it("ignores stale owner and unmounted completions", async () => {
		const oldStatus = deferred<{ enabled: boolean; available: boolean }>();
		const old = controller({ getStatus: vi.fn(() => oldStatus.promise) });
		const replacement = controller({
			getStatus: vi.fn(async () => ({ enabled: true, available: true })),
		});
		const view = render(<SecurityCard security={old} />);
		view.rerender(<SecurityCard security={replacement} />);
		expect(await screen.findByRole("checkbox", { name: /require device unlock/i })).toBeChecked();
		await act(async () => oldStatus.resolve({ enabled: false, available: true }));
		expect(screen.getByRole("checkbox", { name: /require device unlock/i })).toBeChecked();

		const transition = deferred<{ status: "changed"; enabled: true }>();
		const pending = controller({ setEnabled: vi.fn(() => transition.promise) });
		view.rerender(<SecurityCard security={pending} />);
		const toggle = await screen.findByRole("checkbox", { name: /require device unlock/i });
		fireEvent.click(toggle);
		view.unmount();
		await act(async () => transition.resolve({ status: "changed", enabled: true }));
		expect(pending.getStatus).toHaveBeenCalledOnce();
	});
});
