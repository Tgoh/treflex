import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IAction, IActionGenerator } from "../../src/Types/IAction";
import type { IEntity, IEntityId } from "../../src/Types/IEntity";
import { describe, expect, expectTypeOf, it } from "vitest";
import { entity, idOf, withoutIds } from "../../src/Effects/entity";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { EntityReplacedError, HandWrittenIdError } from "../../src/Runtime/draftNode";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { transient } from "../../src/Runtime/transient";
import { copyComponentSeed } from "../../src/Runtime/viewProxy";
import { SNAPSHOT_FORMAT_VERSION } from "../../src/Snapshot/ISnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";
import { createTestRuntime, guids } from "../../src/Testing/createTestRuntime";

interface IRow {
	$Id: string;
	Name: string;
}

interface IWorld {
	$Id: string;
	Rows: IRow[];
	Slot: unknown;
}

const seed = (): IWorld => ({
	$Id: "root",
	Rows: [
		{
			$Id: "row-1",
			Name: "one"
		}
	],
	Slot: null
});

function build(allowFailures?: readonly IAction<any, any, any>[]) {
	const runtime = createTestRuntime<IWorld>(
		seed(),
		{
			generateGuid: guids("m")
		},
		{
			allowFailures
		}
	);
	return {
		runtime,
		run: <R>(action: (draft: IWorld) => IActionGenerator<R>): Promise<R | undefined> => runtime.dispatch(action, "root")
	};
}

