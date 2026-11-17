import type { IActionGenerator } from "../../src/Types/IAction";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { entity } from "../../src/Effects/entity";
import { createJournal } from "../../src/Runtime/createJournal";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createWriteGateway } from "../../src/Runtime/createWriteGateway";
import { DraftDetachedError, isAttached } from "../../src/Runtime/draftNode";
import { open } from "../../src/Runtime/open";
import { sliceSetState } from "../../src/Runtime/sliceSetState";
import { rawOf } from "../../src/Runtime/viewProxy";
import { createTreeState, minted, rootSetState } from "../testHelpers";

type IRow = {
	$Id: string;
	Name: string;
	Meta?: {
		Tag: string;
	};
};

type IWorld = {
	$Id: string;
	Rows: IRow[];
	Spare: IRow[];
};

const world = (): IWorld => ({
	$Id: "root",
	Rows: [
		{
			$Id: "row-1",
			Name: "one",
			Meta: {
				Tag: "t1"
			}
		},
		{
			$Id: "row-2",
			Name: "two"
		}
	],
	Spare: []
});

function makeHarness() {
	const runtime = createRuntime<IWorld>(world(), {
		onError: () => {}
	});
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	runtime.registerImplementation("park", () => gate);
	runtime.registerImplementation("tick", () => Promise.resolve());
	return {
		runtime,
		release: () => release(),
		dispatch: <A extends any[], R>(action: (draft: any, ...args: A) => Generator<any, R, any>, ...args: A) =>
			runtime.processAction(
				action as any,
				() => runtime.state,
				rootSetState(runtime),
				() => "root",
				...args
			)
	};
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function* park(): IActionGenerator {
	yield {
		Type: "park"
	};
}

function holdThen(out: unknown[], probe: (ref: any, draft: IWorld) => unknown) {
	return function* held(draft: IWorld) {
		const ref = draft.Rows[0];
		yield* open(park());
		try {
			out.push(probe(ref, draft));
		} catch (e) {
			out.push(e instanceof DraftDetachedError ? `detached:${e.path.join(".")}` : `other:${String(e)}`);
		}
	};
}

function* removeRow1(draft: IWorld): IActionGenerator {
	draft.Rows = draft.Rows.filter((r) => r.$Id !== "row-1");
}

function* moveRow1(draft: IWorld): IActionGenerator {
	const [first, second] = draft.Rows;
	draft.Rows[0] = second;
	draft.Rows[1] = first;
}

describe("held references", () => {
	it("answers hasOwn and getOwnPropertyDescriptor on an absent key of an attached draft", async () => {
		const runtime = createRuntime<any>({
			$Id: "root",
			Present: 1
		});
		const got = await runtime.dispatch(function* (draft: any): IActionGenerator<unknown[]> {
			return [
				Object.hasOwn(draft, "Present"),
				Object.hasOwn(draft, "Absent"),
				Object.getOwnPropertyDescriptor(draft, "Absent")
			];
		}, "root");
		expect(got).toEqual([
			true,
			false,
			undefined
		]);
		runtime.dispose();
	});

	it("keeps working across a move, and names the node's last place after a removal", async () => {
		await createRoot(async (dispose) => {
			const moved = makeHarness();
			const movedOut: unknown[] = [];
			const parkedMoved = moved.dispatch(holdThen(movedOut, (ref) => ref.Name));
			await tick();
			await moved.dispatch(moveRow1);
			moved.release();
			await parkedMoved;
			expect(movedOut).toEqual([
				"one"
			]);
			moved.runtime.dispose();

			const gone = makeHarness();
			const goneOut: unknown[] = [];
			const parkedGone = gone.dispatch(holdThen(goneOut, (ref) => ref.Name));
			await tick();
			await gone.dispatch(removeRow1);
			gone.release();
			await parkedGone;
			expect(goneOut).toEqual([
				"detached:AppState.Rows.0"
			]);
			gone.runtime.dispose();
			dispose();
		});
	});

	it("detaches the node a replacement vacated, and not the replacement", async () => {
		await createRoot(async (dispose) => {
			const h = makeHarness();
			const out: unknown[] = [];
			const parked = h.dispatch(
				holdThen(out, (ref, draft) => [
					isAttached(ref),
					isAttached(draft.Rows[0]),
					draft.Rows[0].Name
				])
			);
			await tick();
			await h.dispatch(function* replaceSlot(draft: IWorld): IActionGenerator {
				draft.Rows[0] = minted("row-other", {
					Name: "replacement"
				});
			});
			h.release();
			await parked;
			expect(out).toEqual([
				[
					false,
					true,
					"replacement"
				]
			]);
			h.runtime.dispose();
			dispose();
		});
	});

	it("throws through every trap, and answers the probe channels without throwing", async () => {
		await createRoot(async (dispose) => {
			const h = makeHarness();
			const out: unknown[] = [];
			function* probe(draft: IWorld) {
				const ref = draft.Rows[0];
				yield* open(park());
				out.push(isAttached(ref));
				out.push(rawOf(ref) !== undefined);
				out.push(Object.prototype.toString.call(ref));
				const attempts: [
					string,
					() => unknown
				][] = [
					[
						"read",
						() => ref.Name
					],
					[
						"write",
						() => {
							ref.Name = "x";
						}
					],
					[
						"delete",
						() => {
							delete ref.Meta;
						}
					],
					[
						"in",
						() => "Name" in ref
					],
					[
						"spread",
						() => ({
							...ref
						})
					],
					[
						"keys",
						() => Object.keys(ref)
					],
					// ownKeys and getOwnPropertyDescriptor on their own, not
					// through spread and keys, which exercise both at once and
					// stay green with either check removed. entity() re-raises the
					// path-carrying error through Reflect.ownKeys, so the ownKeys
					// check is load-bearing.
					[
						"ownKeys",
						() => Object.getOwnPropertyNames(ref)
					],
					[
						"descriptor",
						() => Object.getOwnPropertyDescriptor(ref, "Name")
					],
					[
						"entity",
						() => entity(ref).next()
					]
				];
				for (const [name, attempt] of attempts) {
					try {
						attempt();
						out.push(`${name}:no-throw`);
					} catch (e) {
						out.push(`${name}:${e instanceof DraftDetachedError ? "detached" : `other:${String(e)}`}`);
					}
				}
			}
			const parked = h.dispatch(probe);
			await tick();
			await h.dispatch(removeRow1);
			h.release();
			await parked;
			expect(out).toEqual([
				false,
				true,
				"[object Object]",
				"read:detached",
				"write:detached",
				"delete:detached",
				"in:detached",
				"spread:detached",
				"keys:detached",
				"ownKeys:detached",
				"descriptor:detached",
				"entity:detached"
			]);
			h.runtime.dispose();
			dispose();
		});
	});

	it("does not throw for a replacement inside the same slice: the mark lands at frame close", async () => {
		await createRoot(async (dispose) => {
			const h = makeHarness();
			const out: unknown[] = [];
			function* replaceThenWrite(draft: IWorld): IActionGenerator {
				const ref = draft.Rows[0];
				// No yield between. The cascade that marks the replaced node
				// runs when this slice's frame closes, so the write below
				// lands on the detached object rather than throwing, and the
				// stale-path tripwire is what witnesses it.
				draft.Rows[0] = minted("row-other", {
					Name: "replacement"
				});
				try {
					ref.Name = "written through the old node";
					out.push("no-throw");
				} catch (e) {
					out.push(e instanceof DraftDetachedError ? "detached" : `other:${String(e)}`);
				}
				out.push(draft.Rows[0].Name);
			}
			await h.dispatch(replaceThenWrite);
			expect(out).toEqual([
				"no-throw",
				"replacement"
			]);
			h.runtime.dispose();
			dispose();
		});
	});

	it("re-attaches the node when a held reference is assigned back into the draft", async () => {
		await createRoot(async (dispose) => {
			const h = makeHarness();
			const out: unknown[] = [];
			function* restore(draft: IWorld) {
				const ref = draft.Rows[0];
				yield* open(park());
				out.push(isAttached(ref));
				// The write reads the raw through the symbol channel, so the
				// assignment itself does not throw. This is the only way an
				// author can put a removed node back, so it has to work.
				draft.Spare.push(ref);
				// Still detached in THIS slice: the adoption that un-marks it
				// runs when the frame closes, like every other reconciliation.
				out.push(isAttached(ref));
				yield {
					Type: "tick"
				};
				out.push(isAttached(ref));
				out.push(ref.Name);
			}
			const parked = h.dispatch(restore);
			await tick();
			await h.dispatch(removeRow1);
			h.release();
			await parked;
			expect(out).toEqual([
				false,
				false,
				true,
				"one"
			]);
			expect(h.runtime.state.Spare.map((r) => r.$Id)).toEqual([
				"row-1"
			]);
			h.runtime.dispose();
			dispose();
		});
	});

	it("goes live again when a later action re-attaches the raw node", async () => {
		await createRoot(async (dispose) => {
			const h = makeHarness();
			const out: unknown[] = [];
			function* readdRow1(draft: IWorld): IActionGenerator {
				draft.Rows.push(draft.Spare[0]);
				draft.Spare = [];
			}
			function* park(draft: IRow): IActionGenerator {
				const ref = draft;
				yield {
					Type: "park"
				};
				out.push(isAttached(ref));
				out.push(ref.Name);
			}
			// Park the row rather than dropping it, so the same raw object can
			// come back: a WeakMap delete is what makes the reference live.
			function* parkRow1(draft: IWorld): IActionGenerator {
				draft.Spare = [
					draft.Rows[0]
				];
				draft.Rows = draft.Rows.filter((r) => r.$Id !== "row-1");
			}
			const parked = h.runtime.dispatch(park, "row-1");
			await tick();
			await h.dispatch(parkRow1);
			await h.dispatch(readdRow1);
			h.release();
			await parked;
			expect(out).toEqual([
				true,
				"one"
			]);
			h.runtime.dispose();
			dispose();
		});
	});

	it("exempts a cancelled branch's close, and detaches again after it", async () => {
		await createRoot(async (dispose) => {
			const runtime = createRuntime<IWorld>(world(), {
				onError: () => {}
			});
			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			runtime.registerImplementation("park", () => gate);
			const out: unknown[] = [];
			let escaped: IRow | undefined;
			function* rowStory(draft: IRow): IActionGenerator {
				escaped = draft;
				try {
					yield {
						Type: "park"
					};
				} finally {
					draft.Name = "cleaned up";
					out.push("finally ran");
				}
			}
			function* dropRow1(draft: IWorld): IActionGenerator {
				draft.Rows = draft.Rows.filter((r) => r.$Id !== "row-1");
			}
			const parked = runtime.processAction(
				rowStory as any,
				() => runtime.state.Rows[0],
				sliceSetState(rootSetState(runtime), (s: IWorld) => s.Rows[0]),
				() => "row-1"
			);
			await tick();
			await runtime.processAction(
				dropRow1 as any,
				() => runtime.state,
				rootSetState(runtime),
				() => "root"
			);
			release();
			await parked;
			expect(out).toEqual([
				"finally ran"
			]);
			expect(isAttached(escaped)).toBe(false);
			runtime.dispose();
			dispose();
		});
	});
});

describe("detachment through resync", () => {
	function buildGateway<T extends object>(initial: T) {
		const gateway = createWriteGateway({
			journal: createJournal(),
			emitDiag: () => {}
		});
		const { raw, setState } = createTreeState<T>(initial, gateway);
		gateway.connect(raw, setState);
		return {
			raw,
			gateway
		};
	}

	it("survives a dispose callback that resyncs while several ids are dropping", () => {
		const world = buildGateway<{
			$Id: string;
			Rows: {
				$Id: string;
			}[];
		}>({
			$Id: "root",
			Rows: [
				{
					$Id: "a"
				},
				{
					$Id: "b"
				},
				{
					$Id: "c"
				}
			]
		});
		const disposed: string[] = [];
		// Once, on the first id to drop: the latch is what keeps it a re-entry
		// rather than an unbounded recursion. The inner rebuild deletes cells
		// the outer loop still holds ids for, so the outer loop has to re-read
		// rather than trust its list.
		let resynced = false;
		world.gateway.onDispose((id) => {
			disposed.push(id);
			if (resynced) {
				return;
			}
			resynced = true;
			world.gateway.resync();
		}, "tables");
		world.raw.Rows = [];
		expect(() => world.gateway.resync()).not.toThrow();
		expect(
			[
				...new Set(disposed)
			].sort()
		).toEqual([
			"a",
			"b",
			"c"
		]);
	});

	it("un-marks a node a bypassed write put back", () => {
		const world = buildGateway<{
			$Id: string;
			Row: {
				$Id: string;
				Name: string;
			} | null;
		}>({
			$Id: "root",
			Row: {
				$Id: "row",
				Name: "one"
			}
		});
		const node = world.raw.Row!;
		world.raw.Row = null;
		world.gateway.resync();
		expect(world.gateway.isDetached(node)).toBe(true);

		world.raw.Row = node;
		world.gateway.resync();
		expect(world.gateway.isDetached(node)).toBe(false);
		expect(rawOf(world.gateway.lookup().row?.state)).toBe(node);
	});

	it("does not detach a node whose $Id was re-identified in place by a bypassed write", () => {
		const world = buildGateway<{
			$Id: string;
			Row: {
				$Id: string;
				Name: string;
			};
		}>({
			$Id: "root",
			Row: {
				$Id: "old",
				Name: "one"
			}
		});
		const node = world.raw.Row;
		node.$Id = "fresh";
		world.gateway.resync();
		expect(world.gateway.isDetached(node)).toBe(false);
		expect(rawOf(world.gateway.lookup().fresh?.state)).toBe(node);

		const dropped = world.raw.Row;
		(world.raw as unknown as Record<string, unknown>).Row = {
			$Id: "other",
			Name: "two"
		};
		world.gateway.resync();
		expect(world.gateway.isDetached(dropped)).toBe(true);
	});
});
