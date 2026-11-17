import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator, IActionYield } from "../../src/Types/IAction";
import type { IRecord, IRecordExtras } from "../../src/Types/IRecord";
import { describe, expect, it } from "vitest";
import { createActivityLog } from "../../src/Runtime/createActivityLog";
import { createRuntime } from "../../src/Runtime/createRuntime";

interface IWorld {
	$Id: string;
	Count: number;
}

const boom = new Error("boom");

function build() {
	const gates: (() => void)[] = [];
	const runtime = createRuntime<IWorld>(
		{
			$Id: "root",
			Count: 0
		},
		{
			onError: () => {},
			implementations: {
				echo: () => Promise.resolve("ok"),
				gate: () =>
					new Promise<void>((resolve) => {
						gates.push(resolve);
					})
			}
		}
	) as IRuntimeInternal<IWorld>;
	return {
		runtime,
		journal: runtime.get("runtime/journal"),
		release: () => gates.shift()?.()
	};
}

function* writes(draft: IWorld): IActionGenerator {
	draft.Count++;
	yield {
		Type: "echo"
	} as IActionYield;
	draft.Count++;
}

function* fails(_draft: IWorld): IActionGenerator {
	throw boom;
}

describe("a record tap with kinds", () => {
	it("hears only its kinds, an action:end with no action:start tap among them, its extras included", async () => {
		const { runtime } = build();
		const heard: [
			IRecord["Kind"],
			string,
			IRecordExtras | undefined
		][] = [];
		runtime.on(
			"record",
			(record, live) => {
				heard.push([
					record.Kind,
					record.Status,
					live
				]);
			},
			{
				kinds: [
					"action:end"
				]
			}
		);
		await runtime.dispatch(writes, "root");
		await runtime.dispatch(fails, "root").catch(() => {});
		expect(heard).toEqual([
			[
				"action:end",
				"completed",
				expect.objectContaining({
					duration: expect.any(Number)
				})
			],
			[
				"action:end",
				"errored",
				expect.objectContaining({
					error: boom
				})
			]
		]);
	});

	it("turns on only its kinds, so a tap of the lifecycle builds no step", () => {
		const { runtime, journal } = build();
		const off = runtime.on("record", () => {}, {
			kinds: [
				"action:start",
				"action:end"
			]
		});
		expect(journal.wants("action:end")).toBe(true);
		expect(journal.wants("step")).toBe(false);
		expect(journal.sample()).toMatchObject({
			"action:start": true,
			"action:end": true,
			step: false,
			effect: false
		});
		off();
		expect(journal.wants("action:end")).toBe(false);
		expect(journal.enabled).toBe(false);
	});

	it("leaves step capture off under createActivityLog, which keeps no steps", () => {
		const { runtime, journal } = build();
		createActivityLog(runtime);
		expect(journal.wants("action:end")).toBe(true);
		expect(journal.wants("message:deliver")).toBe(true);
		expect(journal.wants("step")).toBe(false);
		expect(journal.wants("effect")).toBe(false);
		expect(journal.wants("response")).toBe(false);
	});

	it("gives a response tap its responses, with the effect records they name made beside them", async () => {
		const { runtime } = build();
		const responses: IRecord[] = [];
		const all: IRecord[] = [];
		runtime.on("record", (record) => responses.push(record), {
			kinds: [
				"response"
			]
		});
		await runtime.dispatch(writes, "root");
		const off = runtime.on("record", (record) => all.push(record));
		await runtime.dispatch(writes, "root");
		off();
		expect(responses.map((record) => record.Kind)).toEqual([
			"response",
			"response"
		]);
		const effect = all.find((record) => record.Kind === "effect")!;
		expect(responses[1]).toMatchObject({
			ForSeq: effect.Seq
		});
	});

	it("samples each kind at dispatch, so an action already running makes no steps for a tap attached later", async () => {
		const { runtime, release } = build();
		const steps: IRecord[] = [];
		function* gated(draft: IWorld): IActionGenerator {
			yield {
				Type: "gate"
			} as IActionYield;
			draft.Count++;
		}
		const running = runtime.dispatch(gated, "root");
		await Promise.resolve();
		runtime.on("record", (record) => steps.push(record), {
			kinds: [
				"step"
			]
		});
		release();
		await running;
		expect(steps).toEqual([]);
		await runtime.dispatch(writes, "root");
		expect(steps.map((record) => record.Kind)).toEqual([
			"step",
			"step"
		]);
	});
});
