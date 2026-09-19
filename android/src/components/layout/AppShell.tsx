import { CalendarDays, NotebookPen, Settings, Sparkles } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
	{ to: "/today", label: "Today", icon: NotebookPen },
	{ to: "/weekly", label: "Weekly Review", icon: Sparkles },
	{ to: "/archive", label: "Archive", icon: CalendarDays },
	{ to: "/settings", label: "Settings", icon: Settings },
] as const;

/**
 * RememberMe app shell (adapted from the web Sidebar): a top brand bar plus a
 * bottom tab bar for thumb-friendly touch navigation. Single-cell column; the
 * outlet renders the routed page below. Static/offline — no server links.
 * Phase 5 Task 1: semantic `.app-*`/`.nav-*` classes replace Tailwind
 * utilities (see global.css); DOM and accessibility contract are unchanged.
 */
export default function AppShell() {
	return (
		<div className="app-shell">
			<header className="app-header">
				<span className="app-brand">rememberme</span>
			</header>
			<main className="app-main">
				<Outlet />
			</main>
			<nav aria-label="Main" className="tab-bar">
				<ul className="tab-list">
					{NAV_LINKS.map(({ to, label, icon: Icon }) => (
						<li key={to} className="tab-item">
							<NavLink
								to={to}
								className={({ isActive }) =>
									cn("nav-link", isActive ? "nav-link-active" : "nav-link-idle")
								}
							>
								{({ isActive }) => (
									<>
										<Icon
											className="nav-icon"
											aria-hidden="true"
											strokeWidth={isActive ? 2.2 : 1.8}
										/>
										<span className="nav-label">{label}</span>
									</>
								)}
							</NavLink>
						</li>
					))}
				</ul>
			</nav>
		</div>
	);
}
