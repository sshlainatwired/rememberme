import { type SyntheticEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Password-only login. The account's email is resolved server-side. */
export default function LoginForm() {
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(e: SyntheticEvent<HTMLFormElement>) {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			const res = await fetch("/api/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password }),
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
					autoComplete="current-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					autoFocus
					required
				/>
			</div>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<Button type="submit" disabled={busy} className="w-full">
				{busy ? "Signing in…" : "Continue"}
			</Button>
		</form>
	);
}
