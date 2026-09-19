/**
 * Storage context for the React tree.
 *
 * The bootstrap gate (mounted once in `main.tsx`) opens + migrates the native
 * database before rendering, then supplies the handle through this context.
 * `StorageProvider` adapts that handle for the routed screens:
 *
 * - native: the real database handle (journal + settings services),
 * - web/test/dev: `null` — there is NO storage layer, and screens that need
 *   persistence must fail closed rather than fall back to browser storage.
 *
 * The gate (AppBootstrap) is the SOLE provider: `App.tsx` renders no provider
 * of its own, so rendering `App` alone — as tests do — leaves the context at
 * its default `null`, the honest non-native state. There is no inheritance
 * or nesting option; one provider, one value.
 */

import { createContext, type ReactNode, useContext } from "react";
import type { DatabaseHandle } from "@/db/bootstrap";

const StorageContext = createContext<DatabaseHandle | null>(null);

export interface StorageProviderProps {
	children: ReactNode;
	/** Handle supplied by the bootstrap gate; `null` on web/test/dev. */
	database: DatabaseHandle | null;
}

export function StorageProvider({ children, database }: StorageProviderProps) {
	return <StorageContext.Provider value={database}>{children}</StorageContext.Provider>;
}

/** Access the database handle (null on web/test/dev, or before the gate). */
export function useStorage(): DatabaseHandle | null {
	return useContext(StorageContext);
}
