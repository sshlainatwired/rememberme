import { Settings as SettingsIcon } from "lucide-react";
import SettingsForm from "@/components/settings/SettingsForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Settings — Android-specific settings screen (Phase 5 Task 9).
 *
 * Renders the live SettingsForm under the heading. Retains (on the Android
 * settings schema): timezone, weekly-review enabled/time, biometric/security,
 * backup/restore, appearance. No email or server-password controls on
 * Android. The form itself fails closed on absent storage / pending reads /
 * read failures; this page only frames it.
 */
export default function Settings() {
	return (
		<section aria-labelledby="settings-title" className="page-section">
			<div className="page-heading-row">
				<SettingsIcon className="page-icon" aria-hidden="true" />
				<h1 id="settings-title" className="page-title">
					Settings
				</h1>
			</div>
			<Card>
				<CardHeader>
					<CardTitle>Preferences</CardTitle>
					<CardDescription>
						Timezone, weekly review and appearance preferences — all stored on-device.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<SettingsForm />
				</CardContent>
			</Card>
		</section>
	);
}
