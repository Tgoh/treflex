import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import { describe, expect, it } from "vitest";
import { publish } from "../../src/Effects/publish";
import { publishToNearest } from "../../src/Effects/publishToNearest";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { receiver } from "../../src/Runtime/receiver";
import * as reactive from "../reactive";
import { createTestRuntime, minted, mountComponent, rawWrite } from "../testHelpers";

const refreshRaw = (raw: IParent): void => {
	raw.Children = [
		{
			$Id: "child-1",
			Name: "replacement"
		},
		raw.Children[1]
	];
};

type IChild = {
	$Id: string;
	Name: string;
};
type IParent = {
	$Id: string;
	Children: IChild[];
};

const makeParent = (): IParent => ({
	$Id: "Parent",
	Children: [
		{
			$Id: "child-1",
			Name: "one"
		},
		{
			$Id: "child-2",
			Name: "two"
		}
	]
});

function* rename(draft: IChild, name: string): IActionGenerator {
	draft.Name = name;
}

describe("runtime.dispatch (createRuntime)", () => {
	it("dispatches against the entity the id resolves to", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<IParent>(makeParent());
				await runtime.dispatch(rename, "child-2", "renamed");
				expect(runtime.state.Children[1].Name).toBe("renamed");
				expect(runtime.state.Children[0].Name).toBe("one");
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("rejects and diags dispatch/unresolved-entity for an id the index cannot serve", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<IParent>(makeParent());
				const diags: any[] = [];
				runtime.on("diag", (event) => diags.push(event));

				await expect(runtime.dispatch(rename, "~nobody", "x")).rejects.toThrow(/no entity "~nobody"/);
				expect(diags).toHaveLength(1);
				expect(diags[0].code).toBe("dispatch/unresolved-entity");
				expect(diags[0].data).toMatchObject({
					entityId: "~nobody",
					cause: "unresolved"
				});

				await expect(runtime.dispatch(rename, "~nobody", "x")).rejects.toThrow();
				expect(diags).toHaveLength(1);

				function* arrive(draft: IParent): IActionGenerator {
					draft.Children = [
						...draft.Children,
						minted("nobody", {
							Name: "arrived"
						})
					];
				}
				function* leave(draft: IParent): IActionGenerator {
					draft.Children = draft.Children.filter((c) => c.$Id !== "~nobody");
				}

				await runtime.dispatch(arrive, "Parent");
				await runtime.dispatch(rename, "~nobody", "renamed");
				expect(diags).toHaveLength(1);

				await runtime.dispatch(leave, "Parent");
				await expect(runtime.dispatch(rename, "~nobody", "x")).rejects.toThrow(/no entity "~nobody"/);
				expect(diags).toHaveLength(2);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("dispatches to a ComponentState entity by its $Id, and refuses it once unmounted", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<IParent>(makeParent());
				const internal = runtime as IRuntimeInternal<IParent>;
				const local = mountComponent(runtime, undefined, {
					Name: ""
				});
				await runtime.dispatch(rename as any, local, "x");
				expect(
					(
						internal.resolveCell(local)?.state as {
							Name: string;
						}
					).Name
				).toBe("x");
				internal.unmountComponent(local);
				await expect(runtime.dispatch(rename as any, local, "y")).rejects.toThrow(/no entity/);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("a raw same-$Id replacement mid-park stops the parked action, which resolves undefined", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<IParent>(makeParent());
				let release!: () => void;
				const gate = new Promise<void>((r) => {
					release = r;
				});
				runtime.registerImplementation("gate", () => gate);

				function* story(draft: IChild): IActionGenerator {
					draft.Name = "before-park";
					yield {
						Type: "gate"
					};
					draft.Name = "after-park";
				}
				const parked = runtime.dispatch(story, "child-1");
				await Promise.resolve();
				expect(runtime.state.Children[0].Name).toBe("before-park");

				rawWrite(runtime, refreshRaw);
				expect(runtime.state.Children[0].Name).toBe("replacement");

				release();
				await expect(parked).resolves.toBeUndefined();
				expect(runtime.state.Children[0].Name).toBe("replacement");
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("does not subscribe the calling computation to the entity's cell", async () => {
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<IParent>(makeParent());
				function* noop(_draft: IChild): IActionGenerator {}

				let runs = 0;
				reactive.effect(() => {
					runs++;
					void runtime.dispatch(noop, "child-1").catch(() => {});
				});
				await new Promise((r) => setTimeout(r, 0));
				expect(runs).toBe(1);

				rawWrite(runtime, refreshRaw);
				await new Promise((r) => setTimeout(r, 0));
				expect(runs).toBe(1);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});
});

describe("testRuntime.dispatch (createTestRuntime)", () => {
	it("dispatches against a nested entity resolved by the index", async () => {
		const runtime = createTestRuntime<IParent>(makeParent());
		await runtime.dispatch(rename, "child-2", "renamed");
		expect(runtime.state.Children[1].Name).toBe("renamed");
		expect(runtime.state.Children[0].Name).toBe("one");
	});

	it("stamps the entity's real id-ancestry on the action records", async () => {
		const runtime = createTestRuntime<IParent>(makeParent());
		const starts: IRecord[] = [];
		runtime.on("record", (record) => {
			if (record.Kind === "action:start") starts.push(record);
		});
		await runtime.dispatch(rename, "child-1", "renamed");
		expect(starts).toHaveLength(1);
		expect((starts[0] as any).EntityId).toBe("child-1");
		expect((starts[0] as any).Path).toEqual([
			"Parent",
			"child-1"
		]);
	});

	it("suppresses delivery to an entity an earlier receiver removed in the same fan-out", async () => {
		const runtime = createTestRuntime<IParent>(makeParent());
		type IRoot = IParent;

		const ParentReceiver = receiver<IRoot>("SuppressionParentReceiver")({
			"Suppress/Test": function* (draft: IRoot) {
				draft.Children = draft.Children.filter((c) => c.$Id !== "child-2");
			}
		} as any);
		const ChildReceiver = receiver<IChild>("SuppressionChildReceiver")({
			"Suppress/Test": function* (draft: IChild) {
				draft.Name = "heard";
			}
		} as any);
		runtime.registerReceiver(ParentReceiver);
		runtime.registerReceiver(ChildReceiver);

		function* setup(draft: IRoot): IActionGenerator {
			bind(draft, ParentReceiver);
			bind(draft.Children[1], ChildReceiver);
		}
		function* trigger(_draft: IChild): IActionGenerator {
			yield* (publish as any)("Suppress/Test", {});
		}

		const errors: any[] = [];
		runtime.on("record", (record) => {
			if (record.Kind === "receiver:error") errors.push(record);
		});

		await runtime.dispatch(setup, "Parent");
		const removed = runtime.state.Children[1];
		await runtime.dispatch(trigger, "child-1");
		await new Promise((r) => setTimeout(r, 0));

		expect(runtime.state.Children.some((c) => c.$Id === "child-2")).toBe(false);
		expect(removed.Name).toBe("two");
		expect(errors).toEqual([]);
	});

	it("serves live cells: a held cell's state re-resolves across a same-$Id replacement", async () => {
		let lookup: any;
		const runtime = createTestRuntime<IParent>(makeParent(), {
			captureLookup: (_e: any, action: any) => {
				lookup = action.get("runtime/stateIdLookup")();
			}
		});
		function* capture(_draft: IParent): IActionGenerator {
			yield {
				Type: "captureLookup"
			};
		}

		await runtime.dispatch(capture, "Parent");
		const held = lookup["child-1"];
		expect(held.state.Name).toBe("one");
		rawWrite(runtime, refreshRaw);
		expect(held.state.Name).toBe("replacement");
	});

	it("routes publishToNearest from a nested entity up its real ancestry", async () => {
		type IRoot = IParent & {
			Heard: string;
		};
		const runtime = createTestRuntime<IRoot>({
			...makeParent(),
			Heard: ""
		});
		const ParentReceiver = receiver<IRoot>("DispatchTestParentReceiver")({
			"Dispatch/Test": function* (draft: IRoot, e: any) {
				draft.Heard = e.From;
			}
		} as any);
		runtime.registerReceiver(ParentReceiver);

		function* setup(draft: IRoot): IActionGenerator {
			bind(draft, ParentReceiver);
		}
		function* shout(draft: IChild): IActionGenerator {
			yield* (publishToNearest as any)(draft, "Dispatch/Test", {
				From: draft.$Id
			});
		}

		await runtime.dispatch(setup, "Parent");
		await runtime.dispatch(shout, "child-2");
		await new Promise((r) => setTimeout(r, 0));
		expect(runtime.state.Heard).toBe("child-2");
	});
});
