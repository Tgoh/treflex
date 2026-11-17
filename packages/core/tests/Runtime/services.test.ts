import type { IActionContext, IEffect } from "../../src/index";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createTestRuntime } from "../testHelpers";

// Declaration-merge typed keys for these tests so `runtime.set` and
// `action.get` are correctly typed. In real applications this declaration
// lives alongside the service implementation.
declare module "../../src/Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"test:counter": {
			count: number;
		};
		"test:other": {
			value: string;
		};
	}
}

interface TestState {
	$Id: string;
	value: string;
}

interface ITestEffect extends IEffect {
	Type: "test";
}

describe("runtime-scoped values", () => {
	it("createRuntime exposes set on the returned instance", () => {
		const runtime = createRuntime<TestState>({
			$Id: "root",
			value: ""
		});

		// Just check the method exists with the right signature — the
		// behavioural assertion is in the next test.
		expect(typeof runtime.set).toBe("function");
	});

	it("effect implementations receive the action context and can read registered values", async () => {
		let observed:
			| {
					count: number;
			  }
			| undefined;
		const runtime = createTestRuntime<TestState>(
			{
				$Id: "root",
				value: ""
			},
			{
				test: ((_e: ITestEffect, action?: IActionContext) => {
					observed = action?.get("test:counter");
					return "ok";
				}) as any
			}
		);

		runtime.set("test:counter", {
			count: 42
		});

		function* action(_draft: TestState) {
			yield {
				Type: "test"
			};
		}

		await runtime.dispatch(action, "root");
		expect(observed).toBeDefined();
		expect(observed!.count).toBe(42);
	});

	it("runtime values are isolated between separate runtimes", () => {
		const a = createRuntime<TestState>({
			$Id: "root",
			value: ""
		});
		const b = createRuntime<TestState>({
			$Id: "root",
			value: ""
		});

		a.set("test:counter", {
			count: 1
		});
		b.set("test:counter", {
			count: 999
		});

		// Each runtime's store is independent. We can't read from the
		// top-level handle (only IActionContext exposes get), so this
		// indirect check via dispatching through is the cleanest assertion
		// at the public API level.
		let aValue:
			| {
					count: number;
			  }
			| undefined;
		let bValue:
			| {
					count: number;
			  }
			| undefined;

		const aRuntime = createTestRuntime<TestState>(
			{
				$Id: "r",
				value: ""
			},
			{
				probe: ((_e: any, action?: IActionContext) => {
					aValue = action?.get("test:counter");
				}) as any
			}
		);
		aRuntime.set("test:counter", {
			count: 1
		});

		const bRuntime = createTestRuntime<TestState>(
			{
				$Id: "r",
				value: ""
			},
			{
				probe: ((_e: any, action?: IActionContext) => {
					bValue = action?.get("test:counter");
				}) as any
			}
		);
		bRuntime.set("test:counter", {
			count: 999
		});

		function* probe(_draft: TestState) {
			yield {
				Type: "probe"
			};
		}

		return Promise.all([
			aRuntime.dispatch(probe, "r"),
			bRuntime.dispatch(probe, "r")
		]).then(() => {
			expect(aValue!.count).toBe(1);
			expect(bValue!.count).toBe(999);
		});
	});

	it("action.get throws when the key has not been set", async () => {
		let captured: unknown;
		const runtime = createTestRuntime<TestState>(
			{
				$Id: "root",
				value: ""
			},
			{
				test: ((_e: any, action?: IActionContext) => {
					try {
						action?.get("test:counter");
					} catch (e) {
						captured = e;
					}
				}) as any
			}
		);

		function* action(_draft: TestState) {
			yield {
				Type: "test"
			};
		}

		await runtime.dispatch(action, "root");
		expect(captured).toBeInstanceOf(Error);
		expect((captured as Error).message).toContain("test:counter");
	});

	it("runtime.set overwrites the previous value", async () => {
		let observed:
			| {
					count: number;
			  }
			| undefined;
		const runtime = createTestRuntime<TestState>(
			{
				$Id: "root",
				value: ""
			},
			{
				test: ((_e: any, action?: IActionContext) => {
					observed = action?.get("test:counter");
				}) as any
			}
		);

		runtime.set("test:counter", {
			count: 1
		});
		runtime.set("test:counter", {
			count: 2
		});

		function* action(_draft: TestState) {
			yield {
				Type: "test"
			};
		}

		await runtime.dispatch(action, "root");
		expect(observed!.count).toBe(2);
	});

	it("different keys store independent values", async () => {
		const observed: {
			counter?: {
				count: number;
			};
			other?: {
				value: string;
			};
		} = {};
		const runtime = createTestRuntime<TestState>(
			{
				$Id: "root",
				value: ""
			},
			{
				test: ((_e: any, action?: IActionContext) => {
					observed.counter = action?.get("test:counter");
					observed.other = action?.get("test:other");
				}) as any
			}
		);

		runtime.set("test:counter", {
			count: 1
		});
		runtime.set("test:other", {
			value: "a"
		});

		function* action(_draft: TestState) {
			yield {
				Type: "test"
			};
		}

		await runtime.dispatch(action, "root");
		expect(observed.counter!.count).toBe(1);
		expect(observed.other!.value).toBe("a");
	});
});
