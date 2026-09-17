import { journalContentSchema } from "@rememberme/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JournalEditor from "@/components/journal/JournalEditor";
import { JournalService } from "@/db/journal";
import { applyMigrations } from "@/db/migrations";
import { createTestDb } from "@/db/test-helper";

/** A promise the test opens/rejects by hand, to hold a write genuinely in flight. */
function makeGate(): {
	promise: Promise<void>;
	open: () => void;
	fail: (reason?: unknown) => void;
} {
	let open!: () => void;
	let fail!: (reason?: unknown) => void;
	const promise = new Promise<void>((resolve, reject) => {
		open = resolve;
		fail = reject;
	});
	return { promise, open, fail };
}

// Real in-memory JournalService over the node:sqlite dialect (createTestDb),
// so debounced/retried/delete writes go through the same repository the app
// uses. Fake timers drive the 800ms debounce and 5s retry deterministically.
// Migrations run first (createTestDb returns a bare dialect with no tables),
// mirroring how journal.vitest.ts's `setup()` builds a service.
async function makeService() {
	const db = createTestDb();
	await applyMigrations(db);
	return new JournalService(db);
}

// Wait for the sqlite-backed service promise chain to settle (node:sqlite
// resolves on microtasks, not timers, so timer advancement alone is not enough).
async function settle() {
	for (let i = 0; i < 10; i += 1) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
	await settle();
}

function textarea(date = "2026-08-10") {
	return screen.getByLabelText(`Journal entry for ${date}`) as HTMLTextAreaElement;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("JournalEditor: preloaded content and explicit states", () => {
	it("loads the preloaded content and shows saved state", async () => {
		const svc = await makeService();
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="hello" />);
		expect(textarea().value).toBe("hello");
		expect(screen.getByText("Saved")).toBeInTheDocument();
		expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
	});

	it("shows an explicit loading state until preloaded content is provided", async () => {
		const svc = await makeService();
		render(<JournalEditor date="2026-08-10" service={svc} initialContent={null} />);
		expect(screen.getByText(/Loading entry/)).toBeInTheDocument();
		// The loading line is announced as live status, never a plain paragraph.
		expect(screen.getByRole("status").textContent).toMatch(/loading entry/i);
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});

	it("swaps to the textarea once the preloaded content arrives", async () => {
		const svc = await makeService();
		const { rerender } = render(
			<JournalEditor date="2026-08-10" service={svc} initialContent={null} />,
		);
		rerender(<JournalEditor date="2026-08-10" service={svc} initialContent="hello" />);
		expect(screen.queryByText(/Loading entry/)).not.toBeInTheDocument();
		expect(textarea().value).toBe("hello");
		expect(screen.getByText("Saved")).toBeInTheDocument();
	});
});

describe("JournalEditor: debounce and single write", () => {
	it("does not save before the 800ms debounce window elapses", async () => {
		const svc = await makeService();
		const upsert = vi.spyOn(svc, "upsert");
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="" />);
		fireEvent.change(textarea(), { target: { value: "a" } });
		await advance(799);
		expect(upsert).not.toHaveBeenCalled();
		expect(await svc.get("2026-08-10")).toBeNull();
	});

	it("debounces by 800ms and saves the newest value once", async () => {
		const svc = await makeService();
		const upsert = vi.spyOn(svc, "upsert");
		const onSaved = vi.fn();
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="" onSaved={onSaved} />);
		fireEvent.change(textarea(), { target: { value: "a" } });
		fireEvent.change(textarea(), { target: { value: "ab" } });
		await advance(800);
		expect(upsert).toHaveBeenCalledTimes(1);
		expect(upsert).toHaveBeenCalledWith("2026-08-10", "ab");
		expect(await svc.get("2026-08-10")).toMatchObject({ content: "ab" });
		expect(onSaved).toHaveBeenCalledWith("ab");
	});

	it("does not re-save when the value matches the last saved value", async () => {
		const svc = await makeService();
		await svc.upsert("2026-08-10", "hello");
		const upsert = vi.spyOn(svc, "upsert");
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="hello" />);
		await advance(1000);
		expect(upsert).not.toHaveBeenCalled();
	});
});

