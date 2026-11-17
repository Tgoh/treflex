import type { IActionGenerator } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import { createRuntime } from "treflex";
import { rawOf } from "treflex/internal";
import { describe, expect, it, vi } from "vitest";
import { getFrames } from "../src/createFrames";
import { createComponentEntity } from "../src/useComponentState";

vi.mock("../../core/src/Utility/devMode", () => ({
	DEV: false
}));

const seed = () => ({
	$Id: "root",
	Notes: {
		Deep: {
			Text: "x"
		}
	},
	Left: {
		$Id: "left",
		Items: [
			{
				$Id: "a"
			}
		]
	}
});

describe("in production", () => {
	it("frames are frozen, and a write to one throws", () => {
		const frames = getFrames(createRuntime<any>(seed()));
		const root = frames.root() as any;
		expect(Object.isFrozen(root)).toBe(true);
		expect(Object.isFrozen(root.Notes.Deep)).toBe(true);
		expect(Object.isFrozen(root.Left.Items)).toBe(true);
		expect(() => {
			root.Notes.Deep.Text = "y";
		}).toThrow(TypeError);
		expect(Object.isFrozen(frames.entity("left"))).toBe(true);
	});

	it("a view write throws", () => {
		const runtime = createRuntime<any>(seed());
		expect(() => {
			runtime.state.Notes.Deep.Text = "y";
		}).toThrow(/read-only outside a dispatch/);
		expect(runtime.state.Notes.Deep.Text).toBe("x");
	});

	it("a component state seed spreading a node copies what is nested in it, so a write to it stays there", async () => {
		const runtime = createRuntime<any>(seed());
		const local = createComponentEntity<any>(runtime as IRuntimeInternal<any>, () => ({
			...runtime.state.Notes
		}));
		const stop = local.mount();
		await local.dispatch(function* (s: any): IActionGenerator {
			s.Deep.Text = "local";
		});
		expect(runtime.state.Notes.Deep.Text).toBe("x");
		expect(Object.isFrozen(rawOf(runtime.state.Notes.Deep))).toBe(false);
		stop();
	});

	it("a component state seed lands as a copy, and the caller's object is frozen", () => {
		const made = {
			Rows: [
				1
			]
		};
		const local = createComponentEntity<any>(createRuntime<any>(seed()) as IRuntimeInternal<any>, () => made);
		expect(rawOf(local.view)).not.toBe(made);
		expect(() => made.Rows.push(2)).toThrow(TypeError);
		expect((rawOf(local.view) as any).Rows).toEqual([
			1
		]);
	});
});
