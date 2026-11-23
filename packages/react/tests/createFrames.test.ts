import type { IActionGenerator, IEntity, IRuntime, ISelectorGenerator } from "treflex";
import type { IRuntimeInternal, IWriteGateway } from "treflex/internal";
import {
	createRuntime,
	EntityReplacedError,
	entity,
	idOf,
	MoveBetweenRootsError,
	StateAliasError,
	StateCycleError,
	start,
	withoutIds
} from "treflex";
import { rawOf } from "treflex/internal";
import { createSnapshot, restoreRuntime } from "treflex/snapshot";
import { describe, expect, it, vi } from "vitest";
import { getFrames } from "../src/createFrames";
import { createComponentEntity } from "../src/useComponentState";
import { minted, treeWrite } from "./treeWrite";

function captureMicrotasks() {
	const deferred: (() => void)[] = [];
	const spy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
		deferred.push(callback);
	});
	return {
		surface(): unknown[] {
			spy.mockRestore();
			const reports: unknown[] = [];
			for (const callback of deferred) {
				try {
					callback();
				} catch (error) {
					reports.push(error);
				}
			}
			return reports;
		}
	};
}

interface IItem extends IEntity {
	Label: string;
	Count: number;
}

interface IList extends IEntity {
	Items: IItem[];
}

interface IRoot extends IEntity {
	Title: string;
	Left: IList;
	Right: IList;
	Notes: {
		Deep: {
			Text: string;
		};
		Other: {
			Text: string;
		};
	};
}

function seed(): IRoot {
	return {
		$Id: "root",
		Title: "t",
		Left: {
			$Id: "left",
			Items: [
				{
					$Id: "a",
					Label: "A",
					Count: 0
				},
				{
					$Id: "b",
					Label: "B",
					Count: 0
				}
			]
		},
		Right: {
			$Id: "right",
			Items: []
		},
		Notes: {
			Deep: {
				Text: "x"
			},
			Other: {
				Text: "y"
			}
		}
	};
}

function world(options?: { journal?: boolean }) {
	return framesOver(createRuntime<IRoot>(seed()), options);
}

function framesOver(
	runtime: IRuntime<IRoot>,
	options?: {
		journal?: boolean;
	}
) {
	if (options?.journal) {
		runtime.on("record", () => {});
	}
	const frames = getFrames(runtime);
	let notified = 0;
	frames.subscribe(() => {
		notified++;
	});
	return {
		runtime,
		frames,
		notified: () => notified,
		root: () => frames.root() as any,
		entity: (id: string) => frames.entity(id) as any
	};
}