describe("JournalEditor: empty content deletes through upsert", () => {
	it("deletes the row when content is cleared", async () => {
		const svc = await makeService();
		await svc.upsert("2026-08-10", "x");
		const onSaved = vi.fn();
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="x" onSaved={onSaved} />);
		fireEvent.change(textarea(), { target: { value: "" } });
		await advance(800);
		expect(await svc.get("2026-08-10")).toBeNull();
		expect(onSaved).toHaveBeenCalledWith("");
	});
});

describe("JournalEditor: failures, latest-value retry, and typing resets", () => {
	it("shows an explicit error status when a save fails", async () => {
		const svc = await makeService();
		vi.spyOn(svc, "upsert").mockRejectedValueOnce(new Error("db busy"));
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="" />);
		fireEvent.change(textarea(), { target: { value: "v1" } });
		await advance(800);
		expect(screen.getByRole("alert").textContent).toMatch(/could not save/i);
		expect(textarea().value).toBe("v1");
	});

	it("retries every 5s with the LATEST value after failures and recovers to saved", async () => {
		const svc = await makeService();
		const real = svc.upsert.bind(svc);
		// Reject the first two write attempts (v1 debounce + v2 debounce), then
		// succeed on the 5s retry so it is the retry that persists v2.
		vi.spyOn(svc, "upsert")
			.mockRejectedValueOnce(new Error("db busy"))
			.mockRejectedValueOnce(new Error("db busy"))
			.mockImplementation(real);
		const onSaved = vi.fn();
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="" onSaved={onSaved} />);
		fireEvent.change(textarea(), { target: { value: "v1" } });
		await advance(800); // v1 debounce fails -> error status + retry armed
		expect(screen.getByRole("alert").textContent).toMatch(/could not save/i);
		fireEvent.change(textarea(), { target: { value: "v2" } });
		await advance(800); // v2 debounce fails too -> error + retry re-armed
		expect(screen.getByRole("alert").textContent).toMatch(/could not save/i);
		await advance(5000); // 5s retry now sends the LATEST value (v2)
		expect(await svc.get("2026-08-10")).toMatchObject({ content: "v2" });
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.getByText("Saved")).toBeInTheDocument();
		expect(onSaved).toHaveBeenCalledWith("v2");
	});

	it("clears the error status when the user types again", async () => {
		const svc = await makeService();
		vi.spyOn(svc, "upsert").mockRejectedValueOnce(new Error("db busy"));
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="" />);
		fireEvent.change(textarea(), { target: { value: "v1" } });
		await advance(800);
		expect(screen.getByRole("alert")).toBeInTheDocument();
		fireEvent.change(textarea(), { target: { value: "v2" } });
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});

describe("JournalEditor: 100,000-character boundary (shared core cap)", () => {
	it("blocks input beyond 100,000 characters and shows an error", async () => {
		const svc = await makeService();
		const upsert = vi.spyOn(svc, "upsert");
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="" />);
		fireEvent.change(textarea(), { target: { value: "x".repeat(100_000) } });
		expect(textarea().value).toHaveLength(100_000);
		fireEvent.change(textarea(), { target: { value: "x".repeat(100_001) } });
		expect(textarea().value).toHaveLength(100_000);
		expect(screen.getByRole("alert").textContent).toMatch(/100,000 characters/i);
		await advance(800);
		// The overflow must never reach the repository.
		expect(upsert).toHaveBeenCalledTimes(1);
		expect(upsert).toHaveBeenCalledWith("2026-08-10", "x".repeat(100_000));
	});

	it("accepts exactly 100,000 characters (boundary matches the shared schema)", async () => {
		const svc = await makeService();
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="" />);
		fireEvent.change(textarea(), { target: { value: "x".repeat(100_000) } });
		expect(textarea().value).toHaveLength(100_000);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		await advance(800);
		expect(await svc.get("2026-08-10")).toMatchObject({ content: "x".repeat(100_000) });
	});
});

