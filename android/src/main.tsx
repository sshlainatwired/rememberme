import { Capacitor } from "@capacitor/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "@/App";
import AppBootstrap from "@/components/layout/AppBootstrap";
import "@/styles/global.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
	throw new Error("Missing #root element");
}

// Storage opens + migrates BEFORE any screen renders (native only). On web/
// test/dev there is no storage layer at all — no browser persistence
// substitutes for the on-device database. Failure fails closed with a clear,
// non-destructive startup screen instead of the app.
createRoot(rootEl).render(
	<StrictMode>
		<HashRouter>
			<AppBootstrap attemptNative={Capacitor.isNativePlatform()}>
				<App />
			</AppBootstrap>
		</HashRouter>
	</StrictMode>,
);
