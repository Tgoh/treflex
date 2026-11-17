import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IAskId } from "../../src/Types/IAskId";
import type { IEffect } from "../../src/Types/IEffect";
import { describe, expect, it, vi } from "vitest";
import { answer } from "../../src/Effects/answer";
import { ask } from "../../src/Effects/ask";
import { defineEffect } from "../../src/Effects/defineEffect";
import { parallel } from "../../src/Effects/parallel";
import { parallelSettled } from "../../src/Effects/parallelSettled";
import { publish } from "../../src/Effects/publish";
import { start } from "../../src/Effects/start";
import { select } from "../../src/Reads/select";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { EntityReplacedError } from "../../src/Runtime/draftNode";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { open } from "../../src/Runtime/open";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { StateAliasError } from "../../src/Runtime/stateAlias";
import { rawOf } from "../../src/Runtime/viewProxy";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { captureSurfaced, minted, pendingAsksOf, rootSetState } from "../testHelpers";

interface IWorld {
	$Id: string;
	N: number;
	Src: {
		V: {
			W: number;
		};
	};
	A?: unknown;
	B?: unknown;
	Slot?: unknown;
	Asks: unknown[];
	Other: {
		$Id: string;
		N: number;
	};
}

interface IProbeEffect extends IEffect {
	Type: "rules/probe";
	Input?: unknown;
}
const probe = defineEffect<IProbeEffect, unknown>("rules/probe");

const publishAny = publish as unknown as (topic: string, data: object) => Generator<any, void, any>;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