describe("JournalEditor: unmount flush and cancellation", () => {
	it("flushes the latest value on unmount when dirty", async () => {
		const svc = await makeService();
		const { unmount } = render(<JournalEditor date="2026-08-10" service={svc} initialContent="" />);
		fireEvent.change(textarea(), { target: { value: "typed" } });
		unmount(); // flush path: debounce has not elapsed
		await settle();
		expect(await svc.get("2026-08-10")).toMatchObject({ content: "typed" });
	});

	it("does not write on unmount when clean", async () => {
		const svc = await makeService();
		const { unmount } = render(
			<JournalEditor date="2026-08-10" service={svc} initialContent="hello" />,
		);
		unmount();
		await settle();
		expect(await svc.get("2026-08-10")).toBeNull();
	});

	it("a save that resolves after unmount cannot mutate a newer date's row", async () => {
		const svc = await makeService();
		await svc.upsert("2026-08-11", "newer-date-content");
		let resolveUpsert!: () => void;
		const gate = new Promise<void>((resolve) => {
			resolveUpsert = resolve;
		});
		const real = svc.upsert.bind(svc);
		// First write attempt stays pending past unmount (the view keyed-remount
		// analog: a save for the OLD date that only resolves after unmount).
		vi.spyOn(svc, "upsert").mockImplementationOnce(() => gate.then(() => real("2026-08-10", "x")));
		const { unmount } = render(<JournalEditor date="2026-08-10" service={svc} initialContent="" />);
		fireEvent.change(textarea(), { target: { value: "x" } });
		await advance(800); // write attempt in flight
		unmount();
		await act(async () => {
			resolveUpsert();
		});
		await settle();
		// The newer date's row is untouched: only the ORIGINAL date was ever a
		// possible write target (upsert is date-scoped; no crash, no overwrite).
		expect(await svc.get("2026-08-11")).toMatchObject({ content: "newer-date-content" });
	});
});

