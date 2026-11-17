import type { IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it, vi } from "vitest";
import { createTestRuntime, settled } from "../../src/Testing/createTestRuntime";
import { combineReports, drainReports, holdReports, report } from "../../src/Testing/reports";
import { unhandledDuring } from "../unhandledDuring";

function* fails(_draft: object): IActionGenerator {
	throw new Error("boom");
}

describe("holding, as treflex/vitest sets it", () => {
	it("holds each report until drained", () => {
		const first = new Error("first");
		const second = new Error("second");
		report(first);
		report(second);
		expect(drainReports()).toEqual([
			first,
			second
		]);
		expect(drainReports()).toEqual([]);
	});

	it("combines one report as itself, and more as an AggregateError on the first one's frames", () => {
		const first = new Error("first");
		first.stack = "Error: first\n    at builder (app.test.ts:3:5)";
		const second = new Error("second");
		expect(combineReports([])).toBeUndefined();
		expect(
			combineReports([
				first
			])
		).toBe(first);
		const combined = combineReports([
			first,
			second
		]) as AggregateError;
		expect(combined).toBeInstanceOf(AggregateError);
		expect(combined.errors).toEqual([
			first,
			second
		]);
		expect(combined.message).toBe("[treflex] 2 reports:\n1. first\n2. second");
		expect(combined.stack).toBe(`AggregateError: ${combined.message}\n    at builder (app.test.ts:3:5)`);
	});
});

describe("raising, without treflex/vitest", () => {
	const raising = async (run: () => Promise<void>): Promise<unknown[]> => {
		holdReports(false);
		try {
			return await unhandledDuring(run);
		} finally {
			holdReports();
		}
	};

	it("raises a report as an unhandled rejection", async () => {
		const raised = new Error("raised");
		const heard = await raising(async () => {
			report(raised);
		});
		expect(heard).toEqual([
			raised
		]);
	});

	it("raises under fake timers", async () => {
		const raised = new Error("raised under fake timers");
		vi.useFakeTimers();
		try {
			const heard = await raising(async () => {
				report(raised);
			});
			expect(heard).toEqual([
				raised
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("raises a test runtime's failure once", async () => {
		const heard = await raising(async () => {
			const runtime = createTestRuntime({
				$Id: "Root"
			});
			void runtime.dispatch(fails, "Root");
			await settled();
		});
		expect(heard.map((error) => (error as Error).message)).toEqual([
			expect.stringContaining('[treflex] createTestRuntime: action "fails" on "Root" failed.')
		]);
	});
});
