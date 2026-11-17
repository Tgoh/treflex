import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IVerifyIndexMode } from "../../src/Runtime/createWriteGateway";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { ISetState } from "../../src/Runtime/sliceSetState";
import type { IActionGenerator } from "../../src/Types/IAction";
import { createMemo, createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { registerDataSource } from "../../src/Effects/registerDataSource";
import { startTimer } from "../../src/Effects/startTimer";
import { unregisterDataSource } from "../../src/Effects/unregisterDataSource";
import { bind } from "../../src/Runtime/bind";
import { createJournal } from "../../src/Runtime/createJournal";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createWriteGateway, TRIPWIRE_MASK, VERIFY_MIN_CADENCE, VERIFY_NODE_BUDGET } from "../../src/Runtime/createWriteGateway";
import { seat } from "../../src/Runtime/draftNode";
import { receiver } from "../../src/Runtime/receiver";
import { sliceSetState } from "../../src/Runtime/sliceSetState";
import { rawOf } from "../../src/Runtime/viewProxy";
import { createTreeState, minted, mountComponent, rootSetState } from "../testHelpers";

function buildGateway<T extends object>(initial: T, journal = createJournal(), verifyIndex?: boolean | IVerifyIndexMode) {
	const gateway = createWriteGateway({
		journal,
		emitDiag: () => {},
		verifyIndex
	});
	const { raw, state, setState: wrapped } = createTreeState<T>(initial, gateway);
	gateway.connect(raw, wrapped);
	const attributed = <R>(fn: () => R): R => gateway.exemptFrame(fn);
	const setState: ISetState<T> = (...args: ((x: any) => any)[]) => attributed(() => wrapped(...args));
	return {
		state,
		raw,
		setState,
		attributed,
		gateway,
		lookup: gateway.lookup
	};
}