describe("JournalEditor: serialized writes — a stale in-flight save can never drive the newer value's UI", () => {
	it("a slow earlier save resolving after a newer value was typed never paints stale Saved or fires onSaved", async () => {
		const svc = await makeService();
		const real = svc.upsert.bind(svc);
		const g1 = makeGate();
		// First write attempt (v1) is held in flight by the gate.
		vi.spyOn(svc, "upsert").mockImplementationOnce((d, c) => g1.promise.then(() => real(d, c)));
		const onSaved = vi.fn();
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="" onSaved={onSaved} />);
		fireEvent.change(textarea(), { target: { value: "v1" } });
		await advance(800); // v1 write is in flight (gated)
		fireEvent.change(textarea(), { target: { value: "v2" } }); // debounce armed, not elapsed
		expect(screen.queryByText("Saved")).not.toBeInTheDocument();
		// v1 resolves LATE — after v2 is the typed, still-unsaved value.
		await act(async () => {
			g1.open();
		});
		await settle();
		// v1's success must not paint a stale "Saved" nor fire onSaved(v1).
		expect(screen.queryByText("Saved")).not.toBeInTheDocument();
		expect(onSaved).not.toHaveBeenCalled();
		// v2's own debounce still fires and saves the LATEST value.
		await advance(800);
		expect(await svc.get("2026-08-10")).toMatchObject({ content: "v2" });
		expect(screen.getByText("Saved")).toBeInTheDocument();
		expect(onSaved).toHaveBeenCalledTimes(1);
		expect(onSaved).toHaveBeenCalledWith("v2");
	});

	it("serializes writes: a newer debounced save waits for the in-flight write, whose late success never paints Saved", async () => {
		const svc = await makeService();
		const real = svc.upsert.bind(svc);
		const g1 = makeGate();
		const g2 = makeGate();
		const spy = vi.spyOn(svc, "upsert");
		spy.mockImplementationOnce((d, c) => g1.promise.then(() => real(d, c))); // v1 write, gated
		spy.mockImplementationOnce((d, c) => g2.promise.then(() => real(d, c))); // v2 write, gated
		const onSaved = vi.fn();
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="" onSaved={onSaved} />);
		fireEvent.change(textarea(), { target: { value: "v1" } });
		await advance(800); // v1 write is in flight (gated)
		fireEvent.change(textarea(), { target: { value: "v2" } });
		await advance(800); // v2's debounce elapses while v1 is STILL writing
		expect(screen.queryByText("Saved")).not.toBeInTheDocument();
		// Single-flight: v2 did not start a second, concurrent write.
		expect(spy).toHaveBeenCalledTimes(1);
		// v1 resolves late — its success must not paint Saved or fire onSaved,
		// because v2 is the value the editor shows and its write is queued.
		await act(async () => {
			g1.open();
		});
		await settle();
		expect(spy).toHaveBeenCalledTimes(2); // v2 write began only after v1 settled
		expect(spy).toHaveBeenNthCalledWith(2, "2026-08-10", "v2");
		expect(screen.queryByText("Saved")).not.toBeInTheDocument();
		expect(onSaved).not.toHaveBeenCalled();
		// DB still holds v1: v2's write is serialized behind v1's completion.
		expect(await svc.get("2026-08-10")).toMatchObject({ content: "v1" });
		// v2's write completes -> the latest value is saved and the parent is
		// notified exactly once, with v2.
		await act(async () => {
			g2.open();
		});
		await settle();
		expect(await svc.get("2026-08-10")).toMatchObject({ content: "v2" });
		expect(screen.getByText("Saved")).toBeInTheDocument();
		expect(onSaved).toHaveBeenCalledTimes(1);
		expect(onSaved).toHaveBeenCalledWith("v2");
	});

	it("an earlier in-flight save failing after a newer value was typed never surfaces its error or arms a stale retry", async () => {
		const svc = await makeService();
		const real = svc.upsert.bind(svc);
		const g1 = makeGate();
		const g2 = makeGate();
		const spy = vi.spyOn(svc, "upsert");
		spy.mockImplementationOnce((d, c) => g1.promise.then(() => real(d, c))); // v1 write, gated
		spy.mockImplementationOnce((d, c) => g2.promise.then(() => real(d, c))); // v2 write, gated
		const onSaved = vi.fn();
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="" onSaved={onSaved} />);
		fireEvent.change(textarea(), { target: { value: "v1" } });
		await advance(800); // v1 write in flight (gated)
		fireEvent.change(textarea(), { target: { value: "v2" } });
		await advance(800); // v2's debounce elapses while v1 is STILL writing
		// v1 FAILS late — after v2 is the typed value.
		await act(async () => {
			g1.fail(new Error("db busy"));
		});
		await settle();
		// v1's stale failure must not show an error for v2, and v2's own write
		// is what runs next (still gated here), so no Saved yet either.
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(spy).toHaveBeenCalledTimes(2);
		expect(screen.queryByText("Saved")).not.toBeInTheDocument();
		// v2 (the latest value) then saves cleanly through the serialized tail.
		await act(async () => {
			g2.open();
		});
		await settle();
		expect(await svc.get("2026-08-10")).toMatchObject({ content: "v2" });
		expect(screen.getByText("Saved")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(onSaved).toHaveBeenCalledTimes(1);
		expect(onSaved).toHaveBeenCalledWith("v2");
		// No stale retry was armed for v1: nothing else ever writes.
		await advance(5_000);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(await svc.get("2026-08-10")).toMatchObject({ content: "v2" });
	});

	it("orders the unmount flush after an in-flight write and notifies the parent once the latest value persists", async () => {
		const svc = await makeService();
		const real = svc.upsert.bind(svc);
		const g1 = makeGate();
		const spy = vi.spyOn(svc, "upsert");
		spy.mockImplementationOnce((d, c) => g1.promise.then(() => real(d, c))); // v1 write, gated
		const onSaved = vi.fn();
		const { unmount } = render(
			<JournalEditor date="2026-08-10" service={svc} initialContent="" onSaved={onSaved} />,
		);
		fireEvent.change(textarea(), { target: { value: "v1" } });
		await advance(800); // v1 write is in flight (gated)
		fireEvent.change(textarea(), { target: { value: "v2" } });
		unmount(); // dirty unmount flush fires while v1 is still in flight
		expect(spy).toHaveBeenCalledTimes(1); // flush is queued, not yet written
		// The in-flight v1 write completes first; ONLY THEN does the flushed v2
		// write run, so v1 can never clobber the flushed (newest) value.
		await act(async () => {
			g1.open();
		});
		await settle();
		expect(await svc.get("2026-08-10")).toMatchObject({ content: "v2" });
		expect(onSaved).toHaveBeenCalledTimes(1);
		expect(onSaved).toHaveBeenCalledWith("v2");
	});

	it("handles an unmount flush rejection (no unhandled rejection, no onSaved)", async () => {
		const svc = await makeService();
		vi.spyOn(svc, "upsert").mockRejectedValueOnce(new Error("db busy"));
		const onSaved = vi.fn();
		const { unmount } = render(
			<JournalEditor date="2026-08-10" service={svc} initialContent="" onSaved={onSaved} />,
		);
		fireEvent.change(textarea(), { target: { value: "typed" } });
		unmount(); // the flush is the only write; it rejects
		await settle();
		expect(onSaved).not.toHaveBeenCalled();
		expect(await svc.get("2026-08-10")).toBeNull();
	});
});

