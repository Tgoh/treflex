import type { IRecordingContext } from "../../src/Runtime/recordingProxy";
import type { IRecordChange } from "../../src/Types/IRecord";
import { describe, expect, it } from "vitest";
import { createRecordingProxy } from "../../src/Runtime/recordingProxy";
import { sliceSetState } from "../../src/Runtime/sliceSetState";
import { createTreeState } from "../testHelpers";

describe("sliceSetState", () => {
	it("creates a sliced setState targeting a nested property", () => {
		const state = {
			person: {
				name: "before"
			}
		};
		const { raw, setState } = createTreeState(state);

		const setPersonState = sliceSetState(setState, (x: typeof state) => x.person);
		setPersonState((person: typeof state.person) => {
			person.name = "after";
			return person;
		});

		expect(raw.person.name).toBe("after");
	});

	it("composes multiple slices", () => {
		const state = {
			a: {
				b: {
					c: "original"
				}
			}
		};
		const { raw, setState } = createTreeState(state);

		const setA = sliceSetState<typeof state.a, typeof state>(setState, (x) => x.a);
		const setB = sliceSetState<typeof state.a.b, typeof state.a>(setA, (a) => a.b);
		setB((b: typeof state.a.b) => {
			b.c = "modified";
			return b;
		});

		expect(raw.a.b.c).toBe("modified");
	});
});

// The recording proxy is the action-side draft surface. It's created once per
// action by processAction, holds a per-action WeakMap for nested sub-proxy
// caching, and records writes into ctx.currentJournalChanges — the one
// recording sink: the journal change list IS the change list, swapped
// per generator slice by the runtime. These tests exercise the proxy in
// isolation; processAction integration is covered in processAction.test.ts.
function makeContext(): {
	ctx: IRecordingContext;
	changes: IRecordChange[];
} {
	const changes: IRecordChange[] = [];
	const ctx: IRecordingContext = {
		currentJournalChanges: changes
	};
	return {
		ctx,
		changes
	};
}

describe("createRecordingProxy", () => {
	it("records changes with paths and both sides cloned", () => {
		const state = {
			name: "before",
			count: 0
		};
		const { ctx, changes } = makeContext();
		const draft = createRecordingProxy(state, ctx, new WeakMap());

		draft.name = "after";
		draft.count = 1;

		expect(changes).toEqual([
			{
				Path: [
					"name"
				],
				Prev: "before",
				Value: "after"
			},
			{
				Path: [
					"count"
				],
				Prev: 0,
				Value: 1
			}
		]);
	});

	it("records nested property paths", () => {
		const state = {
			person: {
				name: "old"
			}
		};
		const { ctx, changes } = makeContext();
		const draft = createRecordingProxy(state, ctx, new WeakMap());

		draft.person.name = "new";

		expect(changes).toEqual([
			{
				Path: [
					"person",
					"name"
				],
				Prev: "old",
				Value: "new"
			}
		]);
	});

	it("does not record when the sink is null", () => {
		const state = {
			value: 1
		};
		const { ctx, changes } = makeContext();
		ctx.currentJournalChanges = null;
		const draft = createRecordingProxy(state, ctx, new WeakMap());

		draft.value = 2;

		expect(changes).toEqual([]);
		// But the write still happens — recording is observation, not gatekeeping
		expect(state.value).toBe(2);
	});

	it("snapshots values so they are not proxies", () => {
		const state = {
			items: [
				1,
				2,
				3
			] as number[]
		};
		const { ctx, changes } = makeContext();
		const draft = createRecordingProxy(state, ctx, new WeakMap());

		draft.items = [
			4,
			5
		];

		const change = changes[0];
		expect(change.Prev).toEqual([
			1,
			2,
			3
		]);
		expect(change.Value).toEqual([
			4,
			5
		]);
	});

	it("ignores symbol properties", () => {
		const sym = Symbol("test");
		const state = {
			[sym]: "hidden",
			name: "visible"
		} as any;
		const { ctx, changes } = makeContext();
		const draft = createRecordingProxy(state, ctx, new WeakMap());

		draft[sym] = "changed";
		draft.name = "updated";

		expect(changes.length).toBe(1);
		expect(changes[0].Path).toEqual([
			"name"
		]);
	});

	it("returns the same nested proxy on repeated access", () => {
		const state = {
			child: {
				value: 0
			}
		};
		const { ctx } = makeContext();
		const draft = createRecordingProxy(state, ctx, new WeakMap());

		const a = draft.child;
		const b = draft.child;

		expect(a).toBe(b);
	});

	it("held nested proxies survive draft re-traversal — writes through held refs still record", () => {
		// The reason the recording proxy exists: held sub-references stay valid
		// across yields. Simulating that here: grab a nested proxy, swap the
		// journal sink (as the runtime does at step boundaries), write through
		// the held ref, and verify the write lands in the new array.
		const state = {
			item: {
				count: 0
			}
		};
		const { ctx } = makeContext();
		const draft = createRecordingProxy(state, ctx, new WeakMap());

		const heldItem = draft.item;
		const stepOneChanges: IRecordChange[] = [];
		ctx.currentJournalChanges = stepOneChanges;

		heldItem.count = 5;

		expect(stepOneChanges).toEqual([
			{
				Path: [
					"item",
					"count"
				],
				Prev: 0,
				Value: 5
			}
		]);

		// Now simulate the next step: runtime swaps the sink again.
		const stepTwoChanges: IRecordChange[] = [];
		ctx.currentJournalChanges = stepTwoChanges;

		heldItem.count = 10;

		expect(stepTwoChanges).toEqual([
			{
				Path: [
					"item",
					"count"
				],
				Prev: 5,
				Value: 10
			}
		]);
	});

	it("records property deletions with Value absent", () => {
		const state = {
			optional: "present" as string | undefined
		};
		const { ctx, changes } = makeContext();
		const draft = createRecordingProxy(state, ctx, new WeakMap());

		delete (draft as any).optional;

		// A delete's "after" is absence — the Value key stays off the change
		// entirely, so records() and the parsed export agree.
		expect(changes.length).toBe(1);
		expect(changes[0].Path).toEqual([
			"optional"
		]);
		expect(changes[0].Prev).toBe("present");
		expect("Value" in changes[0]).toBe(false);
	});
});