describe("frames", () => {
	it("reports a store listener's throw as runtime/callback-threw, and still notifies the others", async () => {
		const w = world();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const broke = new Error("listener broke");
		const reported: unknown[] = [];
		w.runtime.on("diag", (event) => {
			if (event.code === "runtime/callback-threw") {
				reported.push(event.data?.error);
			}
		});
		w.frames.subscribe(() => {
			throw broke;
		});
		await w.runtime.dispatch(function* rename(draft: IRoot): IActionGenerator {
			draft.Title = "renamed";
		}, "root");
		expect(w.notified()).toBe(1);
		expect(reported).toEqual([
			broke
		]);
		warn.mockRestore();
	});

	it("notifies a store listener when the step's frame ends, before a tap hears the step's record", async () => {
		const w = world();
		const heard: string[] = [];
		w.frames.subscribe(() => {
			heard.push(`store ${w.root().Title}`);
		});
		w.runtime.on("record", (record) => {
			if (record.Kind === "step") {
				heard.push("step");
			}
		});
		await w.runtime.dispatch(function* rename(draft: IRoot): IActionGenerator {
			draft.Title = "renamed";
		}, "root");
		expect(heard).toEqual([
			"store renamed",
			"step"
		]);
	});

	it("keeps every frame and notifies no subscriber when a slice is refused and undone", async () => {
		const w = world();
		const before = w.root();
		const left = w.entity("left");
		const notified = w.notified();
		await expect(
			w.runtime.dispatch(function* (draft: IRoot): IActionGenerator {
				draft.Title = "written";
				draft.Right.Items.push(draft.Left.Items[0]!);
			}, "root")
		).rejects.toBeInstanceOf(StateAliasError);
		expect(w.notified()).toBe(notified);
		expect(w.root()).toBe(before);
		expect(w.entity("left")).toBe(left);
	});

	it("selects a selector's own cyclic value with the closing slot read as absent", () => {
		const w = world();
		const cyclic: any = {
			A: 1
		};
		cyclic.Self = cyclic;
		const out = w.frames.select(cyclic) as any;
		expect(out.A).toBe(1);
		expect(out.Self).toBeUndefined();
	});

	it("keeps the reference of every branch a write did not reach", () => {
		const { runtime, root } = world();
		const before = root();
		treeWrite(runtime, (s) => {
			s.Notes.Deep.Text = "changed";
		});
		const after = root();
		expect(after).not.toBe(before);
		expect(after.Notes).not.toBe(before.Notes);
		expect(after.Notes.Deep).not.toBe(before.Notes.Deep);
		expect(after.Notes.Deep.Text).toBe("changed");
		expect(after.Notes.Other).toBe(before.Notes.Other);
		expect(after.Left).toBe(before.Left);
		expect(after.Right).toBe(before.Right);
	});

	it("returns the same frame while nothing is written", () => {
		const { root, entity } = world();
		expect(root()).toBe(root());
		expect(entity("left")).toBe(entity("left"));
	});

	it("holds a child entity as a stub, so its writes stop at the child", () => {
		const { runtime, root, entity } = world();
		const rootBefore = root();
		const leftBefore = entity("left");
		const aBefore = entity("a");
		expect(rootBefore.Left).toEqual({
			$Id: "left"
		});
		expect(leftBefore.Items).toEqual([
			{
				$Id: "a"
			},
			{
				$Id: "b"
			}
		]);
		treeWrite(runtime, (s) => {
			s.Left.Items[0].Count = 5;
		});
		expect(entity("a")).not.toBe(aBefore);
		expect(entity("a").Count).toBe(5);
		expect(entity("left")).toBe(leftBefore);
		expect(root()).toBe(rootBefore);
	});

	it("rebuilds the ancestors up to the nearest entity when a child list changes", () => {
		const { runtime, root, entity } = world();
		const rootBefore = root();
		const leftBefore = entity("left");
		treeWrite(runtime, (s) => {
			s.Left.Items.push(
				minted("c", {
					Label: "C",
					Count: 0
				})
			);
		});
		expect(entity("left")).not.toBe(leftBefore);
		expect(entity("left").Items[0]).toBe(leftBefore.Items[0]);
		expect(entity("left").Items.map((i: IItem) => i.$Id)).toEqual([
			"a",
			"b",
			"~c"
		]);
		expect(root()).toBe(rootBefore);
	});

	it("follows a moved entity to its new parent and keeps its own frame", () => {
		const { runtime, entity } = world();
		const leftBefore = entity("left");
		const rightBefore = entity("right");
		const aBefore = entity("a");
		const stub = leftBefore.Items[0];
		treeWrite(runtime, (s) => {
			const [moved] = s.Left.Items.splice(0, 1);
			s.Right.Items.push(moved);
		});
		expect(entity("left")).not.toBe(leftBefore);
		expect(entity("right")).not.toBe(rightBefore);
		expect(entity("right").Items[0]).toBe(stub);
		expect(entity("a")).toBe(aBefore);
		const rightNow = entity("right");
		treeWrite(runtime, (s) => {
			s.Right.Items[0].Count = 9;
		});
		expect(entity("a").Count).toBe(9);
		expect(entity("right")).toBe(rightNow);
	});

	it("replaces a stub whose entity changed its $Id in place", () => {
		const { runtime, entity } = world();
		const leftBefore = entity("left");
		treeWrite(runtime, (s) => {
			// Past the trap, which refuses this. The field write is what tells the frames about the node.
			rawOf(s.Left.Items[1]).$Id = "b2";
			s.Left.Items[1].Count = 1;
		});
		expect(entity("left")).not.toBe(leftBefore);
		expect(entity("left").Items[1]).toEqual({
			$Id: "b2"
		});
	});

	it("turns a node that gains an $Id into a stub in its parent's frame", () => {
		const { runtime, root } = world();
		expect(root().Notes.Deep).toEqual({
			Text: "x"
		});
		treeWrite(runtime, (s) => {
			// Past the trap, which refuses this. The field write is what tells the frames about the node.
			(rawOf(s.Notes.Deep) as any).$Id = "deep";
			s.Notes.Deep.Text = "y";
		});
		expect(root().Notes.Deep).toEqual({
			$Id: "deep"
		});
	});

	it("rebuilds everything after a resync, which reads the tree past the traps", () => {
		const { runtime, root, entity, notified } = world();
		const before = root();
		const aBefore = entity("a");
		const raw = rawOf(runtime.state) as IRoot;
		raw.Title = "bypassed";
		raw.Left.Items[0].Label = "bypassed";
		expect(root()).toBe(before);
		const count = notified();
		((runtime as IRuntimeInternal<IRoot>).get("runtime/writeGateway") as IWriteGateway).resync();
		expect(notified()).toBe(count + 1);
		expect(root()).not.toBe(before);
		expect(root().Title).toBe("bypassed");
		expect(entity("a")).not.toBe(aBefore);
		expect(entity("a").Label).toBe("bypassed");
	});

	it("frames a restored runtime's tree", async () => {
		const source = createRuntime<IRoot>(seed());
		treeWrite(source, (s) => {
			s.Title = "restored";
			s.Left.Items[0].Count = 7;
			s.Notes.Other.Text = "restored";
		});
		const envelope = createSnapshot(source);
		source.dispose();
		const { runtime: restored } = await restoreRuntime<IRoot>(envelope, {
			rootId: "root",
			options: {}
		});
		const { root, entity } = framesOver(restored);
		expect(root().Title).toBe("restored");
		expect(root().Notes.Other.Text).toBe("restored");
		expect(entity("a").Count).toBe(7);
	});

	it("is frozen in development", () => {
		const { root } = world();
		const frame = root();
		expect(Object.isFrozen(frame)).toBe(true);
		expect(Object.isFrozen(frame.Notes.Deep)).toBe(true);
		expect(Object.isFrozen(frame.Left)).toBe(true);
	});

	it("never hands out a live node", () => {
		const { root, entity } = world();
		for (const frame of [
			root(),
			root().Notes,
			entity("left").Items,
			entity("a")
		]) {
			expect(rawOf(frame)).toBe(frame);
		}
	});

	it("answers undefined for an id the tree does not hold", () => {
		const { entity } = world();
		expect(entity("nope")).toBeUndefined();
	});
});

