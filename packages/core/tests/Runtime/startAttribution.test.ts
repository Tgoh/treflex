import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import { describe, expect, it } from "vitest";
import { generateGuid } from "../../src/Effects/generateGuid";
import { publish } from "../../src/Effects/publish";
import { start } from "../../src/Effects/start";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { receiver } from "../../src/Runtime/receiver";

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"StartAttribution/Ping": {};
	}
}

interface IWorld {
	$Id: string;
	Heard: number;
}

const Listener = receiver<IWorld>("StartAttributionListener")({
	"StartAttribution/Ping": function* heard(draft): IActionGenerator {
		draft.Heard++;
	}
});

function* listen(draft: IWorld): IActionGenerator {
	bind(draft, Listener);
}

function* mintThenPublish(): IActionGenerator {
	yield* generateGuid();
	yield* publish("StartAttribution/Ping");
}

function* publishFirst(): IActionGenerator {
	yield* publish("StartAttribution/Ping");
}

async function startsOf(started: () => IActionGenerator): Promise<
	Extract<
		IRecord,
		{
			Kind: "action:start";
		}
	>[]
> {
	const runtime = createRuntime<IWorld>(
		{
			$Id: "root",
			Heard: 0
		},
		{}
	);
	runtime.registerReceiver(Listener);
	await runtime.dispatch(listen, "root");
	const starts: Extract<
		IRecord,
		{
			Kind: "action:start";
		}
	>[] = [];
	runtime.on("record", (record) => {
		if (record.Kind === "action:start") {
			starts.push(record);
		}
	});
	function* starter(draft: IWorld): IActionGenerator {
		yield* start(started, draft);
	}
	await runtime.dispatch(starter, "root");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(runtime.state.Heard).toBe(1);
	return starts;
}

describe("start attribution", () => {
	for (const [name, started] of [
		[
			"after a sync yield",
			mintThenPublish
		],
		[
			"as the started action's first yield",
			publishFirst
		]
	] as const) {
		it(`names the start on the started action alone when it publishes ${name}`, async () => {
			const starts = await startsOf(started);
			const starter = starts.find((s) => s.Name === "starter");
			const child = starts.find((s) => s.Name === started.name);
			const listener = starts.find((s) => s.Name !== "starter" && s.Name !== started.name);
			expect(starter).toBeDefined();
			expect(child?.StartedBy).toBe(starter?.ActionId);
			expect(listener).toBeDefined();
			expect(listener).not.toHaveProperty("StartedBy");
			expect(starter).not.toHaveProperty("StartedBy");
		});
	}
});
