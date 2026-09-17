import { Capacitor } from "@capacitor/core";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { useStorage } from "@/db/storage";
import { useSettings } from "@/db/use-settings";
import {
	NotificationPermissionProvider,
	useNotificationPermission,
} from "./use-notification-permission";
import {
	createNoopWeeklyNotificationAdapter,
	createWeeklyNotificationAdapter,
	type WeeklyNotificationAdapter,
} from "./weekly-notification-adapter";
import {
	WeeklyNotificationCoordinator,
	type WeeklyNotificationReconciliationStatus,
} from "./weekly-notification-coordinator";

export interface WeeklyNotificationsContextValue {
	/** The last successful reconciliation for the current owner. */
	status: WeeklyNotificationReconciliationStatus | null;
	/** Navigate to the in-app weekly review. */
	navigateToWeekly: () => void;
	/** Current native permission status and actions for the weekly reminder. */
	permissionStatus: ReturnType<typeof useNotificationPermission>["status"];
	permissionBlockedAt: ReturnType<typeof useNotificationPermission>["blockedAt"];
	permissionLoading: boolean;
	permissionError: string | null;
	refreshPermission: ReturnType<typeof useNotificationPermission>["refresh"];
	requestIfPrompt: ReturnType<typeof useNotificationPermission>["requestIfPrompt"];
	openSystemSettings: ReturnType<typeof useNotificationPermission>["openSystemSettings"];
}

const defaultContext: WeeklyNotificationsContextValue = {
	status: null,
	navigateToWeekly: () => {},
	permissionStatus: "unsupported",
	permissionBlockedAt: null,
	permissionLoading: false,
	permissionError: null,
	refreshPermission: async () => ({ status: "unsupported", blockedAt: null }),
	requestIfPrompt: async () => ({ status: "unsupported", blockedAt: null }),
	openSystemSettings: async () => {},
};

const WeeklyNotificationsContext = createContext(defaultContext);
const noopNavigate = () => {};

export interface WeeklyNotificationsProviderProps {
	children: ReactNode;
	/** Test seam; production uses the platform adapter selected below. */
	adapter?: WeeklyNotificationAdapter;
}

export function WeeklyNotificationsProvider(props: WeeklyNotificationsProviderProps) {
	if (useInRouterContext()) return <RoutedWeeklyNotificationsProvider {...props} />;
	return <WeeklyNotificationsProviderContent {...props} navigate={noopNavigate} />;
}

function RoutedWeeklyNotificationsProvider(props: WeeklyNotificationsProviderProps) {
	const navigate = useNavigate();
	const goWeekly = useCallback(() => navigate("/weekly"), [navigate]);
	return <WeeklyNotificationsProviderContent {...props} navigate={goWeekly} />;
}

function WeeklyNotificationsProviderContent({
	children,
	adapter: injectedAdapter,
	navigate,
}: WeeklyNotificationsProviderProps & { navigate: () => void }) {
	const storage = useStorage();
	const { settings } = useSettings();
	const [status, setStatus] = useState<WeeklyNotificationReconciliationStatus | null>(null);
	const mountedRef = useRef(false);
	const navigateRef = useRef(navigate);
	navigateRef.current = navigate;
	const adapter = useMemo(
		() =>
			injectedAdapter ??
			(Capacitor.isNativePlatform()
				? createWeeklyNotificationAdapter()
				: createNoopWeeklyNotificationAdapter()),
		[injectedAdapter],
	);
	const coordinator = useMemo(
		() =>
			new WeeklyNotificationCoordinator(adapter, (next) => {
				if (mountedRef.current) setStatus(next);
			}),
		[adapter],
	);
	const enabled = settings?.weeklyReviewEnabled ?? null;
	const hour = settings?.weeklyReviewHour ?? null;
	const timezone = settings?.timezone ?? null;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		setStatus(null);
		const snapshot =
			enabled === null || hour === null || timezone === null ? null : { enabled, hour, timezone };
		coordinator.setOwner(storage, snapshot);
	}, [coordinator, storage, enabled, hour, timezone]);

	const navigateToWeekly = useCallback(() => {
		if (mountedRef.current) navigateRef.current();
	}, []);
	const navigateToWeeklyRef = useRef(navigateToWeekly);
	navigateToWeeklyRef.current = navigateToWeekly;

	useEffect(() => {
		coordinator.start((action) => {
			if (action.route === "/weekly") navigateToWeeklyRef.current();
		});
		return () => coordinator.stop();
	}, [coordinator]);
	return (
		<NotificationPermissionProvider adapter={adapter}>
			<WeeklyNotificationsContextBridge status={status} navigateToWeekly={navigateToWeekly}>
				{children}
			</WeeklyNotificationsContextBridge>
		</NotificationPermissionProvider>
	);
}

function WeeklyNotificationsContextBridge({
	children,
	status,
	navigateToWeekly,
}: {
	children: ReactNode;
	status: WeeklyNotificationReconciliationStatus | null;
	navigateToWeekly: () => void;
}) {
	const permission = useNotificationPermission();
	const value: WeeklyNotificationsContextValue = {
		status,
		navigateToWeekly,
		permissionStatus: permission.status,
		permissionBlockedAt: permission.blockedAt,
		permissionLoading: permission.loading,
		permissionError: permission.error,
		refreshPermission: permission.refresh,
		requestIfPrompt: permission.requestIfPrompt,
		openSystemSettings: permission.openSystemSettings,
	};
	return (
		<WeeklyNotificationsContext.Provider value={value}>
			{children}
		</WeeklyNotificationsContext.Provider>
	);
}

export function useWeeklyNotifications(): WeeklyNotificationsContextValue {
	return useContext(WeeklyNotificationsContext);
}