describe("selector results", () => {
	function* items(draft: IList): ISelectorGenerator<IItem[]> {
		return draft.Items.filter((i) => i.Count >= 0);
	}

	function* summary(draft: IList): ISelectorGenerator<{
		Count: number;
		First: IItem | undefined;
	}> {
		return {
			Count: draft.Items.length,
			First: draft.Items[0]
		};
	}

	function* list(draft: IList): ISelectorGenerator<IItem[]> {
		return draft.Items;
	}

	function* total(draft: IList): ISelectorGenerator<number> {
		return draft.Items.reduce((n, i) => n + i.Count, 0);
	}

	function run<R>(w: ReturnType<typeof world>, selector: (draft: IList) => ISelectorGenerator<R>): any {
		return w.frames.select((w.runtime as IRuntimeInternal<any>).runSelector(selector, () => w.frames.node("left")));
	}

	it("replaces every entity in a result with that entity's frame", () => {
		const w = world();
		const result = run(w, items);
		expect(result).toHaveLength(2);
		expect(result[0]).toBe(w.entity("a"));
		expect(result[1]).toBe(w.entity("b"));
		expect(rawOf(result)).toBe(result);
	});

	it("copies a tree container out of a result, framing the entities in it", () => {
		const w = world();
		const result = run(w, list);
		expect(rawOf(result)).toBe(result);
		expect(result[0]).toBe(w.entity("a"));
	});

	it("is the same reference while nothing it holds has changed", () => {
		const w = world();
		const first = run(w, summary);
		expect(run(w, summary)).toBe(first);
		treeWrite(w.runtime, (s) => {
			s.Title = "unrelated";
		});
		expect(run(w, summary)).toBe(first);
		expect(run(w, items)).toBe(run(w, items));
	});

	it("changes when an entity in it changes, though the selector did not re-run", () => {
		const w = world();
		const first = run(w, summary);
		treeWrite(w.runtime, (s) => {
			s.Left.Items[0].Label = "renamed";
		});
		const second = run(w, summary);
		expect(second).not.toBe(first);
		expect(second.First.Label).toBe("renamed");
		expect(second.Count).toBe(2);
	});

	it("passes a primitive and a result with no node in it through untouched", () => {
		const w = world();
		expect(run(w, total)).toBe(0);
		const plain = {
			Count: 1
		};
		expect(w.frames.select(plain)).toBe(plain);
	});
});

