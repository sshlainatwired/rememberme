import { isCalendarDate, journalContentSchema, parseTransferInstant } from "@rememberme/core";
import { decodeJournalRow, type JournalRow } from "@/db/journal";
import { decodeSettingsRows, type SettingRow } from "@/db/settings";
import type { SQLDialect } from "@/db/types";
import {
	type BackupCodec,
	type BackupPayload,
	createBackupCodec,
	type PortableSettings,
	type TransferEntry,
} from "./backup-codec";
import { encodeBase64 } from "./base64";
import { decryptLegacyExport } from "./legacy-import";

const PREVIEW_LIFETIME_MS = 5 * 60_000;
const PORTABLE_SETTING_KEYS = [
	"timezone",
	"weeklyReviewEnabled",
	"weeklyReviewHour",
	"appearance",
] as const;

export interface TransferPreview {
	token: string;
	kind: "backup" | "legacy";
	additions: number;
	conflicts: number;
	settingsChanged: boolean;
	expiresAt: number;
}

export interface ApplyTransferResult {
	imported: number;
}

interface PreparedTransfer extends TransferPreview {
	entries: TransferEntry[];
	settings: PortableSettings | null;
	dateFingerprint: string;
	settingsFingerprint: string | null;
	timer: ReturnType<typeof setTimeout>;
}

interface CurrentState {
	rows: JournalRow[];
	settingsRows: SettingRow[];
	settings: ReturnType<typeof decodeSettingsRows>;
}

function portableSettings(settings: ReturnType<typeof decodeSettingsRows>): PortableSettings {
	return {
		timezone: settings.timezone,
		weeklyReviewEnabled: settings.weeklyReviewEnabled,
		weeklyReviewHour: settings.weeklyReviewHour,
		appearance: settings.appearance,
	};
}

function validateEntries(entries: TransferEntry[]): TransferEntry[] {
	if (!Array.isArray(entries) || entries.length > 10_000)
		throw new Error("Transfer entries are invalid.");
	let previous: string | null = null;
	return entries.map((entry) => {
		if (
			typeof entry !== "object" ||
			entry === null ||
			typeof entry.date !== "string" ||
			!isCalendarDate(entry.date) ||
			(previous !== null && entry.date <= previous)
		) {
			throw new Error("Transfer entries are invalid.");
		}
		const content = journalContentSchema.safeParse(entry.content);
		if (!content.success) throw new Error("Transfer entries are invalid.");
		const createdAt = parseTransferInstant(entry.createdAt, "createdAt");
		const updatedAt = parseTransferInstant(entry.updatedAt, "updatedAt");
		if (createdAt > updatedAt) throw new Error("Transfer entries are invalid.");
		previous = entry.date;
		return { date: entry.date, content: content.data, createdAt, updatedAt };
	});
}

function dateFingerprint(rows: JournalRow[], imported: TransferEntry[]): string {
	const byDate = new Map(rows.map((row) => [row.date, row]));
	return JSON.stringify(
		imported.map(({ date }) => {
			const row = byDate.get(date);
			return row === undefined ? [date, null] : [date, row.content, row.created_at, row.updated_at];
		}),
	);
}

