import type { IWriteGateway } from "../../src/Runtime/createWriteGateway";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { rawOf } from "../../src/Runtime/viewProxy";
import { treeWrite } from "../testHelpers";

type IRoot = {
	$Id: string;
	A: {
		Value: number;
	};
	B: {
		Value: number;
	};
	List: number[];
};

function world() {
	const runtime = createRuntime<IRoot>({
		$Id: "root",
		A: {
			Value: 0
		},
		B: {
			Value: 0
		},
		List: []
	}) as IRuntimeInternal<IRoot>;
	const gateway = runtime.get("runtime/writeGateway") as IWriteGateway;
	const raw = rawOf(runtime.state) as IRoot;
	const calls: (readonly object[] | null)[] = [];
	const listen = () =>
		gateway.onDrained((touched) => {
			calls.push(touched);
		});
	return {
		runtime,
		gateway,
		raw,
		calls,
		listen
	};
}

function* writeAll(draft: IRoot): IActionGenerator {
	draft.A.Value++;
	draft.B.Value++;
	draft.List.push(1);
	draft.A.Value++;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("onDrained", () => {
	it("fires once per outermost drain with every container written in it", async () => {
		const { runtime, raw, calls, listen } = world();
		listen();
		await runtime.dispatch(writeAll, "root");
		expect(calls).toHaveLength(1);
		expect(new Set(calls[0])).toEqual(
			new Set([
				raw.A,
				raw.B,
				raw.List
			])
		);
	});

	it("fires once for nested frames", () => {
		const { runtime, raw, calls, listen } = world();
		listen();
		treeWrite(runtime, (s) => {
			s.A.Value = 1;
			treeWrite(runtime, (inner) => {
				inner.B.Value = 1;
			});
		});
		expect(calls).toEqual([
			expect.arrayContaining([
				raw.A,
				raw.B
			])
		]);
	});

	it("does not fire for a frame that wrote nothing", () => {
		const { runtime, calls, listen } = world();
		listen();
		treeWrite(runtime, () => {});
		expect(calls).toEqual([]);
	});

	it("fires with null after a resync", () => {
		const { gateway, calls, listen } = world();
		listen();
		gateway.resync();
		expect(calls).toEqual([
			null
		]);
	});

	it("reports only the writes made while a listener is attached", () => {
		const { runtime, raw, calls, listen } = world();
		treeWrite(runtime, (s) => {
			s.A.Value = 1;
		});
		const stop = listen();
		treeWrite(runtime, (s) => {
			s.B.Value = 1;
		});
		expect(calls).toEqual([
			[
				raw.B
			]
		]);
		stop();
		treeWrite(runtime, (s) => {
			s.List.push(2);
		});
		listen();
		treeWrite(runtime, (s) => {
			s.A.Value = 2;
		});
		expect(calls[1]).toEqual([
			raw.A
		]);
	});

	it("keeps a throwing listener from the writer and the other listeners, and reports it as a diag", () => {
		const { runtime, gateway, calls, listen } = world();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const reported: unknown[] = [];
		runtime.on("diag", (event) => {
			if (event.code === "runtime/callback-threw") {
				reported.push(event.data?.error);
			}
		});
		const failure = new Error("listener failed");
		gateway.onDrained(() => {
			throw failure;
		});
		listen();
		expect(() =>
			treeWrite(runtime, (s) => {
				s.A.Value = 3;
			})
		).not.toThrow();
		expect(runtime.state.A.Value).toBe(3);
		expect(calls).toHaveLength(1);
		expect(reported).toEqual([
			failure
		]);
		treeWrite(runtime, (s) => {
			s.A.Value = 4;
		});
		expect(calls).toHaveLength(2);
	});
});
