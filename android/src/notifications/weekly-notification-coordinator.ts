import type { DatabaseHandle } from "@/db/bootstrap";
import type { AppSettings } from "@/db/settings";
import type {
	WeeklyNotificationAction,
	WeeklyNotificationAdapter,
	WeeklyNotificationSettings,
} from "./weekly-notification-adapter";

export type WeeklyNotificationReconciliationStatus = Awaited<
	ReturnType<WeeklyNotificationAdapter["reconcile"]>
>;

type StatusListener = (status: WeeklyNotificationReconciliationStatus) => void;

type SettingsResult = ReturnType<DatabaseHandle["settings"]["get"]>;

function isValidSnapshot(snapshot: WeeklyNotificationSettings): boolean {
	return (
		typeof snapshot.enabled === "boolean" &&
		Number.isInteger(snapshot.hour) &&
		snapshot.hour >= 0 &&
		snapshot.hour <= 23 &&
		typeof snapshot.timezone === "string" &&
		snapshot.timezone.length > 0
	);
}

function sameSnapshot(
	first: WeeklyNotificationSettings | null,
	second: WeeklyNotificationSettings | null,
): boolean {
	return (
		first !== null &&
		second !== null &&
		first.enabled === second.enabled &&
		first.hour === second.hour &&
		first.timezone === second.timezone
	);
}

function snapshotFromSettings(settings: Awaited<SettingsResult>): WeeklyNotificationSettings {
	return {
		enabled: settings.weeklyReviewEnabled,
		hour: settings.weeklyReviewHour,
		timezone: settings.timezone,
	};
}

export class WeeklyNotificationCoordinator {
	private owner: DatabaseHandle | null = null;
	private snapshot: WeeklyNotificationSettings | null = null;
	private epoch = 0;
	private tail: Promise<void> = Promise.resolve();
	private started = false;
	private lifecycle = 0;
	private removeActionListener: (() => void) | undefined;
	private readonly visibilityListener = () => {
		if (typeof document !== "undefined" && document.visibilityState === "visible") {
			void this.reconcile().catch(() => {});
		}
	};

	public constructor(
		private readonly adapter: WeeklyNotificationAdapter,
		private readonly onStatus?: StatusListener,
	) {}

	public setOwner(owner: DatabaseHandle | null, snapshot: WeeklyNotificationSettings | null): void {
		if (this.owner !== owner) {
			this.owner = owner;
			this.epoch += 1;
			this.snapshot = null;
		}

		const nextSnapshot = snapshot !== null && isValidSnapshot(snapshot) ? { ...snapshot } : null;
		if (!owner || !nextSnapshot || sameSnapshot(this.snapshot, nextSnapshot)) {
			this.snapshot = nextSnapshot;
			return;
		}
		this.snapshot = nextSnapshot;
		void this.enqueue(owner, this.epoch, nextSnapshot).catch(() => {});
	}

	public start(onAction: (action: WeeklyNotificationAction) => void | Promise<void>): void {
		if (this.started) return;
		this.started = true;
		const lifecycle = ++this.lifecycle;
		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", this.visibilityListener);
		}

		void this.adapter
			.addActionListener((action) => {
				if (!this.started || lifecycle !== this.lifecycle) return;
				return onAction(action);
			})
			.then((remove) => {
				if (!this.started || lifecycle !== this.lifecycle) {
					remove();
					return;
				}
				this.removeActionListener = remove;
			})
			.catch(() => {});
	}

	public reconcile(snapshot?: WeeklyNotificationSettings): Promise<void> {
		const owner = this.owner;
		const epoch = this.epoch;
		if (!owner) return Promise.resolve();

		if (snapshot !== undefined) {
			if (!isValidSnapshot(snapshot)) return Promise.resolve();
			this.snapshot = { ...snapshot };
			return this.enqueue(owner, epoch, this.snapshot);
		}

		return owner.settings.get().then((settings) => {
			if (!this.isCurrent(owner, epoch)) return;
			const nextSnapshot = snapshotFromSettings(settings);
			this.snapshot = nextSnapshot;
			return this.enqueue(owner, epoch, nextSnapshot);
		});
	}

	public stop(): void {
		this.started = false;
		this.lifecycle += 1;
		this.epoch += 1;
		this.owner = null;
		this.snapshot = null;
		if (typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", this.visibilityListener);
		}
		const remove = this.removeActionListener;
		this.removeActionListener = undefined;
		if (remove) remove();
	}

	private isCurrent(owner: DatabaseHandle, epoch: number): boolean {
		return this.started && this.owner === owner && this.epoch === epoch;
	}

	private enqueue(
		owner: DatabaseHandle,
		epoch: number,
		snapshot: WeeklyNotificationSettings,
	): Promise<void> {
		const run = this.tail.then(async () => {
			if (!this.isCurrent(owner, epoch)) return;
			const result = await this.adapter.reconcile(snapshot);
			if (this.isCurrent(owner, epoch)) this.onStatus?.(result);
		});
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

export function weeklyNotificationSettings(settings: AppSettings): WeeklyNotificationSettings {
	return snapshotFromSettings(settings);
}
