// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import { encodeUtf8 } from "./base64";
import { createDocumentTransfer, type DocumentTransferPlugin } from "./document-transfer";

const MAX_BYTES = 16 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

interface CapturedOptions {
	openDocument?: { mimeTypes: string[]; maxBytes: number };
	saveDocument?: {
		suggestedName: string;
		mimeType: string;
		bytesBase64: string;
		maxBytes: number;
	};
}

function fakePlugin(overrides: Partial<DocumentTransferPlugin> = {}) {
	const captured: CapturedOptions = {};
	const plugin: DocumentTransferPlugin = {
		async openDocument(options) {
			captured.openDocument = options;
			return { status: "cancelled" };
		},
		async saveDocument(options) {
			captured.saveDocument = options;
			return { status: "saved" };
		},
		...overrides,
	};
	return { plugin, captured };
}

describe("document transfer adapter", () => {
	test("opens a backup with the exact MIME and byte limit and decodes UTF-8 content", async () => {
		const content = "日本語のバックアップ 📖";
		const { plugin, captured } = fakePlugin({
			async openDocument(options) {
				captured.openDocument = options;
				return {
					status: "selected",
					name: "rememberme.rmbak",
					bytesBase64: bytesToBase64(encodeUtf8(content)),
				};
			},
		});
		const adapter = createDocumentTransfer(plugin);
		expect(await adapter.openBackup()).toEqual({
			status: "selected",
			name: "rememberme.rmbak",
			contents: content,
		});
		expect(captured.openDocument).toEqual({ mimeTypes: ["application/json"], maxBytes: MAX_BYTES });
	});

	test("opens a legacy export and cancels normally", async () => {
		const { plugin, captured } = fakePlugin();
		const adapter = createDocumentTransfer(plugin);
		expect(await adapter.openLegacy()).toEqual({ status: "cancelled" });
		expect(captured.openDocument).toEqual({ mimeTypes: ["application/json"], maxBytes: MAX_BYTES });
	});

	test("saves a backup with canonical base64 and the exact options", async () => {
		const contents = "encrypted archive body";
		const { plugin, captured } = fakePlugin();
		const adapter = createDocumentTransfer(plugin);
		expect(await adapter.saveBackup("rememberme.rmbak", contents)).toEqual({ status: "saved" });
		expect(captured.saveDocument?.suggestedName).toBe("rememberme.rmbak");
		expect(captured.saveDocument?.mimeType).toBe("application/json");
		expect(captured.saveDocument?.maxBytes).toBe(MAX_BYTES);
		expect(captured.saveDocument?.bytesBase64).toBe(bytesToBase64(encodeUtf8(contents)));
	});

	test("rejects malformed native results with masked stable errors", async () => {
		const cases: Array<Awaited<ReturnType<DocumentTransferPlugin["openDocument"]>>> = [
			{ status: "selected", name: "x", bytesBase64: "not base64!" },
			{ status: "wat" as never },
			{ status: "selected", name: 5 as never, bytesBase64: "AQ==" },
			{ status: "selected", bytesBase64: "AQ==" } as never,
			{ status: "selected", name: "x", bytesBase64: "AQ==", extra: true } as never,
		];
		for (const result of cases) {
			const { plugin } = fakePlugin({
				async openDocument() {
					return result;
				},
			});
			await expect(createDocumentTransfer(plugin).openBackup()).rejects.toThrow(
				"Could not read the selected document.",
			);
		}
	});

	test("rejects oversized decoded documents with a masked error", async () => {
		const huge = new Uint8Array(MAX_BYTES + 1);
		const { plugin } = fakePlugin({
			async openDocument() {
				return { status: "selected", name: "huge", bytesBase64: bytesToBase64(huge) };
			},
		});
		await expect(createDocumentTransfer(plugin).openBackup()).rejects.toThrow(
			"document is too large",
		);
	});

	test("rejects oversize saves before invoking the native bridge", async () => {
		const open = vi.fn();
		const save = vi.fn(async () => ({ status: "saved" as const }));
		const adapter = createDocumentTransfer({ openDocument: open, saveDocument: save });
		await expect(adapter.saveBackup("x.rmbak", "a".repeat(MAX_BYTES + 1))).rejects.toThrow(
			"document is too large",
		);
		expect(save).not.toHaveBeenCalled();
	});

	test("maps native rejections to stable masked errors without echoing details", async () => {
		const { plugin } = fakePlugin({
			async openDocument() {
				throw new Error("SECRET-native-detail");
			},
			async saveDocument() {
				throw new Error("SECRET-save-detail");
			},
		});
		const adapter = createDocumentTransfer(plugin);
		await expect(adapter.openBackup()).rejects.toThrow("Could not read the selected document.");
		await expect(adapter.openLegacy()).rejects.toThrow("Could not read the selected document.");
		await expect(adapter.saveBackup("x.rmbak", "body")).rejects.toThrow(
			"Could not save the document.",
		);
	});

	test("returns fresh isolated result objects", async () => {
		const nativeResult = {
			status: "selected" as const,
			name: "a",
			bytesBase64: bytesToBase64(encodeUtf8("x")),
		};
		const { plugin } = fakePlugin({
			async openDocument() {
				return nativeResult;
			},
		});
		const result = await createDocumentTransfer(plugin).openBackup();
		expect(result).not.toBe(nativeResult);
		expect(result).toEqual({ status: "selected", name: "a", contents: "x" });
	});
});