export function stateRules(build: string): void {
	describe.each([
		{
			tap: false
		},
		{
			tap: true
		}
	])(`the state rules, ${build}, with a tap: $tap`, ({ tap }) => {
		function world() {
			const errors: unknown[] = [];
			const runtime = createRuntime<IWorld>(
				{
					$Id: "root",
					N: 0,
					Src: {
						V: {
							W: 1
						}
					},
					Asks: [],
					Other: {
						$Id: "other",
						N: 0
					}
				},
				{
					onError: (error) => errors.push(error),
					implementations: {
						"rules/probe": () => settle()
					}
				}
			) as IRuntimeInternal<IWorld>;
			if (tap) {
				runtime.on("record", () => {});
			}
			return {
				runtime,
				errors
			};
		}

		it.each([
			[
				"Date",
				() => new Date(0)
			],
			[
				"NaN",
				() => Number.NaN
			],
			[
				"undefined array element",
				() => [
					undefined
				]
			]
		])("refuses a non-plain write: %s", async (kind, value) => {
			const { runtime } = world();
			function* write(draft: IWorld): IActionGenerator {
				draft.Slot = value();
			}
			const refusal = runtime.dispatch(write, "root");
			await expect(refusal).rejects.toThrow(NonPlainDataError);
			await expect(refusal).rejects.toThrow(`a write to state is not plain: ${kind} at [Slot`);
			expect(runtime.state.Slot).toBeUndefined();
		});

		it("refuses a code write", async () => {
			const { runtime } = world();
			function* write(draft: IWorld): IActionGenerator {
				draft.Slot = () => {};
			}
			const refusal = runtime.dispatch(write, "root");
			await expect(refusal).rejects.toThrow(NonPlainDataError);
			await expect(refusal).rejects.toThrow("a write to state is not plain: function at [Slot]");
			expect(runtime.state.Slot).toBeUndefined();
		});

		it("refuses a view write", () => {
			const { runtime } = world();
			expect(() => {
				runtime.state.N = 1;
			}).toThrow(/read-only outside a dispatch/);
			expect(runtime.state.N).toBe(0);
		});

		it("refuses a direct setState write with no action open", () => {
			const { runtime } = world();
			expect(() =>
				rootSetState(runtime)((s) => {
					s.N = 1;
				})
			).toThrow(/state mutations belong to actions/);
			expect(runtime.state.N).toBe(0);
		});

		it("lets setState hand over a node with no action open", async () => {
			const { runtime, errors } = world();
			const setState = rootSetState(runtime);
			let node: unknown;
			setState((s) => {
				node = s;
			});
			expect(node).toBeDefined();
			function* setField(draft: IWorld, value: number): IActionGenerator {
				draft.N = value;
			}
			await runtime.processAction(
				setField,
				() => runtime.state,
				setState,
				() => "root",
				7
			);
			expect(errors).toEqual([]);
			expect(runtime.state.N).toBe(7);
		});

		describe("a write through a held draft", () => {
			it("is refused with no step open: after the action, in a timer and in a promise callback", async () => {
				const { runtime } = world();
				let held!: IWorld;
				const outcomes: Promise<unknown>[] = [];
				const attempt = (resolve: (value: unknown) => void) => {
					try {
						held.N = 1;
						resolve("landed");
					} catch (error) {
						resolve(String(error));
					}
				};
				function* holds(draft: IWorld): IActionGenerator {
					held = draft;
					outcomes.push(new Promise((resolve) => setTimeout(() => attempt(resolve), 0)));
					outcomes.push(new Promise((resolve) => Promise.resolve().then(() => attempt(resolve))));
					yield* probe({});
				}
				await runtime.dispatch(holds, "root");
				outcomes.push(new Promise(attempt));
				for (const outcome of await Promise.all(outcomes)) {
					expect(outcome).toMatch(/state mutations belong to actions/);
				}
				expect(runtime.state.N).toBe(0);
			});

			it("is refused in another action's step", async () => {
				const { runtime, errors } = world();
				let held!: IWorld;
				function* holds(draft: IWorld): IActionGenerator {
					held = draft;
				}
				await runtime.dispatch(holds, "root");
				function* intruder(): IActionGenerator {
					held.N = 1;
				}
				await expect(runtime.dispatch(intruder, "other")).rejects.toThrow(/state mutations belong to actions/);
				expect(errors).toHaveLength(1);
				expect(runtime.state.N).toBe(0);
			});

			it("is refused from a function given to start", async () => {
				const { runtime, errors } = world();
				function* starts(draft: IWorld): IActionGenerator {
					yield* start(function* (): IActionGenerator {
						draft.N = 1;
					}, "other");
				}
				await runtime.dispatch(starts, "root");
				await settle();
				expect(errors.map(String)).toEqual([
					expect.stringContaining("state mutations belong to actions")
				]);
				expect(runtime.state.N).toBe(0);
			});

			it("is refused from an action dispatched synchronously in a step", async () => {
				const { runtime, errors } = world();
				function* outer(draft: IWorld): IActionGenerator {
					void runtime
						.dispatch(function* inner(): IActionGenerator {
							draft.N = 1;
						}, "other")
						.catch(() => {});
				}
				await runtime.dispatch(outer, "root");
				expect(errors).toHaveLength(1);
				expect(runtime.state.N).toBe(0);
			});

			it("lands from the action's own parallel and parallelSettled branches", async () => {
				const { runtime } = world();
				function* branches(draft: IWorld): IActionGenerator {
					yield* parallel(
						(function* (): IActionGenerator {
							draft.N = 1;
							yield* probe({});
							draft.A = 1;
						})()
					);
					yield* parallelSettled(
						(function* (): IActionGenerator {
							draft.B = 1;
						})()
					);
				}
				await runtime.dispatch(branches, "root");
				expect(runtime.state.N).toBe(1);
				expect(runtime.state.A).toBe(1);
				expect(runtime.state.B).toBe(1);
			});
		});

		it("is silent on one select written to two slots, each slot with its own copy", async () => {
			const surfaced = captureSurfaced();
			const { runtime, errors } = world();
			function* source(s: IWorld): Generator<any, IWorld["Src"], any> {
				return s.Src;
			}
			function* twice(draft: IWorld): IActionGenerator {
				const s = yield* select(source);
				draft.A = s;
				draft.B = s;
			}
			await runtime.dispatch(twice, "root");
			await settle();
			expect(errors).toEqual([]);
			expect(surfaced).toEqual([]);
			expect(rawOf(runtime.state.A)).not.toBe(rawOf(runtime.state.B));
			expect(runtime.state.A).toEqual({
				V: {
					W: 1
				}
			});
		});

		it("freezes a select result and leaves an effect result writable", async () => {
			const { runtime } = world();
			runtime.registerImplementation("rules/value", () => ({
				V: 1
			}));
			function* source(s: IWorld): Generator<any, IWorld["Src"], any> {
				return s.Src;
			}
			let selected: unknown;
			let result: unknown;
			function* reads(): IActionGenerator {
				selected = yield* select(source);
				result = yield {
					Type: "rules/value"
				};
			}
			await runtime.dispatch(reads, "root");
			expect(Object.isFrozen(selected)).toBe(true);
			expect(Object.isFrozen(result)).toBe(false);
		});

		it("lists in-flight work in a snapshot, and none once it settles", async () => {
			const { runtime } = world();
			function* parked(): IActionGenerator {
				yield* probe({});
			}
			const first = runtime.dispatch(parked, "other");
			const second = runtime.dispatch(function* (): IActionGenerator {
				yield* probe({});
			}, "root");
			const during = JSON.parse(createSnapshot(runtime)).InFlight;
			expect(
				during.map((entry: any) => [
					entry.Label,
					entry.EntityId
				])
			).toEqual([
				[
					"parked",
					"other"
				],
				[
					null,
					"root"
				]
			]);
			await Promise.all([
				first,
				second
			]);
			expect(JSON.parse(createSnapshot(runtime)).InFlight).toEqual([]);
		});

		describe("a function", () => {
			it("is refused in an argument, an effect input and a publish payload", async () => {
				const { runtime } = world();
				function* take(_draft: IWorld, _arg: unknown): IActionGenerator {}
				await expect(
					runtime.dispatch(take, "root", {
						Call: () => {}
					})
				).rejects.toThrow(NonPlainDataError);
				function* input(): IActionGenerator {
					yield* probe({
						Input: () => {}
					});
				}
				await expect(runtime.dispatch(input, "root")).rejects.toThrow(NonPlainDataError);
				function* payload(): IActionGenerator {
					yield* publishAny("Rules/Topic", {
						Call: () => {}
					});
				}
				await expect(runtime.dispatch(payload, "root")).rejects.toThrow(NonPlainDataError);
			});

			it("still reaches start's Action, parallel, parallelSettled, ask and select", async () => {
				const { runtime, errors } = world();
				const reached: unknown[] = [];
				function* source(s: IWorld): Generator<any, number, any> {
					return s.N;
				}
				function* branch(value: string): IActionGenerator<string> {
					return value;
				}
				function* uses(draft: IWorld) {
					yield* start(function* started(): IActionGenerator {
						reached.push("start");
					}, "other");
					reached.push(...(yield* parallel(branch("parallel"))));
					reached.push((yield* select(source)) === 0 ? "select" : "wrong");
					const [settledBranch] = yield* parallelSettled(branch("settled"));
					reached.push(settledBranch.ok ? settledBranch.value : "failed");
					reached.push(
						yield* open(
							ask<string>(draft.Other, {
								Path: "Rules"
							})
						)
					);
				}
				const inFlight = runtime.dispatch(uses, "root");
				while (pendingAsksOf(runtime, runtime.state).length === 0) {
					await settle();
				}
				const id = pendingAsksOf(runtime, runtime.state)[0]!.Id as IAskId<string>;
				function* answers(): IActionGenerator {
					yield* answer(id, "ask");
				}
				await runtime.dispatch(answers, "other");
				await inFlight;
				expect(errors).toEqual([]);
				expect(reached).toEqual(
					expect.arrayContaining([
						"start",
						"parallel",
						"select",
						"settled",
						"ask"
					])
				);
			});
		});

		describe("writing a plain value", () => {
			const caller = (): any => ({
				Rows: [
					2,
					1
				],
				Nested: {
					V: 1
				}
			});
			const expected = {
				Rows: [
					2,
					1
				],
				Nested: {
					V: 1
				}
			};
			const ways: {
				way: string;
				land: (draft: any, value: object) => void;
				read: (state: any) => object;
			}[] = [
				{
					way: "an assign",
					land: (draft, value) => {
						draft.A = value;
					},
					read: (state) => state.A
				},
				{
					way: "a push",
					land: (draft, value) => {
						draft.Asks.push(value);
					},
					read: (state) => state.Asks[0]
				},
				{
					way: "a splice",
					land: (draft, value) => {
						draft.Asks.splice(0, 0, value);
					},
					read: (state) => state.Asks[0]
				},
				{
					way: "Object.assign",
					land: (draft, value) => {
						Object.assign(draft, {
							A: value
						});
					},
					read: (state) => state.A
				},
				{
					way: "Object.defineProperty",
					land: (draft, value) => {
						Object.defineProperty(draft, "A", {
							value,
							writable: true,
							enumerable: true,
							configurable: true
						});
					},
					read: (state) => state.A
				}
			];
			async function landed(land: (draft: any, value: object) => void, value: object): Promise<IRuntimeInternal<IWorld>> {
				const { runtime } = world();
				function* write(draft: IWorld): IActionGenerator {
					land(draft, value);
				}
				await runtime.dispatch(write, "root");
				return runtime;
			}
			const expectCallerClosed = (value: any) => {
				expect(() => {
					value.Total = 1;
				}).toThrow(TypeError);
				expect(() => value.Rows.push(3)).toThrow(TypeError);
				expect(() => value.Rows.sort()).toThrow(TypeError);
				expect(() => {
					value.Nested.V = 2;
				}).toThrow(TypeError);
				expect(value).toEqual(expected);
			};

			it.each(ways)("through $way lands a copy, and an edit, a push and a sort on the caller's object throw", async ({ land, read }) => {
				const value = caller();
				const runtime = await landed(land, value);
				expect(rawOf(read(runtime.state))).not.toBe(value);
				expectCallerClosed(value);
				expect(read(runtime.state)).toEqual(expected);
				expect(Object.isFrozen(rawOf(read(runtime.state)))).toBe(false);
			});

			it("through a seed lands a copy, and an edit, a push and a sort on the caller's object throw", () => {
				const value = caller();
				const runtime = createRuntime<any>({
					$Id: "root",
					A: value
				});
				expect(rawOf(runtime.state).A).not.toBe(value);
				expectCallerClosed(value);
				expect(runtime.state.A).toEqual(expected);
			});

			it("takes an edit made before the write", async () => {
				const value = caller();
				value.Total = 1;
				const runtime = await landed((draft, v) => {
					draft.A = v;
				}, value);
				expect(runtime.state.A).toEqual({
					...expected,
					Total: 1
				});
			});

			it("changes through the draft after the write", async () => {
				const runtime = await landed((draft, value) => {
					draft.A = value;
					draft.A.Total = 1;
					draft.A.Rows.sort();
				}, caller());
				expect(runtime.state.A).toEqual({
					...expected,
					Rows: [
						1,
						2
					],
					Total: 1
				});
			});

			it.each(ways)("refused through $way leaves the caller's object as it was", async ({ land }) => {
				const value = {
					Ok: {
						V: 1
					},
					List: [
						1
					],
					Bad: new Date(0)
				};
				const { runtime } = world();
				function* write(draft: IWorld): IActionGenerator {
					land(draft, value);
				}
				await expect(runtime.dispatch(write, "root")).rejects.toThrow(/not plain: Date at/);
				expect(Object.isFrozen(value)).toBe(false);
				expect(Object.isFrozen(value.Ok)).toBe(false);
				expect(Object.isFrozen(value.List)).toBe(false);
				expect(runtime.state.A).toBeUndefined();
			});

			describe("refused at the write, not for the value", () => {
				const value = () => ({
					Nested: {
						V: 1
					}
				});
				const expectUnfrozen = (written: { Nested: object }) => {
					expect(Object.isFrozen(written)).toBe(false);
					expect(Object.isFrozen(written.Nested)).toBe(false);
				};
				async function heldDraft(runtime: IRuntimeInternal<IWorld>): Promise<IWorld> {
					let held!: IWorld;
					function* holds(draft: IWorld): IActionGenerator {
						held = draft;
					}
					await runtime.dispatch(holds, "root");
					return held;
				}

				it("through a held draft after its action", async () => {
					const { runtime } = world();
					const held = await heldDraft(runtime);
					const written = value();
					expect(() => {
						held.A = written;
					}).toThrow(/state mutations belong to actions/);
					expectUnfrozen(written);
				});

				it("for a value carrying an $Id that is live elsewhere", async () => {
					const { runtime } = world();
					const written = {
						...value(),
						$Id: "other"
					};
					function* write(draft: IWorld): IActionGenerator {
						draft.A = written;
					}
					await expect(runtime.dispatch(write, "root")).rejects.toThrow(EntityReplacedError);
					expectUnfrozen(written);
				});

				it("as an array's length", async () => {
					const { runtime } = world();
					const written = value();
					function* write(draft: IWorld): IActionGenerator {
						(draft.Asks as any).length = written;
					}
					await expect(runtime.dispatch(write, "root")).rejects.toThrow(RangeError);
					expectUnfrozen(written);
				});

				it("by the engine, at a slot that can't be written", async () => {
					const { runtime } = world();
					Object.defineProperty(rawOf(runtime.state), "A", {
						value: 1,
						writable: false,
						enumerable: true,
						configurable: true
					});
					const written = value();
					function* write(draft: IWorld): IActionGenerator {
						draft.A = written;
					}
					await expect(runtime.dispatch(write, "root")).rejects.toThrow(TypeError);
					expectUnfrozen(written);
				});
			});

			it("in a seed, copies a proxy rather than keeping its node, and leaves that node's tree as it was", () => {
				const { runtime: other } = world();
				const seeded = createRuntime<any>({
					$Id: "root",
					...other.state.Src
				});
				expect(rawOf(seeded.state).V).not.toBe(rawOf(other.state.Src.V));
				expect(seeded.state.V).toEqual({
					W: 1
				});
				expect(Object.isFrozen(rawOf(other.state.Src))).toBe(false);
				expect(Object.isFrozen(rawOf(other.state.Src.V))).toBe(false);
			});

			it("refused through a seed leaves the caller's object as it was", () => {
				const value = {
					Ok: {
						V: 1
					},
					Bad: new Date(0)
				};
				expect(() =>
					createRuntime<any>({
						$Id: "root",
						A: value
					})
				).toThrow("createRuntime(): the initial state is not plain: Date at [A.Bad]");
				expect(Object.isFrozen(value)).toBe(false);
				expect(Object.isFrozen(value.Ok)).toBe(false);
			});

			it("freezes a wrapper around a live node, and not the node", async () => {
				captureSurfaced();
				const { runtime } = world();
				const wrapper: any = {};
				const src = rawOf(runtime.state.Src);
				function* write(draft: IWorld): IActionGenerator {
					wrapper.Kid = draft.Src;
					draft.A = wrapper;
					delete (draft as Partial<IWorld>).Src;
					(draft.A as any).Kid.V.W = 2;
				}
				await runtime.dispatch(write, "root");
				await settle();
				expect(Object.isFrozen(wrapper)).toBe(true);
				expect(Object.isFrozen(src)).toBe(false);
				expect(rawOf(runtime.state.A as any).Kid).toBe(src);
				expect((runtime.state.A as any).Kid.V.W).toBe(2);
			});

			it("takes a frozen value as it stands, and lands an object twice as two nodes", async () => {
				const surfaced = captureSurfaced();
				const value = Object.freeze({
					V: 1
				});
				const runtime = await landed((draft, v) => {
					draft.A = v;
					draft.B = v;
					draft.A.V = 2;
				}, value);
				await settle();
				expect(runtime.state.A).toEqual({
					V: 2
				});
				expect(runtime.state.B).toEqual({
					V: 1
				});
				expect(surfaced).toEqual([]);
			});

			it("reads a getter once, and carries what it answered as data", async () => {
				let reads = 0;
				const runtime = await landed(
					(draft, v) => {
						draft.A = v;
					},
					{
						get Tick() {
							reads++;
							return 1;
						}
					}
				);
				expect(reads).toBe(1);
				expect(Object.getOwnPropertyDescriptor(rawOf(runtime.state.A as object), "Tick")?.value).toBe(1);
			});

			it("closes an array's extra function property and an Array subclass", async () => {
				class Rows extends Array<number> {}
				const extra: any = [
					1
				];
				extra.Call = () => {};
				const runtime = await landed(
					(draft, v: any) => {
						draft.A = v.extra;
						draft.B = v.subclass;
					},
					{
						extra,
						subclass: Rows.from([
							1
						])
					}
				);
				expect(Object.keys(rawOf(runtime.state.A as object))).toEqual([
					"0"
				]);
				expect(Object.getPrototypeOf(rawOf(runtime.state.B as object))).toBe(Array.prototype);
			});
		});

		describe("a reconcileRows reorder", () => {
			const twoRows = async () => {
				const { runtime } = world();
				function* setup(draft: IWorld): IActionGenerator {
					draft.A = [
						minted("r1", {
							V: 0
						}),
						minted("r2", {
							V: 0
						})
					];
				}
				await runtime.dispatch(setup, "root");
				return runtime;
			};
			const reorder = (rows: any) =>
				reconcileRows(
					rows,
					[
						{
							Key: "~r2"
						},
						{
							Key: "~r1"
						}
					],
					(row: any) => row.Key ?? row.$Id,
					{
						update: () => {}
					}
				);

			it("seats the nodes themselves, so a write through a row is no stale path", async () => {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const runtime = await twoRows();
				function* write(draft: any): IActionGenerator {
					yield* reorder(draft.A);
					draft.A[0].V = 5;
				}
				await runtime.dispatch(write, "root");
				const rows = rawOf(runtime.state).A as any[];
				expect(rows.map((row) => rawOf(row) === row)).toEqual([
					true,
					true
				]);
				expect(rows[0]).toEqual({
					$Id: "~r2",
					V: 5
				});
				expect(warn.mock.calls.filter((call) => String(call[0]).includes("draft/"))).toEqual([]);
				warn.mockRestore();
			});

			it("leaves a fresh array of live rows free to move, once their originals are gone", async () => {
				const runtime = await twoRows();
				function* write(draft: any): IActionGenerator {
					const [first, second] = [
						draft.A[0],
						draft.A[1]
					];
					delete draft.A;
					draft.B = {
						Rows: [
							first,
							second
						]
					};
					yield* reorder(draft.B.Rows);
					draft.Slot = {
						Held: draft.B
					};
					delete draft.B;
				}
				await runtime.dispatch(write, "root");
				expect((runtime.state.Slot as any).Held.Rows.map((row: any) => row.$Id)).toEqual([
					"~r2",
					"~r1"
				]);
			});
		});

		describe.each([
			{
				slot: "empty",
				before: null
			},
			{
				slot: "holding an object",
				before: {
					Old: 1
				}
			}
		])("a live node written into a slot, the slot $slot", ({ before }) => {
			async function seated() {
				const { runtime, errors } = world();
				function* asker(draft: any) {
					draft.Slot = before
						? {
								Seat: {
									...before
								}
							}
						: {};
					draft.A = minted("moved", {
						K: "a"
					});
					return yield* open(
						ask<string>("~moved", {
							Path: "Moved"
						})
					);
				}
				const asking = runtime.dispatch(asker, "root");
				await settle();
				const id = pendingAsksOf(runtime, runtime.state)[0]!.Id as IAskId<string>;
				return {
					runtime,
					errors,
					id,
					asking
				};
			}
			const seatIn = (draft: any) => {
				draft.Slot.Seat = draft.A;
			};

			it("moves, and the ask it owns stays open", async () => {
				const { runtime, errors, id, asking } = await seated();
				const node = rawOf(runtime.state.A);
				function* move(draft: any): IActionGenerator {
					seatIn(draft);
					delete draft.A;
				}
				await runtime.dispatch(move, "root");
				expect(rawOf((runtime.state.Slot as any).Seat)).toBe(node);
				expect((runtime.state.Slot as any).Seat).toEqual({
					$Id: "~moved",
					K: "a"
				});
				function* answers(): IActionGenerator {
					yield* answer(id, "yes");
				}
				await runtime.dispatch(answers, "~moved");
				expect(await asking).toBe("yes");
				expect(errors).toEqual([]);
			});

			it("refuses with the alias error when the original stays, and undoes the slice", async () => {
				const surfaced = captureSurfaced();
				const { runtime } = await seated();
				const before = rawOf(runtime.state.Slot as any).Seat;
				function* alias(draft: any): IActionGenerator {
					seatIn(draft);
				}
				await expect(runtime.dispatch(alias, "root")).rejects.toThrow(StateAliasError);
				await settle();
				expect(surfaced).toEqual([]);
				expect(rawOf(runtime.state.Slot as any).Seat).toBe(before);
			});

			it("is a no-op written into its own slot", async () => {
				const { runtime } = await seated();
				function* first(draft: any): IActionGenerator {
					seatIn(draft);
					delete draft.A;
				}
				await runtime.dispatch(first, "root");
				const node = rawOf((runtime.state.Slot as any).Seat);
				function* again(draft: any): IActionGenerator {
					const seat = draft.Slot.Seat;
					draft.Slot.Seat = seat;
				}
				await runtime.dispatch(again, "root");
				expect(rawOf((runtime.state.Slot as any).Seat)).toBe(node);
			});
		});

		describe("a live list as a refresh's incoming rows", () => {
			it.each([
				{
					name: "another list on the draft",
					incoming: (draft: any) => draft.Rows
				},
				{
					name: "the target",
					incoming: (draft: any) => draft.A
				},
				{
					name: "a view of a list",
					incoming: (_draft: any, runtime: IRuntimeInternal<IWorld>) => (runtime.state as any).Rows
				}
			])("is read as a copy, and no node moves or freezes: $name", async ({ incoming }) => {
				const { runtime } = world();
				function* setup(draft: any): IActionGenerator {
					draft.A = [
						{
							K: 1
						}
					];
					draft.Rows = [
						{
							K: 1
						}
					];
				}
				await runtime.dispatch(setup, "root");
				const nodes = [
					rawOf(runtime.state.A as any[])[0],
					rawOf((runtime.state as any).Rows)[0]
				];
				function* write(draft: any): IActionGenerator {
					yield* reconcileRows(draft.A, incoming(draft, runtime), (row: any) => row.K, {
						update: () => {}
					});
				}
				await runtime.dispatch(write, "root");
				expect(rawOf(runtime.state.A as any[])[0]).toBe(nodes[0]);
				expect(rawOf((runtime.state as any).Rows)[0]).toBe(nodes[1]);
				expect(Object.isFrozen(nodes[1])).toBe(false);
			});

			it("takes a fresh array holding live nodes through a plain write, and each lands as the node itself", async () => {
				const { runtime } = world();
				function* setup(draft: any): IActionGenerator {
					draft.A = [
						minted("r1"),
						minted("r2")
					];
				}
				await runtime.dispatch(setup, "root");
				const kept = rawOf(runtime.state.A as any[])[1];
				function* write(draft: any): IActionGenerator {
					draft.A = draft.A.filter((row: any) => row.$Id === "~r2");
				}
				await runtime.dispatch(write, "root");
				expect(rawOf(runtime.state.A as any[])).toEqual([
					{
						$Id: "~r2"
					}
				]);
				expect(rawOf(runtime.state.A as any[])[0]).toBe(kept);
			});
		});

		describe("an array's shape", () => {
			async function refused(seedList: number[], write: (list: any[]) => void): Promise<IRuntimeInternal<IWorld>> {
				const { runtime } = world();
				function* setup(draft: IWorld): IActionGenerator {
					draft.A = seedList;
				}
				await runtime.dispatch(setup, "root");
				function* attempt(draft: IWorld): IActionGenerator {
					write(draft.A as any[]);
				}
				await expect(runtime.dispatch(attempt, "root")).rejects.toThrow(/an empty index at .*write at `length` or use `push`/);
				return runtime;
			}

			it("refuses a growing length, and a delete with a neighbour above it", async () => {
				const grown = await refused(
					[
						1
					],
					(list) => {
						list.length = 2;
					}
				);
				expect(grown.state.A).toEqual([
					1
				]);
				const holed = await refused(
					[
						1,
						2
					],
					(list) => {
						delete list[0];
					}
				);
				expect(holed.state.A).toEqual([
					1,
					2
				]);
			});

			it("takes a shrinking length", async () => {
				const { runtime } = world();
				function* write(draft: IWorld): IActionGenerator {
					draft.A = [
						1,
						2
					];
					(draft.A as number[]).length = 1;
				}
				await runtime.dispatch(write, "root");
				expect(runtime.state.A).toEqual([
					1
				]);
			});
		});

		it("hears a branch's failure once, through onError, as its action's", async () => {
			const { runtime, errors } = world();
			function* failing(): IActionGenerator {
				throw new Error("the branch failed");
			}
			function* fans(): IActionGenerator {
				yield* parallel(failing(), probe({}));
			}
			await runtime.dispatch(fans, "root").catch(() => {});
			await settle();
			expect(errors.map(String)).toEqual([
				"Error: the branch failed"
			]);
		});

		it("refuses an entity cell's setState in a step", async () => {
			const { runtime } = world();
			function* write(): IActionGenerator {
				runtime
					.get("runtime/stateIdLookup")()
					.other.setState((s: any) => {
						s.N = 1;
					});
			}
			await expect(runtime.dispatch(write, "root")).rejects.toThrow(/state mutations belong to actions/);
			expect(runtime.state.Other.N).toBe(0);
		});

		it("refuses another runtime's draft in a step", async () => {
			const { runtime: home } = world();
			const { runtime: away } = world();
			let held!: IWorld;
			function* holds(draft: IWorld): IActionGenerator {
				held = draft;
			}
			await home.dispatch(holds, "root");
			function* intruder(): IActionGenerator {
				held.N = 1;
			}
			await expect(away.dispatch(intruder, "root")).rejects.toThrow(/state mutations belong to actions/);
			expect(home.state.N).toBe(0);
		});
	});
}
