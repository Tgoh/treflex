import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";

type IDiag = IRuntimeEventOf<"diag">;

type TestState = {
	$Id: string;
	Data: string;
	Count: number;
};

const initialState = (): TestState => ({
	$Id: "Root",
	Data: "before",
	Count: 0
});

function collectDiags(runtime: IRuntime<TestState>): IDiag[] {
	const diags: IDiag[] = [];
	runtime.on("diag", (e) => diags.push(e));
	return diags;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("diag events", () => {
	it("restore/orphaned-rows fires when the restore leaves out orphaned table rows", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const a = createRuntime<TestState>(initialState(), {});
		const envelope = JSON.parse(createSnapshot(a));
		envelope.Timers = [
			{
				Key: "Orphaned/Tick",
				OwnerId: "gone",
				ReceiverId: "R1",
				IntervalMs: 1000,
				Payload: null
			}
		];
		const snapshot = JSON.stringify(envelope);

		let diags!: IDiag[];
		const { result } = await restoreRuntime<TestState>(snapshot, {
			rootId: "Root",
			options: {},
			setup: (b) => {
				diags = collectDiags(b);
			}
		});

		expect(result.sweptOrphanedRows).toBe(1);
		const swept = diags.filter((d) => d.code === "restore/orphaned-rows");
		expect(swept.length).toBe(1);
		expect(swept[0].severity).toBe("info");
		expect(swept[0].data).toStrictEqual({
			count: 1
		});
		expect(info.mock.calls.some((c) => c[0] === swept[0].message)).toBe(true);
	});

	it("the diag payload is typed through the registry", async () => {
		const runtime = createRuntime<TestState>(initialState());
		// Compile-time pin: runtime.on("diag", …) narrows the payload to the
		// registry entry's shape.
		const off = runtime.on("diag", (e) => {
			const severity: "info" | "warn" = e.severity;
			const code: string = e.code;
			const message: string = e.message;
			const data: Record<string, unknown> | undefined = e.data;
			void severity;
			void code;
			void message;
			void data;
		});
		off();
	});
});
