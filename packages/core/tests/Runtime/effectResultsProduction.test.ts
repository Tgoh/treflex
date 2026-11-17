import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEffect } from "../../src/Types/IEffect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineEffect, implementation } from "../../src/Effects/defineEffect";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { SyncEffectWorkError } from "../../src/Runtime/effectDeclarations";
import { treeWrite } from "../testHelpers";

// DEV is a module constant, so this file mocks it off for the whole file.
vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

interface IWorld {
	$Id: string;
	Slot?: unknown;
	Count: number;
}

interface ILoadEffect extends IEffect {
	Type: "prod/load";
}
const load = defineEffect<
	ILoadEffect,
	{
		init(): void;
	}
>("prod/load", {
	returns: "module"
});

interface IOpaqueEffect extends IEffect {
	Type: "prod/opaque";
}
const opaque = defineEffect<IOpaqueEffect, unknown>("prod/opaque");

interface IStampEffect extends IEffect {
	Type: "prod/stamp";
}
const stamp = defineEffect<IStampEffect, number>("prod/stamp", {
	settles: "sync"
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("in a production build", () => {
	it.each([
		"no tap",
		"a tap"
	])("refuses code written into state, a module result or a function, with %s", async (tap) => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const runtime = createRuntime<IWorld>({
			$Id: "root",
			Count: 0
		});
		if (tap === "a tap") {
			runtime.on("record", () => {});
		}
		runtime.registerImplementation(
			implementation(load, () => ({
				init: () => {}
			}))
		);
		function* seat(draft: IWorld): IActionGenerator {
			draft.Slot = yield* load();
		}
		await expect(runtime.dispatch(seat, "root")).rejects.toThrow(/not plain: module result at \[Slot\]/);
		expect(() =>
			treeWrite(runtime, (s) => {
				s.Slot = () => {};
			})
		).toThrow(/not plain: function at \[(AppState\.)?Slot\]/);
		expect(runtime.state.Slot).toBeUndefined();
	});

	it("still refuses a non-plain effect result", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const runtime = createRuntime<IWorld>({
			$Id: "root",
			Count: 0
		});
		runtime.registerImplementation(implementation(opaque, () => new Map()));
		function* act(): IActionGenerator {
			yield* opaque();
		}
		await expect(runtime.dispatch(act, "root")).rejects.toThrow(/effect "prod\/opaque": the result is not plain: Map at \[\]/);
	});

	it("still refuses a write inside a sync dispatch", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const runtime = createRuntime<IWorld>({
			$Id: "root",
			Count: 0
		});
		runtime.registerImplementation(
			implementation(stamp, () => {
				treeWrite(runtime, (s) => {
					s.Count = 1;
				});
				return 1;
			})
		);
		function* act(): IActionGenerator {
			yield* stamp();
		}
		await expect(runtime.dispatch(act, "root")).rejects.toBeInstanceOf(SyncEffectWorkError);
		expect(runtime.state.Count).toBe(0);
	});
});
