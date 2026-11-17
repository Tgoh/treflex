import type { IRuntimeOptions } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it, vi } from "vitest";
import { generateGuid } from "../../src/Effects/generateGuid";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createTraceAggregator } from "../../src/Runtime/createTraceAggregator";
import { createTreeState } from "../testHelpers";

let testIdCounter = 0;
function createTestIdAccessor() {
	const id = `test-${++testIdCounter}`;
	return () => id;
}

function createTestRuntime(options?: IRuntimeOptions) {
	const runtime = createRuntime(
		{
			$Id: "root"
		},
		options
	);
	runtime.registerImplementation("fetch", () => "mocked");
	return runtime;
}

describe("createRuntime", () => {
	it("ships neither setState nor mutate on the runtime", () => {
		const runtime = createTestRuntime() as unknown as Record<string, unknown>;
		expect(typeof runtime.setState).toBe("undefined");
		expect(typeof runtime.mutate).toBe("undefined");
	});

	describe("processAction", () => {
		it("runs actions that mutate state", async () => {
			const runtime = createTestRuntime();
			const { raw, setState } = createTreeState({
				value: ""
			});

			function* setVal(draft: { value: string }): IActionGenerator {
				draft.value = "done";
			}

			await runtime.processAction(setVal, (() => runtime.state) as any, setState, createTestIdAccessor());
			expect(raw.value).toBe("done");
		});

		it("runs actions with effects", async () => {
			const runtime = createTestRuntime();
			const { raw, setState } = createTreeState({
				data: ""
			});

			function* loadData(draft: { data: string }): IActionGenerator {
				const result: string = yield {
					Type: "fetch"
				};
				draft.data = result;
			}

			await runtime.processAction(loadData, (() => runtime.state) as any, setState, createTestIdAccessor());
			expect(raw.data).toBe("mocked");
		});
	});

	describe("onError", () => {
		it("calls onError when an action throws", async () => {
			const onError = vi.fn();
			const runtime = createTestRuntime({
				onError
			});
			const { setState } = createTreeState({});

			function* failing(_draft: object): IActionGenerator {
				throw new Error("runtime error");
			}

			await expect(runtime.processAction(failing, (() => runtime.state) as any, setState, createTestIdAccessor())).rejects.toThrow(
				"runtime error"
			);
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "runtime error"
				}),
				expect.objectContaining({
					Name: null,
					Label: "failing"
				})
			);
		});
	});

	describe("trace aggregation via the record tap", () => {
		it("passes traces through to a createTraceAggregator subscriber", async () => {
			const onTrace = vi.fn();
			const runtime = createTestRuntime();
			createTraceAggregator(runtime, onTrace);
			const { setState } = createTreeState({
				x: 0
			});

			function* inc(draft: { x: number }): IActionGenerator {
				draft.x = 1;
			}
			await runtime.processAction(inc, (() => runtime.state) as any, setState, createTestIdAccessor());

			expect(onTrace).toHaveBeenCalledOnce();
			const trace = onTrace.mock.calls[0][0];
			expect(trace.label).toBe("inc");
			expect(trace.entries.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("effect registration", () => {
		it("carries out a hand-written publish as the runtime's operation", async () => {
			const runtime = createTestRuntime();
			const { setState } = createTreeState({});

			function* pub(_draft: object): IActionGenerator {
				yield {
					Type: "publish",
					Data: {
						Type: "test"
					}
				};
			}

			await runtime.processAction(pub, (() => runtime.state) as any, setState, createTestIdAccessor());
		});
	});

	describe("no ambient reactive owner", () => {
		it("memoizes and invalidates selectors, silently", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const runtime = createRuntime<{
				$Id: string;
				Count: number;
			}>({
				$Id: "Root",
				Count: 1
			}) as IRuntimeInternal<{
				$Id: string;
				Count: number;
			}>;

			let runs = 0;
			function* doubled(draft: { Count: number }) {
				runs++;
				return draft.Count * 2;
			}
			expect(runtime.runSelector(doubled as any, () => runtime.state)).toBe(2);
			expect(runtime.runSelector(doubled as any, () => runtime.state)).toBe(2);
			expect(runs).toBe(1);

			function* bump(draft: { Count: number }): IActionGenerator {
				draft.Count = 5;
			}
			await runtime.dispatch(bump, "Root");
			expect(runtime.runSelector(doubled as any, () => runtime.state)).toBe(10);
			expect(runs).toBe(2);

			runtime.dispose();
			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		});
	});

	describe("the implementations option", () => {
		it("seeds a narrowed implementation, and one that replaces generateGuid, silently", async () => {
			// The type-level half: an implementation declaring its own descriptor type
			// must compile through the option. Pinned at the call, because
			// IEffectImplementation<IEffect> would reject it under
			// strictFunctionTypes and the failure is a compile error, not a
			// test failure.
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const runtime = createRuntime(
				{
					$Id: "root"
				},
				{
					implementations: {
						"seeded/echo": (e: { Type: "seeded/echo"; Message: string }) => `seeded:${e.Message}`,
						generateGuid: () => "seeded-guid"
					}
				}
			);
			function* raise(_draft: object): IActionGenerator<string> {
				const echoed: string = yield {
					Type: "seeded/echo",
					Message: "boom"
				};
				return `${echoed} ${yield* generateGuid()}`;
			}
			expect(await runtime.dispatch(raise, "root")).toBe("seeded:boom seeded-guid");
			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
			runtime.dispose();
		});
	});

	describe("dispose", () => {
		it("exposes a dispose method that runs without throwing", () => {
			const runtime = createRuntime({
				$Id: "root",
				child: {
					$Id: "child"
				}
			});
			expect(() => runtime.dispose()).not.toThrow();
		});
	});
});
