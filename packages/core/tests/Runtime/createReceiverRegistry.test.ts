import type { IActionContext } from "../../src/index";
import { describe, expect, it } from "vitest";
import { createReceiverRegistry } from "../../src/Runtime/createReceiverRegistry";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { rawReceiver } from "../testHelpers";

interface TestState {
	$Id: string;
	Value: number;
}

describe("createReceiverRegistry", () => {
	it("register/get round-trip", () => {
		const registry = createReceiverRegistry();
		const handle = function* (s: TestState) {
			s.Value += 1;
		};

		registry.register(rawReceiver("CounterReceiver", [], handle));

		expect(registry.get("CounterReceiver")).toBe(handle);
	});

	it("get returns undefined for an unregistered id", () => {
		const registry = createReceiverRegistry();

		expect(registry.get("Missing")).toBeUndefined();
	});

	it("answers handles and handling from the declared topics, in registration order", () => {
		const registry = createReceiverRegistry();

		registry.register(
			rawReceiver(
				"CartReceiver",
				[
					"Added",
					"Cleared"
				],
				function* () {}
			)
		);
		registry.register(
			rawReceiver(
				"AuditReceiver",
				[
					"Added"
				],
				function* () {}
			)
		);

		expect(registry.handles("CartReceiver", "Cleared")).toBe(true);
		expect(registry.handles("AuditReceiver", "Cleared")).toBe(false);
		expect(registry.handles("Missing", "Added")).toBe(false);
		expect(registry.handling("Added")).toEqual([
			"CartReceiver",
			"AuditReceiver"
		]);
		expect(registry.handling("Unknown")).toEqual([]);
	});

	it("re-registering an id rebinds it to the fresh handle and topics (HMR)", () => {
		// The production collision diag is pinned in receiverIdCollision.test.ts.
		const diags: unknown[] = [];
		const registry = createReceiverRegistry((event) => diags.push(event));
		const before = function* (s: TestState) {
			s.Value += 1;
		};
		const after = function* (s: TestState) {
			s.Value += 2;
		};

		registry.register(
			rawReceiver(
				"CounterReceiver",
				[
					"Incremented",
					"Reset"
				],
				before
			)
		);
		registry.register(
			rawReceiver(
				"CounterReceiver",
				[
					"Incremented",
					"Doubled"
				],
				after
			)
		);

		expect(registry.get("CounterReceiver")).toBe(after);
		expect(registry.handles("CounterReceiver", "Reset")).toBe(false);
		expect(registry.handles("CounterReceiver", "Doubled")).toBe(true);
		expect(registry.handling("Incremented")).toEqual([
			"CounterReceiver"
		]);
		expect(registry.handling("Reset")).toEqual([]);
		expect(diags).toEqual([]);
	});

	it("re-registering the same handle under the same id is a no-op (idempotent startup)", () => {
		const registry = createReceiverRegistry();
		const handle = function* () {};

		registry.register(
			rawReceiver(
				"CounterReceiver",
				[
					"Incremented"
				],
				handle
			)
		);
		registry.register(
			rawReceiver(
				"CounterReceiver",
				[
					"Incremented"
				],
				handle
			)
		);

		expect(registry.get("CounterReceiver")).toBe(handle);
		expect(registry.handling("Incremented")).toEqual([
			"CounterReceiver"
		]);
	});

	it("refuses a malformed receiver with a TypeError", () => {
		const registry = createReceiverRegistry();
		const handle = function* () {};

		expect(() => registry.register("CounterReceiver" as never)).toThrow(TypeError);
		expect(() =>
			registry.register({
				Id: "CounterReceiver",
				handle
			} as never)
		).toThrow(TypeError);
		expect(() =>
			registry.register({
				Id: "",
				Topics: [],
				handle
			} as never)
		).toThrow(TypeError);
		expect(registry.get("CounterReceiver")).toBeUndefined();
	});

	it('runtime.registerReceiver populates the "runtime/receivers" service', async () => {
		const runtime = createRuntime<TestState>({
			$Id: "root",
			Value: 0
		});
		const handle = function* (s: TestState) {
			s.Value += 1;
		};
		runtime.registerReceiver(rawReceiver("CounterReceiver", [], handle));

		// Only IActionContext exposes get, so read the service from inside a dispatched effect.
		let observed: Function | undefined;
		runtime.registerImplementation("probe", ((_e: any, action?: IActionContext) => {
			observed = action?.get("runtime/receivers").get("CounterReceiver");
		}) as any);

		function* probe(_draft: TestState) {
			yield {
				Type: "probe"
			};
		}
		await runtime.dispatch(probe, "root");

		expect(observed).toBe(handle);
	});
});
