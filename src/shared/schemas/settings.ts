import { z } from "zod";

/** IANA timezone names supported by the runtime (e.g. "Europe/Istanbul"). */
const supportedTimeZones = new Set(Intl.supportedValuesOf("timeZone"));

export const timezoneSchema = z
	.string()
	.min(1)
	.refine((tz) => supportedTimeZones.has(tz), {
		message: "Invalid IANA timezone",
	});

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
