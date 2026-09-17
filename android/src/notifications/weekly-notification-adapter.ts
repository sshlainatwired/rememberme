import { type PluginListenerHandle, registerPlugin } from "@capacitor/core";

export type NotificationPermissionStatus = "granted" | "denied" | "prompt" | "unsupported";
export type NotificationBlockedAt = "runtime" | "app" | "channel" | null;

export interface NotificationPermissionResult {
	status: NotificationPermissionStatus;
	blockedAt: NotificationBlockedAt;
}

export interface WeeklyNotificationSettings {
	enabled: boolean;
	hour: number;
	timezone: string;
}

export interface WeeklyNotificationAction {
	id: string;
	route: "/weekly";
}

export interface WeeklyNotificationAdapter {
	reconcile(
		settings: WeeklyNotificationSettings,
	): Promise<{ scheduled: boolean; caughtUp: boolean }>;
	getPermissionStatus(): Promise<NotificationPermissionResult>;
	requestPermission(): Promise<NotificationPermissionResult>;
	openNotificationSettings(): Promise<void>;
	addActionListener(
		listener: (action: WeeklyNotificationAction) => void | Promise<void>,
	): Promise<() => void>;
}

interface WeeklyNotificationsPlugin {
	reconcile(
		settings: WeeklyNotificationSettings,
	): Promise<{ scheduled: boolean; caughtUp: boolean }>;
	getPermissionStatus(): Promise<NotificationPermissionResult>;
	requestPermission(): Promise<NotificationPermissionResult>;
	openNotificationSettings(): Promise<void>;
	addListener(
		eventName: "weeklyNotificationAction",
		listener: (action: WeeklyNotificationAction) => void,
	): Promise<PluginListenerHandle>;
	consumePendingActions(): Promise<{ actions: WeeklyNotificationAction[] }>;
	acknowledgeAction(payload: { id: string }): Promise<void>;
}

const MAX_ACTIONS = 8;
const ACTION_EVENT = "weeklyNotificationAction" as const;
const nativeWeeklyNotifications = registerPlugin<WeeklyNotificationsPlugin>("WeeklyNotifications");

type ActionState = "buffered" | "delivering" | "delivered-awaiting-ack";

interface ActionEntry {
	action: WeeklyNotificationAction;
	state: ActionState;
}

interface Binding {
	listener: (action: WeeklyNotificationAction) => void | Promise<void>;
	handle?: PluginListenerHandle;
	handleRemoved: boolean;
	active: boolean;
}

class WeeklyNotificationAdapterImpl implements WeeklyNotificationAdapter {
	private readonly entries = new Map<string, ActionEntry>();
	private readonly installationQueue: WeeklyNotificationAction[] = [];
	private readonly queuedDuringInstallation = new Set<string>();
	private currentBinding: Binding | undefined;
	private installingBinding: Binding | undefined;
	private boundBinding: Binding | undefined;
	private pumpRunning = false;
	private pumpPending = false;

	public constructor(private readonly plugin: WeeklyNotificationsPlugin) {}

	public reconcile(settings: WeeklyNotificationSettings) {
		return this.plugin.reconcile(settings);
	}

	public getPermissionStatus() {
		return this.plugin.getPermissionStatus();
	}

	public requestPermission() {
		return this.plugin.requestPermission();
	}

	public openNotificationSettings() {
		return this.plugin.openNotificationSettings();
	}

	public async addActionListener(
		listener: (action: WeeklyNotificationAction) => void | Promise<void>,
	): Promise<() => void> {
		if (this.currentBinding?.active) {
			await this.removeBinding(this.currentBinding);
		}

		const binding: Binding = { listener, handleRemoved: false, active: true };
		this.currentBinding = binding;
		this.installingBinding = binding;
		try {
			// Native registration comes first so no warm tap can be missed while
			// the cold pending-action list is being consumed.
			const handle = await this.plugin.addListener(ACTION_EVENT, (action) => {
				this.receiveAction(binding, action);
			});
			if (!this.isCurrent(binding)) {
				await this.removeNativeHandle(binding, handle);
				return () => {};
			}
			binding.handle = handle;
			this.boundBinding = binding;
			const pending = await this.plugin.consumePendingActions();
			if (!this.isCurrent(binding)) {
				await this.removeNativeHandle(binding);
				return () => {};
			}
			this.enqueue(pending.actions);
			const installedWarmActions = this.installationQueue.splice(0);
			for (const action of installedWarmActions) this.queuedDuringInstallation.delete(action.id);
			this.enqueue(installedWarmActions);
		} catch (error) {
			if (this.isCurrent(binding)) {
				this.boundBinding = undefined;
				if (this.installingBinding === binding) this.installingBinding = undefined;
				this.currentBinding = undefined;
				this.pumpPending = false;
			}
			try {
				await this.removeNativeHandle(binding);
			} catch {
				// Preserve the original consume or registration error.
			}
			throw error;
		}

		if (this.installingBinding === binding) this.installingBinding = undefined;
		this.requestPump();
		let removed = false;
		return () => {
			if (removed) return;
			removed = true;
			void this.removeBinding(binding);
		};
	}

