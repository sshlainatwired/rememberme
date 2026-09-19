const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function encodeBase64(bytes: Uint8Array): string {
	let output = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index];
		const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
		const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
		output += ALPHABET[first >> 2];
		output += ALPHABET[((first & 3) << 4) | (second >> 4)];
		output += index + 1 < bytes.length ? ALPHABET[((second & 15) << 2) | (third >> 6)] : "=";
		output += index + 2 < bytes.length ? ALPHABET[third & 63] : "=";
	}
	return output;
}

function decodeCharacter(code: number, label: string): number {
	if (code >= 65 && code <= 90) return code - 65;
	if (code >= 97 && code <= 122) return code - 97 + 26;
	if (code >= 48 && code <= 57) return code - 48 + 52;
	if (code === 43) return 62;
	if (code === 47) return 63;
	throw new Error(`${label} must be canonical standard base64.`);
}

export function decodeBase64(value: unknown, label: string): Uint8Array<ArrayBuffer> {
	if (typeof value !== "string" || value.length % 4 !== 0) {
		throw new Error(`${label} must be canonical standard base64.`);
	}
	if (value.length === 0) return new Uint8Array(0);
	let padding = 0;
	if (value.endsWith("=")) padding = 1;
	if (value.endsWith("==")) padding = 2;
	const dataLength = value.length - padding;
	const remainder = dataLength % 4;
	if (remainder === 1) throw new Error(`${label} must be canonical standard base64.`);
	const bytes = new Uint8Array(Math.floor(dataLength / 4) * 3 + Math.max(0, remainder - 1));
	let outputIndex = 0;
	for (let index = 0; index < dataLength; index += 4) {
		const first = decodeCharacter(value.charCodeAt(index), label);
		const second = decodeCharacter(value.charCodeAt(index + 1), label);
		bytes[outputIndex++] = (first << 2) | (second >> 4);
		if (index + 2 < dataLength) {
			const third = decodeCharacter(value.charCodeAt(index + 2), label);
			bytes[outputIndex++] = ((second & 15) << 4) | (third >> 2);
			if (index + 3 < dataLength) {
				const fourth = decodeCharacter(value.charCodeAt(index + 3), label);
				bytes[outputIndex++] = ((third & 3) << 6) | fourth;
			}
		}
	}
	if (encodeBase64(bytes) !== value) {
		throw new Error(`${label} must be canonical standard base64.`);
	}
	return bytes;
}

export function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
	return UTF8_ENCODER.encode(value);
}

export function decodeUtf8(bytes: Uint8Array, label: string): string {
	try {
		return UTF8_DECODER.decode(bytes);
	} catch {
		throw new Error(`${label} must be valid UTF-8.`);
	}
}

export function wipe(...buffers: Array<Uint8Array | undefined>): void {
	for (const buffer of buffers) buffer?.fill(0);
}
