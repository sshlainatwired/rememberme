import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useNotificationPermission } from "@/notifications/use-notification-permission";

function blockedCopy(blockedAt: "runtime" | "app" | "channel"): string {
	switch (blockedAt) {
		case "runtime":
			return "Android has blocked notification permission for RememberMe.";
		case "app":
			return "Notifications are disabled for RememberMe in Android app settings.";
		case "channel":
			return "Notifications are disabled for the weekly review notification channel.";
	}
}

export function NotificationPermissionCard() {
	const { status, blockedAt, loading, error, requestIfPrompt, openSystemSettings } =
		useNotificationPermission();

	if (status === "unsupported") return null;
	if (loading && status === null) {
		return (
			<Card aria-label="Notification permission">
				<CardContent>
					<p role="status">Checking notification permission…</p>
				</CardContent>
			</Card>
		);
	}

	const blocked = status === "denied" && blockedAt !== null;
	return (
		<Card aria-label="Notification permission">
			<CardHeader>
				<CardTitle>Weekly review notifications</CardTitle>
				<CardDescription>
					{status === "granted"
						? "Notifications are enabled."
						: status === "prompt"
							? "Allow notifications to receive a weekly reminder."
							: blocked
								? blockedCopy(blockedAt)
								: "Notification permission is unavailable."}
				</CardDescription>
			</CardHeader>
			<CardContent>
				{status === "prompt" && (
					<button
						type="button"
						className="btn btn-secondary"
						onClick={() => void requestIfPrompt()}
					>
						Allow notifications
					</button>
				)}
				{blocked && (
					<button
						type="button"
						className="btn btn-secondary"
						onClick={() => void openSystemSettings()}
					>
						Open notification settings
					</button>
				)}
				{error !== null && (
					<p className="error-text" role="alert">
						{error}
					</p>
				)}
			</CardContent>
		</Card>
	);
}

export default NotificationPermissionCard;
