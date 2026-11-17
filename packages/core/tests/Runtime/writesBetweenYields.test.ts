import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";

type IChild = {
	$Id: string;
	Value: number;
};

type IState = {
	$Id: string;
	A: IChild[];
	B: IChild[];
	Count: number;
};

function build() {
	const runtime = createRuntime<IState>({
		$Id: "root",
		A: [
			{
				$Id: "child",
				Value: 1
			}
		],
		B: [],
		Count: 0
	});
	const records: IRecord[] = [];
	runtime.on("record", (record) => {
		records.push(record);
	});
	runtime.registerImplementation("writes/wait", async () => {});
	return {
		runtime,
		records,
		disposed: () =>
			records.flatMap((record) =>
				record.Kind === "entity:dispose"
					? [
							record.EntityId
						]
					: []
			)
	};
}

describe("writes with no yield between them", () => {
	it("land together, in one step record", async () => {
		const { runtime, records } = build();
		await runtime.dispatch(function* relocate(draft: IState): IActionGenerator {
			draft.Count = 1;
			draft.B.push(...draft.A);
			draft.A = [];
			draft.Count = 2;
		}, "root");
		expect(records.filter((record) => record.Kind === "step")).toHaveLength(1);
		expect(runtime.state.B).toHaveLength(1);
		expect(runtime.state.A).toHaveLength(0);
		runtime.dispose();
	});

	it("keep a relocation a relocation, so the moved entity is not disposed", async () => {
		const { runtime, disposed } = build();
		await runtime.dispatch(function* relocate(draft: IState): IActionGenerator {
			draft.B.push(...draft.A);
			draft.A = [];
		}, "root");
		expect(disposed()).toEqual([]);
		expect(runtime.state.B[0].$Id).toBe("child");
		runtime.dispose();
	});

	it("split across a yield, the same edit disposes the moved entity", async () => {
		const { runtime, disposed } = build();
		await runtime.dispatch(function* split(draft: IState): IActionGenerator {
			const moved = draft.A[0];
			draft.A = [];
			yield {
				Type: "writes/wait"
			};
			draft.B.push(moved);
		}, "root");
		expect(disposed()).toContain("child");
		runtime.dispose();
	});
});
