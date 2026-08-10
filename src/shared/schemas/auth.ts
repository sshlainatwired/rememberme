import { z } from "zod";
import { timezoneSchema } from "./settings";

/** Password rules: at least 8 characters, at most 128. */
export const passwordSchema = z.string().min(8).max(128);

/** Request body for POST /api/setup (first launch). */
export const setupSchema = z
	.object({
		password: passwordSchema,
		confirmPassword: passwordSchema,
		timezone: timezoneSchema.default("UTC"),
	})
	.refine((d) => d.password === d.confirmPassword, {
		message: "Passwords do not match",
		path: ["confirmPassword"],
	});

export type SetupInput = z.infer<typeof setupSchema>;

/** Request body for POST /api/login (password only). */
export const loginSchema = z.object({
	password: z.string().min(1).max(128),
});

export type LoginInput = z.infer<typeof loginSchema>;

/** Request body for POST /api/settings/password. */
export const changePasswordSchema = z.object({
	currentPassword: passwordSchema,
	newPassword: passwordSchema,
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