function rawSettingsFingerprint(rows: SettingRow[]): string {
	return JSON.stringify(
		rows
			.filter((row) =>
				PORTABLE_SETTING_KEYS.includes(row.key as (typeof PORTABLE_SETTING_KEYS)[number]),
			)
			.map((row) => [row.key, row.value])
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}

function samePortableSettings(
	current: ReturnType<typeof decodeSettingsRows>,
	incoming: PortableSettings,
): boolean {
	return JSON.stringify(portableSettings(current)) === JSON.stringify(incoming);
}

export class DataTransferService {
	private prepared: PreparedTransfer | null = null;
	private expiredToken: string | null = null;
	private disposed = false;
	private prepareGeneration = 0;

	constructor(
		private readonly db: SQLDialect,
		private readonly publishCommittedSettings: () => void,
		private readonly codec: BackupCodec = createBackupCodec(),
		private readonly clock: () => Date = () => new Date(),
	) {}

	async createBackup(password: string): Promise<string> {
		this.assertActive();
		const payload = await this.db.withLock(async () => {
			const current = await this.readCurrent();
			const entries = current.rows.map(decodeJournalRow).map((entry) => ({
				date: entry.date,
				content: entry.content,
				createdAt: entry.createdAt,
				updatedAt: entry.updatedAt,
			}));
			return {
				format: "rememberme-backup-content",
				version: 1,
				exportedAt: this.clock().toISOString(),
				entries,
				settings: portableSettings(current.settings),
			} satisfies BackupPayload;
		});
		return this.codec.encrypt(payload, password);
	}

	async prepareBackup(archive: string, password: string): Promise<TransferPreview> {
		this.assertActive();
		const payload = await this.codec.decrypt(archive, password);
		return this.prepare("backup", payload.entries, payload.settings);
	}

	async prepareEntries(kind: "legacy", entries: TransferEntry[]): Promise<TransferPreview> {
		this.assertActive();
		return this.prepare(kind, entries, null);
	}

	async prepareLegacy(source: string, legacyKey: string): Promise<TransferPreview> {
		this.assertActive();
		const entries = await decryptLegacyExport(source, legacyKey);
		return this.prepare("legacy", entries, null);
	}

	async apply(token: string): Promise<ApplyTransferResult> {
		this.assertActive();
		if (this.prepared === null) {
			if (this.expiredToken === token) throw new Error("Transfer preview expired; preview again.");
			throw new Error("Transfer preview is unavailable; preview again.");
		}
		if (this.prepared.token !== token)
			throw new Error("Transfer preview is unavailable; preview again.");
		const prepared = this.prepared;
		this.clearPrepared();
		const result = await this.db.withLock(async () => {
			const current = await this.readCurrent();
			if (
				dateFingerprint(current.rows, prepared.entries) !== prepared.dateFingerprint ||
				(prepared.settings !== null &&
					rawSettingsFingerprint(current.settingsRows) !== prepared.settingsFingerprint)
			) {
				throw new Error("Journal or settings changed; preview again.");
			}
			await this.db.begin();
			try {
				for (const entry of prepared.entries) {
					const updated = await this.db.run(
						"UPDATE journal_entries SET content = ?, created_at = ?, updated_at = ? WHERE date = ?",
						[entry.content, entry.createdAt, entry.updatedAt, entry.date],
					);
					if (updated.changes === 0) {
						await this.db.run(
							"INSERT INTO journal_entries (date, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
							[entry.date, entry.content, entry.createdAt, entry.updatedAt],
						);
					}
				}
				if (prepared.settings !== null) {
					for (const key of PORTABLE_SETTING_KEYS) {
						const encoded = JSON.stringify(prepared.settings[key]);
						const updated = await this.db.run("UPDATE settings SET value = ? WHERE key = ?", [
							encoded,
							key,
						]);
						if (updated.changes === 0) {
							await this.db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [key, encoded]);
						}
					}
				}
				await this.db.commit();
			} catch (cause) {
				try {
					await this.db.rollback();
				} catch {
					// Preserve the original transaction failure.
				}
				throw cause;
			}
			return { imported: prepared.entries.length };
		});
		this.publishCommittedSettings();
		return result;
	}

	cancel(token: string): void {
		if (this.prepared?.token === token) this.clearPrepared();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.prepareGeneration += 1;
		this.clearPrepared();
		this.expiredToken = null;
	}

	private async prepare(
		kind: "backup" | "legacy",
		entries: TransferEntry[],
		settings: PortableSettings | null,
	): Promise<TransferPreview> {
		this.assertActive();
		const generation = ++this.prepareGeneration;
		const checkedEntries = validateEntries(entries);
		const preview = await this.db.withLock(async () => {
			const current = await this.readCurrent();
			const currentDates = new Set(current.rows.map((row) => row.date));
			const conflicts = checkedEntries.filter((entry) => currentDates.has(entry.date)).length;
			const tokenBytes = new Uint8Array(16);
			globalThis.crypto.getRandomValues(tokenBytes);
			const token = encodeBase64(tokenBytes);
			tokenBytes.fill(0);
			return {
				token,
				kind,
				additions: checkedEntries.length - conflicts,
				conflicts,
				settingsChanged: settings !== null && !samePortableSettings(current.settings, settings),
				expiresAt: this.clock().valueOf() + PREVIEW_LIFETIME_MS,
				entries: checkedEntries,
				settings,
				dateFingerprint: dateFingerprint(current.rows, checkedEntries),
				settingsFingerprint:
					settings === null ? null : rawSettingsFingerprint(current.settingsRows),
			};
		});
		this.assertActive();
		if (generation !== this.prepareGeneration) {
			throw new Error("Transfer preview was replaced; preview again.");
		}
		this.clearPrepared();
		this.expiredToken = null;
		const timer = setTimeout(() => {
			if (this.prepared?.token === preview.token) {
				this.expiredToken = preview.token;
				this.prepared = null;
			}
		}, PREVIEW_LIFETIME_MS);
		this.prepared = { ...preview, timer };
		return {
			token: preview.token,
			kind: preview.kind,
			additions: preview.additions,
			conflicts: preview.conflicts,
			settingsChanged: preview.settingsChanged,
			expiresAt: preview.expiresAt,
		};
	}

	private async readCurrent(): Promise<CurrentState> {
		const rows = await this.db.query<JournalRow>(
			"SELECT date, content, created_at, updated_at FROM journal_entries ORDER BY date ASC",
		);
		rows.forEach(decodeJournalRow);
		const settingsRows = await this.db.query<SettingRow>(
			"SELECT key, value FROM settings ORDER BY key ASC",
		);
		return { rows, settingsRows, settings: decodeSettingsRows(settingsRows) };
	}

	private clearPrepared(): void {
		if (this.prepared !== null) clearTimeout(this.prepared.timer);
		this.prepared = null;
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Data transfer service is disposed.");
	}
}
