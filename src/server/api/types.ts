import type { Auth } from "../auth";
import type { AppConfig } from "../config";
import type { JournalCipher } from "../crypto/journal-encryption";
import type { Db } from "../db/client";
import type { Mailer } from "../mail/mailer";

/** Everything the API routes need, injectable for tests. */
export interface ApiDeps {
	config: AppConfig;
	db: Db;
	auth: Auth;
	cipher: JournalCipher;
	mailer: Mailer | null;
}
