import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// This is intentionally a closed, immutable file list. Static boundary tests
// must not discover files or accidentally read environment/spec/migration data.
const ALLOWED_FILES = Object.freeze([
	"android/android/app/src/main/AndroidManifest.xml",
	"android/android/app/src/main/java/app/rememberme/journal/MainActivity.java",
	"android/android/app/src/main/java/app/rememberme/journal/notifications/AndroidWeeklyNotificationPlatform.java",
	"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyAlarmReceiver.java",
	"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationController.java",
	"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationPlatform.java",
	"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationsPlugin.java",
	"android/android/app/src/test/java/app/rememberme/journal/notifications/WeeklyNotificationControllerTest.java",
	"android/src/App.tsx",
	"android/src/components/layout/AppBootstrap.tsx",
	"android/src/components/layout/AppShell.tsx",
	"android/src/components/settings/SettingsForm.tsx",
	"android/src/notifications/WeeklyNotificationsProvider.tsx",
	"android/src/notifications/weekly-notification-adapter.ts",
	"android/src/notifications/weekly-notification-coordinator.ts",
	"android/src/pages/WeeklyReview.tsx",
	"android/package.json",
	"android/capacitor.config.ts",
	"android/index.html",
	"android/scripts/verify-legacy-build.mjs",
	"android/scripts/verify-legacy-css.mjs",
	"bun.lock",
] as const);

type AllowedFile = (typeof ALLOWED_FILES)[number];

function readAllowed(path: AllowedFile): string {
	if (!ALLOWED_FILES.includes(path)) {
		throw new Error(`unlisted static-boundary input: ${path}`);
	}
	return readFileSync(resolve(ROOT, path), "utf8");
}

function count(source: string, pattern: RegExp): number {
	return source.match(pattern)?.length ?? 0;
}

function expectInOrder(source: string, ...needles: string[]): void {
	let previous = -1;
	for (const needle of needles) {
		const index = source.indexOf(needle, previous + 1);
		expect(index, `missing or out-of-order contract: ${needle}`).toBeGreaterThan(previous);
		previous = index;
	}
}

function section(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	expect(from, `missing section: ${start}`).toBeGreaterThanOrEqual(0);
	expect(to, `missing section end: ${end}`).toBeGreaterThan(from);
	return source.slice(from, to);
}

function methodBody(source: string, signature: string): string {
	const from = source.indexOf(signature);
	expect(from, `missing method: ${signature}`).toBeGreaterThanOrEqual(0);
	const open = source.indexOf("{", from + signature.length);
	expect(open, `missing method body: ${signature}`).toBeGreaterThan(from);
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		if (source[index] === "{") depth += 1;
		if (source[index] === "}") depth -= 1;
		if (depth === 0) return source.slice(open, index + 1);
	}
	throw new Error(`unterminated method: ${signature}`);
}

function classBody(source: string, signature: string): string {
	return methodBody(source, signature);
}

function withoutJavaComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
}