describe("JournalEditor: shared-schema content limit — astral parity and DOM snap-back", () => {
	it("matches the actual shared journalContentSchema boundary for astral characters and snaps the DOM back on repeated overflow", async () => {
		const svc = await makeService();
		const upsert = vi.spyOn(svc, "upsert");
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="" />);
		// 100,000 emoji = 100,000 code points but 200,000 UTF-16 code units.
		// The ACTUAL shared schema accepts them (max counts code points), so the
		// editor must too — the limit is never a UTF-16 truncation.
		const atMax = "😀".repeat(100_000);
		const over = "😀".repeat(100_001);
		expect(journalContentSchema.safeParse(atMax).success).toBe(true);
		expect(journalContentSchema.safeParse(over).success).toBe(false);
		expect(Array.from(atMax)).toHaveLength(100_000);

		fireEvent.change(textarea(), { target: { value: atMax } });
		expect(Array.from(textarea().value)).toHaveLength(100_000);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();

		// Overflow is rejected and the field snaps back to the accepted value.
		fireEvent.change(textarea(), { target: { value: over } });
		expect(Array.from(textarea().value)).toHaveLength(100_000);
		expect(screen.getByRole("alert").textContent).toMatch(/100,000 characters/i);

		// REPEATED overflow: the error text is unchanged, so React would skip a
		// re-render — the DOM must still be forced back to the accepted value.
		fireEvent.change(textarea(), { target: { value: over } });
		expect(Array.from(textarea().value)).toHaveLength(100_000);
		expect(screen.getByRole("alert").textContent).toMatch(/100,000 characters/i);

		// A valid edit afterwards still works; only the accepted value saves.
		fireEvent.change(textarea(), { target: { value: "ok" } });
		expect(textarea().value).toBe("ok");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		await advance(800);
		expect(upsert).toHaveBeenCalledTimes(1);
		expect(upsert).toHaveBeenCalledWith("2026-08-10", "ok");
		expect(await svc.get("2026-08-10")).toMatchObject({ content: "ok" });
	});
});

describe("JournalEditor: beforeunload guard", () => {
	it("registers a beforeunload guard while dirty and removes it once clean", async () => {
		const svc = await makeService();
		const add = vi.spyOn(window, "addEventListener");
		const remove = vi.spyOn(window, "removeEventListener");
		render(<JournalEditor date="2026-08-10" service={svc} initialContent="" />);
		fireEvent.change(textarea(), { target: { value: "dirty" } });
		expect(add).toHaveBeenCalledWith("beforeunload", expect.any(Function));
		await advance(800); // save completes -> clean -> guard removed
		expect(remove).toHaveBeenCalledWith("beforeunload", expect.any(Function));
	});

	it("removes the beforeunload guard on unmount while dirty", async () => {
		const svc = await makeService();
		const add = vi.spyOn(window, "addEventListener");
		const remove = vi.spyOn(window, "removeEventListener");
		const { unmount } = render(<JournalEditor date="2026-08-10" service={svc} initialContent="" />);
		fireEvent.change(textarea(), { target: { value: "dirty" } });
		expect(add).toHaveBeenCalledWith("beforeunload", expect.any(Function));
		unmount();
		expect(remove).toHaveBeenCalledWith("beforeunload", expect.any(Function));
	});
});
