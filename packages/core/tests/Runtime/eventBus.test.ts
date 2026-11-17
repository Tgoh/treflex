import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../src/Runtime/createEventBus";
import { createJournal } from "../../src/Runtime/createJournal";

const diag = (code: string): IRuntimeEventOf<"diag"> => ({
	severity: "info",
	code,
	message: code
});

describe("createEventBus", () => {
	it("delivers events to subscribers of the matching name", () => {
		const bus = createEventBus();
		const handler = vi.fn();

		bus.on("diag", handler);
		bus.emit("diag", diag("test/one"));

		expect(handler).toHaveBeenCalledOnce();
		expect(handler.mock.calls[0][0]).toMatchObject({
			code: "test/one"
		});
	});

	it("supports multiple subscribers for the same event", () => {
		const bus = createEventBus();
		const a = vi.fn();
		const b = vi.fn();

		bus.on("diag", a);
		bus.on("diag", b);
		bus.emit("diag", diag("test/multi"));

		expect(a).toHaveBeenCalledOnce();
		expect(b).toHaveBeenCalledOnce();
	});

	it("returns an unsubscribe function that removes the listener", () => {
		const bus = createEventBus();
		const handler = vi.fn();

		const off = bus.on("diag", handler);
		bus.emit("diag", diag("test/first"));
		off();
		bus.emit("diag", diag("test/second"));

		expect(handler).toHaveBeenCalledOnce();
	});

	it("a throwing subscriber does not break siblings or the runtime", () => {
		const bus = createEventBus();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const survivor = vi.fn();

		try {
			bus.on("diag", () => {
				throw new Error("subscriber failure");
			});
			bus.on("diag", survivor);

			// emit must not throw
			expect(() => bus.emit("diag", diag("test/throwing"))).not.toThrow();

			expect(survivor).toHaveBeenCalledOnce();
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("unsubscribing during emit does not skip subsequent siblings", () => {
		// Snapshot semantics: the listener array is snapshotted before the
		// walk, so a subscriber that unsubscribes itself (or a sibling)
		// during emit doesn't perturb the in-flight dispatch.
		const bus = createEventBus();
		const calls: string[] = [];

		const offA = bus.on("diag", () => {
			calls.push("a");
			offA();
			offB();
		});
		const offB = bus.on("diag", () => {
			calls.push("b");
		});
		const c = vi.fn(() => calls.push("c"));
		bus.on("diag", c);

		bus.emit("diag", diag("test/reentrant"));

		// All three saw the event; A's unsubscribe of itself and B took
		// effect only for the next emit.
		expect(calls).toEqual([
			"a",
			"b",
			"c"
		]);
	});

	it("unsubscribing a never-subscribed handler is a no-op", () => {
		const bus = createEventBus();
		const off = bus.on("diag", () => {});
		// Call twice — first removes; second is no-op rather than throwing.
		off();
		expect(() => off()).not.toThrow();
	});

	// ── The "record" channel ────────────────────────────────────────

	it('on("record") delegates to the wired journal tap', () => {
		const journal = createJournal();
		const bus = createEventBus(journal.tap);
		const seen: string[] = [];

		const off = bus.on("record", (record) => seen.push(record.Kind));
		// Subscribing is what enables appending (derived gating).
		expect(journal.enabled).toBe(true);
		journal.append({
			T: 0,
			Kind: "entity:dispose",
			Root: "AppState",
			EntityId: "e",
			Path: [
				"e"
			]
		});
		expect(seen).toEqual([
			"entity:dispose"
		]);

		off();
		expect(journal.enabled).toBe(false);
	});

	it('on("record") without a wired tap throws, naming the missing wiring', () => {
		const bus = createEventBus();
		expect(() => bus.on("record", () => {})).toThrow(/journal tap/);
	});
});
