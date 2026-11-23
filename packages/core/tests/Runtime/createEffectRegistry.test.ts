import type { IActionGenerator } from "../../src/Types/IAction";
import type { IActionTrace } from "../../src/Types/IActionTrace";
import { describe, expect, it } from "vitest";
import { defineEffect } from "../../src/Effects/defineEffect";
import { createEffectRegistry } from "../../src/Runtime/createEffectRegistry";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createTraceAggregator } from "../../src/Runtime/createTraceAggregator";
import { createTestRuntime } from "../../src/Testing/createTestRuntime";
import { rootSetState } from "../testHelpers";

interface TestState {
	$Id: string;
}

for (const type of [
	"registry/headers",
	"registry/sessionThrows",
	"registry/sessionRejects",
	"registry/sessionRejectsValue",
	"registry/sessionReads"
]) {
	defineEffect(type as never, {
		redact: true
	});
}

const OPERATIONS = [
	"start",
	"parallel",
	"parallelSettled",
	"publish",
	"publishToNearest",
	"startTimer",
	"stopTimer",
	"registerDataSource",
	"unregisterDataSource",
	"openResource",
	"closeResource",
	"resource",
	"ask",
	"answer"
];

const READS = [
	"getData",
	"getDataGlobal",
	"getDataPath",
	"select",
	"transient",
	"inFlight",
	"pendingAsks"
];

describe("createEffectRegistry", () => {
	it("throws the no-implementation error for an unregistered effect type", () => {
		const registry = createEffectRegistry();
		expect(() =>
			registry.processEffect({
				Type: "ghost"
			})
		).toThrow('No implementation registered for effect type: "ghost"');
	});
});

describe("a runtime operation's or a read's name", () => {
	it.each(OPERATIONS)("refuses an implementation for the operation %s", (type) => {
		const registry = createEffectRegistry();
		expect(() => registry.registerImplementation(type, () => undefined)).toThrow(`"${type}" is one of the runtime's own operations`);
	});

	it.each(READS)("refuses an implementation for the read %s", (type) => {
		const registry = createEffectRegistry();
		expect(() => registry.registerImplementation(type, () => undefined)).toThrow(`"${type}" is a read`);
	});

	it.each([
		"publish",
		"select"
	])("refuses %s among createRuntime's implementations", (type) => {
		expect(() =>
			createRuntime<TestState>(
				{
					$Id: "root"
				},
				{
					implementations: {
						[type]: () => undefined
					}
				}
			)
		).toThrow(`createRuntime's implementations option: "${type}"`);
	});

	it("refuses start in createTestRuntime's stub map", () => {
		expect(() =>
			createTestRuntime<TestState>(
				{
					$Id: "root"
				},
				{
					start: () => undefined
				}
			)
		).toThrow(`createTestRuntime's stub map: "start"`);
	});

	it("refuses inFlight in createTestRuntime's stub map, pointing at the inFlight option", () => {
		expect(() =>
			createTestRuntime<TestState>(
				{
					$Id: "root"
				},
				{
					inFlight: () => undefined
				}
			)
		).toThrow(/^\[treflex\] createTestRuntime's stub map: "inFlight" is a read.* Stub it with createTestRuntime's inFlight option/);
	});

	it.each([
		"answer",
		"pendingAsks"
	])("refuses %s as a defineEffect type", (type) => {
		expect(() => defineEffect(type as never)).toThrow(`defineEffect("${type}"): "${type}"`);
	});
});

