import { useEffect, useMemo, useRef, useState } from "react";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/auth/passwords";
import type { DatabaseHandle } from "@/db/bootstrap";
import type { TransferPreview } from "@/transfer/data-transfer";
import type { DocumentTransfer } from "@/transfer/document-transfer";
import { createDefaultDocumentTransfer } from "@/transfer/document-transfer";

export interface DataTransferCardProps {
	database: DatabaseHandle;
	documents?: DocumentTransfer;
}

interface DeferredState {
	generation: number;
	database: DatabaseHandle;
}

const PASSWORD_COPY = `Password must be ${PASSWORD_MIN}..${PASSWORD_MAX} characters.`;
const MISMATCH_COPY = "Passwords do not match.";
const SAVE_ERROR = "We couldn't save your backup.";
const READ_ERROR = "We couldn't read that file.";
const APPLY_ERROR = "We couldn't apply that transfer. Please preview again.";
const SECRETS = "Password and key fields are cleared on completion, failure, or cancellation.";

function sentence(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function previewSummary(preview: TransferPreview): string {
	const parts = [
		`${sentence(preview.additions, "new entry", "new entries")}, ${sentence(preview.conflicts, "conflict", "conflicts")}`,
	];
	if (preview.settingsChanged) parts.push("portable settings will be overwritten");
	return `${parts.join("; ")}.`;
}

/**
 * Data transfer card: password-encrypted backup, restore, and legacy import.
 *
 * Every operation is deferred-guarded: a captured generation plus mounted and
 * database identity checks drop stale completions after owner replacement or
 * unmount. Only one operation runs at a time (busy disables all controls).
 * Secrets are cleared on every terminal path and never rendered or logged.
 * Restore/import shows the transfer preview and requires a second explicit
 * confirmation button; the five-minute preview expiry cancels the token and
 * announces that the user must preview again. After a successful apply the
 * transfer service publishes its same-handle settings event, so live
 * appearance and weekly-notification consumers refresh without a remount.
 */
export default function DataTransferCard({
	database,
	documents: injectedDocuments,
}: DataTransferCardProps) {
	const documents = useMemo(
		() => injectedDocuments ?? createDefaultDocumentTransfer(),
		[injectedDocuments],
	);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [legacyKey, setLegacyKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<TransferPreview | null>(null);
	const [remainingMs, setRemainingMs] = useState<number | null>(null);
	const mountedRef = useRef(true);
	const generationRef = useRef(0);
	const databaseRef = useRef(database);

	if (databaseRef.current !== database) {
		databaseRef.current = database;
		generationRef.current += 1;
		setPassword("");
		setConfirm("");
		setLegacyKey("");
		setBusy(false);
		setStatus(null);
		setError(null);
		setPreview(null);
	}

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			generationRef.current += 1;
		};
	}, []);

	const isCurrent = (state: DeferredState): boolean =>
		mountedRef.current &&
		state.generation === generationRef.current &&
		state.database === databaseRef.current;

	const clearSecrets = (): void => {
		setPassword("");
		setConfirm("");
		setLegacyKey("");
	};

	// Five-minute preview expiry: cancel the token and announce re-preview.
	useEffect(() => {
		if (preview === null) return;
		const delay = Math.max(0, preview.expiresAt - Date.now());
		const timer = setTimeout(() => {
			databaseRef.current.transfer.cancel(preview.token);
			if (mountedRef.current && preview === previewRefToken.current) {
				setPreview(null);
				setStatus("Your preview expired. Please select the file and preview again.");
			}
		}, delay);
		return () => clearTimeout(timer);
	}, [preview]);
	// Keep the latest preview identity for the expiry callback (avoids a stale
	// closure clearing a newer preview).
	const previewRefToken = useRef<TransferPreview | null>(null);
	previewRefToken.current = preview;

	// Accessible remaining-time countdown.
	useEffect(() => {
		if (preview === null) {
			setRemainingMs(null);
			return;
		}
		setRemainingMs(preview.expiresAt - Date.now());
		const interval = setInterval(() => {
			const remaining = preview.expiresAt - Date.now();
			if (mountedRef.current) setRemainingMs(Math.max(0, remaining));
		}, 1000);
		return () => clearInterval(interval);
	}, [preview]);

	const saveBackup = async (): Promise<void> => {
		if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
			setError(PASSWORD_COPY);
			return;
		}
		if (password !== confirm) {
			setError(MISMATCH_COPY);
			return;
		}
		const state: DeferredState = { generation: ++generationRef.current, database };
		setBusy(true);
		setError(null);
		setStatus(null);
		try {
			const archive = await database.transfer.createBackup(password);
			const result = await documents.saveBackup("rememberme.rmbak", archive);
			if (isCurrent(state)) {
				setStatus(result.status === "cancelled" ? "Backup cancelled." : "Backup saved.");
			}
		} catch {
			if (isCurrent(state)) setError(SAVE_ERROR);
		} finally {
			if (isCurrent(state)) setBusy(false);
			clearSecrets();
		}
	};

	const pickBackup = async (): Promise<void> => {
		if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
			setError(PASSWORD_COPY);
			return;
		}
		if (password !== confirm) {
			setError(MISMATCH_COPY);
			return;
		}
		const state: DeferredState = { generation: ++generationRef.current, database };
		setBusy(true);
		setError(null);
		setStatus(null);
		try {
			const selected = await documents.openBackup();
			if (!isCurrent(state)) return;
			if (selected.status === "cancelled") {
				setStatus("Backup selection cancelled.");
				return;
			}
			const next = await database.transfer.prepareBackup(selected.contents, password);
			if (isCurrent(state)) {
				setPreview(next);
			}
		} catch {
			if (isCurrent(state)) setError(READ_ERROR);
		} finally {
			if (isCurrent(state)) setBusy(false);
			clearSecrets();
		}
	};

	const pickLegacy = async (): Promise<void> => {
		if (legacyKey.length === 0) {
			setError("Enter the web journal encryption key to continue.");
			return;
		}
		const state: DeferredState = { generation: ++generationRef.current, database };
		setBusy(true);
		setError(null);
		setStatus(null);
		try {
			const selected = await documents.openLegacy();
			if (!isCurrent(state)) return;
			if (selected.status === "cancelled") {
				setStatus("Legacy export selection cancelled.");
				return;
			}
			const next = await database.transfer.prepareLegacy(selected.contents, legacyKey);
			if (isCurrent(state)) {
				setPreview(next);
			}
		} catch {
			if (isCurrent(state)) setError(READ_ERROR);
		} finally {
			if (isCurrent(state)) setBusy(false);
			clearSecrets();
		}
	};

	const applyTransfer = async (): Promise<void> => {
		if (preview === null) return;
		const state: DeferredState = { generation: ++generationRef.current, database };
		const token = preview.token;
		setBusy(true);
		setError(null);
		setStatus(null);
		try {
			const result = await database.transfer.apply(token);
			if (isCurrent(state)) {
				setPreview(null);
				setStatus(`Restored ${result.imported} ${result.imported === 1 ? "entry" : "entries"}.`);
			}
		} catch {
			if (isCurrent(state)) {
				setPreview(null);
				setError(APPLY_ERROR);
			}
		} finally {
			if (isCurrent(state)) setBusy(false);
			clearSecrets();
		}
	};

	const cancelPreview = (): void => {
		if (preview !== null) database.transfer.cancel(preview.token);
		setPreview(null);
		setStatus(null);
		clearSecrets();
	};

	const bundledOverwriteCopy =
		preview === null
			? null
			: `Matching dates and portable settings will be overwritten; unrelated local entries stay.`;
	const applyLabel =
		preview === null
			? ""
			: preview.kind === "legacy"
				? "Import and overwrite conflicts"
				: "Restore and overwrite conflicts";

	return (
		<div className="settings-stack">
			<input
				type="password"
				id="transfer-password"
				className="input"
				value={password}
				onChange={(e) => setPassword(e.target.value)}
				autoComplete="new-password"
				disabled={busy}
			/>
			<label className="field-label" htmlFor="transfer-password">
				Backup password
			</label>

			<input
				type="password"
				id="transfer-confirm"
				className="input"
				value={confirm}
				onChange={(e) => setConfirm(e.target.value)}
				autoComplete="new-password"
				disabled={busy}
			/>
			<label className="field-label" htmlFor="transfer-confirm">
				Confirm password
			</label>

			<div className="settings-button-row">
				<button
					type="button"
					className="btn btn-secondary"
					onClick={() => void saveBackup()}
					disabled={busy}
				>
					Save encrypted backup
				</button>
				<button
					type="button"
					className="btn btn-secondary"
					onClick={() => void pickBackup()}
					disabled={busy}
				>
					Choose .rmbak backup
				</button>
			</div>

			<p className="field-hint">
				Restore overwrites matching dates and portable settings after preview; authentication and
				unrelated entries stay. {PASSWORD_COPY} {SECRETS}
			</p>

			<input
				type="password"
				id="transfer-legacy-key"
				className="input"
				value={legacyKey}
				onChange={(e) => setLegacyKey(e.target.value)}
				autoComplete="off"
				disabled={busy}
			/>
			<label className="field-label" htmlFor="transfer-legacy-key">
				Legacy web encryption key
			</label>
			<button
				type="button"
				className="btn btn-secondary"
				onClick={() => void pickLegacy()}
				disabled={busy}
			>
				Choose legacy export
			</button>

			{preview !== null && (
				<div className="settings-preview" role="status">
					<p>
						Preview ready: {previewSummary(preview)} Available for about{" "}
						{Math.max(0, Math.ceil((remainingMs ?? 0) / 1000))} seconds.
					</p>
					<p className="field-hint">{bundledOverwriteCopy}</p>
					<div className="settings-button-row">
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => void applyTransfer()}
							disabled={busy}
						>
							{applyLabel}
						</button>
						<button
							type="button"
							className="btn btn-secondary"
							onClick={cancelPreview}
							disabled={busy}
						>
							Cancel preview
						</button>
					</div>
				</div>
			)}

			{status !== null && (
				<p role="status" className="muted-text">
					{status}
				</p>
			)}
			{error !== null && (
				<p role="alert" className="error-text">
					{error}
				</p>
			)}
			{status === null && error === null && busy && (
				<p role="status" className="muted-text">
					Working…
				</p>
			)}
		</div>
	);
}
