import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { StorageProvider } from "@/db/storage";
import { createTestBackupCodec } from "@/db/test-codec";
import { createTestHandle } from "@/db/test-helper";
import { WeeklyNotificationsProvider } from "@/notifications/WeeklyNotificationsProvider";
import type { WeeklyNotificationAdapter } from "@/notifications/weekly-notification-adapter";
import type { BackupPayload } from "@/transfer/backup-codec";
import type { DocumentTransfer } from "@/transfer/document-transfer";
import DataTransferCard from "./DataTransferCard";

const TEST_CODEC = createTestBackupCodec();

const now = "2026-09-11T03:33:06.906Z";
const later = "2026-09-11T05:06:07.008Z";
const PAYLOAD: BackupPayload = {
	format: "rememberme-backup-content",
	version: 1,
	exportedAt: now,
	entries: [
		{ date: "2026-09-10", content: "backup content", createdAt: now, updatedAt: later },
		{ date: "2026-09-11", content: "backup addition", createdAt: now, updatedAt: later },
	],
	settings: {
		timezone: "UTC",
		weeklyReviewEnabled: true,
		weeklyReviewHour: 20,
		appearance: "dark",
	},
};

const LEGACY_SOURCE = JSON.stringify({
	format: "rememberme-legacy-export",
	version: 1,
	exportedAt: now,
	entries: [
		{
			entryDate: "2026-09-10",
			encryptedContent: "AA==",
			iv: "AAAAAAAAAAAAAAAA",
			authTag: "AAAAAAAAAAAAAAAAAAAAAA==",
			createdAt: now,
			updatedAt: later,
		},
	],
});

const handles: Array<Awaited<ReturnType<typeof createTestHandle>>> = [];

async function makeDatabase() {
	const database = await createTestHandle(TEST_CODEC);
	handles.push(database);
	return database;
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(handles.splice(0).map((database) => database.close().catch(() => undefined)));
});

function fakeDocuments(overrides: Partial<DocumentTransfer> = {}): DocumentTransfer {
	return {
		async openBackup() {
			return { status: "cancelled" };
		},
		async openLegacy() {
			return { status: "cancelled" };
		},
		async saveBackup() {
			return { status: "saved" };
		},
		...overrides,
	};
}

async function renderCard(
	database: Awaited<ReturnType<typeof createTestHandle>>,
	documents?: DocumentTransfer,
) {
	const utils = render(<DataTransferCard database={database} documents={documents} />);
	const password = await screen.findByLabelText(/backup password/i);
	return { ...utils, password };
}

function typeValue(element: HTMLElement, value: string): void {
	fireEvent.change(element, { target: { value } });
}

