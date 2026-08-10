import type { DateTime } from "luxon";

/**
 * Weekly digest email generation. Pure functions: given a week (Monday–Sunday)
 * and the decrypted entries, produce the subject, HTML, and plain-text bodies.
 * No SMTP, no database, no logging of content.
 */

export interface DigestDay {
	date: DateTime; // Monday..Sunday of the week
	content: string | null; // null when the user wrote no entry that day
}

export interface DigestEmail {
	subject: string;
	html: string;
	text: string;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Convert plain-text entry content to safe HTML paragraphs. */
function contentToHtml(content: string): string {
	return content
		.split("\n")
		.map((line) => escapeHtml(line))
		.join("<br>");
}

function contentToText(content: string): string {
	return content.replace(/\n+/g, "\n");
}

function formatRange(start: DateTime, end: DateTime): string {
	const sameMonth = start.month === end.month && start.year === end.year;
	if (sameMonth) return `${start.toFormat("MMMM d")} — ${end.toFormat("MMMM d, yyyy")}`;
	return `${start.toFormat("MMMM d")} — ${end.toFormat("MMMM d, yyyy")}`;
}

export function buildDigestEmail(
	weekStart: DateTime, // Monday
	weekEnd: DateTime, // Sunday
	days: DigestDay[],
): DigestEmail {
	const entryCount = days.filter((d) => d.content !== null).length;
	const range = formatRange(weekStart, weekEnd);

	const blocks = days
		.map((day) => {
			const heading = `${day.date.toFormat("cccc").toUpperCase()} · ${day.date.toFormat("LLLL d")}`;
			if (day.content === null || day.content.trim() === "") {
				return { heading, body: "No entry." };
			}
			return { heading, body: day.content };
		})
		.map(
			({ heading, body }) =>
				`<tr><td style="padding:18px 0 4px 0;border-bottom:1px solid #e7e5e4;">
          <span style="font-size:12px;letter-spacing:0.08em;color:#78716c;font-weight:600;">${escapeHtml(heading)}</span>
        </td></tr>
        <tr><td style="padding:10px 0 6px 0;color:#1c1917;font-size:15px;line-height:1.6;white-space:pre-wrap;">${
					body === "No entry."
						? `<span style="color:#a8a29e;font-style:italic;">No entry.</span>`
						: contentToHtml(body)
				}</td></tr>`,
		)
		.join("");

	const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#fafaf9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fafaf9;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border:1px solid #e7e5e4;border-radius:12px;">
        <tr><td style="padding:28px 28px 20px 28px;">
          <div style="font-size:13px;letter-spacing:0.12em;text-transform:lowercase;color:#78716c;">rememberme</div>
          <div style="font-size:24px;font-weight:700;color:#1c1917;margin-top:6px;">Your week</div>
          <div style="font-size:14px;color:#78716c;margin-top:2px;">${escapeHtml(range)}</div>
        </td></tr>
        ${blocks}
        <tr><td style="padding:20px 28px 28px 28px;color:#a8a29e;font-size:12px;">
          7 days · ${entryCount} ${entryCount === 1 ? "entry" : "entries"}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

	const text = [
		"rememberme — Your week",
		range,
		"",
		...days.map((day) => {
			const heading = `${day.date.toFormat("cccc").toUpperCase()} · ${day.date.toFormat("LLLL d")}`;
			const body =
				day.content === null || day.content.trim() === ""
					? "No entry."
					: contentToText(day.content);
			return `${heading}\n${body}`;
		}),
		"",
		`7 days · ${entryCount} ${entryCount === 1 ? "entry" : "entries"}`,
	].join("\n");

	return {
		subject: `Your week — ${range}`,
		html,
		text,
	};
}
