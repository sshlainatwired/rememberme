import { timezoneSchema } from "@rememberme/core";
import { z } from "zod";

/**
 * Web settings schema.
 *
 * Phase 2 split: the lower-level timezone validation primitive now lives in
 * the shared `@rememberme/core` package (`timezoneSchema`), consumed and
 * re-exported here unchanged. The web-only settings fields (digest email,
 * digest hour, digest enabled) stay in this module; the Android app builds
 * its own settings schema on the same shared primitive without these fields.
 */
export { timezoneSchema };

export const digestHourSchema = z.number().int().min(0).max(23);

/** Digest recipient email; empty string disables sending until set. */
export const emailSchema = z.union([z.literal(""), z.email().trim().max(254)]);

/** Request body for PUT /api/settings */
export const settingsSchema = z.object({
	email: emailSchema,
	timezone: timezoneSchema,
	weeklyDigestEnabled: z.boolean(),
	weeklyDigestHour: digestHourSchema,
});

export type SettingsInput = z.infer<typeof settingsSchema>;

/** The default settings applied when a new account is created. */
export const defaultSettingsInput: SettingsInput = {
	email: "",
	timezone: "UTC",
	weeklyDigestEnabled: false,
	weeklyDigestHour: 20,
};
