import nodemailer, { type Transporter } from "nodemailer";
import type { AppConfig } from "../config";

/**
 * SMTP mailer. Credentials come exclusively from the validated environment;
 * they are never stored in the database and never exposed to the browser.
 *
 * In development and tests, when no SMTP host is configured, a jsonTransport
 * fallback is used so the weekly digest job still runs end-to-end. The
 * fallback never logs the message body (it may contain decrypted journal
 * content) — send() simply resolves.
 */

export interface MailMessage {
	to: string;
	subject: string;
	text: string;
	html: string;
}

export interface Mailer {
	send(message: MailMessage): Promise<void>;
}

/** SMTP transport, or null when SMTP is unavailable. */
function createSmtpTransport(config: AppConfig): Transporter | null {
	if (!config.SMTP_HOST) return null;
	return nodemailer.createTransport({
		host: config.SMTP_HOST,
		port: config.SMTP_PORT,
		secure: config.SMTP_PORT === 465,
		auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
	});
}

export function createMailer(config: AppConfig): Mailer | null {
	if (!config.MAIL_FROM) return null;

	const smtp = createSmtpTransport(config);
	if (!smtp) {
		// Production requires SMTP; dev/test get a silent no-op fallback.
		if (config.NODE_ENV === "production") return null;
		return {
			async send(_message: MailMessage): Promise<void> {
				// No-op: the digest job completes without delivering anywhere.
			},
		};
	}

	return {
		async send(message: MailMessage): Promise<void> {
			await smtp.sendMail({
				from: config.MAIL_FROM,
				to: message.to,
				subject: message.subject,
				text: message.text,
				html: message.html,
			});
		},
	};
}
