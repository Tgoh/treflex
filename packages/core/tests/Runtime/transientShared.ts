import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import type { IRecord } from "../../src/Types/IRecord";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { createMemo, createRoot } from "solid-js";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { withoutIds } from "../../src/Effects/entity";
import { generateGuid } from "../../src/Effects/generateGuid";
import { parallel } from "../../src/Effects/parallel";
import { publishToNearest } from "../../src/Effects/publishToNearest";
import { registerDataSource } from "../../src/Effects/registerDataSource";
import { start } from "../../src/Effects/start";
import { getData } from "../../src/Reads/getData";
import { getDataPath } from "../../src/Reads/getDataPath";
import { select } from "../../src/Reads/select";
import { bind } from "../../src/Runtime/bind";
import { createRuntime, type IRuntime, type IRuntimeOptions } from "../../src/Runtime/createRuntime";
import { DraftDetachedError, EntityReplacedError, seat } from "../../src/Runtime/draftNode";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { StateAliasError } from "../../src/Runtime/stateAlias";
import { StateCycleError } from "../../src/Runtime/stateCycle";
import { MoveBetweenRootsError, transient } from "../../src/Runtime/transient";
import { rawOf, view } from "../../src/Runtime/viewProxy";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";
import { captureSurfaced, minted, rawWrite } from "../testHelpers";

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"Transient/Ping": {
			From: string;
		};
	}
}

declare module "../../src/Registries/IDataSourceRegistry" {
	interface IDataSourceRegistry {
		"Transient/Theme": {
			$Id: string;
			Name: string;
		};
	}
}

interface IRow extends IEntity {
	Name: string;
}

interface IOwner extends IEntity {
	Rows: IRow[];
	Note?: unknown;
	Held?: unknown;
	Pings?: string[];
}

interface IWorld extends IEntity {
	Left: IOwner[];
	Right: IOwner[];
	Theme: {
		$Id: string;
		Name: string;
	};
}

function seed(): IWorld {
	return {
		$Id: "root",
		Left: [
			{
				$Id: "owner",
				Rows: [
					{
						$Id: "row",
						Name: "row"
					}
				]
			}
		],
		Right: [],
		Theme: {
			$Id: "theme",
			Name: "dark"
		}
	};
}

const progress = (owner: IEntity) =>
	transient(owner, "Test/Progress", {
		Running: 0
	});
const other = (owner: IEntity) =>
	transient(owner, "Test/Other", {
		Running: 0
	});
const shelf = (owner: IEntity) =>
	transient(owner, "Test/Shelf", {
		Rows: [] as IEntity[],
		Note: null as unknown,
		Item: null as IEntity | null
	});
const drawer = (owner: IEntity) =>
	transient(owner, "Test/Drawer", {
		Item: null as IEntity | null
	});

interface IRawRoot {
	TransientState: object;
}

interface IShelf {
	Rows: IEntity[];
	Note: unknown;
	Item: IEntity | null;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function peek<S extends object>(runtime: IRuntime<IWorld>, slot: (owner: IEntity) => Generator<any, S, any>, owner: IEntity): S {
	return runtime.processSelector(
		function* (draft: IEntity) {
			return yield* slot(draft);
		},
		() => owner
	);
}

function* park(): IActionGenerator {
	return yield {
		Type: "park"
	};
}

function* trips(): IActionGenerator {
	yield* park();
	throw new Error("tripped");
}

const optionsFor = (errors: unknown[]): IRuntimeOptions => ({
	onError: (error) => errors.push(error)
});

function build() {
	const errors: unknown[] = [];
	return wire(createRuntime<IWorld>(seed(), optionsFor(errors)), errors);
}

function wire(built: IRuntime<IWorld>, errors: unknown[]) {
	const runtime = built as IRuntimeInternal<IWorld>;
	const releases: (() => void)[] = [];
	runtime.registerImplementation(
		"park",
		() =>
			new Promise<void>((resolve) => {
				releases.push(resolve);
			})
	);
	runtime.registerImplementation("echo", () => "echoed");
	const records: IRecord[] = [];
	runtime.on("record", (record) => {
		records.push(record);
	});
	const owner = (): IOwner => runtime.state.Left[0];
	const run = <R>(action: (draft: IWorld) => IActionGenerator<R>): Promise<R | undefined> => runtime.dispatch(action, "root");
	const onOwner = <R>(action: (draft: IOwner) => IActionGenerator<R>): Promise<R | undefined> => runtime.dispatch(action, "owner");
	return {
		runtime,
		errors,
		releases,
		records,
		owner,
		run,
		onOwner
	};
}

async function restoreBuilt(saved: string, setup?: (runtime: IRuntime<IWorld>) => void) {
	const errors: unknown[] = [];
	let world!: ReturnType<typeof wire>;
	const { result } = await restoreRuntime<IWorld>(saved, {
		rootId: "root",
		options: optionsFor(errors),
		setup: (runtime) => {
			world = wire(runtime, errors);
			setup?.(runtime);
		}
	});
	return {
		...world,
		result
	};
}

function* remove(draft: IWorld): IActionGenerator {
	draft.Left = [];
}

function* readd(draft: IWorld): IActionGenerator {
	seat(draft.Left, draft.Left.length, seed().Left[0]);
}

function* moveRight(draft: IWorld): IActionGenerator {
	const [node] = draft.Left.splice(0, 1);
	draft.Right.push(node);
}

export function transientRules(build_: string): void {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe(`slots ${build_}: reading and writing`, () => {
		it("reads an unwritten slot as its default, through a view and through a draft, writing nothing", async () => {
			const h = build();
			expect(peek(h.runtime, progress, h.owner()).Running).toBe(0);
			const seen = await h.onOwner(function* (draft) {
				return (yield* progress(draft)).Running;
			});
			expect(seen).toBe(0);
			expect(h.records.filter((record) => record.Kind === "step")).toEqual([]);
			expect((h.runtime.get("runtime/writeGateway").rootNode() as IRawRoot).TransientState).toEqual({});
		});

		it("holds what an action wrote, with the write's record under the slot's address", async () => {
			const h = build();
			const warn = vi.spyOn(console, "warn");
			await h.onOwner(function* (draft) {
				(yield* progress(draft)).Running = 2;
			});
			expect(warn).not.toHaveBeenCalled();
			expect(peek(h.runtime, progress, h.owner()).Running).toBe(2);
			const step = h.records.find((record) => record.Kind === "step");
			expect(step && step.Kind === "step" && step.Changes[0].Path).toEqual([
				"TransientState",
				"owner",
				"Test/Progress",
				"Running"
			]);
		});

		it("gives an owner and a slot whatever names they have", async () => {
			const h = build();
			const odd = (owner: IEntity) =>
				transient(owner, "constructor", {
					Running: 0
				});
			const proto = (owner: IEntity) =>
				transient(owner, "__proto__", {
					Running: 0
				});
			expect(peek(h.runtime, odd, h.owner()).Running).toBe(0);
			expect(peek(h.runtime, proto, h.owner()).Running).toBe(0);
			await h.run(function* (draft) {
				seat(draft.Left, 1, {
					$Id: "constructor",
					Rows: []
				});
				seat(draft.Left, 2, {
					$Id: "__proto__",
					Rows: []
				});
			});
			for (const id of [
				"constructor",
				"__proto__"
			]) {
				await h.runtime.dispatch(function* (draft: IEntity): IActionGenerator {
					(yield* odd(draft)).Running = 1;
					(yield* proto(draft)).Running = 2;
				}, id);
			}
			expect(peek(h.runtime, odd, h.runtime.state.Left[1]).Running).toBe(1);
			expect(peek(h.runtime, proto, h.runtime.state.Left[2]).Running).toBe(2);
			expect(Object.getPrototypeOf({}).Running).toBeUndefined();
		});

		it("reads an unwritten slot as a copy, so a write of it into state touches nothing else", async () => {
			const h = build();
			const second = build();
			const seen = peek(h.runtime, progress, h.owner());
			expect(Object.isFrozen(seen)).toBe(true);
			expect(rawOf(seen)).toBe(seen);
			await h.onOwner(function* (draft) {
				draft.Held = seen;
				yield {
					Type: "echo"
				};
				(
					draft.Held as {
						Running: number;
					}
				).Running = 42;
			});
			expect(
				(
					h.owner().Held as {
						Running: number;
					}
				).Running
			).toBe(42);
			expect(peek(h.runtime, progress, h.owner()).Running).toBe(0);
			expect(peek(second.runtime, progress, second.owner()).Running).toBe(0);
		});

		it("refuses a first write into an unborn slot of a copy carrying a live $Id, leaving the slot unborn", async () => {
			const h = build();
			await expect(
				h.onOwner(function* (draft) {
					(yield* shelf(draft)).Item = {
						$Id: "row"
					};
				})
			).rejects.toThrow(EntityReplacedError);
			expect((h.runtime.get("runtime/writeGateway").rootNode() as IRawRoot).TransientState).toEqual({});
		});

		it("gives one owner its slots separately, and one slot to each owner", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				(yield* progress(draft)).Running = 1;
			});
			await h.run(function* (draft) {
				(yield* other(draft.Left[0])).Running = 2;
				(yield* progress(draft)).Running = 3;
			});
			expect(peek(h.runtime, progress, h.owner()).Running).toBe(1);
			expect(peek(h.runtime, other, h.owner()).Running).toBe(2);
			expect(peek(h.runtime, progress, h.runtime.state).Running).toBe(3);
		});