function objectBody(source: string, property: string): string {
	return methodBody(source, `${property}:`);
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, nested]) => [key, sortJson(nested)]),
		);
	}
	return value;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("Phase 6 Task 9 notification boundary", () => {
	it("keeps the manifest permission and receiver action sets exact", () => {
		const manifest = readAllowed("android/android/app/src/main/AndroidManifest.xml");
		const permissions = [...manifest.matchAll(/<uses-permission[^>]+android:name="([^"]+)"/g)].map(
			(match) => match[1],
		);
		expect(permissions).toEqual([
			"android.permission.POST_NOTIFICATIONS",
			"android.permission.RECEIVE_BOOT_COMPLETED",
		]);
		expect(manifest).not.toMatch(/android\.permission\.INTERNET/);
		expect(manifest).not.toMatch(
			/SCHEDULE_EXACT_ALARM|USE_EXACT_ALARM|WAKE_LOCK|USE_BIOMETRIC|USE_FINGERPRINT/,
		);

		const receiver = manifest.match(
			/<receiver[\s\S]*?WeeklyAlarmReceiver[\s\S]*?<\/receiver>/,
		)?.[0];
		expect(receiver).toBeDefined();
		expect(receiver).toMatch(/android:exported="false"/);
		const actions = [...(receiver ?? "").matchAll(/<action[^>]+android:name="([^"]+)"/g)].map(
			(match) => match[1],
		);
		expect(actions).toEqual([
			"android.intent.action.BOOT_COMPLETED",
			"android.intent.action.TIMEZONE_CHANGED",
			"android.intent.action.TIME_SET",
			"android.intent.action.MY_PACKAGE_REPLACED",
			"app.rememberme.journal.WEEKLY_ALARM",
		]);
		expect(actions).not.toContain("android.intent.action.PACKAGE_REPLACED");
	});

	it("uses matching lifecycle constants and rejects only generic package replacement", () => {
		const receiver = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyAlarmReceiver.java",
		);
		for (const constant of [
			"Intent.ACTION_BOOT_COMPLETED",
			"Intent.ACTION_TIMEZONE_CHANGED",
			"Intent.ACTION_TIME_CHANGED",
			"Intent.ACTION_MY_PACKAGE_REPLACED",
		]) {
			expect(count(receiver, new RegExp(`\\b${constant.replace(".", "\\.")}\\b`, "g"))).toBe(1);
		}
		expect(receiver).toContain("AndroidWeeklyNotificationPlatform.ALARM_ACTION");
		const allowedAction = section(receiver, "static boolean isAllowedAction", "}");
		expect(
			count(
				allowedAction,
				/Intent\.ACTION_(?:BOOT_COMPLETED|TIMEZONE_CHANGED|TIME_CHANGED|MY_PACKAGE_REPLACED)/g,
			) + count(allowedAction, /AndroidWeeklyNotificationPlatform\.ALARM_ACTION/g),
		).toBe(5);
		const java = [
			"android/android/app/src/main/java/app/rememberme/journal/MainActivity.java",
			"android/android/app/src/main/java/app/rememberme/journal/notifications/AndroidWeeklyNotificationPlatform.java",
			"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyAlarmReceiver.java",
			"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationController.java",
			"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationPlatform.java",
			"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationsPlugin.java",
		]
			.map((path) => readAllowed(path as AllowedFile))
			.join("\n");
		expect(java).not.toMatch(/(?<!MY_)Intent\.ACTION_PACKAGE_REPLACED/);
		expect(java).not.toMatch(/android\.intent\.action\.PACKAGE_REPLACED/);
	});

	it("keeps native scheduling inexact, durable-first, and Android-API bounded", () => {
		const platform = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/notifications/AndroidWeeklyNotificationPlatform.java",
		);
		const controller = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationController.java",
		);
		const policy = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationPlatform.java",
		);
		const scheduleNext = methodBody(platform, "public void scheduleNext");
		const cancelAlarm = methodBody(platform, "public void cancelAlarm");
		const nativeScheduling = `${scheduleNext}\n${cancelAlarm}`;
		const platformImplementation = withoutJavaComments(
			classBody(platform, "public final class AndroidWeeklyNotificationPlatform"),
		);
		const writeSnapshotBody = methodBody(platform, "public boolean writeSnapshot");
		const markerWriteBody = methodBody(platform, "boolean markPermissionRequested");
		const durableWrites = `${writeSnapshotBody}\n${markerWriteBody}`;
		expect(platform).toMatch(/PREFERENCES_NAME = "rememberme\.weekly\.notifications"/);
		expect(platform).toMatch(/CHANNEL_ID = "rememberme\.weekly\.review"/);
		expect(platform).toMatch(/NOTIFICATION_ID = 60426/);
		expect(platform).toMatch(/ALARM_REQUEST_CODE = 60426/);
		expect(platform).toMatch(/ALARM_ACTION = "app\.rememberme\.journal\.WEEKLY_ALARM"/);
		expect(policy).toMatch(/ACTION_OPEN_WEEKLY = "app\.rememberme\.journal\.OPEN_WEEKLY"/);
		expect(platform).toContain("ACTION_OPEN_WEEKLY = WeeklyNotificationPolicy.ACTION_OPEN_WEEKLY");
		expect(platform).toMatch(/KEY_PERMISSION_REQUESTED = "permissionRequested"/);
		expect(platform).toMatch(/SharedPreferences preferences/);
		expect(platform).toMatch(/getSharedPreferences\(PREFERENCES_NAME, Context\.MODE_PRIVATE\)/);
		expect(platform).toMatch(/FLAG_UPDATE_CURRENT\s*\|\s*PendingIntent\.FLAG_IMMUTABLE/);
		expect(count(scheduleNext, /setAndAllowWhileIdle\s*\(\s*AlarmManager\.RTC_WAKEUP/g)).toBe(1);
		expect(nativeScheduling).not.toMatch(/\.\s*(?:setExact|setRepeating|setInexactRepeating)\s*\(/);
		expect(platformImplementation).not.toMatch(/\b(?:PowerManager|Service)\b/);
		expect(nativeScheduling).not.toMatch(/\bstartService\s*\(/);
		expect(count(durableWrites, /\.commit\s*\(\s*\)/g)).toBe(2);
		expect(durableWrites).not.toMatch(/\.apply\s*\(\s*\)/);
		expect(controller).toMatch(/claimedWeek/);
		const snapshotReadBody = methodBody(platform, "public SnapshotRead readSnapshot");
		const postBody = methodBody(platform, "public void postWeeklyNotification");
		expect(`${snapshotReadBody}\n${writeSnapshotBody}\n${postBody}`).not.toMatch(
			/\b(?:journal\.list|JournalEntry|password|credential|privateKey|secret)\b/i,
		);

		const enabled = section(
			controller,
			"private ReconcileResult reconcileEnabled",
			"private ReconcileResult scheduleResult",
		);
		expectInOrder(
			enabled,
			"if (!canPost())",
			"configured.withMarkers(configured.lastNotifiedWeek, due)",
			"platform.postWeeklyNotification(due)",
			"claimed.withMarkers(due, null)",
			"platform.scheduleNext(next)",
		);
		expect(enabled).toMatch(/if \(!writeSnapshot\(claimed, ErrorCode\.CLAIM_WRITE_FAILED\)\)/);
		expect(enabled).toMatch(
			/catch \(RuntimeException error\) \{\s*clearClaimBestEffort\(claimed\)/,
		);
	});

	it("keeps notification channel, permission gates, content, priority, and intents exact", () => {
		const platform = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/notifications/AndroidWeeklyNotificationPlatform.java",
		);
		const canPost = methodBody(platform, "public boolean canPostNotification");
		const post = methodBody(platform, "public void postWeeklyNotification");
		const alarm = methodBody(platform, "private PendingIntent alarmPendingIntent");
		const channel = methodBody(platform, "void ensureNotificationChannel");
		expectInOrder(
			canPost,
			"ensureNotificationChannel();",
			"WeeklyNotificationPolicy.permissionDecision(",
			"areNotificationsEnabled()",
			"channelImportance()",
		);
		expect(channel).toMatch(/new NotificationChannel\(\s*CHANNEL_ID,[\s\S]*?IMPORTANCE_DEFAULT/);
		expect(post).toMatch(/new NotificationCompat\.Builder\(context, CHANNEL_ID\)/);
		expect(post).toMatch(/setSmallIcon\(R\.mipmap\.ic_launcher\)/);
		expect(post).toMatch(/setContentTitle\("Weekly Review"\)/);
		expect(post).toMatch(/setContentText\("Your week is ready to review\."\)/);
		expect(post).toMatch(/setAutoCancel\(true\)/);
		expect(post).toMatch(
			/Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.N[\s\S]*?PRIORITY_DEFAULT/,
		);
		expect(post).toMatch(
			/new Intent\(context, MainActivity\.class\)[\s\S]*?setAction\(ACTION_OPEN_WEEKLY\)[\s\S]*?putExtra\(EXTRA_ROUTE, WEEKLY_ROUTE\)/,
		);
		expect(post).toMatch(
			/PendingIntent\.getActivity\(\s*context,\s*NOTIFICATION_ID,[\s\S]*?PENDING_INTENT_FLAGS/,
		);
		expect(alarm).toMatch(
			/new Intent\(context, WeeklyAlarmReceiver\.class\)[\s\S]*?setAction\(ALARM_ACTION\)/,
		);
		expect(alarm).toMatch(
			/PendingIntent\.getBroadcast\(\s*context,\s*ALARM_REQUEST_CODE,[\s\S]*?PENDING_INTENT_FLAGS/,
		);
	});

	it("classifies permissionRequested as orthogonal to the five-key snapshot", () => {
		const platform = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/notifications/AndroidWeeklyNotificationPlatform.java",
		);
		const policy = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationPlatform.java",
		);
		const nativeTests = readAllowed(
			"android/android/app/src/test/java/app/rememberme/journal/notifications/WeeklyNotificationControllerTest.java",
		);
		const snapshotRead = methodBody(platform, "public SnapshotRead readSnapshot");
		const snapshotPolicy = methodBody(policy, "static SnapshotRead read");
		expect(snapshotRead).toContain("return WeeklyNotificationPolicy.read(values);");
		expectInOrder(
			snapshotPolicy,
			"boolean hasSchedulingKey = containsSchedulingKey(values);",
			"boolean malformed = hasUnexpectedKey(values);",
			"if (!hasSchedulingKey)",
			"? SnapshotRead.corruptPartial",
			": SnapshotRead.empty()",
		);
		const schedulingKeyCheck = methodBody(policy, "private static boolean containsSchedulingKey");
		const unexpectedKeyCheck = methodBody(policy, "private static boolean hasUnexpectedKey");
		expect(schedulingKeyCheck).toMatch(
			/KEY_ENABLED[\s\S]*KEY_HOUR[\s\S]*KEY_TIMEZONE[\s\S]*KEY_LAST_NOTIFIED_WEEK[\s\S]*KEY_CLAIMED_WEEK/,
		);
		expect(schedulingKeyCheck).not.toContain("KEY_PERMISSION_REQUESTED");
		expect(unexpectedKeyCheck).toContain("KEY_PERMISSION_REQUESTED");
		expectInOrder(
			snapshotRead,
			"final Map<String, ?> values = preferences.getAll();",
			"return WeeklyNotificationPolicy.read(values);",
		);
		expect(snapshotRead).not.toContain("values.containsKey(KEY_PERMISSION_REQUESTED)");
		const permissionRequested = methodBody(platform, "boolean isPermissionRequested");
		expect(permissionRequested).toContain(
			"preferences.getBoolean(KEY_PERMISSION_REQUESTED, false)",
		);

		const markerOnly = { permissionRequested: true };
		const schedulingKeys = ["enabled", "hour", "timezone", "lastNotifiedWeek", "claimedWeek"];
		expect(Object.keys(markerOnly).some((key) => schedulingKeys.includes(key))).toBe(false);
		expect(nativeTests).toContain("permissionMarkerOnlySnapshot_isEmptyAndSeedsAndSchedules");
		expect(nativeTests).toContain("platform.read = SnapshotRead.empty()");
	});

	it("uses the Android-free permission policy for every matrix branch", () => {
		const policy = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationPlatform.java",
		);
		const plugin = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationsPlugin.java",
		);
		const decision = methodBody(policy, "static WeeklyPermissionDecision permissionDecision");
		const permissionStatus = methodBody(plugin, "private static JSObject permissionStatus");
		expectInOrder(
			decision,
			"if (apiLevel < 24)",
			"if (apiLevel >= 33 && !runtimePermissionGranted)",
			"if (!appNotificationsEnabled)",
			"if (apiLevel >= 26 && !channelEnabled)",
			"return WeeklyPermissionDecision.GRANTED",
		);
		expect(permissionStatus).toContain("WeeklyNotificationPolicy.permissionDecision(");
		expect(permissionStatus).toContain("platform.isPermissionRequested()");
	});

	it("keeps Capacitor cold-start capture and permission method contracts exact", () => {
		const activity = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/MainActivity.java",
		);
		const plugin = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationsPlugin.java",
		);
		const requestPermission = methodBody(plugin, "public void requestPermission");
		const consumePendingActions = methodBody(plugin, "public void consumePendingActions");
		const permissionStatus = methodBody(plugin, "private static JSObject permissionStatus");
		const pluginAnnotation = plugin.slice(
			0,
			plugin.indexOf("public final class WeeklyNotificationsPlugin"),
		);
		const onCreate = section(activity, "public void onCreate", "protected void onNewIntent");
		const onNewIntent = activity.slice(activity.indexOf("protected void onNewIntent"));
		expectInOrder(
			onCreate,
			"registerPlugin(WeeklyNotificationsPlugin.class)",
			"super.onCreate(savedInstanceState)",
		);
		expect(onCreate).not.toContain("captureIntent");
		expectInOrder(
			onNewIntent,
			"super.onNewIntent(intent)",
			"setIntent(intent)",
			"WeeklyNotificationsPlugin.captureIntent(intent)",
		);
		expect(count(activity, /captureIntent\(intent\)/g)).toBe(1);
		expect(pluginAnnotation).toMatch(
			/@CapacitorPlugin\([\s\S]*?name = "WeeklyNotifications"[\s\S]*?alias = "notifications"[\s\S]*?Manifest\.permission\.POST_NOTIFICATIONS/,
		);
		const pluginMethods = [
			...plugin.matchAll(/@PluginMethod\s+public void (\w+)\(PluginCall call\)/g),
		].map((match) => match[1]);
		expect(pluginMethods).toEqual([
			"reconcile",
			"getPermissionStatus",
			"requestPermission",
			"openNotificationSettings",
			"consumePendingActions",
			"acknowledgeAction",
		]);
		expect(plugin).toMatch(
			/requestPermissionForAlias\("notifications", call, "notificationsPermissionCallback"\)/,
		);
		expect(plugin).toMatch(
			/@PermissionCallback\s*public void notificationsPermissionCallback\(PluginCall call\)/,
		);
		expect(requestPermission).toMatch(
			/Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.TIRAMISU[\s\S]*?call\.resolve\(permissionStatus\(platform\)\)/,
		);
		expect(consumePendingActions).toMatch(/new JSObject\(\)\.put\("actions", actions\)/);
		expect(permissionStatus).toMatch(/status\(STATUS_PROMPT, null\)/);
		expect(permissionStatus).toMatch(/status\(STATUS_DENIED, BLOCKED_RUNTIME\)/);
		expect(permissionStatus).toMatch(/status\(STATUS_DENIED, BLOCKED_APP\)/);
		expect(permissionStatus).toMatch(/status\(STATUS_DENIED, BLOCKED_CHANNEL\)/);
	});

	it("keeps the native and JS action buffers FIFO, capped, acknowledged, and bounded", () => {
		const policy = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationPlatform.java",
		);
		const platform = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/notifications/AndroidWeeklyNotificationPlatform.java",
		);
		const plugin = readAllowed(
			"android/android/app/src/main/java/app/rememberme/journal/notifications/WeeklyNotificationsPlugin.java",
		);
		const nativeTests = readAllowed(
			"android/android/app/src/test/java/app/rememberme/journal/notifications/WeeklyNotificationControllerTest.java",
		);
		const adapter = readAllowed("android/src/notifications/weekly-notification-adapter.ts");
		const accept = methodBody(policy, "boolean accept");
		const capture = methodBody(
			platform,
			"public static synchronized WeeklyNotificationAction captureIntent",
		);
		const acknowledge = methodBody(policy, "boolean acknowledge");
		const pluginCaptureIntent = methodBody(plugin, "static void captureIntent");
		const emitAction = methodBody(plugin, "private void emitAction");
		const acknowledgeAction = methodBody(plugin, "public void acknowledgeAction");
		expect(policy).toContain("static final int MAX_ACTIONS = 8");
		expectInOrder(
			accept,
			"WeeklyNotificationPolicy.ACTION_OPEN_WEEKLY.equals(action)",
			"actions.containsKey(id)",
			"actions.put(id",
			"while (actions.size() > MAX_ACTIONS)",
			"actions.remove(actions.keySet().iterator().next())",
		);
		expect(capture).toContain("PENDING_ACTIONS.accept(");
		expect(acknowledge).toContain("actions.remove(id)");
		expect(pluginCaptureIntent).toContain(
			"AndroidWeeklyNotificationPlatform.captureIntent(intent)",
		);
		expect(pluginCaptureIntent).not.toContain("isWeeklyAction");
		expect(emitAction).toMatch(
			/notifyListeners\(EVENT_WEEKLY_NOTIFICATION_ACTION, actionObject\(action\), true\)/,
		);
		expect(acknowledgeAction).toMatch(
			/if \(!AndroidWeeklyNotificationPlatform\.acknowledgeAction\(id\)\)/,
		);
		expect(nativeTests).toContain(
			"weeklyActionBuffer_rejectsInvalidActionsAndMaintainsFifoDedupeCapAndAck",
		);
		expect(nativeTests).toContain('assertEquals("id-1", afterEviction.get(0).id)');
		expect(adapter).toMatch(/const MAX_ACTIONS = 8/);
		expect(adapter).toMatch(/entries\.size >= MAX_ACTIONS/);
		expect(adapter).toMatch(
			/type ActionState = "buffered" \| "delivering" \| "delivered-awaiting-ack"/,
		);
		expect(adapter).toMatch(/new Map<string, ActionEntry>\(\)/);
		expect(adapter).toMatch(/const awaiting = \[\.\.\.this\.entries\.values\(\)\]\.filter/);
		expect(adapter).toMatch(/entry\.state === "delivered-awaiting-ack"/);
		expect(adapter).toMatch(/entry\.state = "delivering"/);
		expect(adapter).toMatch(/entry\.state = "delivered-awaiting-ack"/);
		expect(adapter).toMatch(/acknowledgeAction\(\{ id: entry\.action\.id \}\)/);
		expect(adapter).toMatch(/this\.entries\.delete\(entry\.action\.id\)/);
		const adapterImplementation = classBody(adapter, "class WeeklyNotificationAdapterImpl");
		expect(adapterImplementation).not.toMatch(
			/setTimeout|setInterval|queueMicrotask|requestAnimationFrame/,
		);
		expect(count(adapterImplementation, /this\.requestPump\(\)/g)).toBe(3);
		const requestPump = methodBody(adapter, "private requestPump");
		expect(requestPump).toMatch(
			/if \(!binding \|\| !this\.isCurrent\(binding\) \|\| this\.boundBinding !== binding\) return;/,
		);
		expect(requestPump).toContain("if (this.installingBinding === binding) return;");
		const install = section(adapter, "public async addActionListener", "private receiveAction");
		expectInOrder(
			install,
			"this.plugin.addListener",
			"this.plugin.consumePendingActions",
			"this.requestPump()",
		);
		const receive = section(adapter, "private receiveAction", "private enqueue");
		expectInOrder(
			receive,
			"this.enqueue([action])",
			"this.boundBinding === binding",
			"this.requestPump()",
		);
		const pump = section(adapter, "private async pump", "private async tryAcknowledge");
		expect(count(pump, /tryAcknowledge\(entry\)/g)).toBe(2);
		expect(pump).toMatch(/for \(const entry of awaiting\)/);
		expect(pump).toMatch(/if \(entry\.state !== "buffered"\) continue;/);
	});

	it("guards queued reconciliation by the current owner and epoch before adapter effects", () => {
		const coordinator = readAllowed("android/src/notifications/weekly-notification-coordinator.ts");
		expect(coordinator).toMatch(/owner: DatabaseHandle \| null/);
		expect(coordinator).toMatch(/private epoch = 0/);
		expect(coordinator).toMatch(/private tail: Promise<void> = Promise\.resolve\(\)/);
		expect(coordinator).toMatch(
			/setOwner\(owner: DatabaseHandle \| null, snapshot: WeeklyNotificationSettings \| null\)/,
		);
		expect(coordinator).toMatch(/owner\.settings\.get\(\)/);
		const enqueue = section(
			coordinator,
			"private enqueue",
			"export function weeklyNotificationSettings",
		);
		expect(enqueue).toMatch(
			/if \(!this\.isCurrent\(owner, epoch\)\) return;\s*const result = await this\.adapter\.reconcile\(snapshot\)/,
		);
		expect(enqueue).toMatch(/if \(this\.isCurrent\(owner, epoch\)\) this\.onStatus\?\.\(result\)/);
		expect(coordinator).toMatch(/this\.epoch \+= 1/);
	});

	it("keeps the route, review storage seam, provider nesting, and enable token exact", () => {
		const bootstrap = readAllowed("android/src/components/layout/AppBootstrap.tsx");
		const app = readAllowed("android/src/App.tsx");
		const shell = readAllowed("android/src/components/layout/AppShell.tsx");
		const review = readAllowed("android/src/pages/WeeklyReview.tsx");
		const settings = readAllowed("android/src/components/settings/SettingsForm.tsx");
		const provider = readAllowed("android/src/notifications/WeeklyNotificationsProvider.tsx");
		expectInOrder(
			bootstrap,
			"<StorageProvider",
			"<AuthProvider",
			"<WeeklyNotificationsProvider",
			"<AppearanceSync",
			"{children}",
			"</AppearanceSync>",
			"</WeeklyNotificationsProvider>",
			"</AuthProvider>",
			"</StorageProvider>",
		);
		const weeklyRoute = app.indexOf('<Route path="/weekly"');
		const catchAll = app.indexOf('<Route path="*"');
		expect(weeklyRoute).toBeGreaterThanOrEqual(0);
		expect(catchAll).toBeGreaterThan(weeklyRoute);
		expect(shell).toMatch(/to: "\/weekly", label: "Weekly Review"/);
		const reviewEffect = section(
			review,
			"useEffect(() => {\n\t\tconst generation",
			"\n\t}, [instant, settingsError, storage, timezone]);",
		);
		expectInOrder(
			reviewEffect,
			"todayInTimezone(",
			"mostRecentSunday(",
			"mondayOfWeek(",
			"owner.journal.list(monday, sunday)",
			"buildDigestWeek(",
		);
		for (const call of [
			"todayInTimezone(",
			"mostRecentSunday(",
			"mondayOfWeek(",
			"buildDigestWeek(",
		]) {
			expect(reviewEffect.split(call).length - 1).toBe(1);
		}
		expect(reviewEffect).toContain("owner.journal.list(monday, sunday)");
		expect(review).toMatch(/day\.content === null \? "No entry\." : day\.content/);
		expect(review).toMatch(
			/const count = week\.filter\(\(day\) => day\.content !== null\)\.length/,
		);
		expect(provider).toMatch(/<NotificationPermissionProvider adapter=\{adapter\}>/);
		const enableHandler = section(
			settings,
			"const setWeeklyReviewEnabled",
			"\n\t};\n\n\tif (storage",
		);
		const currentPendingGuard = section(enableHandler, "const isCurrentPending", "\n\t\ttry {");
		for (const guard of [
			"mountedRef.current",
			"token === enableTokenRef.current",
			"capturedStorage === storageRef.current",
			"pendingWeeklyReviewRef.current === pending",
		]) {
			expect(currentPendingGuard).toContain(guard);
		}
		expectInOrder(
			enableHandler,
			"const token = ++enableTokenRef.current",
			"pendingWeeklyReviewRef.current = pending",
			"setPendingWeeklyReview(pending)",
			"await update({ weeklyReviewEnabled: enabled })",
			"if (!isCurrentPending()) return",
			"if (!enabled || !latest.weeklyReviewEnabled) return",
			"await requestIfPrompt()",
		);
	});

	it("keeps local Capacitor assets, verified scripts, and canonical dependency hashes", () => {
		const config = readAllowed("android/capacitor.config.ts");
		const index = readAllowed("android/index.html");
		const packageJson = readAllowed("android/package.json");
		const legacyBuild = readAllowed("android/scripts/verify-legacy-build.mjs");
		const legacyCss = readAllowed("android/scripts/verify-legacy-css.mjs");
		expect(config).toMatch(/webDir: "dist"/);
		expect(config).toMatch(/androidScheme: "https"/);
		expect(config).toMatch(/allowMixedContent: false/);
		const serverConfig = objectBody(config, "server");
		expect(serverConfig).not.toMatch(/\burl\s*:/);
		expect(index).toMatch(/<script type="module" src="\/src\/main\.tsx"><\/script>/);
		expect(index).not.toMatch(/https?:\/\//);
		const packageData = JSON.parse(packageJson) as {
			scripts: Record<string, string>;
			dependencies: unknown;
			devDependencies: unknown;
		};
		expect(packageData.scripts.build).toMatch(/verify-legacy-build\.mjs/);
		expect(packageData.scripts.build).toMatch(/verify-legacy-css\.mjs/);
		expect(packageData.scripts["cap:sync"]).toMatch(/bun run verify:legacy/);
		expect(packageData.scripts["cap:sync"]).toMatch(/bun run verify:css/);
		expectInOrder(
			packageData.scripts["cap:sync"],
			"verify:legacy",
			"verify:css",
			"cap sync android",
		);
		expect(legacyBuild).toMatch(/LEGACY BUILD CONTRACT OK/);
		expect(legacyCss).toMatch(/CSS CONTRACT OK/);
		const dependencyFields = JSON.stringify(
			sortJson({
				dependencies: packageData.dependencies,
				devDependencies: packageData.devDependencies,
			}),
		);
		expect(sha256(`${dependencyFields}\n`)).toBe(
			"2e579fba5ab2f266962a4f18ca5db56062067b90fb2da508c54013117526a6a8",
		);
		expect(sha256(readAllowed("bun.lock"))).toBe(
			"cd0d4a1deaef40a7139d630f02d5f2e8e6a20086fdcc974fe7c0d601bb349ade",
		);
	});
});