describe("createRuntime: redaction of live record data", () => {
	it("redacts a declared type only, whatever writes the yield", async () => {
		const runtime = createRuntime<TestState>({
			$Id: "root"
		});
		runtime.registerImplementation("registry/headers", () => ({
			Authorization: "Bearer secret"
		}));
		runtime.registerImplementation("plain", () => "visible");
		const settlements: unknown[] = [];
		runtime.on("record", (record, live) => {
			if (record.Kind === "response") {
				settlements.push({
					value: "Value" in record ? record.Value : undefined,
					hasLiveResult: live !== undefined && "result" in live,
					liveResult: live?.result
				});
			}
		});
		function* read(_draft: TestState): IActionGenerator {
			yield {
				Type: "registry/headers"
			};
			yield {
				Type: "plain"
			};
		}
		await runtime.processAction(
			read,
			() => runtime.state,
			rootSetState(runtime),
			() => "root"
		);
		expect(settlements).toEqual([
			{
				value: undefined,
				hasLiveResult: false,
				liveResult: undefined
			},
			{
				value: "visible",
				hasLiveResult: true,
				liveResult: "visible"
			}
		]);
		runtime.dispose();
	});

	it("withholds what a redacted effect threw or rejected with from the record and the tap's live extras", async () => {
		const runtime = createRuntime<TestState>({
			$Id: "root"
		});
		const refusal = () =>
			Object.assign(new Error("Bearer thrown-secret"), {
				Token: "field-secret"
			});
		runtime.registerImplementation("registry/sessionThrows", () => {
			throw refusal();
		});
		runtime.registerImplementation("registry/sessionRejects", () => Promise.reject(refusal()));
		runtime.registerImplementation("registry/sessionRejectsValue", () => Promise.reject("Bearer value-secret"));
		runtime.registerImplementation("plainThrows", () => {
			throw new Error("visible");
		});
		const responses: unknown[] = [];
		const errors: unknown[] = [];
		const liveKeys: string[][] = [];
		runtime.on("record", (record, live) => {
			if (record.Kind === "response") {
				responses.push(record);
				errors.push("Error" in record ? record.Error : undefined);
				liveKeys.push(Object.keys(live ?? {}).sort());
			}
		});
		const caught: string[] = [];
		function* read(_draft: TestState): IActionGenerator {
			for (const Type of [
				"registry/sessionThrows",
				"registry/sessionRejects",
				"registry/sessionRejectsValue",
				"plainThrows"
			]) {
				try {
					yield {
						Type
					};
				} catch (error) {
					caught.push(String(error));
				}
			}
		}
		await runtime.processAction(
			read,
			() => runtime.state,
			rootSetState(runtime),
			() => "root"
		);

		expect(caught).toEqual([
			"Error: Bearer thrown-secret",
			"Error: Bearer thrown-secret",
			"Bearer value-secret",
			"Error: visible"
		]);
		expect(errors).toEqual([
			{
				Thrown: "redacted"
			},
			{
				Thrown: "redacted"
			},
			{
				Thrown: "redacted"
			},
			expect.objectContaining({
				Thrown: "error",
				Message: "visible"
			})
		]);
		expect(liveKeys).toEqual([
			[
				"duration"
			],
			[
				"duration"
			],
			[
				"duration"
			],
			[
				"duration",
				"error"
			]
		]);
		expect(JSON.stringify(responses)).not.toMatch(/secret/);
		runtime.dispose();
	});

	it("marks a redacted effect's failure in a trace with the record's marker, and a success with no error", async () => {
		const runtime = createRuntime<TestState>({
			$Id: "root"
		});
		runtime.registerImplementation("registry/sessionThrows", () => {
			throw new Error("Bearer thrown-secret");
		});
		runtime.registerImplementation("registry/sessionReads", () => "Bearer read-secret");
		const plainFailure = new Error("visible");
		runtime.registerImplementation("plainThrows", () => {
			throw plainFailure;
		});
		const traces: IActionTrace[] = [];
		createTraceAggregator(runtime, (trace) => traces.push(trace));
		function* read(_draft: TestState): IActionGenerator {
			try {
				yield {
					Type: "registry/sessionThrows"
				};
			} catch {}
			yield {
				Type: "registry/sessionReads"
			};
			try {
				yield {
					Type: "plainThrows"
				};
			} catch {}
		}
		await runtime.processAction(
			read,
			() => runtime.state,
			rootSetState(runtime),
			() => "root"
		);

		const entries = traces[0]!.entries.filter((entry) => entry.type === "effect");
		expect(entries.map((entry) => entry.error)).toEqual([
			{
				Thrown: "redacted"
			},
			undefined,
			plainFailure
		]);
		expect(entries[2]!.error).not.toBe(plainFailure);
		expect(JSON.stringify(traces)).not.toMatch(/secret/);
		runtime.dispose();
	});
});
