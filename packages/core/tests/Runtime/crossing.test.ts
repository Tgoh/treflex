import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IAskId } from "../../src/Types/IAskId";
import type { IEffect } from "../../src/Types/IEffect";
import type { IRecord } from "../../src/Types/IRecord";
import { createEffect, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answer } from "../../src/Effects/answer";
import { ask } from "../../src/Effects/ask";
import { defineEffect, implementation } from "../../src/Effects/defineEffect";
import { openResource } from "../../src/Effects/openResource";
import { parallel } from "../../src/Effects/parallel";
import { parallelSettled } from "../../src/Effects/parallelSettled";
import { publish } from "../../src/Effects/publish";
import { publishToNearest } from "../../src/Effects/publishToNearest";
import { resource } from "../../src/Effects/resource";
import { start } from "../../src/Effects/start";
import { startTimer } from "../../src/Effects/startTimer";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { wrapSetState } from "../../src/Runtime/sliceSetState";
import { rawOf, view } from "../../src/Runtime/viewProxy";
import { captureSurfaced, minted, pendingAsksOf } from "../testHelpers";

interface IKid {
	$Id: string;
	Name: string;
	Saved?: any;
}

interface IWorld {
	$Id: string;
	Node: {
		N: number;
		Deep: {
			M: number;
		};
	};
	Kids: IKid[];
	Saved?: any;
	Other?: any;
	List: any[];
}

const world = (): IWorld => ({
	$Id: "root",
	Node: {
		N: 1,
		Deep: {
			M: 1
		}
	},
	Kids: [
		{
			$Id: "kid-a",
			Name: "a"
		},
		{
			$Id: "kid-b",
			Name: "b"
		}
	],
	List: []
});

class Money {
	Cents = 1;
}

