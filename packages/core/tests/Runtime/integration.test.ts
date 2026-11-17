import type { IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it, vi } from "vitest";
import { createTraceAggregator } from "../../src/Runtime/createTraceAggregator";
import { createTestRuntime } from "../testHelpers";

// Integration tests: wire up createTestRuntime with realistic actions,
// and verify end-to-end state transitions.

describe("integration: processAction + effects", () => {
	it("runs an action that yields fetch and mutates state", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "test",
				items: [] as {
					id: number;
					name: string;
				}[]
			},
			{
				fetch: (e: any) => {
					if (e.Endpoint === "/api/items") {
						return [
							{
								id: 1,
								name: "Item A"
							}
						];
					}
					throw new Error(`No mock response for ${e.Endpoint}`);
				}
			}
		);

		function* loadItems(draft: {
			items: {
				id: number;
				name: string;
			}[];
		}): IActionGenerator {
			const result: any[] = yield {
				Type: "fetch",
				Method: "GET",
				Endpoint: "/api/items",
				Data: undefined
			};
			draft.items = result;
		}

		await runtime.dispatch(loadItems, "test");
		expect(runtime.state.items).toEqual([
			{
				id: 1,
				name: "Item A"
			}
		]);
	});

	it("runs an action that yields generateGuid and assigns it", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "test",
				id: ""
			},
			{
				generateGuid: () => "test-guid-1234"
			}
		);

		function* assignId(draft: { id: string }): IActionGenerator {
			const guid: string = yield {
				Type: "generateGuid"
			};
			draft.id = guid;
		}

		await runtime.dispatch(assignId, "test");
		expect(runtime.state.id).toBe("test-guid-1234");
	});

	it("runs an action that handles an error effect via try/catch", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "test",
				error: ""
			},
			{
				error: (e: any) => {
					throw e.Message;
				}
			},
			{
				onError: () => {}
			}
		);

		function* failGracefully(draft: { error: string }): IActionGenerator {
			try {
				yield {
					Type: "error",
					Message: "something broke"
				};
			} catch (e: any) {
				draft.error = e;
			}
		}

		await runtime.dispatch(failGracefully, "test");
		expect(runtime.state.error).toBe("something broke");
	});

	it("runs a multi-step action with interleaved effects and mutations", async () => {
		const runtime = createTestRuntime(
			{
				$Id: "test",
				user: null as {
					name: string;
				} | null,
				theme: "",
				id: ""
			},
			{
				generateGuid: () => "test-guid-1234",
				fetch: (e: any) => {
					if (e.Endpoint === "/api/user")
						return {
							name: "Alice"
						};
					if (e.Endpoint === "/api/prefs")
						return {
							theme: "dark"
						};
					throw new Error(`No mock response for ${e.Endpoint}`);
				}
			}
		);

		function* initApp(draft: { user: any; theme: string; id: string }): IActionGenerator {
			const id: string = yield {
				Type: "generateGuid"
			};
			draft.id = id;
			const user: any = yield {
				Type: "fetch",
				Method: "GET",
				Endpoint: "/api/user",
				Data: undefined
			};
			draft.user = user;
			const prefs: any = yield {
				Type: "fetch",
				Method: "GET",
				Endpoint: "/api/prefs",
				Data: undefined
			};
			draft.theme = prefs.theme;
		}

		await runtime.dispatch(initApp, "test");

		expect(runtime.state.id).toBe("test-guid-1234");
		expect(runtime.state.user).toEqual({
			name: "Alice"
		});
		expect(runtime.state.theme).toBe("dark");
	});
});

describe("integration: tracing with real effects", () => {
	it("captures effect and mutation entries in correct order", async () => {
		const onTrace = vi.fn();
		const runtime = createTestRuntime(
			{
				$Id: "test",
				data: ""
			},
			{
				fetch: (e: any) => {
					if (e.Endpoint === "/api/traced")
						return {
							result: "ok"
						};
					throw new Error(`No mock response for ${e.Endpoint}`);
				}
			}
		);
		createTraceAggregator(runtime, onTrace);

		function* tracedAction(draft: { data: string }): IActionGenerator {
			const result: any = yield {
				Type: "fetch",
				Method: "GET",
				Endpoint: "/api/traced"
			};
			draft.data = result.result;
		}
		await runtime.dispatch(tracedAction, "test");

		expect(onTrace).toHaveBeenCalledOnce();
		const trace = onTrace.mock.calls[0][0];

		expect(trace.action).toBe("tracedAction");
		expect(trace.duration).toBeGreaterThanOrEqual(0);

		const effectIndex = trace.entries.findIndex((s: any) => s.type === "effect");
		const stepAfterEffect = trace.entries.findIndex((s: any, i: number) => i > effectIndex && s.type === "step");

		expect(effectIndex).toBeGreaterThanOrEqual(0);
		expect(stepAfterEffect).toBeGreaterThan(effectIndex);

		expect(trace.entries[effectIndex]).toMatchObject({
			type: "effect",
			effect: {
				Type: "fetch",
				Method: "GET",
				Endpoint: "/api/traced"
			},
			result: {
				result: "ok"
			}
		});

		const stepEntry = trace.entries[stepAfterEffect];
		expect(stepEntry.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					Path: [
						"data"
					],
					Value: "ok"
				})
			])
		);
	});

	it("traces a multi-step action with interleaved effects in order", async () => {
		const onTrace = vi.fn();
		const runtime = createTestRuntime(
			{
				$Id: "test",
				user: null as {
					name: string;
				} | null,
				theme: "",
				id: ""
			},
			{
				generateGuid: () => "test-guid-1234",
				fetch: (e: any) => {
					if (e.Endpoint === "/api/user")
						return {
							name: "Alice"
						};
					if (e.Endpoint === "/api/prefs")
						return {
							theme: "dark"
						};
					throw new Error(`No mock response for ${e.Endpoint}`);
				}
			}
		);
		createTraceAggregator(runtime, onTrace);

		function* initApp(draft: { user: any; theme: string; id: string }): IActionGenerator {
			const id: string = yield {
				Type: "generateGuid"
			};
			draft.id = id;
			const user: any = yield {
				Type: "fetch",
				Method: "GET",
				Endpoint: "/api/user",
				Data: undefined
			};
			draft.user = user;
			const prefs: any = yield {
				Type: "fetch",
				Method: "GET",
				Endpoint: "/api/prefs",
				Data: undefined
			};
			draft.theme = prefs.theme;
		}

		await runtime.dispatch(initApp, "test");

		const trace = onTrace.mock.calls[0][0];
		const effectEntries = trace.entries.filter((s: any) => s.type === "effect");
		const stepEntries = trace.entries.filter((s: any) => s.type === "step");

		expect(effectEntries.length).toBe(3);
		expect(effectEntries[0].effect).toMatchObject({
			Type: "generateGuid"
		});
		expect(effectEntries[1].effect).toMatchObject({
			Type: "fetch",
			Endpoint: "/api/user"
		});
		expect(effectEntries[2].effect).toMatchObject({
			Type: "fetch",
			Endpoint: "/api/prefs"
		});

		expect(stepEntries.length).toBeGreaterThanOrEqual(3);

		for (let i = 0; i < effectEntries.length; i++) {
			const effectIdx = trace.entries.indexOf(effectEntries[i]);
			const nextMutation = trace.entries.find((s: any, idx: number) => idx > effectIdx && s.type === "step");
			expect(nextMutation).toBeDefined();
		}
	});
});
