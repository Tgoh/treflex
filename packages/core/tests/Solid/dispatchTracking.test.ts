import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord, IRecordTapListener } from "../../src/Types/IRecord";
import { createEffect, createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { describe, expect, it } from "vitest";
import { start } from "../../src/Effects/start";
import { createActivityLogSource } from "../../src/Runtime/createActivityLogSource";
import { createRuntime } from "../../src/Runtime/createRuntime";

// A dispatch from inside a Solid effect must leave the effect depending on
// nothing the dispatch read, including whatever a record tap reads while the
// first slice appends.

type Child = {
	$Id: string;
	Data: string;
};
type Root = {
	$Id: string;
	Host: {
		$Id: string;
		Loaded: number;
	};
	Children: Child[];
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

function* load(draft: Root["Host"]): IActionGenerator {
	yield {
		Type: "slow"
	};
	draft.Loaded++;
}

function* childWrite(draft: Child): IActionGenerator {
	draft.Data = "started";
}

// A started root action, then a dispose, so records keep landing after the
// effect's own dispatch has ended.
function* churn(draft: Root): IActionGenerator {
	yield* start(childWrite, "child-1");
	yield {
		Type: "slow"
	};
	draft.Children = draft.Children.filter((c) => c.$Id !== "child-2");
}

function build(activityLog: boolean) {
	const runtime = createRuntime<Root>(
		{
			$Id: "root",
			Host: {
				$Id: "host",
				Loaded: 0
			},
			Children: [
				{
					$Id: "child-1",
					Data: ""
				},
				{
					$Id: "child-2",
					Data: ""
				}
			]
		},
		{
			activityLog
		}
	);
	runtime.registerImplementation("slow", () => new Promise((resolve) => setTimeout(resolve, 1)));
	return runtime;
}

async function dispatchFromEffect(runtime: ReturnType<typeof build>): Promise<number> {
	let runs = 0;
	await createRoot(async (dispose) => {
		try {
			createEffect(() => {
				runs++;
				// A loop is the failure; cap it so the failure is a count.
				if (runs > 20) {
					return;
				}
				runtime.dispatch(load, "host");
			});
			await settled();
			await runtime.dispatch(churn, "root");
			await settled();
		} finally {
			dispose();
		}
	});
	expect(runtime.state.Children.map((c) => c.$Id)).toEqual([
		"child-1"
	]);
	expect(runtime.state.Children[0].Data).toBe("started");
	return runs;
}

describe("the activity log's tap", () => {
	// Independent of the dispatch boundary: a tap must not depend on who calls it.
	it("subscribes no scope that delivers a record to it", () => {
		let listener!: IRecordTapListener;
		const source = createActivityLogSource((l) => {
			listener = l;
			return () => {};
		});
		let runs = 0;
		const dispose = createRoot((d) => {
			createEffect(() => {
				runs++;
				if (runs > 20) {
					return;
				}
				listener({
					Kind: "action:start"
				} as IRecord);
			});
			return d;
		});
		listener({
			Kind: "action:end"
		} as IRecord);
		dispose();
		source.dispose?.();
		expect(runs).toBe(1);
	});
});

describe("dispatch from a Solid effect", () => {
	it("runs the effect once on a runtime with the activity log on", async () => {
		const runtime = build(true);
		expect(await dispatchFromEffect(runtime)).toBe(1);
		expect(runtime.state.Host.Loaded).toBe(1);
	});

	it("runs the effect once whatever a record tap reads", async () => {
		const runtime = build(false);
		const [seen, setSeen] = createStore<{
			Kinds: string[];
		}>({
			Kinds: []
		});
		const off = runtime.on("record", (record) => {
			setSeen("Kinds", [
				...seen.Kinds,
				record.Kind
			]);
		});
		try {
			expect(await dispatchFromEffect(runtime)).toBe(1);
			expect(seen.Kinds).toContain("entity:dispose");
			// load, churn and the started childWrite.
			expect(seen.Kinds.filter((kind) => kind === "action:end")).toHaveLength(3);
		} finally {
			off();
		}
	});
});
