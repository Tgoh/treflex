import type { IActionGenerator } from "../../src/Types/IAction";
import type { IAskId } from "../../src/Types/IAskId";
import type { IEffect } from "../../src/Types/IEffect";
import type { IRecord, IRecordExtras } from "../../src/Types/IRecord";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answer } from "../../src/Effects/answer";
import { ask } from "../../src/Effects/ask";
import { defineEffect, implementation } from "../../src/Effects/defineEffect";
import { parallel } from "../../src/Effects/parallel";
import { parallelSettled } from "../../src/Effects/parallelSettled";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { open } from "../../src/Runtime/open";
import { pendingAsksOf } from "../testHelpers";

interface IPayload {
	V: number;
}

interface IDesk {
	$Id: string;
	Payload: IPayload;
	Log: string[];
}

interface IWorld {
	$Id: string;
	Rows: {
		A: number;
	}[];
	Got: number | null;
	Desk: IDesk;
	Log: string[];
	Slot?: unknown;
	Replied?: {
		Ok: boolean;
	};
}

const world = (): IWorld => ({
	$Id: "root",
	Rows: [],
	Got: null,
	Desk: {
		$Id: "desk",
		Payload: {
			V: 1
		},
		Log: []
	},
	Log: []
});

interface IFixtureEffect extends IEffect {
	Type: "results/fixture";
}
const fixture = defineEffect<
	IFixtureEffect,
	{
		Rows: {
			A: number;
		}[];
	}
>("results/fixture");

interface IStampEffect extends IEffect {
	Type: "results/stamp";
}
const stamp = defineEffect<
	IStampEffect,
	{
		At: number;
	}
>("results/stamp", {
	settles: "sync"
});

interface IModule {
	init(): string;
	allowMultiInstance: boolean;
}
interface ILoadEffect extends IEffect {
	Type: "results/load";
}
const load = defineEffect<ILoadEffect, IModule>("results/load", {
	returns: "module"
});

interface IOpaqueEffect extends IEffect {
	Type: "results/opaque";
}
const opaque = defineEffect<IOpaqueEffect, unknown>("results/opaque");

const tick = () =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});

