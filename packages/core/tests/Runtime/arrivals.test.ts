import type { IActionGenerator } from "../../src/Types/IAction";
import type { IActionTrace } from "../../src/Types/IActionTrace";
import type { IEntity } from "../../src/Types/IEntity";
import type { IRecord } from "../../src/Types/IRecord";
import { describe, expect, it } from "vitest";
import { start } from "../../src/Effects/start";
import { latest, leading } from "../../src/Runtime/arrivalPolicy";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createTraceAggregator } from "../../src/Runtime/createTraceAggregator";
import { settled } from "../../src/Testing/createTestRuntime";

interface IDoc extends IEntity {
	Log: string[];
}

function build() {
	const runtime = createRuntime<IDoc>(
		{
			$Id: "doc",
			Log: []
		},
		{
			onError: () => {}
		}
	);
	const releases: ((value?: unknown) => void)[] = [];
	runtime.registerImplementation(
		"wait",
		() =>
			new Promise((resolve) => {
				releases.push(resolve);
			})
	);
	const records: IRecord[] = [];
	runtime.on("record", (record) => records.push(record));
	return {
		runtime,
		releases,
		records,
		log: () => runtime.state.Log
	};
}

function* wait(): Generator<any, unknown, any> {
	return yield {
		Type: "wait"
	};
}

describe("arrival policies", () => {
	it("drops a leading arrival while an instance of it is running, or queued behind other work", async () => {
		const h = build();
		function* holds(_draft: IDoc): IActionGenerator {
			yield* wait();
		}
		const save = leading(function* save(draft: IDoc, text: string): IActionGenerator<string> {
			draft.Log.push(`start:${text}`);
			yield* wait();
			return text;
		});
		const holding = h.runtime.dispatch(holds, "doc");
		const queued = h.runtime.dispatch(save, "doc", "one");
		expect(await h.runtime.dispatch(save, "doc", "two")).toBeUndefined();
		h.releases[0]();
		await holding;
		await settled();
		expect(await h.runtime.dispatch(save, "doc", "three")).toBeUndefined();
		h.releases[1]();
		expect(await queued).toBe("one");
		expect(h.log()).toEqual([
			"start:one"
		]);
	});

	it("marks a dropped arrival's trace dropped, and a run's not", async () => {
		const h = build();
		const traces: IActionTrace[] = [];
		createTraceAggregator(h.runtime, (trace) => traces.push(trace));
		const save = leading(function* save(_draft: IDoc): IActionGenerator {
			yield* wait();
		});
		const first = h.runtime.dispatch(save, "doc");
		await h.runtime.dispatch(save, "doc");
		h.releases[0]();
		await first;
		expect(traces.map((trace) => trace.dropped)).toEqual([
			true,
			undefined
		]);
	});

	it("records a dropped arrival as an action that started and did nothing", async () => {
		const h = build();
		const save = leading(function* save(_draft: IDoc): IActionGenerator {
			yield* wait();
		});
		const first = h.runtime.dispatch(save, "doc");
		const before = h.records.length;
		await h.runtime.dispatch(save, "doc");
		expect(h.records.slice(before).map((record) => record.Kind)).toEqual([
			"action:start",
			"action:end"
		]);
		h.releases[0]();
		await first;
	});

	it("replaces a running instance with latest, and the replaced one ends", async () => {
		const h = build();
		const load = latest(function* load(draft: IDoc, text: string): IActionGenerator<string> {
			yield* wait();
			draft.Log.push(text);
			return text;
		});
		const first = h.runtime.dispatch(load, "doc", "old");
		const second = h.runtime.dispatch(load, "doc", "new");
		expect(await first).toBeUndefined();
		await settled();
		h.releases[0]();
		h.releases[1]();
		expect(await second).toBe("new");
		expect(h.log()).toEqual([
			"new"
		]);
	});

	it("replaces a queued instance with latest, so a filter isn't left to run behind a sort", async () => {
		const h = build();
		function* holds(_draft: IDoc): IActionGenerator {
			yield* wait();
		}
		const apply = latest(function* apply(draft: IDoc, view: string): IActionGenerator {
			draft.Log.push(view);
		});
		const holding = h.runtime.dispatch(holds, "doc");
		const filter = h.runtime.dispatch(apply, "doc", "filter");
		const sort = h.runtime.dispatch(apply, "doc", "sort");
		expect(await filter).toBeUndefined();
		h.releases[0]();
		await Promise.all([
			holding,
			sort
		]);
		expect(h.log()).toEqual([
			"sort"
		]);
	});

	it("takes a repeat from work queued behind a leading run once that run has ended", async () => {
		const h = build();
		const save = leading(function* save(draft: IDoc, text: string): IActionGenerator {
			draft.Log.push(`start:${text}`);
			yield* wait();
		});
		function* again(draft: IDoc): IActionGenerator {
			yield* start(save, draft, "two");
		}
		const first = h.runtime.dispatch(save, "doc", "one");
		const queued = h.runtime.dispatch(again, "doc");
		h.releases[0]();
		await first;
		await queued;
		await settled();
		expect(h.log()).toEqual([
			"start:one",
			"start:two"
		]);
		h.releases[1]?.();
		await settled();
	});

	it("queues an arrival with no instance of itself ahead, whatever else holds the entity", async () => {
		const h = build();
		function* holds(_draft: IDoc): IActionGenerator {
			yield* wait();
		}
		const save = leading(function* save(draft: IDoc): IActionGenerator {
			draft.Log.push("saved");
		});
		const holding = h.runtime.dispatch(holds, "doc");
		const saving = h.runtime.dispatch(save, "doc");
		h.releases[0]();
		await Promise.all([
			holding,
			saving
		]);
		expect(h.log()).toEqual([
			"saved"
		]);
	});
});
