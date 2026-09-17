export type SettingsListener = () => void;

export interface SettingsIdentity {
	readonly settings: unknown;
}

interface Entry {
	identity: SettingsIdentity;
	listener: SettingsListener;
}

const listeners = new Set<Entry>();

export function subscribeSettingsChanged(
	identity: SettingsIdentity,
	listener: SettingsListener,
): () => void {
	const entry = { identity, listener };
	listeners.add(entry);
	return () => {
		listeners.delete(entry);
	};
}

export function publishSettingsChanged(
	identity: SettingsIdentity,
	except: SettingsListener | null = null,
): void {
	for (const entry of [...listeners]) {
		if (entry.identity !== identity || entry.listener === except) continue;
		try {
			entry.listener();
		} catch {
			// A listener cannot undo the durable settings commit. Keep notifying
			// healthy peers and never turn a committed write into a reported failure.
		}
	}
}