function build() {
	const runtime = createRuntime<IWorld>(world(), {});
	const taps: {
		record: IRecord;
		live?: IRecordExtras;
	}[] = [];
	runtime.on("record", (record, live) =>
		taps.push({
			record: record as IRecord,
			live
		})
	);
	return {
		runtime,
		taps
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the copy at the driver", () => {
	it("hands the action a copy that is not frozen, and leaves the implementation's object alone", async () => {
		const { runtime } = build();
		const shared = {
			Rows: [
				{
					A: 1
				}
			]
		};
		runtime.registerImplementation(implementation(fixture, () => shared));
		let received: unknown;
		function* adopt(draft: IWorld): IActionGenerator {
			const result = yield* fixture();
			received = result;
			result.Rows.push({
				A: 2
			});
			draft.Rows = result.Rows;
		}
		await runtime.dispatch(adopt, "root");
		function* edit(draft: IWorld): IActionGenerator {
			draft.Rows[0].A = 99;
		}
		await runtime.dispatch(edit, "root");

		expect(received).not.toBe(shared);
		expect(Object.isFrozen(received)).toBe(false);
		expect(shared).toEqual({
			Rows: [
				{
					A: 1
				}
			]
		});
		expect(runtime.state.Rows).toEqual([
			{
				A: 99
			},
			{
				A: 2
			}
		]);
	});

	it("copies a sync type's result too", async () => {
		const { runtime } = build();
		const shared = {
			At: 5
		};
		runtime.registerImplementation(implementation(stamp, () => shared));
		let received: unknown;
		function* act(): IActionGenerator {
			received = yield* stamp();
		}
		await runtime.dispatch(act, "root");
		expect(received).toEqual(shared);
		expect(received).not.toBe(shared);
	});

	it("fails the yield on a non-plain result, naming the effect type, as an ordinary failed settlement", async () => {
		const { runtime, taps } = build();
		vi.spyOn(console, "error").mockImplementation(() => {});
		runtime.registerImplementation(
			implementation(opaque, () => ({
				When: new Date(0)
			}))
		);
		let caught: unknown;
		function* act(draft: IWorld): IActionGenerator {
			try {
				yield* opaque();
			} catch (error) {
				caught = error;
				draft.Log.push("caught");
			}
		}
		await runtime.dispatch(act, "root");
		expect(String(caught)).toContain('effect "results/opaque"');
		expect(String(caught)).toContain("Date at [When]");
		expect(runtime.state.Log).toEqual([
			"caught"
		]);
		const effect = taps.find((t) => t.record.Kind === "effect" && t.record.Type === "results/opaque")!.record as Extract<
			IRecord,
			{
				Kind: "effect";
			}
		>;
		const response = taps.find((t) => t.record.Kind === "response" && t.record.ForSeq === effect.Seq)!.record;
		expect(response).toHaveProperty("Error");
	});

	it("refuses what plain data has no form for: NaN, functions, undefined array elements", async () => {
		const { runtime } = build();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		for (const value of [
			NaN,
			() => {},
			[
				undefined
			]
		]) {
			runtime.registerImplementation("results/opaque", () => value);
			function* act(): IActionGenerator {
				yield* opaque();
			}
			await expect(runtime.dispatch(act, "root")).rejects.toThrow(/results\/opaque/);
		}
	});

	it("exempts the fan-outs, whose results are their branches' own", async () => {
		const { runtime } = build();
		let branch: unknown;
		let settledBranch: unknown;
		function* mapBranch(): IActionGenerator<Map<string, number>> {
			return new Map([
				[
					"a",
					1
				]
			]);
		}
		function* act(): IActionGenerator {
			const [result] = yield* parallel(mapBranch());
			branch = result;
			const [outcome] = yield* parallelSettled(mapBranch());
			settledBranch = outcome.ok ? outcome.value : undefined;
		}
		await runtime.dispatch(act, "root");
		expect(branch).toBeInstanceOf(Map);
		expect(settledBranch).toBeInstanceOf(Map);
	});

	it('exempts a returns: "module" result whole, keeping identity and functions', async () => {
		const { runtime } = build();
		const module: IModule = {
			init: () => "ran",
			allowMultiInstance: true
		};
		runtime.registerImplementation(implementation(load, () => module));
		let received: unknown;
		function* act(draft: IWorld): IActionGenerator {
			const feature = yield* load();
			received = feature;
			draft.Log.push(feature.init());
			draft.Got = feature.allowMultiInstance ? 1 : 0;
		}
		await runtime.dispatch(act, "root");
		expect(received).toBe(module);
		expect(runtime.state.Log).toEqual([
			"ran"
		]);
		expect(runtime.state.Got).toBe(1);
	});

	it('settles a returns: "module" result that is not an object', async () => {
		const { runtime } = build();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const seen: unknown[] = [];
		for (const value of [
			undefined,
			5
		]) {
			runtime.registerImplementation("results/load", () => value);
			function* act(): IActionGenerator {
				seen.push(yield* load());
			}
			await runtime.dispatch(act, "root");
		}
		expect(seen).toEqual([
			undefined,
			5
		]);
	});

	it("puts the action's copy on the live record tap, not the implementation's object", async () => {
		const { runtime, taps } = build();
		const shared = {
			Rows: []
		};
		runtime.registerImplementation(implementation(fixture, () => shared));
		let received: unknown;
		function* act(): IActionGenerator {
			received = yield* fixture();
		}
		await runtime.dispatch(act, "root");
		const effect = taps.find((t) => t.record.Kind === "effect" && t.record.Type === "results/fixture")!.record as Extract<
			IRecord,
			{
				Kind: "effect";
			}
		>;
		const response = taps.find((t) => t.record.Kind === "response" && t.record.ForSeq === effect.Seq)!;
		expect(response.live?.result).toBe(received);
		expect(response.live?.result).not.toBe(shared);
	});
});

