import type { IActionGenerator } from "../../src/Types/IAction";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "../../src/Effects/start";
import { actionNamed, named } from "../../src/Runtime/named";
import { settled } from "../../src/Testing/createTestRuntime";
import { nameInA } from "./namedFixtureA";
import { nameInB } from "./namedFixtureB";
import { build, type IDoc, type IWorld } from "./namedShared";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

function* unnamed(draft: IDoc): IActionGenerator {
	draft.N++;
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("named in production", () => {
	it("lets both functions keep a name two modules gave, makes the name resolve to neither, and tells every runtime", async () => {
		const before = build();
		function* first(_draft: IDoc): IActionGenerator {}
		function* copied(_draft: IDoc): IActionGenerator {}
		nameInA(first, "Prod/Copied");
		expect(() => nameInB(copied, "Prod/Copied")).not.toThrow();
		expect(actionNamed("Prod/Copied")).toBeUndefined();
		await settled();
		const after = build();
		await settled();
		for (const h of [
			before,
			after
		]) {
			expect(h.diags.filter((event) => event.code === "action/name-collision")).toEqual([
				{
					severity: "warn",
					code: "action/name-collision",
					message: expect.stringContaining('two functions are named "Prod/Copied"'),
					data: {
						name: "Prod/Copied"
					}
				}
			]);
		}
		await before.runtime.dispatch(first, "a");
		await before.runtime.dispatch(copied, "a");
		expect(
			before.starts().map((record) => [
				record.Name,
				record.Label
			])
		).toEqual([
			[
				"Prod/Copied",
				"first"
			],
			[
				"Prod/Copied",
				"copied"
			]
		]);
	});

	it("tells a listening runtime of a collision once, as it happens", async () => {
		const h = build();
		await settled();
		function* first(_draft: IDoc): IActionGenerator {}
		function* copied(_draft: IDoc): IActionGenerator {}
		nameInA(first, "Prod/Live");
		nameInB(copied, "Prod/Live");
		expect(h.diags.filter((event) => event.data?.name === "Prod/Live").map((event) => event.code)).toEqual([
			"action/name-collision"
		]);
		await settled();
		expect(h.diags.filter((event) => event.data?.name === "Prod/Live")).toHaveLength(1);
	});

	it("tells a disposed runtime nothing", async () => {
		const h = build();
		await settled();
		h.runtime.dispose();
		const heard = h.diags.length;
		function* one(_draft: IDoc): IActionGenerator {}
		function* two(_draft: IDoc): IActionGenerator {}
		named(one, "Prod/AfterDispose");
		named(two, "Prod/AfterDispose");
		expect(h.diags).toHaveLength(heard);
	});

	it("doesn't check a mark after a dispatch", async () => {
		function* late(draft: IDoc): IActionGenerator {
			draft.N++;
		}
		const h = build();
		await h.runtime.dispatch(late, "a");
		expect(() => named(late, "Prod/Late")).not.toThrow();
	});
});

describe("requireNames in production", () => {
	it("runs an unnamed action with Name: null and diags action/unnamed once per function", async () => {
		const h = build({
			requireNames: true
		});
		await h.runtime.dispatch(unnamed, "a");
		await h.runtime.dispatch(unnamed, "a");
		expect(h.runtime.state.Docs[0]!.N).toBe(2);
		expect(
			h.starts().map((record) => [
				record.Name,
				record.Label
			])
		).toEqual([
			[
				null,
				"unnamed"
			],
			[
				null,
				"unnamed"
			]
		]);
		expect(h.diags.filter((event) => event.code === "action/unnamed")).toEqual([
			{
				severity: "warn",
				code: "action/unnamed",
				message: expect.stringContaining('action "unnamed" has no durable name'),
				data: {
					label: "unnamed"
				}
			}
		]);
	});

	it("starts an unnamed action, with one diag", async () => {
		function* startsUnnamed(draft: IWorld): IActionGenerator {
			yield* start(unnamed, draft.Docs[0]!);
		}
		named(startsUnnamed, "Prod/StartsUnnamed");
		const h = build({
			requireNames: true
		});
		await h.runtime.dispatch(startsUnnamed, "root");
		await settled();
		expect(h.runtime.state.Docs[0]!.N).toBe(1);
		expect(h.codes().filter((code) => code === "action/unnamed")).toHaveLength(1);
	});
});
