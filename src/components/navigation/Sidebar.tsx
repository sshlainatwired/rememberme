import { CalendarDays, LogOut, Menu, PenLine, Settings, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
	{ href: "/journal/today", label: "Today", icon: PenLine, match: "/journal" },
	{ href: "/archive", label: "Archive", icon: CalendarDays, match: "/archive" },
	{ href: "/settings", label: "Settings", icon: Settings, match: "/settings" },
] as const;

interface SidebarProps {
	pathname: string;
}

function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
	return (
		<nav className="flex flex-col gap-1" aria-label="Main">
			{NAV_LINKS.map(({ href, label, icon: Icon, match }) => {
				const active = pathname.startsWith(match);
				return (
					<a
						key={href}
						href={href}
						onClick={onNavigate}
						className={cn(
							"flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
							active
								? "bg-accent font-medium text-accent-foreground"
								: "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
						)}
						aria-current={active ? "page" : undefined}
					>
						<Icon className="h-4 w-4" aria-hidden="true" />
						{label}
					</a>
				);
			})}
			<button
				type="button"
				onClick={async () => {
					await fetch("/api/logout", { method: "POST" });
					window.location.href = "/login";
				}}
				className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
			>
				<LogOut className="h-4 w-4" aria-hidden="true" />
				Log out
			</button>
		</nav>
	);
}

function Brand() {
	return <span className="text-lg tracking-wide text-foreground">rememberme</span>;
}

/**
 * Minimal navigation: fixed sidebar on desktop, a top bar with a slide-in
 * drawer on mobile. Pure client island so the drawer needs no server state.
 */
export default function Sidebar({ pathname }: SidebarProps) {
	const [open, setOpen] = useState(false);

	return (
		<>
			{/* Desktop */}
			<aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col gap-8 border-r bg-background px-4 py-6 md:flex">
				<Brand />
				<NavList pathname={pathname} />
				<p className="mt-auto text-xs text-muted-foreground/70">Private. Encrypted at rest.</p>
			</aside>

			{/* Mobile top bar */}
			<header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b bg-background/90 px-4 backdrop-blur md:hidden">
				<Brand />
				<button
					type="button"
					onClick={() => setOpen(true)}
					className="rounded-md p-2 text-muted-foreground hover:bg-accent"
					aria-label="Open menu"
				>
					<Menu className="h-5 w-5" />
				</button>
			</header>

			{/* Mobile drawer */}
			{open && (
				<div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
					<button
						type="button"
						className="absolute inset-0 bg-black/40"
						onClick={() => setOpen(false)}
						aria-label="Close menu"
					/>
					<div className="absolute inset-y-0 left-0 flex w-64 flex-col gap-8 bg-background px-4 py-6 shadow-lg">
						<div className="flex items-center justify-between">
							<Brand />
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="rounded-md p-2 text-muted-foreground hover:bg-accent"
								aria-label="Close menu"
							>
								<X className="h-5 w-5" />
							</button>
						</div>
						<NavList pathname={pathname} onNavigate={() => setOpen(false)} />
					</div>
				</div>
			)}
		</>
	);
}