describe("createWriteGateway", () => {
	describe("index maintenance", () => {
		it("honours TREFLEX_VERIFY_INDEX: one raw bypass throws on the very next write", () => {
			const world = buildGateway<any>({
				$Id: "root",
				Note: 0
			});
			world.raw.Sneaked = {
				$Id: "sneaked"
			};
			expect(() =>
				world.setState((s: any) => {
					s.Note = 1;
				})
			).toThrow(/index is missing entity "sneaked"/);
		});

		it("has a cleanup's write during a resync indexed when the resync returns", () => {
			const world = buildGateway<any>({
				$Id: "root",
				Child: {
					$Id: "child"
				},
				Added: null
			});
			world.gateway.onDispose((id) => {
				if (id === "child") {
					world.setState((s: any) => {
						s.Added = minted("added");
					});
				}
			}, "tables");
			world.raw.Child = null;
			world.gateway.resync();
			expect(world.lookup()["~added"]).toBeDefined();
		});

		it("seeds the initial tree with id-ancestry paths", () => {
			const world = buildGateway({
				$Id: "root",
				child: {
					$Id: "child",
					grandchild: {
						$Id: "grandchild"
					}
				},
				items: [
					{
						$Id: "a"
					},
					{
						$Id: "b"
					}
				]
			});
			expect(Object.keys(world.lookup()).sort()).toEqual([
				"a",
				"b",
				"child",
				"grandchild",
				"root"
			]);
			expect(rawOf(world.lookup().b.state)).toBe(rawOf(world.state.items[1]));
			expect([
				...world.lookup().grandchild.path
			]).toEqual([
				"root",
				"child",
				"grandchild"
			]);
		});

		it("indexes entities added and removed through public setState", () => {
			const world = buildGateway<{
				$Id: string;
				items: {
					$Id: string;
				}[];
			}>({
				$Id: "root",
				items: []
			});

			world.setState((s) => {
				s.items.push(minted("a"));
			});
			world.setState((s) => {
				s.items.push(minted("b"));
			});
			expect(Object.keys(world.lookup()).sort()).toEqual([
				"root",
				"~a",
				"~b"
			]);

			world.setState((s) => {
				s.items.splice(0, 1);
			});
			expect(world.lookup()["~a"]).toBeUndefined();
			expect(world.lookup()["~b"]).toBeDefined();
			expect([
				...world.lookup()["~b"].path
			]).toEqual([
				"root",
				"~b"
			]);
		});

		it("picks up an $Id stamped after first evaluation", () => {
			const world = buildGateway<{
				$Id?: string;
				Note?: number;
				child?: {
					$Id: string;
				};
			}>({});
			expect(Object.keys(world.lookup())).toEqual([]);

			world.setState((s: any) => {
				rawOf(s).$Id = "root";
				s.Note = 1;
			});
			expect(Object.keys(world.lookup())).toEqual([
				"root"
			]);

			world.setState((s: any) => {
				s.child = minted("child");
			});
			expect([
				...world.lookup()["~child"].path
			]).toEqual([
				"root",
				"~child"
			]);
		});

		it("tolerates null array elements — data slots, not children", () => {
			const world = buildGateway({
				$Id: "root",
				items: [
					{
						$Id: "a"
					},
					null,
					{
						$Id: "b"
					}
				] as ({
					$Id: string;
				} | null)[]
			});
			expect(world.lookup().a).toBeDefined();
			expect(world.lookup().b).toBeDefined();

			world.setState((s: any) => {
				s.items[0] = null;
			});
			expect(world.lookup().a).toBeUndefined();
			expect(world.lookup().b).toBeDefined();
		});

		it("a splice re-keys survivors without disposing them", () => {
			const world = buildGateway({
				$Id: "root",
				items: [
					{
						$Id: "a"
					},
					{
						$Id: "b",
						leaf: {
							$Id: "b-leaf"
						}
					},
					{
						$Id: "c"
					}
				]
			});
			const disposed: string[] = [];
			world.gateway.onDispose((id) => disposed.push(id), "tables");
			const survivorRaw = rawOf(world.lookup().c.state);

			world.setState((s) => {
				s.items.splice(0, 1);
			});

			expect(disposed).toEqual([
				"a"
			]);
			expect(rawOf(world.lookup().c.state)).toBe(survivorRaw);
			expect([
				...world.lookup()["b-leaf"].path
			]).toEqual([
				"root",
				"b",
				"b-leaf"
			]);
		});

		it("the collection-replacement idiom keeps carried-over entities alive", () => {
			// push + filter-assignment in ONE batch: the old array is touched
			// and then replaced — walking it as if attached would steal the
			// carried-over entities and dispose them.
			const world = buildGateway({
				$Id: "root",
				items: [
					{
						$Id: "a"
					},
					{
						$Id: "b"
					}
				]
			});
			const disposed: string[] = [];
			world.gateway.onDispose((id) => disposed.push(id), "tables");

			world.setState((s: any) => {
				s.items.push(minted("c"));
				s.items = s.items.filter((x: { $Id: string }) => x.$Id !== "a");
			});

			expect(disposed).toEqual([
				"a"
			]);
			expect(Object.keys(world.lookup()).sort()).toEqual([
				"b",
				"root",
				"~c"
			]);
		});

		it("dispose cascade runs children-first, with entity:dispose landing after each id's cleanups", () => {
			const journal = createJournal();
			const sequence: string[] = [];
			journal.tap((record) => {
				if (record.Kind === "entity:dispose") {
					sequence.push(`record:${record.EntityId}`);
				}
			});
			const world = buildGateway(
				{
					$Id: "root",
					child: {
						$Id: "child",
						grandchild: {
							$Id: "grandchild"
						}
					} as {
						$Id: string;
						grandchild: {
							$Id: string;
						};
					} | null
				},
				journal
			);
			world.gateway.onDispose((id) => sequence.push(`cleanup-a:${id}`), "tables");
			world.gateway.onDispose((id) => sequence.push(`cleanup-b:${id}`), "tables");

			world.setState((s) => {
				s.child = null;
			});

			expect(sequence).toEqual([
				"cleanup-a:grandchild",
				"cleanup-b:grandchild",
				"record:grandchild",
				"cleanup-a:child",
				"cleanup-b:child",
				"record:child"
			]);
		});

		it("fires the phases in declared order regardless of registration order", () => {
			const world = buildGateway({
				$Id: "root",
				child: {
					$Id: "child"
				} as {
					$Id: string;
				} | null
			});
			const sequence: string[] = [];
			// Scrambled registration on purpose: the pipeline's order is the
			// declared phase, not construction order — with registration order
			// preserved within a phase (cancel-a before cancel-b).
			world.gateway.onDispose((id) => sequence.push(`resources:${id}`), "resources");
			world.gateway.onDispose((id) => sequence.push(`cancel-a:${id}`), "cancel");
			world.gateway.onDispose((id) => sequence.push(`caches:${id}`), "caches");
			world.gateway.onDispose((id) => sequence.push(`tables:${id}`), "tables");
			world.gateway.onDispose((id) => sequence.push(`cancel-b:${id}`), "cancel");

			world.setState((s) => {
				s.child = null;
			});

			expect(sequence).toEqual([
				"cancel-a:child",
				"cancel-b:child",
				"tables:child",
				"caches:child",
				"resources:child"
			]);
		});

		it("hands each cleanup the entity's path as of the last reconciliation", () => {
			const world = buildGateway({
				$Id: "root",
				branch: {
					$Id: "branch",
					leaf: {
						$Id: "leaf"
					} as {
						$Id: string;
					} | null
				}
			});
			const paths: string[][] = [];
			world.gateway.onDispose((_id, path) => {
				paths.push([
					...path
				]);
			}, "tables");

			world.setState((s) => {
				s.branch.leaf = null;
			});

			expect(paths).toEqual([
				[
					"root",
					"branch",
					"leaf"
				]
			]);
		});

		it("reparenting recomputes the moved subtree's paths and disposes nothing", () => {
			const world = buildGateway<any>({
				$Id: "root",
				a: {
					$Id: "a",
					leaf: {
						$Id: "leaf",
						deep: {
							$Id: "deep"
						}
					}
				},
				b: {
					$Id: "b"
				}
			});
			const disposed: string[] = [];
			world.gateway.onDispose((id) => disposed.push(id), "tables");
			const leafRaw = rawOf(world.lookup().leaf.state);

			world.setState((s: any) => {
				s.b.adopted = s.a.leaf;
				delete s.a.leaf;
			});

			expect(disposed).toEqual([]);
			expect(rawOf(world.lookup().leaf.state)).toBe(leafRaw);
			expect([
				...world.lookup().leaf.path
			]).toEqual([
				"root",
				"b",
				"leaf"
			]);
			expect([
				...world.lookup().deep.path
			]).toEqual([
				"root",
				"b",
				"leaf",
				"deep"
			]);
		});

		// The test above writes the destination first, which puts the moved
		// node's new container in `pending` ahead of its old one. That order
		// masks a phase-1-before-phase-2 regression, because the up-link is
		// already current by the time the source is diffed. Source-first is
		// the discriminator: it is the order a removal-then-insert refactor
		// produces, and the only one that fails if the phases interleave.
		it("reparents identically when the source is written before the destination", () => {
			const world = buildGateway<any>({
				$Id: "root",
				a: {
					$Id: "a",
					leaf: {
						$Id: "leaf",
						deep: {
							$Id: "deep"
						}
					}
				},
				b: {
					$Id: "b"
				}
			});
			const disposed: string[] = [];
			world.gateway.onDispose((id) => disposed.push(id), "tables");
			const leafRaw = rawOf(world.lookup().leaf.state);

			world.setState((s: any) => {
				const moved = s.a.leaf;
				delete s.a.leaf;
				s.b.adopted = moved;
			});

			expect(disposed).toEqual([]);
			expect(rawOf(world.lookup().leaf.state)).toBe(leafRaw);
			expect([
				...world.lookup().leaf.path
			]).toEqual([
				"root",
				"b",
				"leaf"
			]);
			expect([
				...world.lookup().deep.path
			]).toEqual([
				"root",
				"b",
				"leaf",
				"deep"
			]);
		});

		// The index's resting state is only half the contract: a regression
		// that disposes a moved entity and re-adopts it leaves an identical
		// set of cells behind, so nothing keyed on cells can see it. These
		// pin the transition — which Ids the pipeline ran for, in what order,
		// and in which phase.
		it("cascades exactly the removed subtree, children before parents, phases in order", () => {
			const world = buildGateway<any>({
				$Id: "root",
				keep: {
					$Id: "keep"
				},
				gone: {
					$Id: "gone",
					mid: {
						$Id: "mid",
						leaf: {
							$Id: "leaf"
						}
					}
				}
			});
			const fired: string[] = [];
			for (const phase of [
				"cancel",
				"tables",
				"caches",
				"resources"
			] as const) {
				world.gateway.onDispose((id) => fired.push(`${id}:${phase}`), phase);
			}

			const before = new Set(Object.keys(world.lookup()));
			world.setState((s: any) => {
				delete s.gone;
			});
			const after = new Set(Object.keys(world.lookup()));

			const cascaded = [
				...new Set(fired.map((entry) => entry.split(":")[0]))
			];
			const lost = [
				...before
			].filter((id) => !after.has(id));
			expect(cascaded.slice().sort()).toEqual(lost.slice().sort());
			expect(lost.slice().sort()).toEqual([
				"gone",
				"leaf",
				"mid"
			]);

			expect(cascaded).toEqual([
				"leaf",
				"mid",
				"gone"
			]);

			for (const id of cascaded) {
				expect(fired.filter((entry) => entry.startsWith(`${id}:`))).toEqual([
					`${id}:cancel`,
					`${id}:tables`,
					`${id}:caches`,
					`${id}:resources`
				]);
			}
		});

		it("cascades nothing for a move, whichever end is written first", () => {
			for (const destinationFirst of [
				true,
				false
			]) {
				const world = buildGateway<any>({
					$Id: "root",
					a: {
						$Id: "a",
						leaf: {
							$Id: "leaf"
						}
					},
					b: {
						$Id: "b"
					}
				});
				const fired: string[] = [];
				world.gateway.onDispose((id) => fired.push(id), "cancel");

				world.setState((s: any) => {
					if (destinationFirst) {
						s.b.adopted = s.a.leaf;
						delete s.a.leaf;
					} else {
						const moved = s.a.leaf;
						delete s.a.leaf;
						s.b.adopted = moved;
					}
				});

				expect(fired).toEqual([]);
				expect(Object.keys(world.lookup()).sort()).toEqual([
					"a",
					"b",
					"leaf",
					"root"
				]);
			}
		});

		it("an $Id change disposes the identity the node stopped bearing", () => {
			const world = buildGateway({
				$Id: "root",
				child: {
					$Id: "old",
					Value: 0
				}
			});
			const disposed: string[] = [];
			world.gateway.onDispose((id) => disposed.push(id), "tables");

			world.setState((s) => {
				rawOf(s.child).$Id = "renamed";
				s.child.Value = 1;
			});

			expect(disposed).toEqual([
				"old"
			]);
			expect(world.lookup().old).toBeUndefined();
			expect([
				...world.lookup().renamed.path
			]).toEqual([
				"root",
				"renamed"
			]);
		});

		it("the cell setState writes through the entity's CURRENT location after a splice", () => {
			const world = buildGateway({
				$Id: "root",
				items: [
					{
						$Id: "a",
						Value: 0
					},
					{
						$Id: "b",
						Value: 0
					}
				]
			});
			const cellSetState = world.lookup().b.setState;

			world.setState((s) => {
				s.items.splice(0, 1);
			});
			world.attributed(() =>
				cellSetState((x: any) => {
					x.Value = 7;
				})
			);

			expect(world.state.items[0].Value).toBe(7);
		});

		it("tolerates a dispose cleanup that re-enters the gateway (queue, drain once)", () => {
			const world = buildGateway<any>({
				$Id: "root",
				Log: [] as string[],
				items: [
					{
						$Id: "a"
					}
				]
			});
			world.gateway.onDispose((id) => {
				world.setState((s: any) => {
					s.Log.push(`disposed:${id}`);
				});
			}, "tables");

			world.setState((s: any) => {
				s.items.splice(0, 1);
			});

			expect(world.state.Log).toEqual([
				"disposed:a"
			]);
			expect(world.lookup().a).toBeUndefined();
			expect(world.lookup().root).toBeDefined();
		});

		it("point reads subscribe to one $Id's cell only", () => {
			createRoot((dispose) => {
				const world = buildGateway<{
					$Id: string;
					items: {
						$Id: string;
						Value: number;
					}[];
				}>({
					$Id: "root",
					items: [
						{
							$Id: "a",
							Value: 1
						}
					]
				});
				let runs = 0;
				const pointRead = createMemo(() => {
					runs++;
					return world.lookup().a?.state;
				});
				expect(rawOf(pointRead())).toBe(rawOf(world.state.items[0]));
				expect(runs).toBe(1);

				world.setState((s) => {
					s.items[0].Value = 2;
				});
				expect(runs).toBe(1);

				world.setState((s) => {
					s.items.push(
						minted("b", {
							Value: 3
						})
					);
				});
				expect(runs).toBe(1);

				world.setState((s) => {
					s.items.splice(0, 1);
				});
				expect(pointRead()).toBeUndefined();
				expect(runs).toBe(2);
				dispose();
			});
		});

		it("DEV tripwire catches a write that bypassed the gateway within its cadence", () => {
			const world = buildGateway<any>({
				$Id: "root",
				Count: 0,
				box: {
					$Id: "box"
				}
			});
			// A write straight to the raw object never reaches the gateway's
			// traps — the unwitnessed door the tripwire exists to catch.
			// Deeper than the witnessed writes below, so reconciliation's
			// own container re-scan cannot incidentally heal it: the walk
			// prunes at the unmoved `box` child and only the tripwire's
			// fresh walk sees inside.
			world.raw.box.Sneak = {
				$Id: "sneak"
			};

			// This suite arms the walk exhaustively (TREFLEX_VERIFY_INDEX in
			// vitest.config.ts), so the bypass fails on the next witnessed
			// write. The bound is what a budgeted gateway would need; the
			// arming tests below pin the modes themselves.
			expect(() => {
				for (let i = 0; i <= TRIPWIRE_MASK; i++) {
					world.setState((s: any) => {
						s.Count = i + 1;
					});
				}
			}).toThrow(/index is missing entity "sneak"/);
		});

		// Arming. DEV alone is not the signal, because this package ships raw
		// TypeScript and a consumer's dev server compiles these same sources.
		// A bypass is the observable: the walk is the only thing that sees it.

		function sneakThenWrite(world: ReturnType<typeof buildGateway<any>>, writes: number): () => void {
			world.raw.box.Sneak = {
				$Id: "sneak"
			};
			return () => {
				for (let i = 0; i < writes; i++) {
					world.setState((s: any) => {
						s.Count = i + 1;
					});
				}
			};
		}

		const boxedTree = (fillers: number) => ({
			$Id: "root",
			Count: 0,
			box: {
				$Id: "box"
			},
			filler: Array.from(
				{
					length: fillers
				},
				(_, i) => ({
					$Id: `f-${i}`,
					a: {},
					b: {}
				})
			)
		});

		it("never walks when verification is off, so a bypass goes unseen", () => {
			const world = buildGateway<any>(boxedTree(0), createJournal(), false);
			expect(sneakThenWrite(world, VERIFY_MIN_CADENCE * 4)).not.toThrow();
			expect(world.lookup().sneak).toBeUndefined();
		});

		it("walks every reconciliation when verification is always", () => {
			const world = buildGateway<any>(boxedTree(0), createJournal(), true);
			expect(sneakThenWrite(world, 1)).toThrow(/index is missing entity "sneak"/);
		});

		it("budgets the walk by tree size, so a big tree is checked less often", () => {
			const small = buildGateway<any>(boxedTree(0), createJournal(), "budgeted");
			expect(sneakThenWrite(small, VERIFY_MIN_CADENCE)).toThrow(/index is missing entity "sneak"/);

			const fillers = VERIFY_NODE_BUDGET * VERIFY_MIN_CADENCE;
			const big = buildGateway<any>(boxedTree(fillers), createJournal(), "budgeted");
			expect(sneakThenWrite(big, VERIFY_MIN_CADENCE)).not.toThrow();
		});
	});

	type TestState = {
		$Id: string;
		Count: number;
		Children: {
			$Id: string;
			Data: string;
		}[];
	};

	const initialState = (): TestState => ({
		$Id: "root",
		Count: 0,
		Children: [
			{
				$Id: "child-1",
				Data: "seed"
			}
		]
	});

	function dispatch<A extends any[], R>(
		runtime: IRuntime<TestState>,
		action: (draft: TestState, ...args: A) => Generator<any, R, any>,
		...args: A
	): Promise<R | undefined> {
		return runtime.processAction(
			action as any,
			() => runtime.state,
			rootSetState(runtime),
			() => "root",
			...args
		);
	}

	function gatewayOf(runtime: IRuntime<TestState>) {
		return (runtime as IRuntimeInternal<TestState>).get("runtime/writeGateway");
	}

	function servingLookupOf(runtime: IRuntime<TestState>) {
		return (runtime as IRuntimeInternal<TestState>).get("runtime/stateIdLookup");
	}

	function* addChild(draft: TestState, id: string): IActionGenerator {
		draft.Children.push(
			minted(id, {
				Data: id
			})
		);
	}

	function* addDuplicateOfChild1(draft: TestState): IActionGenerator {
		seat(draft.Children, draft.Children.length, {
			$Id: "child-1",
			Data: "child-1"
		});
	}

	function* setRowId(draft: any, index: number, id: unknown): IActionGenerator {
		rawOf(draft.Rows[index]).$Id = id;
		draft.Rows[index].Name = `${draft.Rows[index].Name}!`;
	}

	function* dropChildAt(draft: TestState, index: number): IActionGenerator {
		draft.Children.splice(index, 1);
	}

	const SweepReceiver = receiver<TestState["Children"][number]>("GatewaySweepReceiver")({});

	function* wire(draft: TestState["Children"][number]): IActionGenerator {
		const reg = registerDataSource as any;
		const unreg = unregisterDataSource as any;
		const timer = startTimer as any;
		bind(draft, SweepReceiver);
		yield* reg(draft, "Sweep/K1");
		yield* reg(draft, "Sweep/K2");
		yield* unreg(draft, "Sweep/K2");
		yield* timer(draft, "Sweep/T", SweepReceiver, 60_000);
	}

	function* churn(draft: TestState): IActionGenerator {
		draft.Children.push(
			minted("child-9", {
				Data: "c9"
			})
		);
		draft.Children = draft.Children.filter((c) => c.$Id !== "child-1");
		draft.Count += 1;
	}

	describe("runtime integration", () => {
		it("serves the gateway index through runtime/stateIdLookup and observes action writes", async () => {
			const runtime = createRuntime<TestState>(initialState(), {});
			expect(servingLookupOf(runtime)).toBe(gatewayOf(runtime).lookup);

			await dispatch(runtime, addChild, "child-2");
			expect([
				...servingLookupOf(runtime)()["~child-2"].path
			]).toEqual([
				"root",
				"~child-2"
			]);

			await dispatch(runtime, churn);
			const lookup = servingLookupOf(runtime)();
			expect(lookup["child-1"]).toBeUndefined();
			expect([
				...lookup["~child-9"].path
			]).toEqual([
				"root",
				"~child-9"
			]);
			expect(rawOf(lookup["~child-9"].state)).toBe(rawOf(runtime.state.Children.find((c) => c.$Id === "~child-9")!));
			runtime.dispose();
		});

		it("refuses a duplicate $Id when the frame ends, naming both places, and undoes the frame", async () => {
			const runtime = createRuntime<TestState>(initialState(), {});

			await expect(dispatch(runtime, addDuplicateOfChild1)).rejects.toThrow(
				/two nodes carrying the \$Id "child-1" landed in state, at \[AppState\.Children\.0\] and \[AppState\.Children\.1\]/
			);

			expect(runtime.state.Children).toHaveLength(1);
			expect(rawOf(servingLookupOf(runtime)()["child-1"].state)).toBe(rawOf(runtime.state.Children[0]));
			runtime.dispose();
		});

		it("fails the resync that meets a raw write's duplicate $Id, loudly", () => {
			const runtime = createRuntime<TestState>(initialState(), {});
			rawOf(runtime.state.Children).push({
				$Id: "child-1",
				Data: "child-1"
			} as never);
			expect(() => gatewayOf(runtime).resync()).toThrow(/a second node carrying the \$Id "child-1", at \[AppState\.Children\.1\]/);
		});

		it.each([
			7,
			""
		])("disposes an $Id raw-written to %j", async (id) => {
			const runtime = createRuntime<any>({
				$Id: "root",
				Rows: [
					{
						$Id: "row-1",
						Name: "first"
					}
				]
			});

			await runtime.processAction(
				setRowId as any,
				() => runtime.state,
				rootSetState(runtime),
				() => "root",
				0,
				id
			);

			expect(servingLookupOf(runtime)()["row-1"]).toBeUndefined();

			runtime.dispose();
		});

		it("sweeps exactly the registrations an owner still holds when it leaves", async () => {
			const runtime = createRuntime<TestState>(initialState(), {});
			runtime.registerReceiver(SweepReceiver);
			const internal = runtime as unknown as IRuntimeInternal<TestState>;
			const bindings = internal.get("runtime/bindings");
			const sources = internal.get("runtime/dataSources");
			const timers = internal.get("runtime/timers");

			await dispatch(runtime, addChild, "child-2");
			for (const i of [
				0,
				1
			]) {
				await runtime.processAction(
					wire,
					() => runtime.state.Children[i],
					sliceSetState(rootSetState(runtime), (st: TestState) => st.Children[i]),
					() => runtime.state.Children[i].$Id
				);
			}

			const bound = () =>
				[
					...bindings.boundTo(SweepReceiver.Id)
				].sort();
			const ownedSources = (id: string) => sources.entries().filter((e) => e.OwnerId === id);
			const ownedTimers = (id: string) => timers.entries().filter((e) => e.OwnerId === id);
			expect(bound()).toEqual(
				[
					"child-1",
					"~child-2"
				].sort()
			);
			expect(ownedSources("~child-2")).toHaveLength(1);
			expect(ownedTimers("~child-2")).toHaveLength(1);

			await dispatch(runtime, dropChildAt, 1);

			expect(bound()).toEqual([
				"child-1"
			]);
			expect(ownedSources("~child-2")).toHaveLength(0);
			expect(ownedTimers("~child-2")).toHaveLength(0);
			expect(ownedSources("child-1")).toHaveLength(1);
			expect(ownedTimers("child-1")).toHaveLength(1);
			runtime.dispose();
		});

		// A length write drops its tail with no trap per slot, and two length
		// writes in one batch collapse to one touched key, so the drain sees
		// only the final length. The trap observes the dropped slots at the
		// moment each shrink happens, which is the one place they are known.
		it("cascades slots a length shrink dropped, even when the array re-grows in the same batch", async () => {
			const shapes: [
				string,
				(draft: TestState) => IActionGenerator,
				string[]
			][] = [
				[
					"shrink then re-grow to the same length",
					function* (draft: TestState): IActionGenerator {
						draft.Children.length = 1;
						draft.Children.push(
							minted("new-2", {
								Data: "new"
							}),
							minted("new-3", {
								Data: "new"
							}),
							minted("new-4", {
								Data: "new"
							})
						);
					},
					[
						"child-2",
						"child-3",
						"child-4"
					]
				],
				[
					"shrink then partial re-grow",
					function* (draft: TestState): IActionGenerator {
						draft.Children.length = 1;
						draft.Children.push(
							minted("new-2", {
								Data: "new"
							})
						);
					},
					[
						"child-2",
						"child-3",
						"child-4"
					]
				],
				[
					"shrink then a write at the new end",
					function* (draft: TestState): IActionGenerator {
						draft.Children.length = 2;
						draft.Children[2] = minted("late", {
							Data: "late"
						});
					},
					[
						"child-3",
						"child-4"
					]
				]
			];

			for (const [name, act, expected] of shapes) {
				const runtime = createRuntime<TestState>(
					{
						$Id: "root",
						Count: 0,
						Children: [
							"child-1",
							"child-2",
							"child-3",
							"child-4"
						].map(($Id) => ({
							$Id,
							Data: $Id
						}))
					},
					{}
				);
				const disposed: string[] = [];
				runtime.on("record", (record) => {
					if (record.Kind === "entity:dispose") disposed.push(record.EntityId);
				});

				await dispatch(runtime, act);

				const lookup = (runtime as unknown as IRuntimeInternal<TestState>).get("runtime/stateIdLookup");
				const live = new Set([
					"root",
					...runtime.state.Children.filter(Boolean).map((c) => c.$Id)
				]);
				expect({
					name,
					stale: Object.keys(lookup()).filter((id) => !live.has(id))
				}).toEqual({
					name,
					stale: []
				});
				expect({
					name,
					disposed: disposed.sort()
				}).toEqual({
					name,
					disposed: expected
				});
				runtime.dispose();
			}
		});

		it("indexes a ComponentState mount through the same lookup, with a path through its owner", () => {
			const runtime = createRuntime<TestState>(initialState(), {});
			const internal = runtime as IRuntimeInternal<TestState>;

			const id = mountComponent(runtime, undefined, {});
			const lookup = servingLookupOf(runtime)();
			expect([
				...lookup[id].path
			]).toEqual([
				"root",
				id
			]);

			internal.unmountComponent(id);
			expect(servingLookupOf(runtime)()[id]).toBeUndefined();
			runtime.dispose();
		});
	});

	describe("outside-write-rule enforcement", () => {
		it("throws in dev on a public setState, leaving the write unapplied", () => {
			const runtime = createRuntime<TestState>(initialState(), {});
			expect(() =>
				rootSetState(runtime)((s) => {
					s.Count = 99;
				})
			).toThrow(/state mutations belong to actions/);
			expect(runtime.state.Count).toBe(0);
			runtime.dispose();
		});

		it.each([
			{
				name: "a delete",
				write: (s: TestState) => {
					delete (s as Partial<TestState>).Count;
				}
			},
			{
				name: "a length",
				write: (s: TestState) => {
					s.Children.length = 0;
				}
			},
			{
				name: "a push",
				write: (s: TestState) => {
					s.Children.push({
						$Id: "pushed"
					} as TestState["Children"][number]);
				}
			},
			{
				name: "a delete of an absent key",
				write: (s: TestState) => {
					delete (s as unknown as Record<string, unknown>).Absent;
				}
			},
			{
				name: "a set of undefined on an absent key",
				write: (s: TestState) => {
					(s as unknown as Record<string, unknown>).Absent = undefined;
				}
			}
		])("throws on $name through a public setState, leaving the write unapplied", ({ write }) => {
			const runtime = createRuntime<TestState>(initialState(), {});
			const before = JSON.stringify(runtime.state);
			expect(() => rootSetState(runtime)(write)).toThrow(/state mutations belong to actions/);
			expect(JSON.stringify(runtime.state)).toBe(before);
			runtime.dispose();
		});

		it("action writes pass — the recording context is the action-origin signal", async () => {
			const runtime = createRuntime<TestState>(initialState(), {});
			await expect(dispatch(runtime, addChild, "child-2")).resolves.toBeUndefined();
			expect(runtime.state.Children.length).toBe(2);
			runtime.dispose();
		});

		it("a tap (the activity log's) throws identically", () => {
			const runtime = createRuntime<TestState>(initialState(), {
				activityLog: true
			});
			expect(() =>
				rootSetState(runtime)((s) => {
					s.Count = 5;
				})
			).toThrow(/state mutations belong to actions/);
			expect(runtime.state.Count).toBe(0);
			runtime.dispose();
		});

		it("a ComponentState mount and unmount are exempt framework paths", () => {
			const runtime = createRuntime<TestState>(initialState(), {});
			const internal = runtime as IRuntimeInternal<TestState>;
			let id = "";
			expect(() => {
				id = mountComponent(runtime, undefined, {});
			}).not.toThrow();
			expect(() => internal.unmountComponent(id)).not.toThrow();
			runtime.dispose();
		});
	});
});
