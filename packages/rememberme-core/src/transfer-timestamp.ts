const CANONICAL_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Parse the canonical UTC-millisecond timestamp used by portable transfers. */
export function parseTransferInstant(value: unknown, label: string): string {
	if (typeof value !== "string" || !CANONICAL_UTC_INSTANT.test(value)) {
		throw new Error(`${label} must be a canonical UTC instant.`);
	}
	const instant = new Date(value);
	if (!Number.isFinite(instant.valueOf()) || instant.toISOString() !== value) {
		throw new Error(`${label} must be a canonical UTC instant.`);
	}
	return value;
}

/** Format a valid instant for a portable transfer. */
export function formatTransferInstant(value: Date, label: string): string {
	if (!Number.isFinite(value.valueOf())) {
		throw new Error(`${label} must be a valid instant.`);
	}
	return value.toISOString();
}
