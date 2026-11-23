import type { IJournalAppend } from "../../src/Runtime/createJournal";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { describe, expect, it } from "vitest";
import { start } from "../../src/Effects/start";
import { external } from "../../src/Reads/external";
import { createActivityLog } from "../../src/Runtime/createActivityLog";
import { createRuntime } from "../../src/Runtime/createRuntime";
import * as reactive from "../reactive";

declare module "../../src/Registries/IExternalRegistry" {
	interface IExternalRegistry {
		"tracking/Kinds": readonly string[];
	}
}

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

function build() {
	const runtime = createRuntime<Root>({
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
	});
	runtime.registerImplementation("slow", () => new Promise((resolve) => setTimeout(resolve, 1)));
	return runtime;
}

async function dispatchFromEffect(runtime: ReturnType<typeof build>): Promise<number> {
	let runs = 0;
	await reactive.root(async (dispose) => {
		try {
			reactive.effect(() => {
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
	it("subscribes no scope that delivers a record to it", async () => {
		const runtime = build();
		createActivityLog(runtime);
		const journal = (runtime as IRuntimeInternal<Root>).get("runtime/journal");
		const ended: IJournalAppend = {
			T: 0,
			Kind: "action:end",
			Root: "AppState",
			ActionId: "a",
			Status: "completed"
		};
		let runs = 0;
		const dispose = reactive.root((d) => {
			reactive.effect(() => {
				runs++;
				if (runs > 20) {
					return;
				}
				journal.append(ended);
			});
			return d;
		});
		await Promise.resolve();
		journal.append(ended);
		dispose();
		expect(runs).toBe(1);
		expect(
			runtime.processSelector(
				() => external("ActivityLog"),
				() => runtime.state
			)
		).toHaveLength(2);
	});
});

describe("dispatch from an effect", () => {
	it("runs the effect once on a runtime with the activity log on", async () => {
		const runtime = build();
		createActivityLog(runtime);
		expect(await dispatchFromEffect(runtime)).toBe(1);
		expect(runtime.state.Host.Loaded).toBe(1);
	});

	it("runs the effect once whatever a record tap provides", async () => {
		const runtime = build();
		let kinds: readonly string[] = [];
		const seen = runtime.provideExternal("tracking/Kinds", {
			read: () => kinds
		});
		const off = runtime.on("record", (record) => {
			kinds = [
				...kinds,
				record.Kind
			];
			seen.changed();
		});
		function* tapped(): ISelectorGenerator<readonly string[]> {
			return (yield* external("tracking/Kinds")) ?? [];
		}
		const read = () => runtime.processSelector(tapped, () => runtime.state);
		try {
			expect(await dispatchFromEffect(runtime)).toBe(1);
			expect(read()).toContain("entity:dispose");
			// load, churn and the started childWrite.
			expect(read().filter((kind) => kind === "action:end")).toHaveLength(3);
		} finally {
			off();
		}
	});
});
