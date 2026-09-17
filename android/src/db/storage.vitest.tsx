import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthService } from "@/auth/auth-service";
import type { DatabaseHandle } from "@/db/bootstrap";
import { JournalService } from "@/db/journal";
import { SCHEMA_VERSION } from "@/db/migrations";
import { SettingsService } from "@/db/settings";
import { StorageProvider, useStorage } from "@/db/storage";
import { createTestDb } from "@/db/test-helper";
import {
	createUnavailableDeviceUnlockAdapter,
	DeviceUnlockService,
} from "@/security/device-unlock";
import { DataTransferService } from "@/transfer/data-transfer";

function fakeHandle(): DatabaseHandle {
	const db = createTestDb();
	const settings = new SettingsService(db);
	const transfer = new DataTransferService(db, () => {});
	const security = new DeviceUnlockService(
		createUnavailableDeviceUnlockAdapter(),
		settings,
		() => {},
	);
	return {
		schemaVersion: SCHEMA_VERSION,
		journal: new JournalService(db),
		settings,
		transfer,
		auth: new AuthService(db, settings),
		security,
		close: async () => {
			security.dispose();
			transfer.dispose();
			await db.close();
		},
	};
}

/** A consumer component that captures the context value into a holder. */
function Consumer({ holder }: { holder: { current: DatabaseHandle | null } }) {
	holder.current = useStorage();
	return <div>consumer</div>;
}

describe("StorageProvider: provides the handle it is given", () => {
	it("exposes the database handle to consumers", () => {
		const seen: { current: DatabaseHandle | null } = { current: null };
		render(
			<StorageProvider database={fakeHandle()}>
				<Consumer holder={seen} />
			</StorageProvider>,
		);
		expect(seen.current).not.toBeNull();
		expect(seen.current?.schemaVersion).toBe(SCHEMA_VERSION);
	});

	it("is null when no handle is supplied (non-native/dev state)", () => {
		const seen: { current: DatabaseHandle | null } = { current: null };
		render(
			<StorageProvider database={null}>
				<Consumer holder={seen} />
			</StorageProvider>,
		);
		expect(seen.current).toBeNull();
	});

	it("falls back to the default null with no provider at all (App-alone state)", () => {
		// App.tsx renders no StorageProvider — the gate is the sole provider —
		// so an App-alone render (like this consumer without any provider)
		// must honestly read the context default null.
		const seen: { current: DatabaseHandle | null } = { current: null };
		render(<Consumer holder={seen} />);
		expect(seen.current).toBeNull();
	});
});