		it("refuses what the tree refuses inside a slot: a non-plain value, and a draft written outside its steps", async () => {
			const h = build();
			await expect(
				h.onOwner(function* (draft) {
					(yield* shelf(draft)).Note = new Map();
				})
			).rejects.toThrow(NonPlainDataError);
			let held!: {
				Running: number;
			};
			await h.onOwner(function* (draft) {
				held = yield* progress(draft);
				held.Running = 1;
			});
			expect(() => {
				held.Running = 2;
			}).toThrow("only during its own action's steps");
			expect(peek(h.runtime, progress, h.owner()).Running).toBe(1);
		});

		it("copies and freezes what is written into a slot", async () => {
			const h = build();
			const note = {
				Text: "a"
			};
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Note = note;
			});
			expect(Object.isFrozen(note)).toBe(true);
			expect(rawOf(peek(h.runtime, shelf, h.owner()).Note)).not.toBe(note);
			expect(peek(h.runtime, shelf, h.owner()).Note).toEqual(note);
		});

		it("applies the tree rule inside the transient root, undoing the slice that breaks it", async () => {
			const h = build();
			const surfaced = captureSurfaced();
			await expect(
				h.onOwner(function* (draft) {
					const slot = yield* shelf(draft);
					slot.Item = minted("kept");
					yield {
						Type: "echo"
					};
					slot.Note = slot.Item;
				})
			).rejects.toThrow(StateAliasError);
			await settle();
			expect(surfaced).toEqual([]);
			const slot = peek(h.runtime, shelf, h.owner());
			expect(slot.Item?.$Id).toBe("~kept");
			expect(slot.Note).toBeNull();
		});

		it("refuses an owner with no $Id, a value snapshot, and a draft of a node with no $Id", async () => {
			const h = build();
			expect(() => peek(h.runtime, progress, {} as IEntity)).toThrow("transient(");
			expect(() =>
				peek(h.runtime, progress, {
					$Id: "owner"
				})
			).toThrow("through a selector");
			await expect(
				h.onOwner(function* (draft) {
					(draft as unknown as Record<string, unknown>).Note = {};
					yield {
						Type: "echo"
					};
					yield* progress((draft as unknown as Record<string, IEntity>).Note);
				})
			).rejects.toThrow("not an entity");
		});

		it("takes an owner added in the same step, since the yield lands it", async () => {
			const h = build();
			await h.run(function* (draft) {
				draft.Left.push(
					minted("fresh", {
						Rows: []
					})
				);
				(yield* progress(draft.Left[1])).Running = 1;
			});
			expect(peek(h.runtime, progress, h.runtime.state.Left[1]).Running).toBe(1);
		});

		it("refuses an owner added and taken out again in one step, which never reached the tree", async () => {
			const h = build();
			await expect(
				h.run(function* (draft) {
					draft.Left.push(
						minted("passing", {
							Rows: []
						})
					);
					const passing = draft.Left[1];
					draft.Left.pop();
					yield* progress(passing);
				})
			).rejects.toThrow('the owner "~passing" is not on the state tree');
		});

		it("refuses a slot on a view of state outside the tree", () => {
			const h = build();
			const local = view({
				$Id: "local"
			});
			expect(() => peek(h.runtime, progress, local)).toThrow("the owner has to be a draft, or a view of an entity on the state tree");
		});

		it("types the slot as its default, in an action and in a selector, and takes no primitive default", () => {
			function* action(draft: IOwner): IActionGenerator {
				const s = yield* transient(draft, "Test/Typed", {
					Count: 0,
					Rows: [] as IRow[]
				});
				expectTypeOf(s).toEqualTypeOf<{
					Count: number;
					Rows: IRow[];
				}>();
				// @ts-expect-error a slot's default is an object or an array.
				yield* transient(draft, "Test/Primitive", 1);
			}
			function* selector(draft: IOwner): ISelectorGenerator<number> {
				const s = yield* transient(draft, "Test/Typed", {
					Count: 0
				});
				expectTypeOf(s.Count).toEqualTypeOf<number>();
				return s.Count;
			}
			expectTypeOf(action).toBeFunction();
			expectTypeOf(selector).toBeFunction();
		});

		it("refuses a name that is empty and a default that isn't an object", async () => {
			const h = build();
			await expect(
				h.onOwner(function* (draft) {
					yield* transient(draft, "", {});
				})
			).rejects.toThrow("a non-empty name");
			await expect(
				h.onOwner(function* (draft) {
					yield* transient(draft, "Test/Number", 1 as unknown as object);
				})
			).rejects.toThrow("the default has to be");
		});

		it("refuses a non-plain default, or one carrying a live node, as a crossing, from a draft and from a view", async () => {
			const h = build();
			const dated = (owner: IEntity) =>
				transient(owner, "Test/Dated", {
					At: new Date(0)
				});
			await expect(
				h.onOwner(function* (draft) {
					yield* dated(draft);
				})
			).rejects.toThrow(NonPlainDataError);
			expect(() => peek(h.runtime, dated, h.owner())).toThrow(NonPlainDataError);
			await expect(
				h.onOwner(function* (draft) {
					yield* transient(draft, "Test/Holding", {
						Item: draft.Rows[0]
					});
				})
			).rejects.toThrow("a live node");
			const holding = h.owner().Rows[0];
			expect(() =>
				peek(
					h.runtime,
					(owner) =>
						transient(owner, "Test/Holding", {
							Item: holding
						}),
					h.owner()
				)
			).toThrow("a live node");
		});

		it("does not look at the default once the slot exists, and the first of two defaults stands", async () => {
			const h = build();
			const small = (owner: IEntity) =>
				transient(owner, "Test/Two", {
					Size: 1
				});
			const large = (owner: IEntity) =>
				transient(owner, "Test/Two", {
					Size: 2
				});
			await h.onOwner(function* (draft) {
				const s = yield* small(draft);
				s.Size++;
			});
			expect(peek(h.runtime, large, h.owner()).Size).toBe(2);
			const later = await h.onOwner(function* (draft) {
				return (yield* large(draft)).Size;
			});
			expect(later).toBe(2);
		});

		it("takes an array as the default: unborn it reads as a frozen copy, and the first write makes it", async () => {
			const h = build();
			const list = (owner: IEntity) => transient(owner, "Test/List", [] as IRow[]);
			const empty = peek(h.runtime, list, h.owner());
			expect(empty).toEqual([]);
			expect(Object.isFrozen(empty)).toBe(true);
			await h.onOwner(function* (draft) {
				const rows = yield* list(draft);
				rows.push(
					minted("in-list", {
						Name: "listed"
					})
				);
				rows[0].Name = "edited";
			});
			expect(peek(h.runtime, list, h.owner())[0].Name).toBe("edited");
			expect(h.runtime.get("runtime/stateIdLookup")()["~in-list"].path).toEqual([
				"root",
				"owner",
				"~in-list"
			]);
			await h.onOwner(function* (draft) {
				(yield* list(draft)).length = 0;
			});
			expect(peek(h.runtime, list, h.owner())).toEqual([]);
			expect(h.runtime.get("runtime/stateIdLookup")()["~in-list"]).toBeUndefined();
		});

		it("gives each owner its own copy of one default, and leaves the default unfrozen", async () => {
			const h = build();
			const shared = {
				Rows: [] as string[]
			};
			const held = (owner: IEntity) => transient(owner, "Test/Shared", shared);
			await h.run(function* (draft) {
				(yield* held(draft)).Rows.push("root");
				(yield* held(draft.Left[0])).Rows.push("owner");
			});
			expect(peek(h.runtime, held, h.runtime.state).Rows).toEqual([
				"root"
			]);
			expect(peek(h.runtime, held, h.owner()).Rows).toEqual([
				"owner"
			]);
			expect(shared.Rows).toEqual([]);
			expect(Object.isFrozen(shared)).toBe(false);
		});

		it("adds no records beyond the writes", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				(yield* progress(draft)).Running = 1;
			});
			expect(h.records.map((record) => record.Kind)).toEqual([
				"action:start",
				"step",
				"action:end"
			]);
		});

		it("refuses a write through a selector's result, which is read-only", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				(yield* progress(draft)).Running = 1;
			});
			const seen = peek(h.runtime, progress, h.owner());
			expect(() => {
				seen.Running = 2;
			}).toThrow("read-only");
		});
	});

	describe(`slots ${build_}: lifetime`, () => {
		it("goes with its owner, and a re-add starts empty", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				(yield* progress(draft)).Running = 4;
			});
			await h.run(remove);
			await h.run(readd);
			expect(peek(h.runtime, progress, h.owner()).Running).toBe(0);
		});

		function* countsThroughHeld(draft: IOwner): IActionGenerator {
			const s = yield* progress(draft);
			s.Running++;
			try {
				yield* park();
			} finally {
				s.Running--;
			}
		}

		function* countsThroughYield(draft: IOwner): IActionGenerator {
			(yield* progress(draft)).Running++;
			try {
				yield* park();
			} finally {
				(yield* progress(draft)).Running--;
			}
		}

		for (const [how, counts] of [
			[
				"a slot held across the park",
				countsThroughHeld
			],
			[
				"a slot yielded for again in the finally",
				countsThroughYield
			]
		] as const) {
			describe(`a stopped branch's finally through ${how}`, () => {
				it("does not reach the new owner's slot after a remove and re-add, with no warning and no record", async () => {
					const h = build();
					const warn = vi.spyOn(console, "warn");
					const done = h.onOwner(counts);
					await h.run(remove);
					await h.run(readd);
					await h.onOwner(function* (draft) {
						(yield* progress(draft)).Running = 5;
					});
					await done;
					expect(peek(h.runtime, progress, h.owner()).Running).toBe(5);
					expect(h.errors).toEqual([]);
					expect(warn).not.toHaveBeenCalled();
					const cancelling = h.records.filter((record) => record.Kind === "step" && record.Cancelling);
					expect(cancelling).toEqual([]);
				});

				it("does not reach the new slot when it runs after the re-add's own count", async () => {
					const h = build();
					const old = h.onOwner(counts);
					await settle();
					await h.run(function* (draft) {
						draft.Left = [];
						yield* generateGuid();
						seat(draft.Left, 0, seed().Left[0]);
						yield* generateGuid();
						(yield* progress(draft.Left[0])).Running = 1;
					});
					await old;
					expect(peek(h.runtime, progress, h.owner()).Running).toBe(1);
				});

				it("counts down for a stop with the owner still there, reporting no finally-yield", async () => {
					const h = build();
					const codes: string[] = [];
					h.runtime.on("diag", (event) => {
						codes.push(event.code);
					});
					const done = h.onOwner(function* (draft) {
						yield* parallel(counts(draft), trips());
					});
					await settle();
					expect(peek(h.runtime, progress, h.owner()).Running).toBe(1);
					h.releases[1]!();
					await expect(done).rejects.toThrow("tripped");
					expect(peek(h.runtime, progress, h.owner()).Running).toBe(0);
					expect(codes).toEqual([]);
				});
			});
		}

		it("runs the rest of a closing finally past the slot's yield, and an effect's yield there still skips what follows", async () => {
			const h = build();
			const codes: string[] = [];
			h.runtime.on("diag", (event) => {
				codes.push(event.code);
			});
			const ran: string[] = [];
			const done = h.onOwner(function* (draft) {
				yield* parallel(
					(function* (): IActionGenerator {
						try {
							yield* park();
						} finally {
							(yield* progress(draft)).Running = 7;
							ran.push("past the slot");
							yield {
								Type: "echo"
							};
							ran.push("past the effect");
						}
					})(),
					trips()
				);
			});
			await settle();
			h.releases[1]!();
			await expect(done).rejects.toThrow("tripped");
			expect(ran).toEqual([
				"past the slot"
			]);
			expect(peek(h.runtime, progress, h.owner()).Running).toBe(7);
			expect(codes).toEqual([
				"cancel/finally-yield"
			]);
		});

		it("throws a refusal into a closing finally, reported as that finally's throw", async () => {
			const h = build();
			const codes: string[] = [];
			h.runtime.on("diag", (event) => {
				codes.push(event.code);
			});
			const closeThrows: unknown[] = [];
			h.runtime.on("failure", (event) => {
				if (event.Close) {
					closeThrows.push(event.Error);
				}
			});
			const done = h.onOwner(function* () {
				yield* parallel(
					(function* (): IActionGenerator {
						try {
							yield* park();
						} finally {
							yield* progress({} as IEntity);
						}
					})(),
					trips()
				);
			});
			await settle();
			h.releases[1]!();
			await expect(done).rejects.toThrow("tripped");
			expect(codes).toEqual([
				"action/unrouted-throw"
			]);
			expect(closeThrows.map(String)).toEqual([
				expect.stringContaining('transient("')
			]);
		});

		it("gives a closing finally in a yield* helper its slot, and the stopped caller does not run on past the helper", async () => {
			const h = build();
			const codes: string[] = [];
			h.runtime.on("diag", (event) => {
				codes.push(event.code);
			});
			const ran: string[] = [];
			function* helper(draft: IOwner): IActionGenerator {
				try {
					yield* park();
				} finally {
					(yield* progress(draft)).Running = 7;
					ran.push("helper finally");
				}
			}
			const done = h.onOwner(function* (draft) {
				yield* parallel(
					(function* (): IActionGenerator {
						yield* helper(draft);
						ran.push("caller ran on");
						draft.Note = "caller ran on";
					})(),
					trips()
				);
			});
			await settle();
			h.releases[1]!();
			await expect(done).rejects.toThrow("tripped");
			expect(ran).toEqual([
				"helper finally"
			]);
			expect(peek(h.runtime, progress, h.owner()).Running).toBe(7);
			expect(h.owner().Note).toBeUndefined();
			expect(codes).toEqual([]);
		});

		it("does not run a root action on past a yield* helper whose closing finally takes a slot, when its owner goes", async () => {
			const h = build();
			const ran: string[] = [];
			function* helper(draft: IOwner): IActionGenerator {
				try {
					yield* park();
				} finally {
					(yield* progress(draft)).Running = 7;
					ran.push("helper finally");
				}
			}
			const done = h.onOwner(function* (draft) {
				yield* helper(draft);
				ran.push("caller ran on");
			});
			await settle();
			await h.run(remove);
			await done;
			expect(ran).toEqual([
				"helper finally"
			]);
			expect(h.errors).toEqual([]);
		});

		it("throws from a branch that was not stopped, as any read through a gone reference does", async () => {
			const h = build();
			await expect(
				h.run(function* (draft) {
					const held = draft.Left[0];
					draft.Left = [];
					yield {
						Type: "echo"
					};
					yield* progress(held);
				})
			).rejects.toThrow(DraftDetachedError);
			let held!: {
				Running: number;
			};
			await h.run(function* (draft) {
				seat(draft.Left, 0, seed().Left[0]);
				held = yield* progress(draft.Left[0]);
				draft.Left = [];
				yield {
					Type: "echo"
				};
			});
			expect(() => held.Running).toThrow(DraftDetachedError);
		});

		it("lets a slot held from another entity's action fail in its finally when the owner goes, as a held draft does", async () => {
			const h = build();
			const outer = h.runtime.dispatch(function* (draft: IWorld) {
				const s = yield* progress(draft.Left[0]);
				s.Running++;
				try {
					yield* open(park());
				} finally {
					s.Running--;
				}
			}, "root");
			await settle();
			await h.run(remove);
			h.releases[0]();
			await expect(outer).rejects.toThrow(DraftDetachedError);
		});

		it("throws for a gone reference even when a later owner holds the $Id, and that owner's slot stands", async () => {
			const h = build();
			const caught = await h.run(function* (draft): IActionGenerator<string> {
				const held = draft.Left[0];
				draft.Left = [];
				seat(draft.Right, 0, {
					$Id: "owner",
					Rows: []
				});
				yield {
					Type: "echo"
				};
				draft.Right = [];
				yield {
					Type: "echo"
				};
				seat(draft.Left, 0, seed().Left[0]);
				yield {
					Type: "echo"
				};
				(yield* progress(draft.Left[0])).Running = 5;
				try {
					(yield* progress(held)).Running = 77;
					return "wrote";
				} catch (error) {
					return (error as Error).name;
				}
			});
			expect(caught).toBe("DraftDetachedError");
			expect(peek(h.runtime, progress, h.owner()).Running).toBe(5);
		});

		it("writes nothing that lasts from a stopped branch whose owner has gone, and makes no slot, reached in the close", async () => {
			const h = build();
			const done = h.onOwner(function* (draft) {
				try {
					yield* park();
				} finally {
					const slot = yield* shelf(draft);
					slot.Rows.push(minted("late"));
					slot.Note = slot.Rows.length;
				}
			});
			await settle();
			await h.run(remove);
			await done;
			expect(h.errors).toEqual([]);
			expect(h.runtime.get("runtime/stateIdLookup")()["~late"]).toBeUndefined();
		});

		it("writes nothing that lasts from a stopped branch whose owner has gone, through a slot held from before and never born", async () => {
			const h = build();
			const warn = vi.spyOn(console, "warn");
			const done = h.onOwner(function* (draft) {
				const slot = yield* shelf(draft);
				try {
					yield* park();
				} finally {
					slot.Rows.push(minted("late"));
					slot.Note = slot.Rows.length;
					delete (slot as Record<string, unknown>).Item;
					slot.Rows.length = 0;
				}
			});
			await settle();
			await h.run(remove);
			await done;
			expect(h.errors).toEqual([]);
			expect(warn).not.toHaveBeenCalled();
			expect(h.runtime.get("runtime/stateIdLookup")()["~late"]).toBeUndefined();
			expect(h.records.filter((record) => record.Kind === "step" && record.Cancelling)).toEqual([]);
			expect((h.runtime.get("runtime/writeGateway").rootNode() as IRawRoot).TransientState).toEqual({});
		});

		it("drops an unwritten slot held by a draft with its owner, and a held reference to it stops working", async () => {
			const h = build();
			let held!: {
				Running: number;
			};
			await expect(
				h.run(function* (draft) {
					held = yield* progress(draft.Left[0]);
					draft.Left = [];
					yield {
						Type: "echo"
					};
					held.Running = 1;
				})
			).rejects.toThrow(DraftDetachedError);
			await h.run(readd);
			expect(peek(h.runtime, progress, h.owner()).Running).toBe(0);
		});

		it("comes out right when a slot is written and its owner removed in one slice", async () => {
			const h = build();
			await h.run(function* (draft) {
				const slot = yield* shelf(draft.Left[0]);
				slot.Rows.push(minted("in-slot"));
				draft.Left = [];
			});
			expect(h.runtime.get("runtime/stateIdLookup")()["~in-slot"]).toBeUndefined();
			await h.run(readd);
			expect(peek(h.runtime, shelf, h.owner()).Rows).toEqual([]);
		});

		it("comes out right when a slot is written and its owner moved in one slice", async () => {
			const h = build();
			await h.run(function* (draft) {
				const slot = yield* shelf(draft.Left[0]);
				slot.Item = minted("in-slot");
				const [node] = draft.Left.splice(0, 1);
				draft.Right.push(node);
			});
			expect(h.runtime.get("runtime/stateIdLookup")()["~in-slot"].path).toEqual([
				"root",
				"owner",
				"~in-slot"
			]);
		});

		it("disposes a transient entity ahead of its owner, with the entity's path through the owner", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Item = minted("in-slot");
			});
			await h.run(remove);
			const disposed = h.records
				.filter((record) => record.Kind === "entity:dispose")
				.map((record) => (record.Kind === "entity:dispose" ? record.Path : []));
			expect(disposed).toEqual([
				[
					"root",
					"owner",
					"row"
				],
				[
					"root",
					"owner",
					"~in-slot"
				],
				[
					"root",
					"owner"
				]
			]);
		});

		it("cancels a transient entity's actions with its owner, and nested slots go with it", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Item = minted("in-slot");
			});
			await h.runtime.dispatch(function* (draft: IEntity): IActionGenerator {
				(yield* shelf(draft)).Item = minted("nested");
			}, "~in-slot");
			const done = h.runtime.dispatch(function* (draft: IEntity): IActionGenerator<string> {
				(yield* progress(draft)).Running = 1;
				try {
					yield* park();
					return "finished";
				} finally {
					(yield* progress(draft)).Running = 0;
				}
			}, "~in-slot");
			await settle();
			await h.run(remove);
			await expect(done).resolves.toBeUndefined();
			expect(h.errors).toEqual([]);
			const lookup = h.runtime.get("runtime/stateIdLookup")();
			expect(lookup["~in-slot"]).toBeUndefined();
			expect(lookup["~nested"]).toBeUndefined();
			expect((h.runtime.get("runtime/writeGateway").rootNode() as IRawRoot).TransientState).toEqual({});
		});

		it("removes a row taken out of a slot through the ordinary cascade, cancelling what runs on it", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Rows.push(minted("row-in-slot"));
			});
			const done = h.runtime.dispatch(function* (): IActionGenerator<string> {
				yield* park();
				return "finished";
			}, "~row-in-slot");
			await settle();
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Rows.length = 0;
			});
			await expect(done).resolves.toBeUndefined();
			expect(h.runtime.get("runtime/stateIdLookup")()["~row-in-slot"]).toBeUndefined();
		});
	});

	describe(`slots ${build_}: lineage`, () => {
		const Pings = receiver<IOwner>("Transient/Pings")({
			*"Transient/Ping"(draft, message) {
				draft.Pings = [
					...(draft.Pings ?? []),
					message.From
				];
			},
			*"Action/Error"(draft, message) {
				draft.Pings = [
					...(draft.Pings ?? []),
					String(message.ActionName)
				];
			}
		});

		function* listen(draft: IOwner): IActionGenerator {
			bind(draft, Pings);
		}

		function withListeners() {
			const h = build();
			h.runtime.registerReceiver(Pings);
			return h;
		}

		async function holdingEntity(h: ReturnType<typeof build>) {
			await h.run(function* (draft) {
				draft.Right.push(
					minted("right", {
						Rows: []
					})
				);
				draft.Left.push(
					minted("left", {
						Rows: []
					})
				);
			});
			await h.runtime.dispatch(listen, "~right");
			await h.runtime.dispatch(listen, "~left");
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Item = minted("in-slot");
			});
		}

		function* moveUnderRight(draft: IWorld): IActionGenerator {
			const [node] = draft.Left.splice(0, 1);
			draft.Right[0].Rows.push(node as unknown as IRow);
		}

		function* moveUnderLeft(draft: IWorld): IActionGenerator {
			const [node] = draft.Left.splice(0, 1);
			draft.Left[0].Rows.push(node as unknown as IRow);
		}

		it("gives a transient entity a path through its owner, and follows a move as it happens", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Item = minted("in-slot");
			});
			const path = () => h.runtime.get("runtime/stateIdLookup")()["~in-slot"].path;
			expect(path()).toEqual([
				"root",
				"owner",
				"~in-slot"
			]);
			await h.run(moveRight);
			expect(path()).toEqual([
				"root",
				"owner",
				"~in-slot"
			]);
			await h.run(function* (draft) {
				draft.Left.push(
					minted("nest", {
						Rows: []
					})
				);
			});
			await h.run(function* (draft) {
				const [node] = draft.Right.splice(0, 1);
				draft.Left[0].Rows.push(node as unknown as IRow);
			});
			expect(path()).toEqual([
				"root",
				"~nest",
				"owner",
				"~in-slot"
			]);
		});

		it("composes through a transient entity that owns a slot of its own, across a move", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Item = minted("in-slot");
			});
			await h.runtime.dispatch(function* (draft: IEntity): IActionGenerator {
				(yield* shelf(draft)).Item = minted("deeper");
			}, "~in-slot");
			await h.run(function* (draft) {
				draft.Left.push(
					minted("nest", {
						Rows: []
					})
				);
			});
			await h.run(function* (draft) {
				const [node] = draft.Left.splice(0, 1);
				draft.Left[0].Rows.push(node as unknown as IRow);
			});
			expect(h.runtime.get("runtime/stateIdLookup")()["~deeper"].path).toEqual([
				"root",
				"~nest",
				"owner",
				"~in-slot",
				"~deeper"
			]);
			await h.run(function* (draft) {
				draft.Left = [];
			});
			expect(h.runtime.get("runtime/stateIdLookup")()["~deeper"]).toBeUndefined();
			expect(h.runtime.get("runtime/stateIdLookup")()["~in-slot"]).toBeUndefined();
		});

		it("reaches the owner's ancestors with publishToNearest, and the new ones after a move", async () => {
			const h = withListeners();
			await holdingEntity(h);
			await h.run(moveUnderLeft);
			const send = (from: string) =>
				h.runtime.dispatch(function* (draft: IEntity): IActionGenerator {
					yield* publishToNearest(draft, "Transient/Ping", {
						From: from
					});
				}, "~in-slot");
			await send("first");
			await settle();
			expect(h.runtime.state.Left[0].Pings).toEqual([
				"first"
			]);
			await h.run(function* (draft) {
				const [node] = draft.Left[0].Rows.splice(0, 1);
				draft.Right[0].Rows.push(node);
			});
			await send("second");
			await settle();
			expect(h.runtime.state.Right[0].Pings).toEqual([
				"second"
			]);
			expect(h.runtime.state.Left[0].Pings).toEqual([
				"first"
			]);
		});

		it("escalates a transient entity's Action/Error through the owner to its ancestors", async () => {
			const h = withListeners();
			await holdingEntity(h);
			await h.run(moveUnderRight);
			await expect(
				h.runtime.dispatch(function* failing(): IActionGenerator {
					throw new Error("failed");
				}, "~in-slot")
			).rejects.toThrow("failed");
			await settle();
			expect(h.runtime.state.Right[0].Pings).toEqual([
				"failing"
			]);
		});

		it("resolves getData and getDataPath through the owner, and a memo re-derives on a move with nothing else changing", async () => {
			const h = build();
			await h.run(function* (draft) {
				yield* registerDataSource(draft, "Transient/Theme", draft.Theme);
			});
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Item = minted("in-slot");
			});
			const walk = (): string[] =>
				h.runtime.processSelector(
					function* () {
						const found = yield* getDataPath(
							{
								$Id: "~in-slot"
							},
							"Transient/Theme"
						);
						return found.ancestors as string[];
					},
					() => h.runtime.state
				);
			expect(walk()).toEqual([
				"~in-slot",
				"owner",
				"root"
			]);
			await h.run(function* (draft) {
				draft.Left.push(
					minted("nest", {
						Name: "light",
						Rows: []
					})
				);
			});
			await h.runtime.dispatch(function* (draft: IOwner): IActionGenerator {
				yield* registerDataSource(draft as never, "Transient/Theme");
			}, "~nest");
			await createRoot(async (dispose) => {
				const name = createMemo(() =>
					h.runtime.runSelector(
						function* () {
							const theme = yield* getData(
								{
									$Id: "~in-slot"
								},
								"Transient/Theme"
							);
							return theme?.Name;
						},
						() => h.runtime.state
					)
				);
				expect(name()).toBe("dark");
				await h.run(function* (draft) {
					const [node] = draft.Left.splice(0, 1);
					draft.Left[0].Rows.push(node as unknown as IRow);
				});
				expect(name()).toBe("light");
				dispose();
			});
			expect(walk()).toEqual([
				"~in-slot",
				"owner",
				"~nest"
			]);
		});
	});

	describe(`slots ${build_}: loops through an owner`, () => {
		async function inSlot(h: ReturnType<typeof build>, ...ids: string[]): Promise<void> {
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Rows.push(...ids.map((id) => minted(id)));
			});
		}

		it("refuses an entity written into its own slot with StateCycleError, undoing the slice", async () => {
			const h = build();
			const surfaced = captureSurfaced();
			await inSlot(h, "e");
			await expect(
				h.runtime.dispatch(function* (draft: IEntity): IActionGenerator {
					(yield* shelf(draft)).Item = draft;
				}, "~e")
			).rejects.toThrow(StateCycleError);
			await settle();
			expect(surfaced).toEqual([]);
			expect(h.runtime.get("runtime/stateIdLookup")()["~e"].path).toEqual([
				"root",
				"owner",
				"~e"
			]);
			expect(peek(h.runtime, shelf, h.runtime.get("runtime/stateIdLookup")()["~e"].state as IEntity).Item).toBeNull();
		});

		it("refuses two entities moved into each other's slots with StateCycleError, leaving both where they were", async () => {
			const h = build();
			const surfaced = captureSurfaced();
			await inSlot(h, "e1", "e2");
			await expect(
				h.onOwner(function* (draft) {
					const slot = yield* shelf(draft);
					const [e1, e2] = slot.Rows;
					const inE1 = yield* shelf(e1);
					const inE2 = yield* shelf(e2);
					inE1.Item = e2;
					inE2.Item = e1;
					slot.Rows.length = 0;
				})
			).rejects.toThrow(StateCycleError);
			await settle();
			expect(surfaced).toEqual([]);
			const lookup = h.runtime.get("runtime/stateIdLookup")();
			expect(lookup["~e1"].path).toEqual([
				"root",
				"owner",
				"~e1"
			]);
			expect(lookup["~e2"].path).toEqual([
				"root",
				"owner",
				"~e2"
			]);
			expect(peek(h.runtime, shelf, h.owner()).Rows.map((row) => row.$Id)).toEqual([
				"~e1",
				"~e2"
			]);
		});

		it("fails the rebuild that meets a raw loop through an owner, whichever order the holders were born in", async () => {
			const h = build();
			await inSlot(h, "e");
			await h.runtime.dispatch(function* (draft: IEntity): IActionGenerator {
				(yield* progress(draft)).Running = 1;
				(yield* shelf(draft)).Item = null;
			}, "~e");
			await h.onOwner(function* (draft) {
				(yield* progress(draft)).Running = 1;
			});
			expect(() =>
				rawWrite(h.runtime, () => {
					const root = h.runtime.get("runtime/writeGateway").rootNode() as {
						TransientState: Record<string, Record<string, IShelf>>;
					};
					root.TransientState["~e"]!["Test/Shelf"]!.Item = rawOf(h.runtime.get("runtime/stateIdLookup")()["~e"].state) as IEntity;
				})
			).toThrow(/a rebuild met a loop/);
		});
	});

	describe(`slots ${build_}: never saved`, () => {
		it("snapshots no slot, nothing a transient entity owns, and restores to empty with nothing to sweep", async () => {
			const a = build();
			const Pings = receiver<IEntity>("Transient/Unused")({
				*"Transient/Ping"() {}
			});
			a.runtime.registerReceiver(Pings);
			await a.onOwner(function* (draft) {
				(yield* progress(draft)).Running = 3;
				(yield* shelf(draft)).Item = minted("in-slot");
			});
			await a.runtime.dispatch(function* (draft: IEntity): IActionGenerator {
				bind(draft, Pings);
			}, "~in-slot");
			const saved = createSnapshot(a.runtime);
			expect(saved).not.toContain("Test/Progress");
			expect(saved).not.toContain("in-slot");
			expect(saved).not.toContain("TransientState");
			const envelope = JSON.parse(saved);
			expect(envelope.Version).toBe(JSON.parse(createSnapshot(build().runtime)).Version);
			expect(Object.keys(envelope)).toEqual(Object.keys(JSON.parse(createSnapshot(build().runtime))));

			const diags: string[] = [];
			const b = await restoreBuilt(saved, (runtime) => {
				runtime.on("diag", (event) => {
					diags.push(event.code);
				});
			});
			expect(b.result.sweptOrphanedRows).toBe(0);
			expect(diags).toEqual([]);
			expect(peek(b.runtime, progress, b.owner()).Running).toBe(0);
			expect(peek(b.runtime, shelf, b.owner()).Item).toBeNull();
			expect((b.runtime.get("runtime/writeGateway").rootNode() as IRawRoot).TransientState).toEqual({});
		});
	});

	describe(`slots ${build_}: crossing between roots`, () => {
		it("refuses a live tree node written into a slot, by itself or inside a value, leaving both where they were", async () => {
			const h = build();
			for (const write of [
				(draft: IOwner, slot: IShelf) => {
					slot.Item = draft.Rows[0];
				},
				(draft: IOwner, slot: IShelf) => {
					slot.Rows.push(draft.Rows[0]);
				},
				(draft: IOwner, slot: IShelf) => {
					slot.Note = {
						Selected: draft.Rows[0]
					};
				},
				(draft: IOwner, slot: IShelf) => {
					slot.Note = view(rawOf(draft.Rows[0]));
				},
				(draft: IOwner, slot: IShelf) => {
					reconcileRows(
						slot.Rows,
						[
							"a"
						],
						(row: any) => row,
						{
							add: () => draft.Rows[0],
							update: () => {}
						}
					).next();
				}
			]) {
				await expect(
					h.onOwner(function* (draft) {
						write(draft, yield* shelf(draft));
					})
				).rejects.toThrow(MoveBetweenRootsError);
			}
			expect(h.owner().Rows).toHaveLength(1);
			expect(peek(h.runtime, shelf, h.owner()).Item).toBeNull();
			expect(peek(h.runtime, shelf, h.owner()).Note).toBeNull();
			expect(peek(h.runtime, shelf, h.owner()).Rows).toHaveLength(0);
		});

		it("refuses a move of a tree node into a slot, cleared first in the same step", async () => {
			const h = build();
			await expect(
				h.onOwner(function* (draft) {
					const slot = yield* shelf(draft);
					const row = draft.Rows[0];
					draft.Rows = [];
					slot.Item = row;
				})
			).rejects.toThrow(MoveBetweenRootsError);
		});

		it("names the owner and the slot in the error, unborn or not", async () => {
			const h = build();
			const refusal = (write: (draft: IOwner, slot: IShelf) => void) =>
				h.onOwner(function* (draft) {
					write(draft, yield* shelf(draft));
				});
			await expect(
				refusal((draft, slot) => {
					slot.Item = draft.Rows[0];
				})
			).rejects.toThrow("[TransientState.owner.Test/Shelf]");
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Item = minted("in-slot");
			});
			await expect(
				refusal((draft, slot) => {
					draft.Held = slot.Item;
				})
			).rejects.toThrow("[TransientState.owner.Test/Shelf.Item]");
		});

		it("refuses a node written into a slot in the same step and then into the tree, and keeps the write before it", async () => {
			const h = build();
			const surfaced = captureSurfaced();
			await expect(
				h.onOwner(function* (draft) {
					const slot = yield* shelf(draft);
					slot.Note = {
						Fresh: true
					};
					draft.Held = slot.Note;
				})
			).rejects.toThrow(MoveBetweenRootsError);
			await settle();
			expect(h.owner().Held).toBeUndefined();
			expect(peek(h.runtime, shelf, h.owner()).Note).toEqual({
				Fresh: true
			});
			expect(surfaced.filter((error) => error instanceof StateAliasError)).toEqual([]);
		});

		it("refuses a tree node written below a slot node new in the same step, and keeps the write before it", async () => {
			const h = build();
			const surfaced = captureSurfaced();
			await expect(
				h.onOwner(function* (draft) {
					const slot = yield* shelf(draft);
					slot.Note = {};
					(
						slot.Note as {
							Selected?: IRow;
						}
					).Selected = draft.Rows[0];
				})
			).rejects.toThrow(MoveBetweenRootsError);
			await settle();
			expect(peek(h.runtime, shelf, h.owner()).Note).toEqual({});
			expect(h.owner().Rows).toHaveLength(1);
			expect(surfaced.filter((error) => error instanceof StateAliasError)).toEqual([]);
			await h.onOwner(function* (draft) {
				const slot = yield* shelf(draft);
				slot.Note = {};
				(
					slot.Note as {
						Selected?: unknown;
					}
				).Selected = withoutIds(draft.Rows[0]);
			});
			expect(peek(h.runtime, shelf, h.owner()).Note).toEqual({
				Selected: {
					Name: "row"
				}
			});
		});

		it("refuses a live slot node written into the tree", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Item = minted("in-slot");
			});
			await expect(
				h.onOwner(function* (draft) {
					draft.Held = (yield* shelf(draft)).Item;
				})
			).rejects.toThrow(MoveBetweenRootsError);
			await expect(
				h.onOwner(function* (draft) {
					draft.Held = {
						Inner: yield* shelf(draft)
					};
				})
			).rejects.toThrow(MoveBetweenRootsError);
			await expect(
				h.onOwner(function* (draft) {
					draft.Held = yield* progress(draft);
				})
			).rejects.toThrow(MoveBetweenRootsError);
			expect(h.owner().Held).toBeUndefined();
		});

		it("takes a real move between two owners' slots: the entity follows its new owner and outlives the old one", async () => {
			const h = build();
			const warn = vi.spyOn(console, "warn");
			await h.run(function* (draft) {
				draft.Left.push(
					minted("second", {
						Rows: []
					})
				);
			});
			await h.run(function* (draft) {
				(yield* shelf(draft.Left[0])).Item = minted("traveller");
			});
			await h.run(function* (draft) {
				const from = yield* shelf(draft.Left[0]);
				const to = yield* drawer(draft.Left[1]);
				const moved = from.Item;
				from.Item = null;
				to.Item = moved;
				yield {
					Type: "echo"
				};
				(to.Item as unknown as Record<string, unknown>).Text = "through the new slot";
			});
			expect(warn).not.toHaveBeenCalled();
			const lookup = h.runtime.get("runtime/stateIdLookup")();
			expect(lookup["~traveller"].path).toEqual([
				"root",
				"~second",
				"~traveller"
			]);
			await h.run(function* (draft) {
				draft.Left.shift();
			});
			expect(h.runtime.get("runtime/stateIdLookup")()["~traveller"].path).toEqual([
				"root",
				"~second",
				"~traveller"
			]);
		});

		it("logs no false orphan when a transient entity's own draft reaches a node first met through a slot", async () => {
			const h = build();
			const warn = vi.spyOn(console, "warn");
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Item = minted("in-slot");
			});
			await h.runtime.dispatch(function* (
				draft: IEntity & {
					Kept?: {
						Text?: string;
					};
				}
			): IActionGenerator {
				(yield* shelf(draft)).Note = {
					Text: "a"
				};
				yield {
					Type: "echo"
				};
				const note = (yield* shelf(draft)).Note as {
					Text: string;
				};
				(yield* shelf(draft)).Note = null;
				draft.Kept = note;
				yield {
					Type: "echo"
				};
				(
					draft.Kept as {
						Text: string;
					}
				).Text = "b";
			}, "~in-slot");
			expect(warn).not.toHaveBeenCalled();
		});

		it("refuses from a transient entity's own action, writing a tree node it was given no draft of", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Item = minted("in-slot");
			});
			await expect(
				h.runtime.dispatch(function* (draft: IEntity & Record<string, unknown>): IActionGenerator {
					draft.Stolen = h.owner();
				}, "~in-slot")
			).rejects.toThrow(MoveBetweenRootsError);
		});

		it("copies a plain value across, and refuses a copy still carrying a live $Id", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Note = JSON.parse(JSON.stringify(draft.Rows[0].Name));
			});
			expect(peek(h.runtime, shelf, h.owner()).Note).toBe("row");
			await expect(
				h.onOwner(function* (draft) {
					(yield* shelf(draft)).Rows.push(JSON.parse(JSON.stringify(draft.Rows[0])));
				})
			).rejects.toThrow(EntityReplacedError);
			await expect(
				h.onOwner(function* (draft) {
					draft.Held = JSON.parse(JSON.stringify(yield* shelf(draft)));
				})
			).resolves.toBeUndefined();
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Item = minted("in-slot");
			});
			await expect(
				h.onOwner(function* (draft) {
					draft.Rows.push(JSON.parse(JSON.stringify((yield* shelf(draft)).Item)));
				})
			).rejects.toThrow(EntityReplacedError);
		});

		it("takes a copy under a new $Id, and reuses an $Id whose first lifetime has ended", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Item = minted("copied", JSON.parse(JSON.stringify(draft.Rows[0])));
			});
			expect(h.runtime.get("runtime/stateIdLookup")()["~copied"].path).toEqual([
				"root",
				"owner",
				"~copied"
			]);
			const row = minted("reused", {
				Name: "row"
			});
			await h.onOwner(function* (draft) {
				draft.Rows = [
					row
				];
			});
			await h.onOwner(function* (draft) {
				draft.Rows = [];
			});
			await h.onOwner(function* (draft) {
				(yield* shelf(draft)).Rows.push({
					...row
				});
			});
			expect(h.runtime.get("runtime/stateIdLookup")()["~reused"].path).toEqual([
				"root",
				"owner",
				"~reused"
			]);
		});

		it("refuses no shape a slot legitimately holds: nested entities, edits, splices, sorts, and a move within the slot", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				const slot = yield* shelf(draft);
				yield* other(draft);
				slot.Rows.push(
					minted("a", {
						State: minted("a-state", {
							Inner: minted("a-inner")
						})
					}),
					minted("b"),
					minted("c")
				);
				yield {
					Type: "echo"
				};
				(slot.Rows[0] as unknown as Record<string, Record<string, unknown>>).State.Text = "edited";
				(slot.Rows[1] as unknown as Record<string, unknown>).Text = "written";
				slot.Rows.splice(1, 1);
				slot.Rows.reverse();
				slot.Item = slot.Rows.pop() as IEntity;
				yield {
					Type: "echo"
				};
				const moved = slot.Item;
				slot.Item = null;
				slot.Note = moved;
			});
			const lookup = h.runtime.get("runtime/stateIdLookup")();
			expect(lookup["~a-inner"].path).toEqual([
				"root",
				"owner",
				"~a",
				"~a-state",
				"~a-inner"
			]);
			expect(lookup["~b"]).toBeUndefined();
			expect(h.errors).toEqual([]);
		});
	});

	describe(`slots ${build_}: views`, () => {
		it("wakes a reader on the first write and on each one after, and goes back to empty with the owner", async () => {
			const h = build();
			await createRoot(async (dispose) => {
				const count = createMemo(() => peek(h.runtime, progress, h.runtime.get("runtime/stateIdLookup")().owner?.state as IOwner).Running);
				expect(count()).toBe(0);
				await h.onOwner(function* (draft) {
					(yield* progress(draft)).Running = 1;
				});
				expect(count()).toBe(1);
				await h.onOwner(function* (draft) {
					(yield* progress(draft)).Running = 2;
				});
				expect(count()).toBe(2);
				dispose();
			});
			const seen: number[] = [];
			await createRoot(async (dispose) => {
				const held = h.owner();
				const count = createMemo(() => {
					const value = peek(h.runtime, progress, held).Running;
					seen.push(value);
					return value;
				});
				count();
				await h.run(remove);
				expect(count()).toBe(0);
				dispose();
			});
			expect(seen).toEqual([
				2,
				0
			]);
		});

		it("does not wake a reader of one slot when another slot on the owner is first written or changes", async () => {
			const h = build();
			await createRoot(async (dispose) => {
				let runs = 0;
				const count = createMemo(() => {
					runs++;
					return peek(h.runtime, progress, h.owner()).Running;
				});
				count();
				await h.onOwner(function* (draft) {
					(yield* other(draft)).Running = 1;
				});
				await h.onOwner(function* (draft) {
					(yield* other(draft)).Running = 2;
				});
				count();
				expect(runs).toBe(1);
				dispose();
			});
		});

		it("does not wake a reader when a draft only reads", async () => {
			const h = build();
			await createRoot(async (dispose) => {
				let runs = 0;
				const count = createMemo(() => {
					runs++;
					return peek(h.runtime, progress, h.owner()).Running;
				});
				count();
				await h.onOwner(function* (draft) {
					return (yield* progress(draft)).Running;
				});
				count();
				expect(runs).toBe(1);
				dispose();
			});
		});

		it("re-derives a memoized selector, and answers an action-side read of it", async () => {
			const h = build();
			function* count(draft: IOwner): ISelectorGenerator<number> {
				return (yield* progress(draft)).Running;
			}
			const read = () => h.runtime.runSelector(count, h.owner);
			await createRoot(async (dispose) => {
				const value = createMemo(read);
				expect(value()).toBe(0);
				await h.onOwner(function* (draft) {
					(yield* progress(draft)).Running = 7;
				});
				expect(value()).toBe(7);
				dispose();
			});
			await expect(
				h.onOwner(function* () {
					return yield* select(count);
				})
			).resolves.toBe(7);
		});

		it("reads an array slot's rows through a view, as read-only views of the rows", async () => {
			const h = build();
			await h.onOwner(function* (draft) {
				yield* start(function* (d: IOwner): IActionGenerator {
					(yield* shelf(d)).Rows.push(minted("started"));
				}, draft.$Id);
			});
			await settle();
			const row = peek(h.runtime, shelf, h.owner()).Rows[0];
			expect(row.$Id).toBe("~started");
			expect(() => {
				row.$Id = "changed";
			}).toThrow("read-only");
		});

		it("returns the frozen default from a selector while unborn, wakes it on the birth, and then returns a view that reacts", async () => {
			const h = build();
			function* whole(draft: IOwner): ISelectorGenerator<{
				Running: number;
			}> {
				return yield* progress(draft);
			}
			await createRoot(async (dispose) => {
				let runs = 0;
				const slot = createMemo(() => {
					runs++;
					return h.runtime.runSelector(whole, h.owner);
				});
				const unborn = slot();
				expect(Object.isFrozen(unborn)).toBe(true);
				expect(unborn.Running).toBe(0);
				await h.onOwner(function* (draft) {
					yield* other(draft);
					yield* progress(draft);
				});
				expect(slot()).toBe(unborn);
				expect(runs).toBe(1);
				await h.onOwner(function* (draft) {
					(yield* progress(draft)).Running = 1;
				});
				const born = slot();
				expect(born).not.toBe(unborn);
				expect(born.Running).toBe(1);
				expect(rawOf(born)).not.toBe(born);
				const seen = createMemo(() => born.Running);
				expect(seen()).toBe(1);
				await h.onOwner(function* (draft) {
					(yield* progress(draft)).Running = 2;
				});
				expect(seen()).toBe(2);
				expect(slot()).toBe(born);
				dispose();
			});
		});

		it("gives a selector its read after a removal and a re-add through the same memo", async () => {
			const h = build();
			function* count(draft: IOwner): ISelectorGenerator<number> {
				return (yield* progress(draft)).Running;
			}
			await h.onOwner(function* (draft) {
				(yield* progress(draft)).Running = 3;
			});
			await createRoot(async (dispose) => {
				const value = createMemo(() =>
					h.runtime.processSelector(count, () => h.runtime.get("runtime/stateIdLookup")().owner?.state as IOwner | undefined)
				);
				expect(value()).toBe(3);
				dispose();
			});
			await h.run(remove);
			await h.run(readd);
			expect(h.runtime.runSelector(count, h.owner)).toBe(0);
		});

		it("answers a selector over a view from inside an action, frozen as select's result is", async () => {
			const h = build();
			function* whole(draft: IOwner): ISelectorGenerator<{
				Running: number;
			}> {
				return yield* progress(draft);
			}
			const seen = (await h.onOwner(function* () {
				return yield* select(whole);
			}))!;
			expect(Object.isFrozen(seen)).toBe(true);
			expect(seen.Running).toBe(0);
		});

		it("reads, unwritable, when an action hands it a view rather than its draft", async () => {
			const h = build();
			await expect(
				h.run(function* () {
					const s = yield* progress(h.owner());
					expect(s.Running).toBe(0);
					s.Running = 1;
				})
			).rejects.toThrow(/read.only/);
		});

		it("holds what an action wrote through a helper handed a child's draft", async () => {
			const h = build();
			function* countOn(draft: IEntity): IActionGenerator {
				(yield* progress(draft)).Running++;
			}
			await h.run(function* (draft) {
				yield* countOn(draft.Left[0]);
				yield* countOn(draft);
				yield* countOn(draft);
			});
			expect(peek(h.runtime, progress, h.owner()).Running).toBe(1);
			expect(peek(h.runtime, progress, h.runtime.state).Running).toBe(2);
		});
	});
}
