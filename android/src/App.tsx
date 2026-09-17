import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "@/auth/auth-context";
import AppShell from "@/components/layout/AppShell";
import Archive from "@/pages/Archive";
import Journal from "@/pages/Journal";
import Settings from "@/pages/Settings";
import Today from "@/pages/Today";
import WeeklyReview from "@/pages/WeeklyReview";

// AppBootstrap (mounted in main.tsx) is the SOLE StorageProvider + AuthProvider;
// App itself renders no providers, so App-alone renders/tests honestly see
// context null (auth null -> RequireAuth passes children through, the honest
// non-native state where screens fail closed on missing storage).
//
// RequireAuth wraps the shell: on native, setup/login render instead of the
// shell (no tab bar), and /today, /journal/:date, /archive, /settings, and
// /weekly only render once unlocked. The catch-all stays behind the same gate.
export default function App() {
	return (
		<Routes>
			<Route
				element={
					<RequireAuth>
						<AppShell />
					</RequireAuth>
				}
			>
				<Route index element={<Navigate to="/today" replace />} />
				<Route path="/today" element={<Today />} />
				<Route path="/journal/:date" element={<Journal />} />
				<Route path="/archive" element={<Archive />} />
				<Route path="/settings" element={<Settings />} />
				<Route path="/weekly" element={<WeeklyReview />} />
				<Route path="*" element={<Navigate to="/today" replace />} />
			</Route>
		</Routes>
	);
}