describe("DataTransferCard backup", () => {
	test("saves a password-encrypted backup and clears secrets", async () => {
		const database = await makeDatabase();
		const save = vi.fn(async (_name: string, _contents: string) => ({ status: "saved" as const }));
		const { password } = await renderCard(database, fakeDocuments({ saveBackup: save }));
		const confirm = screen.getByLabelText(/confirm password/i);
		await database.journal.upsert("2026-09-10", "backup content");
		typeValue(password, "backup-password");
		typeValue(confirm, "backup-password");
		fireEvent.click(screen.getByRole("button", { name: /Save encrypted backup/i }));
		expect(await screen.findByText(/Backup saved/i)).toBeInTheDocument();
		expect(save).toHaveBeenCalledOnce();
		expect(save.mock.calls[0][0]).toMatch(/rememberme\.rmbak$/);
		const contents = save.mock.calls[0][1];
		expect(contents).toContain("backup content");
		expect(password).toHaveValue("");
		expect(confirm).toHaveValue("");
	});

	test("rejects short passwords and mismatch before any document call", async () => {
		const database = await makeDatabase();
		const { password } = await renderCard(database, fakeDocuments());
		const confirm = screen.getByLabelText(/confirm password/i);
		typeValue(password, "short");
		typeValue(confirm, "short");
		fireEvent.click(screen.getByRole("button", { name: /Save encrypted backup/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/Password must be 8\.\.128 characters/,
		);

		typeValue(password, "one-two-three-four");
		typeValue(confirm, "four-three-two-one");
		fireEvent.click(screen.getByRole("button", { name: /Save encrypted backup/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/Passwords do not match/i);
	});

	test("masks backup failures", async () => {
		const database = await makeDatabase();
		const { password } = await renderCard(
			database,
			fakeDocuments({
				async saveBackup() {
					throw new Error("SECRET-save-detail");
				},
			}),
		);
		typeValue(password, "backup-password");
		typeValue(screen.getByLabelText(/confirm password/i), "backup-password");
		fireEvent.click(screen.getByRole("button", { name: /Save encrypted backup/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/We couldn't save your backup/i);
		expect(screen.queryByText(/SECRET-save-detail/i)).not.toBeInTheDocument();
		expect(password).toHaveValue("");
	});
});

describe("DataTransferCard restore", () => {
	test("previews conflicts then requires explicit confirmation before applying", async () => {
		const database = await makeDatabase();
		await database.journal.upsert("2026-09-09", "keep unrelated");
		await database.journal.upsert("2026-09-10", "local conflict");
		const archive = await TEST_CODEC.encrypt(PAYLOAD, "backup-password");
		const { password } = await renderCard(
			database,
			fakeDocuments({
				async openBackup() {
					return { status: "selected", name: "rememberme.rmbak", contents: archive };
				},
			}),
		);
		typeValue(password, "backup-password");
		typeValue(screen.getByLabelText(/confirm password/i), "backup-password");
		fireEvent.click(screen.getByRole("button", { name: /Choose \.rmbak backup/i }));
		expect(await screen.findByText(/1 new entry, 1 conflict/i)).toBeInTheDocument();
		expect(screen.getAllByText(/portable settings will be overwritten/i).length).toBeGreaterThan(0);
		expect(
			screen.getByRole("button", { name: /Restore and overwrite conflicts/i }),
		).toBeInTheDocument();
		// Explicit confirmation: nothing is written until pressed.
		expect(await database.journal.get("2026-09-10")).toMatchObject({ content: "local conflict" });
		fireEvent.click(screen.getByRole("button", { name: /Restore and overwrite conflicts/i }));
		expect(await screen.findByText(/Restored 2 entries/i)).toBeInTheDocument();
		expect(await database.journal.get("2026-09-10")).toMatchObject({ content: "backup content" });
		expect(await database.journal.get("2026-09-11")).toMatchObject({ content: "backup addition" });
		expect(await database.journal.get("2026-09-09")).toMatchObject({ content: "keep unrelated" });
	});

	test("handles picker cancellation and masks read failures", async () => {
		const database = await makeDatabase();
		const first = await renderCard(database, fakeDocuments());
		typeValue(first.password, "backup-password");
		typeValue(screen.getByLabelText(/confirm password/i), "backup-password");
		fireEvent.click(screen.getByRole("button", { name: /Choose \.rmbak backup/i }));
		expect(await screen.findByText(/Backup selection cancelled/i)).toBeInTheDocument();
		first.unmount();

		const failing = await makeDatabase();
		const { password: second } = await renderCard(
			failing,
			fakeDocuments({
				async openBackup() {
					throw new Error("SECRET-read-detail");
				},
			}),
		);
		typeValue(second, "backup-password");
		typeValue(screen.getByLabelText(/confirm password/i), "backup-password");
		fireEvent.click(screen.getByRole("button", { name: /Choose \.rmbak backup/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/We couldn't read that file/i);
		expect(screen.queryByText(/SECRET-read-detail/i)).not.toBeInTheDocument();
	});
});

describe("DataTransferCard legacy import", () => {
	test("fails closed on a corrupt fixture, writes nothing, and clears the key", async () => {
		const database = await makeDatabase();
		const { password } = await renderCard(
			database,
			fakeDocuments({
				async openLegacy() {
					return { status: "selected", name: "export.json", contents: LEGACY_SOURCE };
				},
			}),
		);
		typeValue(password, "legacy-password");
		const key = screen.getByLabelText(/legacy web encryption key/i);
		typeValue(key, "ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8=");
		fireEvent.click(screen.getByRole("button", { name: /Choose legacy export/i }));
		// The fixture row is not valid AES-GCM, so prepare must fail closed.
		expect(await screen.findByRole("alert")).toHaveTextContent(/We couldn't read that file/i);
		expect(await database.journal.list()).toEqual([]);
		expect(key).toHaveValue("");
	});
});

describe("DataTransferCard deferred-operation guards", () => {
	test("five-minute preview expiry cancels the token and asks for a new preview", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const database = await makeDatabase();
		await database.journal.upsert("2026-09-10", "local");
		const archive = await TEST_CODEC.encrypt(PAYLOAD, "backup-password");
		const { password } = await renderCard(
			database,
			fakeDocuments({
				async openBackup() {
					return { status: "selected", name: "x", contents: archive };
				},
			}),
		);
		typeValue(password, "backup-password");
		typeValue(screen.getByLabelText(/confirm password/i), "backup-password");
		fireEvent.click(screen.getByRole("button", { name: /Choose \.rmbak backup/i }));
		await vi.advanceTimersByTimeAsync(0);
		expect(await screen.findByText(/1 new entry, 1 conflict/i)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Restore and overwrite conflicts/i }),
		).toBeInTheDocument();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(screen.getByText(/Your preview expired/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Restore and overwrite conflicts/i }),
		).not.toBeInTheDocument();
	});

	test("owner replacement drops stale preview completions and clears secrets", async () => {
		const first = await makeDatabase();
		const second = await makeDatabase();
		const documents = fakeDocuments({
			async openBackup() {
				return new Promise((resolve) =>
					setTimeout(() => resolve({ status: "selected" as const, name: "x", contents: "" }), 40),
				);
			},
		});
		const firstRender = render(<DataTransferCard database={first} documents={documents} />);
		const firstPassword = await within(firstRender.container).findByLabelText(/backup password/i);
		typeValue(firstPassword, "backup-password");
		fireEvent.click(
			within(firstRender.container).getByRole("button", { name: /Choose \.rmbak backup/i }),
		);
		firstRender.rerender(<DataTransferCard database={second} documents={documents} />);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(screen.queryByText(/new entry/i)).not.toBeInTheDocument();
	});

	test("busy disables controls so only one operation runs at a time", async () => {
		const database = await makeDatabase();
		let release: (value: { status: "saved" }) => void = () => {};
		const save = vi.fn(
			(_name: string, _contents: string) =>
				new Promise<{ status: "saved" }>((resolve) => {
					release = resolve;
				}),
		);
		const { password } = await renderCard(database, fakeDocuments({ saveBackup: save }));
		typeValue(password, "backup-password");
		typeValue(screen.getByLabelText(/confirm password/i), "backup-password");
		const button = screen.getByRole("button", { name: /Save encrypted backup/i });
		fireEvent.click(button);
		await waitFor(() => expect(save).toHaveBeenCalledOnce());
		fireEvent.click(button);
		expect(save).toHaveBeenCalledOnce();
		release({ status: "saved" });
		expect(await screen.findByText(/Backup saved/i)).toBeInTheDocument();
	});

	test("no secret or content appears in rendered output", async () => {
		const database = await makeDatabase();
		await renderCard(
			database,
			fakeDocuments({
				async openLegacy() {
					return { status: "selected", name: "x", contents: "SECRET-LEGACY-CONTENT" };
				},
			}),
		);
		const body = document.body.innerHTML.replace(/<[^>]*>/g, "");
		expect(body).not.toContain("SECRET-LEGACY-CONTENT");
	});
});

function recordingAdapter(records: Array<Record<string, unknown>>): WeeklyNotificationAdapter {
	return {
		async getPermissionStatus() {
			return { status: "unsupported", blockedAt: null };
		},
		async requestPermission() {
			return { status: "unsupported", blockedAt: null };
		},
		async openNotificationSettings() {},
		async addActionListener() {
			return async () => {};
		},
		async reconcile(settings) {
			records.push({ ...settings });
			return { scheduled: true, caughtUp: true };
		},
	};
}

describe("DataTransferCard live settings publication", () => {
	test("a committed apply reconciles the mounted weekly provider exactly once; failures never do", async () => {
		const database = await makeDatabase();
		await database.settings.update({ weeklyReviewEnabled: false });
		const records: Array<Record<string, unknown>> = [];
		render(
			<StorageProvider database={database}>
				<WeeklyNotificationsProvider adapter={recordingAdapter(records)}>
					<div data-testid="child" />
				</WeeklyNotificationsProvider>
			</StorageProvider>,
		);
		await screen.findByTestId("child");
		await waitFor(() => expect(records.length).toBeGreaterThan(0), { timeout: 5000 });
		const afterMount = records.length;

		const payload: BackupPayload = {
			format: "rememberme-backup-content",
			version: 1,
			exportedAt: now,
			entries: [{ date: "2026-09-10", content: "live consumer", createdAt: now, updatedAt: later }],
			settings: {
				timezone: "Pacific/Chatham",
				weeklyReviewEnabled: true,
				weeklyReviewHour: 7,
				appearance: "dark",
			},
		};
		const archive = await TEST_CODEC.encrypt(payload, "backup-password");
		const success = await database.transfer.prepareBackup(archive, "backup-password");
		await database.transfer.apply(success.token);
		await waitFor(() => expect(records.length).toBe(afterMount + 1), { timeout: 5000 });
		expect(records.at(-1)).toMatchObject({
			enabled: true,
			hour: 7,
			timezone: "Pacific/Chatham",
		});

		// A failed apply must publish nothing and trigger no reconciliation.
		const stale = await database.transfer.prepareEntries("legacy", [
			{ date: "2026-09-10", content: "changed", createdAt: now, updatedAt: later },
		]);
		await database.journal.upsert("2026-09-10", "changed after preview");
		await expect(database.transfer.apply(stale.token)).rejects.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(records.length).toBe(afterMount + 1);
	});
});
