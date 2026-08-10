import { LogOut } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export interface SettingsValues {
	email: string;
	timezone: string;
	weeklyDigestEnabled: boolean;
	weeklyDigestHour: number;
}

const DEFAULT_SETTINGS: SettingsValues = {
	email: "",
	timezone: "UTC",
	weeklyDigestEnabled: false,
	weeklyDigestHour: 20,
};

function timezoneGroups(): { region: string; zones: string[] }[] {
	let zones: string[];
	try {
		zones = Intl.supportedValuesOf("timeZone");
	} catch {
		zones = ["UTC"];
	}
	const groups = new Map<string, string[]>();
	for (const zone of zones) {
		const region = zone.includes("/") ? zone.split("/")[0] : "Other";
		const list = groups.get(region) ?? [];
		list.push(zone);
		groups.set(region, list);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([region, list]) => ({ region, zones: list.sort() }));
}

function hourLabel(hour: number): string {
	return `${String(hour).padStart(2, "0")}:00`;
}

/** Hours of the day offered in the digest schedule selector. */
const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** Settings page: account (password, logout) + weekly digest. */
export default function SettingsForm({ initial }: { initial: SettingsValues | null }) {
	const [values, setValues] = useState<SettingsValues>(initial ?? DEFAULT_SETTINGS);
	const [busy, setBusy] = useState(false);
	const [pwOpen, setPwOpen] = useState(false);
	const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
	const [pwError, setPwError] = useState<string | null>(null);
	const [pwBusy, setPwBusy] = useState(false);
	const groups = useMemo(timezoneGroups, []);

	function set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) {
		setValues((v) => ({ ...v, [key]: value }));
	}

	async function save(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		try {
			const res = await fetch("/api/settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(values),
			});
			if (!res.ok) throw new Error(`save failed: ${res.status}`);
			toast.success("Settings saved");
		} catch {
			toast.error("Could not save settings");
		}
		setBusy(false);
	}

	async function changePassword(e: FormEvent) {
		e.preventDefault();
		setPwError(null);
		if (pw.next.length < 8) {
			setPwError("New password must be at least 8 characters.");
			return;
		}
		if (pw.next !== pw.confirm) {
			setPwError("New passwords do not match.");
			return;
		}
		setPwBusy(true);
		try {
			const res = await fetch("/api/settings/password", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					currentPassword: pw.current,
					newPassword: pw.next,
				}),
			});
			const data = (await res.json().catch(() => null)) as {
				error?: string;
			} | null;
			if (!res.ok) {
				setPwError(data?.error ?? "Could not change password.");
				setPwBusy(false);
				return;
			}
			setPw({ current: "", next: "", confirm: "" });
			setPwOpen(false);
			toast.success("Password changed");
		} catch {
			setPwError("Could not reach the server.");
			setPwBusy(false);
		}
	}

	async function logout() {
		await fetch("/api/logout", { method: "POST" });
		window.location.href = "/login";
	}

	return (
		<div className="flex flex-col gap-8">
			<header>
				<h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
			</header>

			{/* Account */}
			<Card>
				<CardHeader>
					<CardTitle>Account</CardTitle>
					<CardDescription>Your password and sign-in.</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<div className="flex flex-wrap items-center gap-3">
						<Dialog open={pwOpen} onOpenChange={setPwOpen}>
							<DialogTrigger asChild>
								<Button variant="outline">Change password</Button>
							</DialogTrigger>
							<DialogContent>
								<form onSubmit={changePassword} className="flex flex-col gap-4">
									<DialogHeader>
										<DialogTitle>Change password</DialogTitle>
										<DialogDescription>
											Other signed-in devices will be signed out.
										</DialogDescription>
									</DialogHeader>
									<div className="flex flex-col gap-1.5">
										<Label htmlFor="current">Current password</Label>
										<Input
											id="current"
											type="password"
											autoComplete="current-password"
											value={pw.current}
											onChange={(e) => setPw({ ...pw, current: e.target.value })}
											required
										/>
									</div>
									<div className="flex flex-col gap-1.5">
										<Label htmlFor="next">New password</Label>
										<Input
											id="next"
											type="password"
											autoComplete="new-password"
											value={pw.next}
											onChange={(e) => setPw({ ...pw, next: e.target.value })}
											required
										/>
									</div>
									<div className="flex flex-col gap-1.5">
										<Label htmlFor="confirm">Confirm new password</Label>
										<Input
											id="confirm"
											type="password"
											autoComplete="new-password"
											value={pw.confirm}
											onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
											required
										/>
									</div>
									{pwError && <p className="text-sm text-destructive">{pwError}</p>}
									<DialogFooter>
										<Button type="submit" disabled={pwBusy}>
											{pwBusy ? "Saving…" : "Change password"}
										</Button>
									</DialogFooter>
								</form>
							</DialogContent>
						</Dialog>
						<Button variant="ghost" onClick={logout}>
							<LogOut className="h-4 w-4" aria-hidden="true" />
							Log out
						</Button>
					</div>
				</CardContent>
			</Card>

			{/* Weekly digest */}
			<form onSubmit={save}>
				<Card>
					<CardHeader>
						<CardTitle>Weekly digest</CardTitle>
						<CardDescription>
							Every Sunday evening, rememberme emails you the week&apos;s entries.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-5">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="email">Email</Label>
							<Input
								id="email"
								type="email"
								placeholder="you@example.com"
								value={values.email}
								onChange={(e) => set("email", e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								Only used to send the weekly digest. Never shown anywhere else.
							</p>
						</div>

						<div className="flex items-center justify-between gap-4">
							<div className="flex flex-col gap-1">
								<Label htmlFor="digest-enabled">Send weekly digest</Label>
								<p className="text-xs text-muted-foreground">Requires an email address above.</p>
							</div>
							<Switch
								id="digest-enabled"
								checked={values.weeklyDigestEnabled}
								onCheckedChange={(checked) => set("weeklyDigestEnabled", checked)}
							/>
						</div>

						<div className="grid gap-5 sm:grid-cols-2">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="timezone">Timezone</Label>
								<select
									id="timezone"
									value={values.timezone}
									onChange={(e) => set("timezone", e.target.value)}
									className={cn(
										"h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
									)}
								>
									{groups.map(({ region, zones }) => (
										<optgroup key={region} label={region}>
											{zones.map((zone) => (
												<option key={zone} value={zone}>
													{zone}
												</option>
											))}
										</optgroup>
									))}
								</select>
								<p className="text-xs text-muted-foreground">
									Used to decide what &ldquo;today&rdquo; means.
								</p>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="digest-hour">Send at</Label>
								<select
									id="digest-hour"
									value={values.weeklyDigestHour}
									onChange={(e) => set("weeklyDigestHour", Number(e.target.value))}
									className={cn(
										"h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
									)}
								>
									{HOURS.map((hour) => (
										<option key={hour} value={hour}>
											{hourLabel(hour)}
										</option>
									))}
								</select>
							</div>
						</div>

						<div>
							<Button type="submit" disabled={busy}>
								{busy ? "Saving…" : "Save settings"}
							</Button>
						</div>
					</CardContent>
				</Card>
			</form>
		</div>
	);
}
