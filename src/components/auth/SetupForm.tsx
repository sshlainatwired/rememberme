import { type SyntheticEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function browserTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** First-launch form: create the password. Sends the browser timezone so
 * "today" is correct from day one. */
export default function SetupForm() {
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(e: SyntheticEvent<HTMLFormElement>) {
		e.preventDefault();
		setError(null);
		if (password.length < 8) {
			setError("Password must be at least 8 characters.");
			return;
		}
		if (password !== confirm) {
			setError("Passwords do not match.");
			return;
		}
		setBusy(true);
		try {
			const res = await fetch("/api/setup", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					password,
					confirmPassword: confirm,
					timezone: browserTimezone(),
				}),
			});
			if (res.ok) {
				window.location.href = "/journal/today";
				return;
			}
			const data = (await res.json().catch(() => null)) as {
				error?: string;
			} | null;
			setError(data?.error ?? "Something went wrong. Please try again.");
		} catch {
			setError("Could not reach the server. Please try again.");
		}
		setBusy(false);
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-6">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="password">Password</Label>
				<Input
					id="password"
					type="password"
					autoComplete="new-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					required
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="confirm">Confirm password</Label>
				<Input
					id="confirm"
					type="password"
					autoComplete="new-password"
					value={confirm}
					onChange={(e) => setConfirm(e.target.value)}
					required
				/>
			</div>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<Button type="submit" disabled={busy} className="w-full">
				{busy ? "Creating…" : "Create journal"}
			</Button>
		</form>
	);
}
