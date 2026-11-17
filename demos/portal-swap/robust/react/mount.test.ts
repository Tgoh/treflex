import { createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountNow } from "./mount";

const flush = vi.hoisted(() => ({
	throwNext: false
}));

vi.mock("react-dom", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-dom")>();
	return {
		...actual,
		flushSync: (run: () => void) => {
			if (!flush.throwNext) return actual.flushSync(run);
			flush.throwNext = false;
			actual.flushSync(run);
			throw new Error("flushSync threw");
		}
	};
});

let explode: (() => void) | undefined;

/** Renders nothing until `explode` is called, then throws, with no boundary above it. */
function Late() {
	const [boom, setBoom] = useState(false);
	explode = () => setBoom(true);
	if (boom) throw new Error("late failure");
	return null;
}

let element: HTMLElement;
let reported: unknown[];

beforeEach(() => {
	element = document.createElement("div");
	document.body.append(element);
	reported = [];
	vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	explode = undefined;
	document.body.innerHTML = "";
});

const later = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("mountNow", () => {
	it("throws an error from the mount, and reports one after it as React would", async () => {
		expect(() =>
			mountNow(
				element,
				createElement(() => {
					throw new Error("mount failure");
				})
			)
		).toThrow("mount failure");
		expect(reported).toEqual([]);
		expect(element.childNodes).toHaveLength(0);
		expect(Object.keys(element).some((key) => key.startsWith("__reactContainer") && (element as any)[key] !== null)).toBe(false);

		const unmount = mountNow(element, createElement(Late));
		explode!();
		await later();
		expect(reported.map(String)).toEqual([
			"Error: late failure"
		]);
		unmount();
	});

	it("unmounts the root when flushSync throws, so nothing in it runs on", async () => {
		flush.throwNext = true;
		expect(() => mountNow(element, createElement(Late))).toThrow("flushSync threw");
		expect(Object.keys(element).some((key) => key.startsWith("__reactContainer") && (element as any)[key] !== null)).toBe(false);
		explode!();
		await later();
		expect(reported).toEqual([]);
		expect(element.childNodes).toHaveLength(0);
	});
});
