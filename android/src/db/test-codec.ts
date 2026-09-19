import type { BackupCodec, BackupPayload } from "@/transfer/backup-codec";

/**
 * Deterministic backup codec for storage/UI integration tests. It swaps the
 * production scrypt + AES-GCM work for a strict JSON round trip so the full
 * transfer/UI flows run fast; the real codec keeps its own production-options
 * coverage in the codec suites.
 */
export function createTestBackupCodec(): BackupCodec {
	return {
		async encrypt(payload, password) {
			return JSON.stringify({ password, payload });
		},
		async decrypt(archive, password) {
			let decoded: unknown;
			try {
				decoded = JSON.parse(archive);
			} catch {
				throw new Error("invalid test archive");
			}
			if (typeof decoded !== "object" || decoded === null) {
				throw new Error("invalid test archive");
			}
			const record = decoded as { password?: unknown; payload?: unknown };
			if (record.password !== password) throw new Error("wrong test password");
			return record.payload as BackupPayload;
		},
	};
}
