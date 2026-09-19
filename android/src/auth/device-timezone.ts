import { isTimezoneSupported } from "@rememberme/core";

/**
 * Resolve the device's IANA timezone for seeding first-run setup.
 *
 * The setup form must record whichever zone the device actually uses, so the
 * weekly review hour is applied in the right wall-clock time. Any invalid,
 * missing, or unsupported value falls back to "UTC" (the safe default) —
 * setup never proceeds from an unvalidated zone. The result is passed to
 * `AuthService.setup` as the seeded `timezone` setting.
 */
export function deviceTimezone(): string {
	try {
		const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (typeof zone === "string" && isTimezoneSupported(zone)) {
			return zone;
		}
		return "UTC";
	} catch {
		return "UTC";
	}
}
