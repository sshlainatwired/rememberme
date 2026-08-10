import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { type SaveState, SaveStatus } from "./SaveStatus";

const DEBOUNCE_MS = 800;
const RETRY_MS = 5_000;

interface JournalEditorProps {
	/** Calendar date (YYYY-MM-DD) this editor writes to. */
	date: string;
	/** Initial content, decrypted server-side. */
	initialContent: string;
}

/**
 * The daily journal editor: a plain textarea with debounced autosave.
 *
 * - Typing is never blocked; saves happen 800ms after the last keystroke.
 * - The text stays in the editor even when a save fails; a retry is
 *   scheduled automatically and typing resets the timers.
 * - Leaving the page with unsaved changes triggers the browser guard.
 */
export default function JournalEditor({ date, initialContent }: JournalEditorProps) {
	const [content, setContent] = useState(initialContent);
	const [status, setStatus] = useState<SaveState>("idle");
	const [savedAt, setSavedAt] = useState<Date | null>(null);

	const contentRef = useRef(content);
	const lastSavedContentRef = useRef(initialContent);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	contentRef.current = content;

	const save = useCallback(
		async (value: string) => {
			setStatus("saving");
			try {
				const res = await fetch(`/api/journal/${date}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: value }),
				});
				if (!res.ok) throw new Error(`save failed: ${res.status}`);
				lastSavedContentRef.current = value;
				setStatus("saved");
				setSavedAt(new Date());
			} catch {
				setStatus("error");
				retryRef.current = setTimeout(() => {
					const latest = contentRef.current;
					if (latest !== lastSavedContentRef.current) {
						void save(latest);
					} else {
						setStatus("saved");
					}
				}, RETRY_MS);
			}
		},
		[date],
	);

	const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
		const value = e.target.value;
		setContent(value);
		setStatus("saving");
		if (debounceRef.current) clearTimeout(debounceRef.current);
		if (retryRef.current) clearTimeout(retryRef.current);
		debounceRef.current = setTimeout(() => void save(value), DEBOUNCE_MS);
	};

	useEffect(() => {
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
			if (retryRef.current) clearTimeout(retryRef.current);
		};
	}, []);

	// Warn before closing while a save is pending or failing.
	useEffect(() => {
		const handler = (e: BeforeUnloadEvent) => {
			if (status === "saving" || status === "error") {
				e.preventDefault();
			}
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [status]);

	return (
		<div className="flex flex-col gap-3">
			<textarea
				value={content}
				onChange={handleChange}
				placeholder="How was today?"
				aria-label="Journal entry"
				className="min-h-[60vh] w-full resize-none border-0 bg-transparent text-lg leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0"
			/>
			<SaveStatus status={status} savedAt={savedAt} />
		</div>
	);
}
