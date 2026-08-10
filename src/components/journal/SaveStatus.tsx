import { cn } from "@/lib/utils";

export type SaveState = "idle" | "saving" | "saved" | "error";

interface SaveStatusProps {
	status: SaveState;
	savedAt: Date | null;
}

function formatSavedAt(savedAt: Date): string {
	const seconds = (Date.now() - savedAt.getTime()) / 1000;
	if (seconds < 45) return "Saved just now";
	return `Saved ${savedAt.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	})}`;
}

/** Tiny, calm status line under the editor. */
export function SaveStatus({ status, savedAt }: SaveStatusProps) {
	if (status === "saving") {
		return (
			<p className="text-xs text-muted-foreground" role="status">
				Saving…
			</p>
		);
	}
	if (status === "error") {
		return (
			<p className="text-xs text-destructive" role="status">
				Unable to save — your writing is safe here. Retrying…
			</p>
		);
	}
	if (status === "saved" && savedAt) {
		return (
			<p className={cn("text-xs text-muted-foreground")} role="status">
				{formatSavedAt(savedAt)}
			</p>
		);
	}
	return (
		<p className="text-xs text-transparent" aria-hidden="true">
			·
		</p>
	);
}
