import type { IActionGenerator } from "../../src/Types/IAction";
import type { IActionTrace } from "../../src/Types/IActionTrace";
import { describe, expect, it, vi } from "vitest";
import { parallel } from "../../src/Effects/parallel";
import { createTraceAggregator } from "../../src/Runtime/createTraceAggregator";
import { createTestRuntime } from "../testHelpers";

describe("branch identity in traces", () => {
	it("root branch's id appears on all entries when no parallel branches run", async () => {
		const onTrace = vi.fn();
		const runtime = createTestRuntime(
			{
				$Id: "test",
				value: ""
			},
			{
				echo: () => "x"
			}
		);
		createTraceAggregator(runtime, onTrace);

		function* simple(draft: { value: string }): IActionGenerator {
			const r: string = yield {
				Type: "echo"
			};
			draft.value = r;
		}

		await runtime.dispatch(simple, "test");
		const trace: IActionTrace = onTrace.mock.calls[0][0];

		const branchIds = new Set(trace.entries.map((s) => s.branchId));
		expect(branchIds.size).toBe(1);
	});

	it("parallel children get distinct branch ids", async () => {
		const onTrace = vi.fn();
		const runtime = createTestRuntime(
			{
				$Id: "test"
			},
			{
				echo: (e: any) => e.payload
			}
		);
		createTraceAggregator(runtime, onTrace);

		function* a(): IActionGenerator {
			yield {
				Type: "echo",
				payload: "a"
			};
		}
		function* b(): IActionGenerator {
			yield {
				Type: "echo",
				payload: "b"
			};
		}

		function* split(): IActionGenerator {
			yield* parallel(a(), b());
		}

		await runtime.dispatch(split, "test");
		const trace: IActionTrace = onTrace.mock.calls[0][0];

		// Echo entries come from child branches; the root branch records the array
		// (parallel) yield itself.
		const echoEntries = trace.entries.filter((s) => s.type === "effect" && (s.effect as any).Type === "echo");
		expect(echoEntries.length).toBe(2);
		const echoBranchIds = new Set(echoEntries.map((s) => s.branchId));
		expect(echoBranchIds.size).toBe(2);
	});

	it("mutations record the branch that caused them", async () => {
		const onTrace = vi.fn();
		const runtime = createTestRuntime(
			{
				$Id: "test",
				items: [] as string[]
			},
			{
				echo: (e: any) => e.payload
			}
		);
		createTraceAggregator(runtime, onTrace);

		function* a(draft: { items: string[] }): IActionGenerator {
			yield {
				Type: "echo",
				payload: "a"
			};
			draft.items.push("a");
		}
		function* b(draft: { items: string[] }): IActionGenerator {
			yield {
				Type: "echo",
				payload: "b"
			};
			draft.items.push("b");
		}

		function* split(draft: { items: string[] }): IActionGenerator {
			yield* parallel(a(draft), b(draft));
		}

		await runtime.dispatch(split, "test");
		const trace: IActionTrace = onTrace.mock.calls[0][0];

		// Each push is a mutation that should record the child branch's id.
		// The root branch's mutations would only be the one(s) caused by the
		// runtime's setState wrapper at parallel boundaries (none here). All
		// "items" mutations should come from non-root branches.
		const childMutations = trace.entries.filter(
			(s) => s.type === "step" && s.changes.some((c) => Array.isArray(c.Path) && c.Path[0] === "items")
		);
		const childBranchIds = new Set(childMutations.map((s) => s.branchId));
		expect(childBranchIds.size).toBe(2);
	});
});