describe("keeping code out of state", () => {
	it('refuses a returns: "module" result written whole, and a function, in development', async () => {
		const { runtime } = build();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const module: IModule = {
			init: () => "ran",
			allowMultiInstance: false
		};
		runtime.registerImplementation(implementation(load, () => module));
		function* seatModule(draft: IWorld): IActionGenerator {
			draft.Slot = yield* load();
		}
		function* seatFunction(draft: IWorld): IActionGenerator {
			draft.Slot = (yield* load()).init;
		}
		function* seatData(draft: IWorld): IActionGenerator {
			const feature = yield* load();
			draft.Slot = {
				Allow: feature.allowMultiInstance
			};
		}
		await expect(runtime.dispatch(seatModule, "root")).rejects.toThrow(NonPlainDataError);
		await expect(runtime.dispatch(seatModule, "root")).rejects.toThrow(/a write to state is not plain: module result at \[Slot\]/);
		await expect(runtime.dispatch(seatFunction, "root")).rejects.toThrow(/a write to state is not plain: function at \[Slot\]/);
		expect(runtime.state.Slot).toBeUndefined();
		await runtime.dispatch(seatData, "root");
		expect(runtime.state.Slot).toEqual({
			Allow: false
		});
	});

	// unwrapValue copies a frozen object, so a check made after it would lose the identity.
	it("refuses a frozen module result by identity, ahead of unwrapValue", async () => {
		const runtime = createRuntime<IWorld>(world());
		vi.spyOn(console, "error").mockImplementation(() => {});
		runtime.registerImplementation(
			implementation(load, () =>
				Object.freeze({
					init: () => "x",
					allowMultiInstance: true
				})
			)
		);
		function* seatModule(draft: IWorld): IActionGenerator {
			draft.Slot = yield* load();
		}
		await expect(runtime.dispatch(seatModule, "root")).rejects.toThrow(/not plain: module result at \[Slot\]/);
		expect(runtime.state.Slot).toBeUndefined();
	});

	it("checks with no tap", async () => {
		const runtime = createRuntime<IWorld>(world());
		vi.spyOn(console, "error").mockImplementation(() => {});
		runtime.registerImplementation(
			implementation(load, () => ({
				init: () => "x",
				allowMultiInstance: true
			}))
		);
		function* seatModule(draft: IWorld): IActionGenerator {
			draft.Slot = yield* load();
		}
		await expect(runtime.dispatch(seatModule, "root")).rejects.toThrow(/not plain: module result/);
	});
});

describe("the copy at the sender", () => {
	function* answerer(draft: IDesk, id: IAskId<IPayload>): IActionGenerator {
		yield* answer(id, draft.Payload);
		draft.Payload.V = 2;
	}

	function* asker(draft: IWorld) {
		const got = yield* open(
			ask<IPayload>(draft.Desk, {
				Path: "Desk"
			})
		);
		draft.Got = got?.V ?? null;
	}

	it("delivers the answer as a copy, not the answerer's node", async () => {
		const { runtime } = build();
		const asking = runtime.dispatch(asker, "root");
		await tick();
		await runtime.dispatch(answerer, "desk", pendingAsksOf(runtime, runtime.state)[0]!.Id as IAskId<IPayload>);
		await asking;
		expect(runtime.state.Desk.Payload.V).toBe(2);
		expect(runtime.state.Got).toBe(1);
	});

	it("fails the answering yield on non-plain data and leaves the ask open for a plain answer", async () => {
		const runtime = createRuntime<IWorld>(world());
		vi.spyOn(console, "error").mockImplementation(() => {});
		function* badThenGood(draft: IDesk, id: IAskId<IPayload>): IActionGenerator {
			try {
				yield* answer(id, {
					V: new Date(0)
				} as unknown as IPayload);
			} catch (error) {
				draft.Log.push(error instanceof NonPlainDataError ? "refused" : "other");
			}
			yield* answer(id, {
				V: 3
			});
		}
		const asking = runtime.dispatch(asker, "root");
		await tick();
		await runtime.dispatch(badThenGood, "desk", pendingAsksOf(runtime, runtime.state)[0]!.Id as IAskId<IPayload>);
		await asking;
		expect(runtime.state.Desk.Log).toEqual([
			"refused"
		]);
		expect(runtime.state.Got).toBe(3);
	});
});