export function handWrittenIdRules(build_: string): void {
	describe(`a hand-written $Id ${build_}`, () => {
		it.each<
			[
				string,
				(draft: any) => void
			]
		>([
			[
				"assigned",
				(draft) => {
					draft.Slot = {
						$Id: "typed"
					};
				}
			],
			[
				"pushed",
				(draft) => {
					draft.Rows.push({
						$Id: "typed"
					});
				}
			],
			[
				"nested in a plain value",
				(draft) => {
					draft.Slot = {
						Deep: [
							{
								$Id: "typed"
							}
						]
					};
				}
			],
			[
				"written through Object.assign",
				(draft) => {
					Object.assign(draft.Rows[0], {
						Kid: {
							$Id: "typed"
						}
					});
				}
			],
			[
				"empty",
				(draft) => {
					draft.Slot = {
						$Id: ""
					};
				}
			],
			[
				"not a string",
				(draft) => {
					draft.Slot = {
						$Id: 7
					};
				}
			]
		])("is refused %s, ahead of the write", async (_way, write) => {
			function* writes(draft: IWorld): IActionGenerator {
				write(draft);
			}
			const { runtime, run } = build([
				writes
			]);
			await expect(run(writes)).rejects.toThrow(HandWrittenIdError);
			expect(runtime.state).toEqual(seed());
		});

		it("says what to do, and carries the id", async () => {
			function* writesTyped(draft: IWorld): IActionGenerator {
				draft.Slot = {
					$Id: "typed"
				};
			}
			const { run } = build([
				writesTyped
			]);
			const thrown = await run(writesTyped).catch((error) => error);
			expect(thrown).toBeInstanceOf(HandWrittenIdError);
			expect(thrown.name).toBe("HandWrittenIdError");
			expect(thrown.id).toBe("typed");
			expect(thrown.message).toContain("entity(");
			expect(thrown.message).toContain("createRuntime seed");
		});

		it("is taken from entity(), through a spread and a JSON copy", async () => {
			const { runtime, run } = build();
			const made = await run(function* (draft) {
				const row = yield* entity({
					Name: "made"
				});
				draft.Rows.push({
					...row,
					Name: "spread"
				});
				return idOf(row);
			});
			expect(made).toBe("~m-1");
			expect(runtime.state.Rows[1]).toEqual({
				$Id: "~m-1",
				Name: "spread"
			});
			function* writeRow(draft: IWorld, row: IRow): IActionGenerator {
				draft.Slot = row;
			}
			await run(function* (draft) {
				const row = yield* entity({
					Name: "argued"
				});
				yield* writeRow(draft, JSON.parse(JSON.stringify(row)));
			});
			expect(runtime.state.Slot).toEqual({
				$Id: "~m-2",
				Name: "argued"
			});
		});

		it("is taken from the seed, and a move of a seed's node stays legal, within a step and across a mint", async () => {
			const { runtime, run } = build();
			const node = runtime.state.Rows[0];
			await run(function* (draft) {
				const [row] = draft.Rows.splice(0, 1);
				draft.Slot = row;
			});
			expect(runtime.state.Slot).toBe(node);

			await run(function* (draft) {
				const held = draft.Slot as IRow;
				draft.Slot = null;
				yield* entity({});
				draft.Rows.push(held);
			});
			expect(runtime.state.Rows[0]).toEqual({
				$Id: "row-1",
				Name: "one"
			});
		});

		it("gives a copy of a seed's row the same-$Id refusal while the row stands, and the hand-written one once it's gone", async () => {
			let copy!: IRow;
			function* pushesACopy(draft: IWorld): IActionGenerator {
				copy = {
					...draft.Rows[0]
				};
				draft.Rows.push(copy);
			}
			function* pushesTheCopyAgain(draft: IWorld): IActionGenerator {
				draft.Rows.push(copy);
			}
			const { run } = build([
				pushesACopy,
				pushesTheCopyAgain
			]);
			await expect(run(pushesACopy)).rejects.toThrow(EntityReplacedError);
			await run(function* (draft) {
				draft.Rows.splice(0, 1);
			});
			await expect(run(pushesTheCopyAgain)).rejects.toThrow(HandWrittenIdError);
		});

		it("is refused from reconcileRows' add before anything moves", async () => {
			function* addsTyped(draft: IWorld): IActionGenerator {
				yield* reconcileRows(
					draft.Rows,
					[
						{
							Name: "new"
						}
					],
					(row) => row.Name,
					{
						add: (item) => ({
							$Id: "typed",
							Name: item.Name
						}),
						update: () => {}
					}
				);
			}
			const { runtime, run } = build([
				addsTyped
			]);
			await expect(run(addsTyped)).rejects.toThrow(HandWrittenIdError);
			expect(runtime.state).toEqual(seed());
		});

		it("is refused in a transient, like the tree", async () => {
			const shelf = (owner: IRow) =>
				transient(owner, "Test/Shelf", {
					Rows: [] as unknown[]
				});
			function* shelvesTyped(draft: IWorld): IActionGenerator {
				(yield* shelf(draft.Rows[0])).Rows.push({
					$Id: "typed"
				});
			}
			const { run } = build([
				shelvesTyped
			]);
			await expect(run(shelvesTyped)).rejects.toThrow(HandWrittenIdError);
		});

		it("is refused in a transient default at any depth, minted or not, since each owner's copy would share it", async () => {
			let held: object = {};
			function* defaultsHeld(draft: IWorld): IActionGenerator {
				yield* transient(draft.Rows[0], "Test/Defaulted", {
					Deep: [
						held
					]
				});
			}
			const { run } = build([
				defaultsHeld
			]);
			for (const value of [
				{
					$Id: "typed"
				},
				{
					$Id: "~minted"
				}
			]) {
				held = value;
				await expect(run(defaultsHeld)).rejects.toThrow(HandWrittenIdError);
			}
		});
	});

	describe(`an $Id in place ${build_}`, () => {
		it.each<
			[
				string,
				(draft: any) => void
			]
		>([
			[
				"overwritten",
				(draft) => {
					draft.Rows[0].$Id = "other";
				}
			],
			[
				"overwritten by a minted one",
				(draft) => {
					draft.Rows[0].$Id = "~other";
				}
			],
			[
				"set to undefined",
				(draft) => {
					draft.Rows[0].$Id = undefined;
				}
			],
			[
				"deleted",
				(draft) => {
					delete draft.Rows[0].$Id;
				}
			],
			[
				"given to a plain node",
				(draft) => {
					draft.Plain = {};
					draft.Plain.$Id = "~other";
				}
			]
		])("is refused %s", async (_way, write) => {
			function* writes(draft: IWorld): IActionGenerator {
				write(draft);
			}
			const { runtime, run } = build([
				writes
			]);
			await expect(run(writes)).rejects.toThrow(HandWrittenIdError);
			expect(runtime.state.Rows[0].$Id).toBe("row-1");
		});

		it("takes writing the $Id it already has, which changes nothing", async () => {
			const { runtime, run } = build();
			await run(function* (draft) {
				draft.Rows[0].$Id = "row-1";
			});
			expect(runtime.state).toEqual(seed());
		});
	});

	describe(`a restore ${build_}`, () => {
		it("loads hand-written and minted ids alike, and a later draft write keeps its refusal", async () => {
			const { runtime } = await restoreRuntime<IWorld>(
				JSON.stringify({
					Version: SNAPSHOT_FORMAT_VERSION,
					AppState: {
						$Id: "root",
						Rows: [
							{
								$Id: "saved",
								Name: "plain id"
							},
							{
								$Id: "~saved",
								Name: "minted id"
							}
						],
						Slot: null
					},
					DataSources: [],
					Timers: [],
					InFlight: []
				}),
				{
					rootId: "root",
					options: {}
				}
			);
			expect(runtime.state.Rows.map((row) => row.$Id)).toEqual([
				"saved",
				"~saved"
			]);
			await expect(
				runtime.dispatch(function* (draft: IWorld): IActionGenerator {
					draft.Slot = {
						$Id: "typed"
					};
				}, "root")
			).rejects.toThrow(HandWrittenIdError);
			runtime.dispose();
		});
	});

	describe(`a seed ${build_}`, () => {
		it("keeps plain ids", () => {
			const runtime = createRuntime<any>({
				$Id: "root",
				Kid: {
					$Id: "kid"
				}
			}) as IRuntimeInternal<any>;
			expect(runtime.get("runtime/stateIdLookup")().kid).toBeDefined();
			runtime.dispose();
		});

		it.each([
			{
				name: "an empty $Id",
				seed: {
					$Id: "root",
					Empty: {
						$Id: ""
					}
				},
				message: /holds an empty \$Id at \[Empty\]/
			},
			{
				name: "a $Id that is not a string",
				seed: {
					$Id: "root",
					Kid: {
						$Id: 0
					}
				},
				message: /holds a \$Id of type "number" at \[Kid\]/
			},
			{
				name: "a duplicate $Id",
				seed: {
					$Id: "root",
					A: {
						$Id: "kid"
					},
					B: [
						{
							$Id: "kid"
						}
					]
				},
				message: /holds the \$Id "kid" at \[A\] and \[B\.0\]/
			},
			{
				name: "one entity at two keys",
				seed: (() => {
					const kid = {
						$Id: "kid"
					};
					return {
						$Id: "root",
						A: kid,
						B: kid
					};
				})(),
				message: /holds the \$Id "kid" at \[A\] and \[B\]/
			}
		])("refuses $name as a construction error, before any index is built", ({ seed, message }) => {
			expect(() => createRuntime<any>(seed)).toThrow(message);
		});
	});

	describe(`a component state factory's result ${build_}`, () => {
		const local = (seedValue: unknown) => copyComponentSeed(seedValue, "~stamped", "useComponentState");

		it("is stamped with the root's $Id, and left to itself otherwise", () => {
			expect(
				local({
					Count: 0
				})
			).toEqual({
				$Id: "~stamped",
				Count: 0
			});
		});

		it.each([
			[
				"at the root",
				{
					$Id: "typed"
				}
			],
			[
				"nested",
				{
					Kid: {
						Rows: [
							{
								$Id: "typed"
							}
						]
					}
				}
			],
			[
				"minted",
				{
					$Id: "~minted"
				}
			]
		])("is refused holding an $Id %s", (_where, value) => {
			expect(() => local(value)).toThrow(HandWrittenIdError);
			expect(() => local(value)).toThrow(/withoutIds/);
		});

		it("refuses an array, which can't take the root's $Id", () => {
			expect(() => local([])).toThrow(TypeError);
		});
	});

	describe(`withoutIds ${build_}`, () => {
		it("keeps a branded field, a tuple's shape and an optional in its type", () => {
			type IRowWithIds = {
				$Id: string;
				SelectedId: IEntityId;
				Pair: [
					IEntity,
					string
				];
				Note?: string;
				Kids: IEntity[];
			};
			const fields = () => withoutIds({} as IRowWithIds);
			expectTypeOf<ReturnType<typeof fields>>().toEqualTypeOf<{
				SelectedId: IEntityId;
				Pair: [
					{},
					string
				];
				Note?: string;
				Kids: {}[];
			}>();
		});

		it("drops every $Id at any depth, from a copy, and leaves the value alone", () => {
			const row = {
				$Id: "a",
				Name: "n",
				Kids: [
					{
						$Id: "b",
						Tags: [
							{
								$Id: "c",
								V: 1
							}
						]
					}
				]
			};
			const before = JSON.stringify(row);
			const fields = withoutIds(row);
			expect(fields).toEqual({
				Name: "n",
				Kids: [
					{
						Tags: [
							{
								V: 1
							}
						]
					}
				]
			});
			expect(JSON.stringify(row)).toBe(before);
			expect(Object.isFrozen(fields)).toBe(false);
		});

		it("makes a value a draft takes, with the row's address kept as data, and an edit writes back", async () => {
			const { runtime, run } = build();
			await run(function* (draft) {
				draft.Slot = {
					...withoutIds(draft.Rows[0]),
					RowId: idOf(draft.Rows[0])
				};
			});
			expect(runtime.state.Slot).toEqual({
				Name: "one",
				RowId: "row-1"
			});
			function* save(draft: IRow, name: string): IActionGenerator {
				draft.Name = name;
			}
			await runtime.dispatch(
				save,
				(
					runtime.state.Slot as {
						RowId: string;
					}
				).RowId,
				"edited"
			);
			expect(runtime.state.Rows[0].Name).toBe("edited");
		});
	});
}
