import {
	createContext,
	createElement,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import type {
	NotificationBlockedAt,
	NotificationPermissionResult,
	NotificationPermissionStatus,
	WeeklyNotificationAdapter,
} from "./weekly-notification-adapter";

export const NOTIFICATION_PERMISSION_ERROR = "Please try again.";

export interface NotificationPermissionContextValue {
	status: NotificationPermissionStatus | null;
	blockedAt: NotificationBlockedAt;
	loading: boolean;
	error: string | null;
	refresh: () => Promise<NotificationPermissionResult | null>;
	requestIfPrompt: () => Promise<NotificationPermissionResult | null>;
	openSystemSettings: () => Promise<void>;
}

const defaultPermission: NotificationPermissionContextValue = {
	status: "unsupported",
	blockedAt: null,
	loading: false,
	error: null,
	refresh: async () => ({ status: "unsupported", blockedAt: null }),
	requestIfPrompt: async () => ({ status: "unsupported", blockedAt: null }),
	openSystemSettings: async () => {},
};

const NotificationPermissionContext = createContext(defaultPermission);

export interface NotificationPermissionProviderProps {
	children: ReactNode;
	adapter: WeeklyNotificationAdapter;
}

function usePermissionState(
	adapter: WeeklyNotificationAdapter,
): NotificationPermissionContextValue {
	const [status, setStatus] = useState<NotificationPermissionStatus | null>(null);
	const [blockedAt, setBlockedAt] = useState<NotificationBlockedAt>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const mountedRef = useRef(false);
	const generationRef = useRef(0);
	const adapterRef = useRef(adapter);
	const epochRef = useRef(0);
	if (adapterRef.current !== adapter) {
		adapterRef.current = adapter;
		++epochRef.current;
	}
	const epoch = epochRef.current;
	const isCurrent = useCallback(
		() => mountedRef.current && adapterRef.current === adapter && epochRef.current === epoch,
		[adapter, epoch],
	);

	const refresh = useCallback(async (): Promise<NotificationPermissionResult | null> => {
		if (!isCurrent()) return null;
		const generation = ++generationRef.current;
		if (!isCurrent()) return null;
		setLoading(true);
		try {
			if (!isCurrent()) return null;
			const result = await adapter.getPermissionStatus();
			if (!isCurrent() || generation !== generationRef.current) return null;
			setStatus(result.status);
			setBlockedAt(result.blockedAt);
			setError(null);
			return result;
		} catch {
			if (isCurrent() && generation === generationRef.current) {
				setError(NOTIFICATION_PERMISSION_ERROR);
				setLoading(false);
			}
			return null;
		} finally {
			if (isCurrent() && generation === generationRef.current) setLoading(false);
		}
	}, [adapter, isCurrent]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			++epochRef.current;
			++generationRef.current;
		};
	}, []);

	useEffect(() => {
		void refresh();
		const onVisibilityChange = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => document.removeEventListener("visibilitychange", onVisibilityChange);
	}, [refresh]);

	const requestIfPrompt = useCallback(async (): Promise<NotificationPermissionResult | null> => {
		if (!isCurrent()) return null;
		const current = await refresh();
		if (!isCurrent()) return null;
		if (current?.status !== "prompt") return current;
		if (!isCurrent()) return null;
		let requestFailed = false;
		try {
			if (!isCurrent()) return null;
			await adapter.requestPermission();
		} catch {
			requestFailed = true;
		}
		if (!isCurrent()) return null;
		const latest = await refresh();
		if (!isCurrent()) return null;
		if (requestFailed) setError(NOTIFICATION_PERMISSION_ERROR);
		return latest;
	}, [adapter, isCurrent, refresh]);

	const openSystemSettings = useCallback(async (): Promise<void> => {
		if (!isCurrent()) return;
		try {
			if (!isCurrent()) return;
			await adapter.openNotificationSettings();
			if (!isCurrent()) return;
		} catch {
			if (isCurrent()) setError(NOTIFICATION_PERMISSION_ERROR);
		}
	}, [adapter, isCurrent]);

	return { status, blockedAt, loading, error, refresh, requestIfPrompt, openSystemSettings };
}

export function NotificationPermissionProvider({
	children,
	adapter,
}: NotificationPermissionProviderProps) {
	const value = usePermissionState(adapter);
	return createElement(NotificationPermissionContext.Provider, { value }, children);
}

export function useNotificationPermission(): NotificationPermissionContextValue {
	return useContext(NotificationPermissionContext);
}