describe("component state frames", () => {
	interface ICounter extends IEntity {
		Count: number;
		Nested: {
			Values: number[];
		};
		Untouched: {
			Text: string;
		};
	}

	function* bump(draft: ICounter): IActionGenerator {
		draft.Count++;
		draft.Nested.Values.push(draft.Count);
	}

	function counter(journal: boolean) {
		const w = world({
			journal
		});
		const local = createComponentEntity<ICounter>(w.runtime as IRuntimeInternal<any>, () => ({
			Count: 0,
			Nested: {
				Values: []
			},
			Untouched: {
				Text: "same"
			}
		}));
		const stop = local.mount();
		return {
			...w,
			local,
			stop,
			frame: () => local.frame(w.frames) as any
		};
	}

	for (const journal of [
		false,
		true
	]) {
		it.each<
			[
				string,
				(runtime: any) => object
			]
		>([
			[
				"an entity",
				(runtime) => runtime.state.Left
			],
			[
				"a plain node",
				(runtime) => runtime.state.Left.Items
			],
			[
				"a node inside a value",
				(runtime) => ({
					Deep: [
						runtime.state.Left
					]
				})
			]
		])(`refuses a live node crossing in by reference, as %s${journal ? ", journal on" : ""}`, async (_shape, live) => {
			const { runtime } = world({
				journal
			});
			const local = createComponentEntity<any>(runtime as IRuntimeInternal<any>, () => ({
				Editing: null
			}));
			const stop = local.mount();
			await expect(
				local.dispatch(function* editing(draft: any): IActionGenerator {
					draft.Editing = live(runtime);
				})
			).rejects.toThrow(MoveBetweenRootsError);
			expect(local.view.Editing).toBeNull();
			stop();
		});

		it(`refuses a component state node crossing out to the tree by reference${journal ? ", journal on" : ""}`, async () => {
			const { runtime } = world({
				journal
			});
			const local = createComponentEntity<any>(runtime as IRuntimeInternal<any>, () => ({
				Rows: [
					{
						Name: "local"
					}
				]
			}));
			const stop = local.mount();
			await expect(
				runtime.dispatch(function* taking(draft: any): IActionGenerator {
					draft.Taken = local.view.Rows[0];
				}, runtime.state.$Id)
			).rejects.toThrow(MoveBetweenRootsError);
			expect((runtime.state as any).Taken).toBeUndefined();
			stop();
		});

		it(`refuses a copy from an action on an entity nested in component state${journal ? ", journal on" : ""}`, async () => {
			const { runtime } = world({
				journal
			});
			const local = createComponentEntity<any>(runtime as IRuntimeInternal<any>, () => ({
				Nested: null
			}));
			const stop = local.mount();
			await local.dispatch(function* nest(draft: any): IActionGenerator {
				draft.Nested = yield* entity({
					Name: "nested"
				});
			});
			function* copying(draft: any): IActionGenerator {
				draft.Copy = JSON.parse(JSON.stringify(runtime.state.Left));
			}
			await expect(runtime.dispatch(copying, local.view.Nested.$Id)).rejects.toThrow(EntityReplacedError);
			expect(local.view.Nested.Copy).toBeUndefined();
			stop();
		});

		it(`starts against an entity nested in component state${journal ? ", journal on" : ""}`, async () => {
			const { runtime } = world({
				journal
			});
			const codes: string[] = [];
			runtime.on("diag", (event) => codes.push(event.code));
			const local = createComponentEntity<any>(runtime as IRuntimeInternal<any>, () => ({
				Nested: null
			}));
			const stop = local.mount();
			let ran = false;
			function* init(): IActionGenerator {
				ran = true;
			}
			await local.dispatch(function* opening(draft: any): IActionGenerator {
				const kid = yield* entity({
					Name: "kid"
				});
				draft.Nested = kid;
				yield* start(init as any, idOf(kid));
			});
			expect(ran).toBe(true);
			expect(codes).toEqual([]);
			stop();
		});

		it(`refuses a copy of a live domain entity, as the domain tree does, and takes it without its ids${journal ? ", under the journal" : ""}`, async () => {
			const { runtime } = world({
				journal
			});
			const local = createComponentEntity<any>(runtime as IRuntimeInternal<any>, () => ({
				Editing: null
			}));
			const stop = local.mount();
			const copy = () => JSON.parse(JSON.stringify(runtime.state.Left));

			await expect(
				local.dispatch(function* editing(draft: any): IActionGenerator {
					draft.Editing = copy();
				})
			).rejects.toThrow(EntityReplacedError);
			expect(local.view.Editing).toBeNull();

			await local.dispatch(function* editing(draft: any): IActionGenerator {
				draft.Editing = withoutIds(copy());
			});
			expect(local.view.Editing.$Id).toBeUndefined();
			expect(local.view.Editing.Items[0].Label).toBe("A");

			expect(() =>
				treeWrite(runtime, (s) => {
					s.Left = copy();
				})
			).toThrow(EntityReplacedError);
			stop();
		});

		it(`remounts inside an open frame${journal ? ", under the journal" : ""}`, () => {
			const { runtime } = world({
				journal
			});
			const local = createComponentEntity<any>(runtime as IRuntimeInternal<any>, () => ({}));
			const stop = local.mount();
			const gateway = (runtime as IRuntimeInternal<any>).get("runtime/writeGateway") as IWriteGateway;
			let remounted!: () => void;
			expect(() =>
				gateway.exemptFrame(() => {
					stop();
					remounted = local.mount();
				})
			).not.toThrow();
			remounted();
		});

		it(`follows an action's writes${journal ? " under the journal" : ""}`, async () => {
			const { local, frame, notified } = counter(journal);
			const before = frame();
			const count = notified();
			await local.dispatch(bump);
			expect(notified()).toBeGreaterThan(count);
			const after = frame();
			expect(after).not.toBe(before);
			expect(after.Count).toBe(1);
			expect(after.Nested.Values).toEqual([
				1
			]);
			expect(after.Untouched).toBe(before.Untouched);
		});
	}

	it("reads the seed's copy before the mount, and the last frame after it", async () => {
		const w = world();
		const local = createComponentEntity<ICounter>(w.runtime as IRuntimeInternal<any>, () => ({
			Count: 0,
			Nested: {
				Values: []
			},
			Untouched: {
				Text: "same"
			}
		}));
		expect((local.frame(w.frames) as any).Count).toBe(0);
		expect(w.frames.entity(local.id)).toBeUndefined();
		const stop = local.mount();
		await local.dispatch(bump);
		stop();
		expect((local.frame(w.frames) as any).Count).toBe(1);
	});

	it("seats the entity while mounted, removes it on unmount, and seats it again on a remount", async () => {
		const { runtime, local, stop } = counter(false);
		const ids = () => Object.keys((runtime as IRuntimeInternal<IRoot>).get("runtime/stateIdLookup")());
		await local.dispatch(bump);
		expect(ids()).toContain(local.id);
		stop();
		await Promise.resolve();
		expect(ids()).not.toContain(local.id);
		const again = local.mount();
		expect(ids()).toContain(local.id);
		expect((local.frame(getFrames(runtime)) as any).Count).toBe(1);
		again();
	});

	it("removes the entity a microtask after the unmount, and again after a dispatch made once it's unmounted", async () => {
		const { runtime, local, stop } = counter(false);
		const ids = () => Object.keys((runtime as IRuntimeInternal<IRoot>).get("runtime/stateIdLookup")());
		stop();
		expect(ids()).toContain(local.id);
		const inWindow = local.dispatch(bump);
		await Promise.resolve();
		await inWindow;
		expect(ids()).not.toContain(local.id);
		const after = local.dispatch(bump);
		expect(ids()).toContain(local.id);
		await Promise.resolve();
		await after;
		expect(ids()).not.toContain(local.id);
		expect((local.view as unknown as ICounter).Count).toBe(2);
	});

	it("frames component state as it was when the tree rule refuses a loop in it", async () => {
		const w = world();
		const local = createComponentEntity<any>(w.runtime as IRuntimeInternal<any>, () => ({
			A: {
				B: {}
			}
		}));
		const stop = local.mount();
		const captured = captureMicrotasks();
		await expect(
			local.dispatch(function* (s: any): IActionGenerator {
				s.A.B.Back = s.A;
			})
		).rejects.toBeInstanceOf(StateCycleError);
		expect(captured.surface()).toEqual([]);
		expect((local.frame(w.frames) as any).A.B).toEqual({});
		await local.dispatch(function* (s: any): IActionGenerator {
			s.A.B.Back = null;
		});
		expect((local.frame(w.frames) as any).A.B.Back).toBeNull();
		stop();
	});

	it("stubs an entity nested in component state, as a tree frame does", async () => {
		const w = world();
		const local = createComponentEntity<any>(w.runtime as IRuntimeInternal<any>, () => ({
			Child: null
		}));
		const stop = local.mount();
		await local.dispatch(function* (draft: any): IActionGenerator {
			draft.Child = yield* entity({
				Value: 1
			});
		});
		const frame = local.frame(w.frames) as any;
		expect(Object.keys(frame.Child)).toEqual([
			"$Id"
		]);
		expect((w.frames.entity(frame.Child.$Id) as any).Value).toBe(1);
		stop();
	});

	it("rejects a dispatch whose seat throws, rather than throwing", async () => {
		const w = world();
		const outer = createComponentEntity<any>(w.runtime as IRuntimeInternal<any>, () => ({}));
		const stop = outer.mount();
		const inner = createComponentEntity<any>(
			w.runtime as IRuntimeInternal<any>,
			() => ({}),
			() => outer.id
		);
		let sent!: Promise<unknown>;
		expect(() => {
			sent = inner.dispatch(function* (): IActionGenerator {});
		}).not.toThrow();
		await expect(sent).rejects.toThrow(/Component mounts are flat/);
		stop();
	});
});
