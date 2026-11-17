import type { IActionGenerator } from "../../src/Types/IAction";
import type { IActionTrace } from "../../src/Types/IActionTrace";
import { describe, expect, it, vi } from "vitest";
import { parallel } from "../../src/Effects/parallel";
import { createJournal } from "../../src/Runtime/createJournal";
import { createTraceAggregator } from "../../src/Runtime/createTraceAggregator";
import { createProcessAction, type IRuntimeStoreReader } from "../../src/Runtime/processAction";
import { createTestRuntime, createTreeState } from "../testHelpers";

const emptyRuntimeStoreReader: IRuntimeStoreReader = ((key: string) => {
	throw new Error(`[test] No runtime value registered for key "${String(key)}".`);
}) as IRuntimeStoreReader;

describe("createProcessAction", () => {
	describe("synchronous actions (no yields)", () => {
		it("mutates state", async () => {
			const runtime = createTestRuntime({
				$Id: "test",
				name: "before"
			});

			function* setName(
				draft: {
					name: string;
				},
				value: string
			): IActionGenerator {
				draft.name = value;
			}

			await runtime.dispatch(setName, "test", "after");
			expect(runtime.state.name).toBe("after");
		});

		it("returns the generator return value", async () => {
			const runtime = createTestRuntime({
				$Id: "test",
				value: 42
			});

			function* readValue(draft: { value: number }): IActionGenerator<number> {
				return draft.value;
			}

			const result = await runtime.dispatch(readValue, "test");
			expect(result).toBe(42);
		});
	});

	describe("actions with effects", () => {
		it("yields an effect and receives the result", async () => {
			const runtime = createTestRuntime(
				{
					$Id: "test",
					data: ""
				},
				{
					fetch: () => "fetched data"
				}
			);

			function* loadData(draft: { data: string }): IActionGenerator {
				const result: string = yield {
					Type: "fetch"
				};
				draft.data = result;
			}

			await runtime.dispatch(loadData, "test");
			expect(runtime.state.data).toBe("fetched data");
		});

		it("yields multiple effects sequentially", async () => {
			const runtime = createTestRuntime(
				{
					$Id: "test",
					items: [] as string[]
				},
				{
					fetch: (e: any) => e.url
				}
			);

			function* loadItems(draft: { items: string[] }): IActionGenerator {
				const a: string = yield {
					Type: "fetch",
					url: "first"
				};
				const b: string = yield {
					Type: "fetch",
					url: "second"
				};
				draft.items = [
					a,
					b
				];
			}

			await runtime.dispatch(loadItems, "test");
			expect(runtime.state.items).toEqual([
				"first",
				"second"
			]);
		});

		it("draft reflects committed writes across yields", async () => {
			const state = {
				$Id: "test",
				count: 0
			};
			const runtime = createTestRuntime(state, {
				noop: () => undefined
			});

			const counts: number[] = [];

			function* incrementTwice(draft: { count: number }): IActionGenerator {
				draft.count = 1;
				counts.push(draft.count);
				yield {
					Type: "noop"
				};
				counts.push(draft.count);
				draft.count = 2;
			}

			await runtime.dispatch(incrementTwice, "test");
			expect(counts).toEqual([
				1,
				1
			]);
			expect(runtime.state.count).toBe(2);
		});
	});

	describe("error handling", () => {
		it("calls onError when an action throws synchronously", async () => {
			const onError = vi.fn();
			const runtime = createTestRuntime(
				{
					$Id: "test"
				},
				{},
				{
					onError
				}
			);

			function* failing(_draft: object): IActionGenerator {
				throw new Error("sync failure");
			}

			await expect(runtime.dispatch(failing, "test")).rejects.toThrow("sync failure");
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "sync failure"
				}),
				{
					ActionName: "failing",
					EntityId: "test"
				}
			);
		});

		it("calls onError when an effect implementation rejects", async () => {
			const onError = vi.fn();
			const runtime = createTestRuntime(
				{
					$Id: "test"
				},
				{
					anything: async () => {
						throw new Error("effect failure");
					}
				},
				{
					onError
				}
			);

			function* failingEffect(_draft: object): IActionGenerator {
				yield {
					Type: "anything"
				};
			}

			await expect(runtime.dispatch(failingEffect, "test")).rejects.toThrow("effect failure");
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "effect failure"
				}),
				expect.anything()
			);
		});

		it("forwards effect errors into the generator for try/catch", async () => {
			const runtime = createTestRuntime(
				{
					$Id: "test",
					error: ""
				},
				{
					fail: () => {
						throw new Error("caught this");
					}
				}
			);

			function* resilient(draft: { error: string }): IActionGenerator {
				try {
					yield {
						Type: "fail"
					};
				} catch (e: any) {
					draft.error = e.message;
				}
			}

			await runtime.dispatch(resilient, "test");
			expect(runtime.state.error).toBe("caught this");
		});
	});

	describe("generator cleanup", () => {
		it("calls finally block when action completes normally", async () => {
			const runtime = createTestRuntime({
				$Id: "test"
			});
			let finallyCalled = false;

			function* withFinally(_draft: object): IActionGenerator {
				try {
				} finally {
					finallyCalled = true;
				}
			}

			await runtime.dispatch(withFinally, "test");
			expect(finallyCalled).toBe(true);
		});

		it("calls finally block when action throws", async () => {
			const onError = vi.fn();
			const runtime = createTestRuntime(
				{
					$Id: "test"
				},
				{},
				{
					onError
				}
			);
			let finallyCalled = false;

			function* withFinally(_draft: object): IActionGenerator {
				try {
					throw new Error("boom");
				} finally {
					finallyCalled = true;
				}
			}

			await expect(runtime.dispatch(withFinally, "test")).rejects.toThrow("boom");
			expect(finallyCalled).toBe(true);
		});
	});

	describe("tracing", () => {
		it("emits a trace with mutation steps for synchronous actions", async () => {
			const onTrace = vi.fn();
			const runtime = createTestRuntime(
				{
					$Id: "test",
					name: ""
				},
				{}
			);
			createTraceAggregator(runtime, onTrace);

			function* setName(draft: { name: string }): IActionGenerator {
				draft.name = "test";
			}
			await runtime.dispatch(setName, "test");

			expect(onTrace).toHaveBeenCalledOnce();
			const trace: IActionTrace = onTrace.mock.calls[0][0];
			expect(trace.action).toBe("setName");
			expect(trace.duration).toBeGreaterThanOrEqual(0);
			expect(trace.error).toBeUndefined();

			const stepEntries = trace.entries.filter((s) => s.type === "step");
			expect(stepEntries.length).toBeGreaterThanOrEqual(1);
			expect(stepEntries[0].changes.length).toBeGreaterThanOrEqual(1);
			expect(stepEntries[0].changes[0]).toMatchObject({
				Path: [
					"name"
				],
				Prev: "",
				Value: "test"
			});
		});

		it("emits a trace with interleaved effect and mutation steps", async () => {
			const onTrace = vi.fn();
			const runtime = createTestRuntime(
				{
					$Id: "test",
					data: ""
				},
				{
					fetch: () => "result"
				}
			);
			createTraceAggregator(runtime, onTrace);

			function* loadData(draft: { data: string }): IActionGenerator {
				const result: string = yield {
					Type: "fetch"
				};
				draft.data = result;
			}

			await runtime.dispatch(loadData, "test");

			const trace: IActionTrace = onTrace.mock.calls[0][0];
			const effectEntries = trace.entries.filter((s) => s.type === "effect");
			expect(effectEntries.length).toBe(1);
			expect(effectEntries[0]).toMatchObject({
				type: "effect",
				effect: {
					Type: "fetch"
				},
				result: "result"
			});
			expect(effectEntries[0].duration).toBeGreaterThanOrEqual(0);
		});

		it("includes error in trace when action fails", async () => {
			const onTrace = vi.fn();
			const onError = vi.fn();
			const runtime = createTestRuntime(
				{
					$Id: "test"
				},
				{},
				{
					onError
				}
			);
			createTraceAggregator(runtime, onTrace);

			function* failing(_draft: object): IActionGenerator {
				throw new Error("traced failure");
			}

			await expect(runtime.dispatch(failing, "test")).rejects.toThrow("traced failure");

			const trace: IActionTrace = onTrace.mock.calls[0][0];
			expect(trace.error).toMatchObject({
				message: "traced failure"
			});
		});

		it("does not pay observability cost when nothing is subscribed", async () => {
			const runtime = createTestRuntime({
				$Id: "test",
				name: ""
			});

			function* setName(draft: { name: string }): IActionGenerator {
				draft.name = "test";
			}

			await runtime.dispatch(setName, "test");
			expect(runtime.state.name).toBe("test");
		});

		it("attributes writes through held sub-references to the right step", async () => {
			const onTrace = vi.fn();
			const runtime = createTestRuntime(
				{
					$Id: "test",
					item: {
						value: "before"
					}
				},
				{
					noop: () => undefined
				}
			);
			createTraceAggregator(runtime, onTrace);

			function* twoStep(draft: {
				item: {
					value: string;
				};
			}): IActionGenerator {
				const held = draft.item;
				held.value = "mid";
				yield {
					Type: "noop"
				};
				held.value = "after";
			}

			await runtime.dispatch(twoStep, "test");
			expect(runtime.state.item.value).toBe("after");

			const trace: IActionTrace = onTrace.mock.calls[0][0];
			const steps = trace.entries.filter((s) => s.type === "step");
			const allChanges = steps.flatMap((m) => m.changes);
			expect(allChanges).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						Path: [
							"item",
							"value"
						],
						Value: "mid"
					}),
					expect.objectContaining({
						Path: [
							"item",
							"value"
						],
						Value: "after"
					})
				])
			);
		});
	});

	describe("the in-flight row", () => {
		function makeAssembly() {
			const gates: (() => void)[] = [];
			const assembly = createProcessAction({
				effectProcessor: (effect) => {
					if (effect.Type === "park") {
						return new Promise<void>((resolve) => {
							gates.push(resolve);
						});
					}
					return undefined;
				},
				runtimeStoreReader: emptyRuntimeStoreReader,
				onError: () => {},
				journal: createJournal()
			});
			return {
				...assembly,
				release: () => {
					gates.shift()?.();
				}
			};
		}

		const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

		function* park(): IActionGenerator {
			yield {
				Type: "park"
			};
		}

		it("a childless action releases its row at settle", async () => {
			const { state, setState } = createTreeState({});
			const a = makeAssembly();

			function* childless(_draft: object): IActionGenerator {
				yield* park();
			}

			const run = a.processAction(
				childless,
				() => state,
				setState,
				() => "test"
			);
			await tick();
			expect(a.runningActions("test").length).toBe(1);
			a.release();
			await run;
			expect(a.runningActions("test").length).toBe(0);
		});

		it("an action whose branches all ended before it settled releases at settle", async () => {
			const { state, setState } = createTreeState({});
			const a = makeAssembly();

			function* fanning(_draft: object): IActionGenerator {
				yield* parallel(park());
			}

			const run = a.processAction(
				fanning,
				() => state,
				setState,
				() => "test"
			);
			await tick();
			expect(a.runningActions("test").length).toBe(1);
			a.release();
			await run;
			expect(a.runningActions("test").length).toBe(0);
		});
	});
});