	private receiveAction(binding: Binding, action: WeeklyNotificationAction): void {
		if (!this.isCurrent(binding)) return;
		if (this.installingBinding === binding) {
			if (
				!this.entries.has(action.id) &&
				!this.queuedDuringInstallation.has(action.id) &&
				this.entries.size + this.installationQueue.length < MAX_ACTIONS
			) {
				this.queuedDuringInstallation.add(action.id);
				this.installationQueue.push(action);
			}
			return;
		}
		if (this.enqueue([action]) && this.boundBinding === binding) this.requestPump();
	}

	private enqueue(actions: WeeklyNotificationAction[]): boolean {
		let accepted = false;
		for (const action of actions) {
			if (this.entries.has(action.id) || this.queuedDuringInstallation.has(action.id)) continue;
			if (this.entries.size >= MAX_ACTIONS) continue;
			this.entries.set(action.id, { action, state: "buffered" });
			accepted = true;
		}
		return accepted;
	}

	private isCurrent(binding: Binding): boolean {
		return binding.active && this.currentBinding === binding;
	}

	private async removeNativeHandle(
		binding: Binding,
		handle: PluginListenerHandle | undefined = binding.handle,
	): Promise<void> {
		if (!handle || binding.handleRemoved) return;
		binding.handleRemoved = true;
		await handle.remove();
	}

	private async removeBinding(binding: Binding): Promise<void> {
		binding.active = false;
		if (this.currentBinding === binding) {
			this.currentBinding = undefined;
			this.boundBinding = undefined;
			if (this.installingBinding === binding) this.installingBinding = undefined;
			this.pumpPending = false;
		}
		await this.removeNativeHandle(binding);
	}

	private requestPump(): void {
		const binding = this.currentBinding;
		if (!binding || !this.isCurrent(binding) || this.boundBinding !== binding) return;
		if (this.installingBinding === binding) return;
		if (this.pumpRunning) {
			this.pumpPending = true;
			return;
		}
		this.pumpRunning = true;
		void this.pump().finally(() => {
			this.pumpRunning = false;
			if (this.pumpPending) {
				this.pumpPending = false;
				this.requestPump();
			}
		});
	}

	private async pump(): Promise<void> {
		const binding = this.currentBinding;
		if (!binding || !this.isCurrent(binding) || this.boundBinding !== binding) return;

		// One attempt per awaiting ID belongs to this pump. A later bind or warm
		// tap creates another explicit pump; failures never schedule themselves.
		const awaiting = [...this.entries.values()].filter(
			(entry) => entry.state === "delivered-awaiting-ack",
		);
		for (const entry of awaiting) {
			await this.tryAcknowledge(entry);
		}

		if (!this.isCurrent(binding) || this.boundBinding !== binding) return;
		for (const entry of [...this.entries.values()]) {
			if (!this.isCurrent(binding) || this.boundBinding !== binding) return;
			if (entry.state !== "buffered") continue;
			entry.state = "delivering";
			try {
				await binding.listener(entry.action);
				entry.state = "delivered-awaiting-ack";
				await this.tryAcknowledge(entry);
			} catch {
				entry.state = "buffered";
			}
		}
	}

	private async tryAcknowledge(entry: ActionEntry): Promise<void> {
		if (entry.state !== "delivered-awaiting-ack") return;
		try {
			await this.plugin.acknowledgeAction({ id: entry.action.id });
			if (this.entries.get(entry.action.id) === entry) this.entries.delete(entry.action.id);
		} catch {
			// Retain delivered-awaiting-ack. Rebinding or another warm pump retries
			// the native acknowledgement but never invokes the callback again.
		}
	}
}

export function createWeeklyNotificationAdapter(
	plugin: WeeklyNotificationsPlugin = nativeWeeklyNotifications,
): WeeklyNotificationAdapter {
	return new WeeklyNotificationAdapterImpl(plugin);
}

function unsupportedPermissionResult(): NotificationPermissionResult {
	return { status: "unsupported", blockedAt: null };
}

class NoopWeeklyNotificationAdapter implements WeeklyNotificationAdapter {
	reconcile(): Promise<{ scheduled: false; caughtUp: false }> {
		return Promise.resolve({ scheduled: false, caughtUp: false });
	}

	getPermissionStatus(): Promise<NotificationPermissionResult> {
		return Promise.resolve(unsupportedPermissionResult());
	}

	requestPermission(): Promise<NotificationPermissionResult> {
		return Promise.resolve(unsupportedPermissionResult());
	}

	openNotificationSettings(): Promise<void> {
		return Promise.resolve();
	}

	addActionListener(): Promise<() => void> {
		return Promise.resolve(() => {});
	}
}

export function createNoopWeeklyNotificationAdapter(): WeeklyNotificationAdapter {
	return new NoopWeeklyNotificationAdapter();
}