function isDeepFrozen(value: unknown): boolean {
	if (value === null || typeof value !== "object") {
		return true;
	}
	return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

interface IProbeEffect extends IEffect {
	Type: "crossing/probe";
	Input: unknown;
}
const probe = defineEffect<IProbeEffect, unknown>("crossing/probe");

interface ISecretEffect extends IEffect {
	Type: "crossing/secret";
	Input: unknown;
}
const secret = defineEffect<ISecretEffect, unknown>("crossing/secret", {
	redact: true
});

interface ILoadEffect extends IEffect {
	Type: "crossing/load";
}
const load = defineEffect<
	ILoadEffect,
	{
		init(): string;
	}
>("crossing/load", {
	returns: "module"
});

const publishAny = publish as unknown as (topic: string, data?: object) => IActionGenerator;
const publishToNearestAny = publishToNearest as unknown as (entity: object, topic: string, data?: object) => IActionGenerator;
const startTimerAny = startTimer as unknown as (
	entity: object,
	key: string,
	handler: unknown,
	ms: number,
	payload?: object
) => IActionGenerator;
const openResourceAny = openResource as unknown as (entity: object, key: string, ...rest: unknown[]) => IActionGenerator;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each([
	{
		journal: true
	},
	{
		journal: false
	}
])("crossings with a tap: $journal", ({ journal }) => {
	function build() {
		const inputs: IEffect[] = [];
		const onError = vi.fn();
		const runtime = createRuntime<IWorld>(world(), {
			onError,
			implementations: {
				"crossing/probe": (effect: IEffect) => {
					inputs.push(effect);
					return (effect as IProbeEffect).Input;
				},
				"crossing/secret": (effect: IEffect) => {
					inputs.push(effect);
				}
			}
		});
		const records: IRecord[] = [];
		if (journal) {
			runtime.on("record", (record) => records.push(record));
		}
		return {
			runtime,
			inputs,
			onError,
			records
		};
	}

	describe("action arguments", () => {
		it("arrive as a deeply frozen copy, leaving the caller's value alone", async () => {
			const { runtime } = build();
			const sent = {
				A: 1,
				B: {
					C: [
						1,
						{
							D: 2
						}
					]
				}
			};
			let got: unknown;
			function* take(_draft: IWorld, arg: unknown): IActionGenerator {
				got = arg;
			}
			await runtime.dispatch(take, "root", sent);
			expect(got).toEqual(sent);
			expect(got).not.toBe(sent);
			expect(isDeepFrozen(got)).toBe(true);
			expect(Object.isFrozen(sent)).toBe(false);
		});

		it("do not hear the caller's edit after the dispatch", async () => {
			const { runtime } = build();
			const sent = {
				V: 1
			};
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			runtime.registerImplementation("crossing/gate", () => gate);
			function* take(draft: IWorld, arg: typeof sent): IActionGenerator {
				yield {
					Type: "crossing/gate"
				};
				draft.Saved = arg.V;
			}
			const inFlight = runtime.dispatch(take, "root", sent);
			sent.V = 2;
			release();
			await inFlight;
			expect(runtime.state.Saved).toBe(1);
		});

		it("reach a direct processAction, which is how a view calls one", async () => {
			const { runtime } = build();
			let got: unknown;
			function* take(_draft: IWorld, arg: unknown): IActionGenerator {
				got = arg;
			}
			await runtime.processAction(
				take,
				() => runtime.state,
				wrapSetState(rawOf(runtime.state)),
				() => "root",
				{
					A: {
						B: 1
					}
				}
			);
			expect(isDeepFrozen(got)).toBe(true);
		});

		it("reach a started action on one copy, shared with the starter's own", async () => {
			const { runtime } = build();
			const got: unknown[] = [];
			function* child(_draft: IKid, arg: unknown): IActionGenerator {
				got.push(arg);
			}
			function* parent(_draft: IWorld, arg: unknown): IActionGenerator {
				got.push(arg);
				yield* start(child, "kid-a", arg);
				yield* start(child, "kid-b", {
					Fresh: true
				});
			}
			await runtime.dispatch(parent, "root", {
				A: 1
			});
			await tick();
			expect(got[0]).toBe(got[1]);
			expect(isDeepFrozen(got[0])).toBe(true);
			expect(isDeepFrozen(got[2])).toBe(true);
		});

		it("lose trailing undefineds, and deliver one in the middle with the later argument intact", async () => {
			const { runtime } = build();
			let got: unknown[] = [];
			function* take(_draft: IWorld, ...args: unknown[]): IActionGenerator {
				got = args;
			}
			await runtime.dispatch(take, "root", 1, undefined, undefined);
			expect(got).toHaveLength(1);
			await runtime.dispatch(take, "root", undefined, 2);
			expect(got).toHaveLength(2);
			expect(got[0]).toBeUndefined();
			expect(got[1]).toBe(2);
		});

		it("deliver a mid-list undefined through a start", async () => {
			const { runtime, records } = build();
			let got: unknown[] = [];
			function* child(_draft: IKid, ...args: unknown[]): IActionGenerator {
				got = args;
			}
			function* parent(): IActionGenerator {
				yield* start(child, "kid-a", undefined, 2);
			}
			await runtime.dispatch(parent, "root");
			await tick();
			expect(got).toHaveLength(2);
			expect(got[0]).toBeUndefined();
			expect(got[1]).toBe(2);
			if (journal) {
				const started = records.find((r) => r.Kind === "action:start" && r.Label === "child") as Extract<
					IRecord,
					{
						Kind: "action:start";
					}
				>;
				expect(JSON.parse(JSON.stringify(started.Args))).toEqual([
					null,
					2
				]);
			}
		});

		it("deliver a mid-list undefined through a resource method, from an action and from r.run", async () => {
			const { runtime } = build();
			const typed = runtime as unknown as {
				registerResourceType(type: string, impl: (params: unknown, r: any) => void): void;
			};
			const got: unknown[][] = [];
			typed.registerResourceType("crossing/parent", (_params, r) => {
				r.methods({
					take(_ctx: unknown, ...args: unknown[]) {
						got.push(args);
					}
				});
			});
			const handle = () =>
				resource("root", "Crossing/Parent" as never) as unknown as {
					take(...args: unknown[]): IActionGenerator;
				};
			let run!: Promise<unknown>;
			typed.registerResourceType("crossing/child", (_params, r) => {
				run = r.run(handle().take(undefined, "from run"));
			});
			function* open(draft: IWorld): IActionGenerator {
				yield* openResourceAny(draft, "Crossing/Parent", {
					Type: "crossing/parent"
				});
			}
			function* openChild(draft: IKid): IActionGenerator {
				yield* openResourceAny(draft, "Crossing/Child", {
					Type: "crossing/child"
				});
			}
			function* callsMethod(): IActionGenerator {
				yield* handle().take(undefined, "from action");
			}
			await runtime.dispatch(open, "root");
			await tick();
			await runtime.dispatch(callsMethod, "root");
			await runtime.dispatch(openChild, "kid-a");
			await tick();
			await run;
			expect(got).toHaveLength(2);
			expect(got[0]).toHaveLength(2);
			expect(got[0][0]).toBeUndefined();
			expect(got[0][1]).toBe("from action");
			expect(got[1]).toHaveLength(2);
			expect(got[1][0]).toBeUndefined();
			expect(got[1][1]).toBe("from run");
			runtime.dispose();
		});

		it("refuse an undefined inside an array", async () => {
			const { runtime } = build();
			function* take(_draft: IWorld, _arg: unknown): IActionGenerator {}
			await expect(
				runtime.dispatch(take, "root", [
					undefined,
					2
				])
			).rejects.toThrow(/undefined array element at \[0\.0\].*pass null instead/);
		});
	});

	it("keeps a bare yield of a generator out of the plain-data refusal", async () => {
		const { runtime } = build();
		function* inner(): IActionGenerator {}
		function* outer(): IActionGenerator {
			yield inner() as never;
		}
		await expect(runtime.dispatch(outer, "root")).rejects.toThrow(/No implementation registered for effect type/);
	});

	describe("a value with no plain form", () => {
		function cycle() {
			const a: Record<string, unknown> = {};
			a.Self = a;
			return a;
		}

		it.each([
			[
				"a Date",
				() => new Date(0),
				"Date at [0]"
			],
			[
				"a Map",
				() => new Map(),
				"Map at [0]"
			],
			[
				"a Set",
				() => new Set(),
				"Set at [0]"
			],
			[
				"a class instance",
				() => new Money(),
				"Money at [0]"
			],
			[
				"NaN",
				() => Number.NaN,
				"NaN at [0]"
			],
			[
				"Infinity",
				() => Number.POSITIVE_INFINITY,
				"Infinity at [0]"
			],
			[
				"a bigint",
				() => 1n,
				"bigint at [0]"
			],
			[
				"a symbol",
				() => Symbol("s"),
				"symbol at [0]"
			],
			[
				"a cycle",
				cycle,
				"cycle at [0.Self]"
			],
			[
				"a nested Date",
				() => ({
					When: [
						null,
						new Date(0)
					]
				}),
				"Date at [0.When.1]"
			]
		])("refuses %s as an argument, failing the action before its generator starts", async (_name, make, where) => {
			const { runtime, records, onError } = build();
			let ran = false;
			function* take(_draft: IWorld, _arg: unknown): IActionGenerator {
				ran = true;
			}
			const refusal = await runtime.dispatch(take, "root", make()).catch((error: unknown) => error);
			expect(refusal).toBeInstanceOf(NonPlainDataError);
			expect((refusal as Error).name).toBe("NonPlainDataError");
			expect((refusal as Error).message).toContain(`action "take": an argument is not plain: ${where}`);
			expect(ran).toBe(false);
			expect(records.filter((r) => r.Kind === "action:start" || r.Kind === "action:end")).toEqual([]);
			expect(onError).toHaveBeenCalledTimes(1);
			expect(onError.mock.calls[0][0]).toBe(refusal);
		});

		it("is heard by the nearest Action/Error error boundary when refused as an argument", async () => {
			const { runtime } = build();
			const heard: any[] = [];
			const ErrorBoundary = receiver<IWorld>("crossing/errorBoundary")({
				"Action/Error": function* onFailure(_draft: IWorld, data: any): IActionGenerator {
					heard.push(data);
				}
			} as never);
			runtime.registerReceiver(ErrorBoundary);
			function* bindsErrorBoundary(draft: IWorld): IActionGenerator {
				bind(draft, ErrorBoundary);
			}
			function* take(_draft: IKid, _arg: unknown): IActionGenerator {}
			await runtime.dispatch(bindsErrorBoundary, "root");
			await expect(runtime.dispatch(take, "kid-a", new Date(0))).rejects.toThrow(NonPlainDataError);
			await tick();
			expect(heard).toHaveLength(1);
			expect(heard[0].Label).toBe("take");
			expect(heard[0].Error.Name).toBe("NonPlainDataError");
		});

		it("is refused at a start's yield, in the starter, and nothing starts", async () => {
			const { runtime } = build();
			let ran = false;
			let refusal: unknown;
			function* child(_draft: IKid, _arg: unknown): IActionGenerator {
				ran = true;
			}
			function* parent(draft: IWorld): IActionGenerator {
				try {
					yield* start(child, "kid-a", new Date(0));
				} catch (error) {
					refusal = error;
				}
				draft.Saved = "carried on";
			}
			await runtime.dispatch(parent, "root");
			await tick();
			expect(refusal).toBeInstanceOf(NonPlainDataError);
			expect((refusal as Error).message).toContain("start: the input is not plain: Date at [0]");
			expect(ran).toBe(false);
			expect(runtime.state.Saved).toBe("carried on");
		});

		it("is refused at publish, in the publisher, with nobody subscribed", async () => {
			const { runtime } = build();
			let refusal: unknown;
			function* sender(): IActionGenerator {
				try {
					yield* publishAny("Nobody/Listens", {
						When: new Date(0)
					});
				} catch (error) {
					refusal = error;
				}
			}
			await runtime.dispatch(sender, "root");
			expect(refusal).toBeInstanceOf(NonPlainDataError);
			expect((refusal as Error).message).toContain("publish: the input is not plain: Date at [Data.When]");
		});

		it("is refused at publishToNearest too", async () => {
			const { runtime } = build();
			let refusal: unknown;
			function* sender(draft: IWorld): IActionGenerator {
				try {
					yield* publishToNearestAny(draft, "Nobody/Listens", {
						Lookup: new Map()
					});
				} catch (error) {
					refusal = error;
				}
			}
			await runtime.dispatch(sender, "root");
			expect((refusal as Error).message).toContain("publishToNearest: the input is not plain: Map at [Data.Lookup]");
		});

		it("is refused at an effect's yield, without reaching the implementation or the record", async () => {
			const { runtime, inputs, records } = build();
			let refusal: unknown;
			function* sender(): IActionGenerator {
				try {
					yield* probe({
						Input: {
							When: new Date(0)
						}
					});
				} catch (error) {
					refusal = error;
				}
			}
			await runtime.dispatch(sender, "root");
			expect(refusal).toBeInstanceOf(NonPlainDataError);
			expect((refusal as Error).message).toContain("crossing/probe: the input is not plain: Date at [Input.When]");
			expect(inputs).toEqual([]);
			expect(records.filter((r) => r.Kind === "effect")).toEqual([]);
		});

		it("is refused on a redacted effect too", async () => {
			const { runtime, inputs } = build();
			let refusal: unknown;
			function* sender(): IActionGenerator {
				try {
					yield* secret({
						Input: new Money()
					});
				} catch (error) {
					refusal = error;
				}
			}
			await runtime.dispatch(sender, "root");
			expect((refusal as Error).message).toContain("crossing/secret: the input is not plain: Money at [Input]");
			expect(inputs).toEqual([]);
		});

		it("is refused at startTimer's yield", async () => {
			const { runtime } = build();
			const Ticks = receiver<IWorld>("crossing/ticks")({} as never);
			let refusal: unknown;
			function* sender(draft: IWorld): IActionGenerator {
				try {
					yield* startTimerAny(draft, "Crossing/Tick", Ticks, 1000, {
						When: new Date(0)
					});
				} catch (error) {
					refusal = error;
				}
			}
			await runtime.dispatch(sender, "root");
			expect((refusal as Error).message).toContain("startTimer: the input is not plain: Date at [Payload.When]");
		});

		it("reads a getter once and carries what it answered", async () => {
			const { runtime } = build();
			let reads = 0;
			const sent = {
				get Computed() {
					reads++;
					return {
						V: 1
					};
				}
			};
			let got: any;
			function* take(_draft: IWorld, arg: unknown): IActionGenerator {
				got = arg;
			}
			await runtime.dispatch(take, "root", sent);
			expect(Object.getOwnPropertyDescriptor(got, "Computed")?.get).toBeUndefined();
			expect(got.Computed).toEqual({
				V: 1
			});
			expect(isDeepFrozen(got)).toBe(true);
			expect(reads).toBe(1);
		});

		it("rejects with a getter's own throw", async () => {
			const { runtime } = build();
			function* take(_draft: IWorld, _arg: unknown): IActionGenerator {}
			await expect(
				runtime.dispatch(take, "root", {
					get Bad(): number {
						throw new RangeError("getter blew");
					}
				})
			).rejects.toThrow(RangeError);
		});
	});

	describe("a function", () => {
		function* carry(
			draft: IWorld,
			arg: {
				Call: () => string;
			}
		): IActionGenerator {
			draft.Saved = arg.Call();
		}
		const sent = {
			Call: () => "called"
		};

		it("still reaches ask and the branches of parallel and parallelSettled", async () => {
			const { runtime } = build();
			function* branch(value: number): IActionGenerator<number> {
				return value;
			}
			function* asker(draft: IWorld) {
				const reply = yield* open(
					ask<string>(draft.Kids[0], {
						Path: "Crossing"
					})
				);
				const [a, b] = yield* parallel(branch(1), branch(2));
				const [c] = yield* parallelSettled(branch(3));
				draft.Saved = [
					reply,
					a,
					b,
					c.ok ? c.value : null
				];
			}
			function* answerer(_draft: IKid, id: IAskId<string>): IActionGenerator {
				yield* answer(id, "yes");
			}
			const asking = runtime.dispatch(asker, "root");
			await tick();
			await runtime.dispatch(answerer, "kid-a", pendingAsksOf(runtime, runtime.state)[0]!.Id as IAskId<string>);
			await asking;
			expect(runtime.state.Saved).toEqual([
				"yes",
				1,
				2,
				3
			]);
		});

		it("in an argument is refused, and the action never starts", async () => {
			const { runtime } = build();
			await expect(runtime.dispatch(carry, "root", sent)).rejects.toThrow(NonPlainDataError);
			expect(runtime.state.Saved).toBeUndefined();
		});
	});

	describe("a live node", () => {
		const unfrozenTree = (runtime: IRuntime<IWorld>) => {
			const raw = rawOf(runtime.state);
			return !Object.isFrozen(raw.Node) && !Object.isFrozen(raw.Node.Deep);
		};

		it("crosses as plain data from a draft, and a write to it reaches nothing", async () => {
			const { runtime } = build();
			let got: any;
			let refusal: unknown;
			function* child(_draft: IKid, arg: any): IActionGenerator {
				got = arg;
				try {
					arg.N = 99;
				} catch (error) {
					refusal = error;
				}
			}
			function* parent(draft: IWorld): IActionGenerator {
				yield* start(child, "kid-a", draft.Node);
				draft.Node.N = 2;
			}
			await runtime.dispatch(parent, "root");
			await tick();
			expect(rawOf(got)).toBe(got);
			expect(rawOf(got.Deep)).toBe(got.Deep);
			expect(got).toEqual({
				N: 1,
				Deep: {
					M: 1
				}
			});
			expect(isDeepFrozen(got)).toBe(true);
			expect(refusal).toBeInstanceOf(TypeError);
			expect(runtime.state.Node.N).toBe(2);
			expect(unfrozenTree(runtime)).toBe(true);
		});

		it("crosses as plain data from a view", async () => {
			const { runtime } = build();
			let got: any;
			function* take(_draft: IWorld, arg: unknown): IActionGenerator {
				got = arg;
			}
			await runtime.dispatch(take, "root", runtime.state.Node);
			expect(rawOf(got)).toBe(got);
			expect(rawOf(got.Deep)).toBe(got.Deep);
			expect(got).not.toBe(rawOf(runtime.state.Node));
			expect(isDeepFrozen(got)).toBe(true);
			expect(unfrozenTree(runtime)).toBe(true);
		});

		it("crosses as plain data from a raw node, leaving the node writable", async () => {
			const { runtime } = build();
			let got: any;
			function* take(_draft: IWorld, arg: unknown): IActionGenerator {
				got = arg;
			}
			function* write(draft: IWorld): IActionGenerator {
				draft.Node.Deep.M = 2;
			}
			await runtime.dispatch(take, "root", rawOf(runtime.state.Node));
			await runtime.dispatch(write, "root");
			expect(got.Deep.M).toBe(1);
			expect(runtime.state.Node.Deep.M).toBe(2);
		});

		it("crosses as plain data from inside a plain wrapper", async () => {
			const { runtime } = build();
			let got: any;
			function* child(_draft: IKid, arg: any): IActionGenerator {
				got = arg;
			}
			function* parent(draft: IWorld): IActionGenerator {
				yield* start(child, "kid-a", {
					Held: [
						draft.Node
					]
				});
			}
			await runtime.dispatch(parent, "root");
			await tick();
			expect(rawOf(got.Held[0])).toBe(got.Held[0]);
			expect(got.Held[0].N).toBe(1);
			expect(isDeepFrozen(got)).toBe(true);
		});

		it("reads nothing a reactive caller would subscribe to", async () => {
			const { runtime } = build();
			function* take(_draft: IWorld, _arg: unknown): IActionGenerator {}
			function* write(draft: IWorld): IActionGenerator {
				draft.Node.N = 2;
			}
			let runs = 0;
			const dispose = createRoot((dispose) => {
				createEffect(() => {
					runs++;
					void runtime.dispatch(take, "root", runtime.state.Node);
				});
				return dispose;
			});
			await tick();
			expect(runs).toBe(1);
			await runtime.dispatch(write, "root");
			await tick();
			expect(runs).toBe(1);
			dispose();
		});

		it("fails with the detachment error when the node has left the tree", async () => {
			const { runtime } = build();
			let held: any;
			function* grab(draft: IWorld): IActionGenerator {
				held = draft.Kids[1];
				yield* probe({
					Input: 1
				});
				draft.Kids.splice(1, 1);
				yield* probe({
					Input: 1
				});
				yield* start(function* (_draft: IKid, _arg: unknown): IActionGenerator {}, "kid-a", held);
			}
			await expect(runtime.dispatch(grab, "root")).rejects.toThrow(/left the state tree/);
		});
	});

	describe("publish", () => {
		function bindBoth(runtime: IRuntime<IWorld>, handler: (draft: IKid, data: any, ctx: any) => IActionGenerator) {
			const Listener = receiver<IKid>("crossing/listener")({
				"Crossing/Said": handler
			} as never);
			runtime.registerReceiver(Listener);
			function* listen(draft: IKid): IActionGenerator {
				bind(draft, Listener);
			}
			return Promise.all([
				runtime.dispatch(listen, "kid-a"),
				runtime.dispatch(listen, "kid-b")
			]);
		}

		it("hands every receiver the one frozen copy", async () => {
			const { runtime } = build();
			const got: any[] = [];
			const contexts: any[] = [];
			await bindBoth(runtime, function* heard(_draft, data, ctx) {
				got.push(data);
				contexts.push(ctx);
			});
			function* sender(draft: IWorld): IActionGenerator {
				yield* publishAny("Crossing/Said", {
					Node: draft.Node
				});
			}
			await runtime.dispatch(sender, "root");
			await tick();
			expect(got).toHaveLength(2);
			expect(got[0]).toBe(got[1]);
			expect(got[0].Type).toBe("Crossing/Said");
			expect(rawOf(got[0].Node)).toBe(got[0].Node);
			expect(isDeepFrozen(got[0])).toBe(true);
			expect(isDeepFrozen(contexts[0])).toBe(true);
		});

		it("lets two receivers adopt a payload without sharing a node", async () => {
			const { runtime } = build();
			await bindBoth(runtime, function* heard(draft, data) {
				draft.Saved = data.Shared;
				draft.Saved.By = draft.$Id;
			});
			function* sender(): IActionGenerator {
				yield* publishAny("Crossing/Said", {
					Shared: {
						V: 1
					}
				});
			}
			await runtime.dispatch(sender, "root");
			await tick();
			expect(runtime.state.Kids.map((k) => k.Saved)).toEqual([
				{
					V: 1,
					By: "kid-a"
				},
				{
					V: 1,
					By: "kid-b"
				}
			]);
			expect(rawOf(runtime.state.Kids[0].Saved)).not.toBe(rawOf(runtime.state.Kids[1].Saved));
		});
	});

	describe("effect inputs", () => {
		it("reach the implementation as a frozen copy holding no live node", async () => {
			const { runtime, inputs } = build();
			function* sender(draft: IWorld): IActionGenerator {
				yield* probe({
					Input: {
						Node: draft.Node
					}
				});
			}
			await runtime.dispatch(sender, "root");
			const effect = inputs[0] as IProbeEffect;
			const input = effect.Input as IWorld;
			expect(rawOf(input.Node)).toBe(input.Node);
			expect(isDeepFrozen(effect)).toBe(true);
		});

		it("do not hear a write after the yield", async () => {
			const { runtime, inputs } = build();
			function* sender(draft: IWorld): IActionGenerator {
				yield* probe({
					Input: draft.Node
				});
				draft.Node.N = 2;
			}
			await runtime.dispatch(sender, "root");
			expect((inputs[0] as IProbeEffect).Input).toMatchObject({
				N: 1
			});
		});

		if (journal) {
			it("are the record's descriptor, on one copy", async () => {
				const { runtime, inputs, records } = build();
				function* sender(): IActionGenerator {
					yield* probe({
						Input: {
							V: 1
						}
					});
				}
				await runtime.dispatch(sender, "root");
				const record = records.find((r) => r.Kind === "effect" && r.Type === "crossing/probe") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>;
				expect(record.Descriptor).toBe(inputs[0]);
			});

			it("are the record's Args, on one copy", async () => {
				const { runtime, records } = build();
				let got: unknown;
				function* take(_draft: IWorld, arg: unknown): IActionGenerator {
					got = arg;
				}
				await runtime.dispatch(take, "root", {
					V: 1
				});
				const record = records.find((r) => r.Kind === "action:start") as Extract<
					IRecord,
					{
						Kind: "action:start";
					}
				>;
				expect(record.Args[0]).toBe(got);
			});
		}
	});

	describe("effect results", () => {
		it("stay unfrozen copies an action can adjust and write", async () => {
			const { runtime } = build();
			let got: any;
			let frozenBeforeWrite: boolean | undefined;
			function* fetcher(draft: IWorld): IActionGenerator {
				got = yield* probe({
					Input: {
						Rows: [
							1
						]
					}
				});
				got.Rows.push(2);
				got.Tagged = true;
				frozenBeforeWrite = Object.isFrozen(got);
				draft.Saved = got;
			}
			await runtime.dispatch(fetcher, "root");
			expect(frozenBeforeWrite).toBe(false);
			expect(Object.isFrozen(got)).toBe(true);
			expect(runtime.state.Saved).toEqual({
				Rows: [
					1,
					2
				],
				Tagged: true
			});
		});
	});

	describe("answers", () => {
		function start(runtime: IRuntime<IWorld>) {
			const got: unknown[] = [];
			function* asker(draft: IWorld) {
				const reply = yield* open(
					ask<any>(draft.Kids[0], {
						Path: "Answers"
					})
				);
				got.push(reply);
				draft.Other = reply;
				draft.Other.Written = true;
			}
			return {
				got,
				asking: runtime.dispatch(asker, "root")
			};
		}

		it("reach the asker frozen and on one copy, and write into the draft", async () => {
			const { runtime } = build();
			const { got, asking } = start(runtime);
			await tick();
			const id = pendingAsksOf(runtime, runtime.state)[0]!.Id;
			let sentCopy: unknown;
			runtime.on("record", (record) => {
				if (record.Kind === "effect" && record.Type === "answer") {
					sentCopy = (
						record.Descriptor as {
							Data: unknown;
						}
					).Data;
				}
			});
			function* answerer(draft: IKid): IActionGenerator {
				draft.Saved = {
					AskId: id
				};
				yield* answer(id, draft.Saved);
				draft.Saved.AskId = null;
			}
			await runtime.dispatch(answerer, "kid-a");
			await asking;
			expect(got[0]).toBe(sentCopy);
			expect(rawOf(got[0])).toBe(got[0]);
			expect(isDeepFrozen(got[0])).toBe(true);
			expect(runtime.state.Other).toEqual({
				AskId: id,
				Written: true
			});
		});

		it("refuse a function, and leave the ask open", async () => {
			const { runtime } = build();
			const { got, asking } = start(runtime);
			await tick();
			const id = pendingAsksOf(runtime, runtime.state)[0]!.Id;
			const outcomes: string[] = [];
			function* answerer(_draft: IKid): IActionGenerator {
				for (const data of [
					{
						Call: () => {}
					},
					{
						When: new Date(0)
					}
				]) {
					try {
						yield* answer(id, data);
					} catch (error) {
						outcomes.push((error as Error).name);
					}
				}
				yield* answer(id, {
					Plain: true
				});
			}
			await runtime.dispatch(answerer, "kid-a");
			await asking;
			expect(outcomes).toEqual([
				"NonPlainDataError",
				"NonPlainDataError"
			]);
			expect(got[0]).toEqual({
				Plain: true
			});
		});
	});

	describe("timers and resources", () => {
		it("deliver a frozen tick", async () => {
			const { runtime } = build();
			const got: any[] = [];
			const Ticks = receiver<IWorld>("crossing/ticks")({
				"Crossing/Tick": function* heard(_draft: IWorld, data: any, ctx: any): IActionGenerator {
					got.push({
						data,
						ctx
					});
				}
			} as never);
			runtime.registerReceiver(Ticks);
			function* arm(draft: IWorld): IActionGenerator {
				yield* startTimerAny(draft, "Crossing/Tick", Ticks, 1, {
					Deep: {
						V: 1
					}
				});
			}
			await runtime.dispatch(arm, "root");
			await vi.waitFor(() => expect(got.length).toBeGreaterThan(0));
			runtime.dispose();
			expect(got[0].data).toEqual({
				Type: "Crossing/Tick",
				Deep: {
					V: 1
				}
			});
			expect(isDeepFrozen(got[0].data)).toBe(true);
			expect(isDeepFrozen(got[0].ctx)).toBe(true);
		});

		it("deliver a frozen resource message", async () => {
			const { runtime } = build();
			const got: any[] = [];
			const Feed = receiver<IWorld>("crossing/feed")({
				"Crossing/Feed": function* heard(_draft: IWorld, data: any): IActionGenerator {
					got.push(data);
				}
			} as never);
			runtime.registerReceiver(Feed);
			const typed = runtime as unknown as {
				registerResourceType(type: string, impl: (params: unknown, r: any) => void): void;
			};
			let emit!: (message: unknown) => Promise<unknown>;
			let params: unknown;
			let methodArg: unknown;
			typed.registerResourceType("crossing/feed", (p, r) => {
				params = p;
				emit = r.emit;
				r.methods({
					take(_ctx: unknown, arg: unknown) {
						methodArg = arg;
					}
				});
			});
			function* open(draft: IWorld): IActionGenerator {
				yield* openResourceAny(draft, "Crossing/Feed", Feed, {
					Type: "crossing/feed",
					Deep: {
						V: 1
					}
				});
			}
			await runtime.dispatch(open, "root");
			await tick();
			expect(params).toEqual({
				Type: "crossing/feed",
				Deep: {
					V: 1
				}
			});
			await emit({
				Deep: {
					V: 2
				}
			});
			await tick();
			expect(got[0]).toEqual({
				Type: "Crossing/Feed",
				Deep: {
					V: 2
				}
			});
			expect(isDeepFrozen(got[0])).toBe(true);

			function* callsMethod(draft: IWorld): IActionGenerator {
				const handle = resource(draft, "Crossing/Feed" as never) as unknown as {
					take(arg: unknown): IActionGenerator;
				};
				yield* handle.take({
					Deep: {
						V: 3
					}
				});
			}
			await runtime.dispatch(callsMethod, "root");
			expect(isDeepFrozen(methodArg)).toBe(true);
			runtime.dispose();
		});
	});

	describe("a frozen value written into the draft", () => {
		const sent = () => ({
			V: 1,
			Deep: {
				M: 1,
				Rows: [
					{
						K: 1
					}
				]
			}
		});

		it("lands as a tree node that can be written later", async () => {
			const { runtime } = build();
			let got: any;
			function* save(draft: IWorld, arg: any): IActionGenerator {
				got = arg;
				draft.Saved = arg;
				yield* probe({
					Input: 1
				});
				draft.Saved.V = 2;
				draft.Saved.Deep.M = 2;
				draft.Saved.Deep.Rows.push({
					K: 2
				});
				draft.Saved.Deep.Rows[0].K = 9;
			}
			await runtime.dispatch(save, "root", sent());
			expect(runtime.state.Saved).toEqual({
				V: 2,
				Deep: {
					M: 2,
					Rows: [
						{
							K: 9
						},
						{
							K: 2
						}
					]
				}
			});
			const raw = rawOf(runtime.state).Saved;
			expect(raw).not.toBe(got);
			expect(Object.isFrozen(raw)).toBe(false);
			expect(Object.isFrozen(raw.Deep.Rows[0])).toBe(false);
			expect(got).toEqual(sent());
		});

		it("takes writes in the same slice it landed", async () => {
			const { runtime } = build();
			function* save(draft: IWorld, arg: any): IActionGenerator {
				draft.Saved = arg;
				draft.Saved.V = 2;
			}
			await runtime.dispatch(save, "root", sent());
			expect(runtime.state.Saved.V).toBe(2);
		});

		it("lands as its own node each time", async () => {
			const { runtime } = build();
			function* save(draft: IWorld, arg: any): IActionGenerator {
				draft.Saved = arg;
				draft.Other = arg;
				draft.Saved.V = 2;
			}
			await runtime.dispatch(save, "root", sent());
			expect(runtime.state.Saved.V).toBe(2);
			expect(runtime.state.Other.V).toBe(1);
		});

		it("lands through a nested piece, a wrapper, a push and a spread", async () => {
			const { runtime } = build();
			function* save(draft: IWorld, arg: any): IActionGenerator {
				draft.Saved = arg.Deep;
				draft.Saved.M = 2;
				draft.Other = {
					Held: arg
				};
				draft.Other.Held.Deep.M = 3;
				draft.List.push(arg.Deep.Rows[0]);
				draft.List[0].K = 4;
				draft.List = [
					...draft.List,
					...arg.Deep.Rows
				];
				draft.List[1].K = 5;
				Object.assign(draft.Node, {
					Deep: arg.Deep
				});
				draft.Node.Deep.M = 6;
			}
			await runtime.dispatch(save, "root", sent());
			expect(runtime.state.Saved.M).toBe(2);
			expect(runtime.state.Other.Held.Deep.M).toBe(3);
			expect(runtime.state.List).toEqual([
				{
					K: 4
				},
				{
					K: 5
				}
			]);
			expect(runtime.state.Node.Deep.M).toBe(6);
		});

		it.each([
			[
				"a row a refresh's add returns",
				(draft: IWorld) => {
					draft.Other = [
						minted("row", {
							K: "a"
						})
					];
				},
				function* (draft: IWorld) {
					yield* reconcileRows(
						draft.List,
						[
							"a"
						],
						(row: any) => row.K ?? row,
						{
							add: () => draft.Other[0],
							update: () => {}
						}
					);
					draft.Other = [];
				},
				(state: IWorld) => state.Other[0],
				(state: IWorld) => state.List[0]
			],
			[
				"a held node under a key",
				(draft: IWorld) => {
					draft.Other = minted("row", {
						K: "a"
					});
				},
				function* (draft: IWorld) {
					(draft.Node as any).Fresh = draft.Other;
					delete draft.Other;
				},
				(state: IWorld) => state.Other,
				(state: IWorld) => (state.Node as any).Fresh
			]
		])("keeps the ask open when %s of live state, its owner, is written: the node moves", async (_name, place, refresh, row, moved) => {
			captureSurfaced();
			const { runtime, onError } = build();
			function* asker(draft: IWorld) {
				place(draft);
				row(draft).Marked = true;
				const reply = yield* open(
					ask<string>("~row", {
						Path: "Row"
					})
				);
				return [
					"resumed",
					reply
				];
			}
			function* refresher(draft: IWorld): IActionGenerator {
				yield* refresh(draft);
			}
			const asking = runtime.dispatch(asker, "root");
			await tick();
			const [entry] = pendingAsksOf(runtime, runtime.state);
			const id = entry!.Id as IAskId<string>;
			await runtime.dispatch(refresher, "root");
			expect(pendingAsksOf(runtime, runtime.state)).toEqual([
				entry
			]);
			expect(moved(runtime.state).Marked).toBe(true);
			expect(moved(runtime.state).K).toBe("a");
			expect(onError).not.toHaveBeenCalled();
			function* answering(_draft: unknown): IActionGenerator {
				yield* answer(id, "yes");
			}
			await runtime.dispatch(answering, "~row");
			expect(await asking).toEqual([
				"resumed",
				"yes"
			]);
			await tick();
		});

		it('refuses a frozen returns: "module" result nested in a value', async () => {
			const { runtime } = build();
			runtime.registerImplementation("crossing/load", () =>
				Object.freeze({
					init: () => "x"
				})
			);
			function* seatModule(draft: IWorld): IActionGenerator {
				const module = yield* load();
				(draft.Node as any).Holder = {
					Slot: module
				};
			}
			await expect(runtime.dispatch(seatModule, "root")).rejects.toThrow(/not plain: function at \[Node\.Holder\.Slot\.init\]/);
			expect((runtime.state.Node as any).Holder).toBeUndefined();
		});

		it("seats an entity that can be dispatched at and written", async () => {
			const { runtime } = build();
			function* seat(draft: IWorld, arg: IKid): IActionGenerator {
				draft.Kids.push(arg);
			}
			function* rename(draft: IKid): IActionGenerator {
				draft.Name = "renamed";
			}
			await runtime.dispatch(
				seat,
				"root",
				minted("kid-c", {
					Name: "c"
				})
			);
			await runtime.dispatch(rename, "~kid-c");
			expect(runtime.state.Kids[2].Name).toBe("renamed");
		});

		it("lands in a slice the index doesn't serve too", async () => {
			const { runtime } = build();
			const raw: {
				Saved?: any;
			} = {};
			function* save(draft: typeof raw, arg: any): IActionGenerator {
				draft.Saved = arg;
				yield* probe({
					Input: 1
				});
				draft.Saved.V = 2;
			}
			await runtime.processAction(
				save,
				() => view(raw),
				wrapSetState(raw),
				() => "local",
				sent()
			);
			expect(raw.Saved.V).toBe(2);
			expect(Object.isFrozen(raw.Saved)).toBe(false);
		});
	});
});

describe("implementation()", () => {
	it("gets the same copy a typed creator's descriptor made", async () => {
		const runtime = createRuntime<IWorld>(world());
		let got: unknown;
		runtime.registerImplementation(
			implementation(probe, (effect) => {
				got = effect;
				return 1;
			})
		);
		function* sender(): IActionGenerator {
			yield* probe({
				Input: {
					V: 1
				}
			});
		}
		await runtime.dispatch(sender, "root");
		expect(isDeepFrozen(got)).toBe(true);
	});
});
