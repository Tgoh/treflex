import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEffect } from "../../src/Types/IEffect";
import { describe, expect, it, vi } from "vitest";
import { defineEffect } from "../../src/Effects/defineEffect";
import { start } from "../../src/Effects/start";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

interface IWorld {
	$Id: string;
	Saved?: any;
}

interface IProbeEffect extends IEffect {
	Type: "crossingProd/probe";
	Input: unknown;
}
const probe = defineEffect<IProbeEffect, unknown>("crossingProd/probe");

describe.each([
	{
		journal: true
	},
	{
		journal: false
	}
])("crossings in production with a tap: $journal", ({ journal }) => {
	const build = () => {
		const runtime = createRuntime<IWorld>(
			{
				$Id: "root"
			},
			{
				onError: () => {},
				implementations: {
					"crossingProd/probe": () => undefined
				}
			}
		);
		if (journal) {
			runtime.on("record", () => {});
		}
		return runtime;
	};

	it("refuses a non-plain argument", async () => {
		function* take(_draft: IWorld, _arg: unknown): IActionGenerator {}
		await expect(build().dispatch(take, "root", new Date(0))).rejects.toThrow(NonPlainDataError);
	});

	it("refuses a non-plain effect input in the sender", async () => {
		let refusal: unknown;
		function* sender(): IActionGenerator {
			try {
				yield* probe({
					Input: new Map()
				});
			} catch (error) {
				refusal = error;
			}
		}
		await build().dispatch(sender, "root");
		expect(refusal).toBeInstanceOf(NonPlainDataError);
	});

	it("delivers a mid-list undefined argument as undefined, with the later argument intact", async () => {
		let got: unknown[] = [];
		function* take(_draft: IWorld, ...args: unknown[]): IActionGenerator {
			got = args;
		}
		await build().dispatch(take, "root", undefined, 1);
		expect(got).toEqual([
			undefined,
			1
		]);
	});

	it("delivers the same shape through a start", async () => {
		let got: unknown[] = [];
		function* child(_draft: IWorld, ...args: unknown[]): IActionGenerator {
			got = args;
		}
		function* parent(): IActionGenerator {
			yield* start(child, "root", undefined, 1);
		}
		await build().dispatch(parent, "root");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(got).toEqual([
			undefined,
			1
		]);
	});

	it("refuses an undefined inside an array argument", async () => {
		function* take(_draft: IWorld, _a: unknown): IActionGenerator {}
		await expect(
			build().dispatch(take, "root", [
				undefined,
				1
			])
		).rejects.toThrow(/undefined array element at \[0\.0\].*pass null instead/);
	});

	it("says no implementation is registered for a bare yield of a generator", async () => {
		function* inner(): IActionGenerator {}
		function* outer(): IActionGenerator {
			yield inner() as never;
		}
		await expect(build().dispatch(outer, "root")).rejects.toThrow(/No implementation registered for effect type/);
	});

	it("freezes the copy, and it writes into the draft", async () => {
		const got: unknown[] = [];
		function* child(draft: IWorld, arg: any): IActionGenerator {
			got.push(arg);
			draft.Saved = arg;
			draft.Saved.Deep.V = 2;
		}
		function* parent(_draft: IWorld): IActionGenerator {
			yield* start(child, "root", {
				Deep: {
					V: 1
				}
			});
		}
		const runtime = build();
		await runtime.dispatch(parent, "root");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(Object.isFrozen(got[0])).toBe(true);
		expect(runtime.state.Saved.Deep.V).toBe(2);
	});

	it("refuses a function in an argument, and the action never starts", async () => {
		let started = false;
		function* take(_draft: IWorld, _arg: unknown): IActionGenerator {
			started = true;
		}
		await expect(
			build().dispatch(take, "root", {
				Call: () => {}
			})
		).rejects.toThrow(NonPlainDataError);
		expect(started).toBe(false);
	});
});
