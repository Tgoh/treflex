import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import { createEffect, createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { rawOf } from "../../src/Runtime/viewProxy";
import { minted, mountComponent, rawWrite, treeWrite } from "../testHelpers";

// Every test that claims re-navigation moves the entity to a DIFFERENT key
// path. A test that leaves the entity at the same path passes against a
// static captured path too, and so pins nothing.

interface IChild extends IEntity {
	Value: number;
}

interface IParent extends IEntity {
	A: IChild[];
	B: IChild[];
}

function* bump(draft: IChild): IActionGenerator {
	draft.Value++;
}

function seed(): IParent {
	return {
		$Id: "root",
		A: [
			{
				$Id: "c0",
				Value: 0
			},
			{
				$Id: "c1",
				Value: 0
			}
		],
		B: []
	};
}

const findChild = (runtime: { state: IParent }) => (): IChild =>
	[
		...runtime.state.A,
		...runtime.state.B
	].find((c) => c.$Id === "c1")!;

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

type IWorld = IRuntimeInternal<IParent>;

function world<R>(fn: (runtime: IWorld) => Promise<R>): Promise<R> {
	return new Promise<R>((resolve, reject) => {
		createRoot(async (dispose) => {
			const runtime = createRuntime<IParent>(seed()) as IWorld;
			try {
				resolve(await fn(runtime));
			} catch (error) {
				reject(error);
			} finally {
				runtime.dispose();
				dispose();
			}
		});
	});
}

describe("runtime.resolveCell", () => {
	it("resolves a setter that writes to the named entity", async () => {
		await world(async (runtime) => {
			const cell = runtime.resolveCell("c1");
			expect(cell).toBeDefined();

			await runtime.processAction(bump, findChild(runtime), cell!.setState, () => "c1");

			expect(runtime.state.A[1].Value).toBe(1);
			expect(runtime.state.A[0].Value).toBe(0);
		});
	});

	it("carries the indexed node, so a caller can check it against the state it holds", async () => {
		await world(async (runtime) => {
			// The identity check the Solid provider makes on every write.
			expect(rawOf(runtime.resolveCell("c1")!.state)).toBe(rawOf(runtime.state.A[1]));
			expect(rawOf(runtime.resolveCell("c1")!.state)).not.toBe(rawOf(runtime.state.A[0]));
			expect(rawOf(runtime.resolveCell("root")!.state)).toBe(rawOf(runtime.state));
		});
	});

	it("keeps writing to the right node after the entity moves to another parent", async () => {
		await world(async (runtime) => {
			const setState = runtime.resolveCell("c1")!.setState;

			// One mutation, so the gateway reads it as a relocation and
			// nothing disposes.
			treeWrite(runtime, (state) => {
				state.B.push(state.A[1]);
				state.A = [
					state.A[0]
				];
			});

			expect(runtime.state.B).toHaveLength(1);

			await runtime.processAction(bump, findChild(runtime), setState, () => "c1");

			expect(runtime.state.B[0].Value).toBe(1);
			expect(runtime.state.A).toHaveLength(1);
			expect(runtime.state.A[0].Value).toBe(0);
		});
	});

	it("keeps writing to the right node after a raw same-$Id replacement lands at a different key", async () => {
		await world(async (runtime) => {
			const setState = runtime.resolveCell("c1")!.setState;

			// This pins the seam. The Solid binding refuses this scenario: a component still
			// holding the superseded node fails its identity check.
			rawWrite(runtime, (state) => {
				state.A = [
					{
						$Id: "c1",
						Value: 10
					},
					{
						$Id: "c0",
						Value: 99
					}
				];
			});

			await runtime.processAction(bump, findChild(runtime), setState, () => "c1");

			expect(runtime.state.A[0].Value).toBe(11);
			expect(runtime.state.A[1].Value).toBe(99);
		});
	});

	it("returns undefined for an id that is not in the tree", async () => {
		await world(async (runtime) => {
			expect(runtime.resolveCell("nope")).toBeUndefined();
			expect(runtime.resolveCell("")).toBeUndefined();
		});
	});

	it("resolves the root entity", async () => {
		await world(async (runtime) => {
			const cell = runtime.resolveCell("root");
			expect(cell).toBeDefined();

			function* addChild(draft: IParent): IActionGenerator {
				draft.B.push(
					minted("c2", {
						Value: 5
					})
				);
			}

			await runtime.processAction(
				addChild,
				() => runtime.state,
				cell!.setState,
				() => "root"
			);

			expect(runtime.state.B).toHaveLength(1);
			expect(runtime.state.B[0].$Id).toBe("~c2");
		});
	});

	it("stops resolving once the entity leaves the tree", async () => {
		await world(async (runtime) => {
			expect(runtime.resolveCell("c1")).toBeDefined();

			treeWrite(runtime, (state) => {
				state.A = [
					state.A[0]
				];
			});

			expect(runtime.resolveCell("c1")).toBeUndefined();
			expect(runtime.resolveCell("c0")).toBeDefined();
		});
	});

	it("does not subscribe the calling computation to the cell", async () => {
		await world(async (runtime) => {
			let runs = 0;
			createEffect(() => {
				runs++;
				runtime.resolveCell("c1");
			});
			await tick();
			expect(runs).toBe(1);

			rawWrite(runtime, (state) => {
				state.A = [
					{
						$Id: "c0",
						Value: 1
					},
					{
						$Id: "c1",
						Value: 5
					}
				];
			});
			await tick();

			expect(runs).toBe(1);
		});
	});

	it("resolves a ComponentState entity to its state", async () => {
		await world(async (runtime) => {
			const id = mountComponent(runtime, undefined, {
				Open: false
			});
			const cell = runtime.resolveCell(id);
			expect(rawOf(cell!.state)).toEqual({
				$Id: id,
				Open: false
			});
		});
	});
});
