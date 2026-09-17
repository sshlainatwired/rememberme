import { registerPlugin } from "@capacitor/core";
import { MAX_TRANSFER_BYTES } from "./backup-codec";
import { decodeBase64, decodeUtf8, encodeBase64, encodeUtf8, wipe } from "./base64";

/** Native bridge result for document selection. */
export interface DocumentTransferPlugin {
	openDocument(options: {
		mimeTypes: string[];
		maxBytes: number;
	}): Promise<{ status: "cancelled" } | { status: "selected"; name: string; bytesBase64: string }>;
	saveDocument(options: {
		suggestedName: string;
		mimeType: string;
		bytesBase64: string;
		maxBytes: number;
	}): Promise<{ status: "cancelled" | "saved" }>;
}

export type OpenDocumentResult =
	| { status: "cancelled" }
	| { status: "selected"; name: string; contents: string };

export interface DocumentTransfer {
	openLegacy(): Promise<OpenDocumentResult>;
	openBackup(): Promise<OpenDocumentResult>;
	saveBackup(suggestedName: string, contents: string): Promise<{ status: "cancelled" | "saved" }>;
}

const JSON_MIME_TYPES = ["application/json"];
const READ_ERROR = "Could not read the selected document.";
const SAVE_ERROR = "Could not save the document.";
const TOO_LARGE = "The document is too large.";

class TooLargeError extends Error {
	constructor() {
		super(TOO_LARGE);
	}
}

class ReadError extends Error {
	constructor() {
		super(READ_ERROR);
	}
}

class SaveError extends Error {
	constructor() {
		super(SAVE_ERROR);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Strictly validate and convert one native open result; returns a fresh object. */
function parseOpenResult(result: unknown): OpenDocumentResult {
	if (isRecord(result) && hasExactKeys(result, ["status"]) && result.status === "cancelled") {
		return { status: "cancelled" };
	}
	if (!isRecord(result) || !hasExactKeys(result, ["status", "name", "bytesBase64"])) {
		throw new ReadError();
	}
	if (
		result.status !== "selected" ||
		typeof result.name !== "string" ||
		typeof result.bytesBase64 !== "string"
	) {
		throw new ReadError();
	}
	let bytes: Uint8Array<ArrayBuffer> | undefined;
	try {
		bytes = decodeBase64(result.bytesBase64, "Document");
		if (bytes.length > MAX_TRANSFER_BYTES) throw new TooLargeError();
		return { status: "selected", name: result.name, contents: decodeUtf8(bytes, "Document") };
	} finally {
		wipe(bytes);
	}
}

function open(plugin: DocumentTransferPlugin): Promise<OpenDocumentResult> {
	return plugin
		.openDocument({ mimeTypes: JSON_MIME_TYPES, maxBytes: MAX_TRANSFER_BYTES })
		.then(parseOpenResult)
		.catch((cause) => {
			if (cause instanceof TooLargeError) throw cause;
			throw new ReadError();
		});
}

export function createDocumentTransfer(plugin: DocumentTransferPlugin): DocumentTransfer {
	return {
		openLegacy: () => open(plugin),
		openBackup: () => open(plugin),
		async saveBackup(suggestedName, contents) {
			let bytes: Uint8Array<ArrayBuffer> | undefined;
			try {
				bytes = encodeUtf8(contents);
				if (bytes.length > MAX_TRANSFER_BYTES) throw new TooLargeError();
				const result = await plugin.saveDocument({
					suggestedName,
					mimeType: "application/json",
					bytesBase64: encodeBase64(bytes),
					maxBytes: MAX_TRANSFER_BYTES,
				});
				if (result.status !== "cancelled" && result.status !== "saved") throw new SaveError();
				return { status: result.status };
			} catch (cause) {
				if (cause instanceof TooLargeError) throw cause;
				throw new SaveError();
			} finally {
				wipe(bytes);
			}
		},
	};
}

/**
 * Production adapter bound to the native DocumentTransfer plugin. Only used
 * on Android (the Settings card renders only when a real database handle
 * exists); calling it on non-native platforms maps to a masked read/save
 * error.
 */
export function createDefaultDocumentTransfer(): DocumentTransfer {
	return createDocumentTransfer(registerPlugin<DocumentTransferPlugin>("DocumentTransfer"));
}
