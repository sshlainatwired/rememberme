/// <reference types="astro/client" />

import type { Session, User } from "better-auth";

export interface AuthSession {
	session: Session;
	user: User;
}

declare global {
	namespace App {
		interface Locals {
			/** Better Auth session wrapper for the current request, or null. */
			session: AuthSession | null;
		}
	}
}
