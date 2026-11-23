import type { IActionGenerator, IEntity, IOpenGenerator, IRuntime, ISelectorGenerator } from "../../src/index";
import type { IHistory } from "../../src/Resume/history";
import type { IScriptStep } from "./replayScript";
import { describe, expect, it } from "vitest";
import { publishToNearest } from "../../src/Effects/publishToNearest";
import { external } from "../../src/Reads/external";
import { resumable } from "../../src/Resume/resumable";
import { latest, leading } from "../../src/Runtime/arrivalPolicy";
import { inFlight } from "../../src/Runtime/arrivals";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { workTag } from "../../src/Runtime/workTag";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { settled } from "../../src/Testing/createTestRuntime";
import { BOOM, PAY, restoreWithResume, runEngine } from "./replayHarness";
import { driverOf, expectEngineFacts, playScript, resnapshot, restoreAt } from "./replayScript";
import { harness, until, wait } from "./resumeHarness";

interface ILine extends IEntity {
	Qty: number;
}

interface IOrder extends IEntity {
	Qty: number;
	Key: string;
	Note: string;
	Tag: string;
	Lines: Record<string, ILine>;
}

interface IShop extends IEntity {
	Orders: Record<string, IOrder>;
}

function seed(): IShop {
	return {
		$Id: "shop",
		Orders: {
			o1: {
				$Id: "o1",
				Qty: 1,
				Key: "",
				Note: "",
				Tag: "",
				Lines: {
					"o1-l1": {
						$Id: "o1-l1",
						Qty: 1
					}
				}
			}
		}
	};
}

const ended = (state: string) => JSON.parse(state) as IShop;

function* setQty(d: IOrder, qty: number): IActionGenerator {
	d.Qty = qty;
}
named(setQty, "Cases/SetQty");
resumable(setQty);

function* setLine(d: ILine, qty: number): IActionGenerator {
	d.Qty = qty;
}

function* regaining(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	d.Note = String(yield* open(wait("first")));
	d.Key = `after:${d.Tag}`;
}
named(regaining, "Cases/Regaining");
resumable(regaining);

function* holder(d: IOrder): IActionGenerator {
	d.Tag = "h0";
	yield* wait("hold");
	d.Tag = "h1";
}

describe("regaining", () => {
	it("drops, since replaying a regain is not built, and ends as a plain restore", async () => {
		const steps: IScriptStep[] = [
			(d) => d.dispatch(regaining, "o1"),
			(d) => d.dispatch(holder, "o1"),
			(d) => d.release("first", "one"),
			(d) => d.release("hold")
		];
		const script = await playScript(seed(), steps, [
			"Cases/Regaining"
		]);
		const point = script.points.find((at) => at.inFlight.some((row) => row.State === "regaining"))!;
		expect(point.inFlight.map((row) => row.State)).toEqual([
			"regaining",
			"holding"
		]);
		const withEngine = await restoreAt(point, steps, {
			engine: true
		});
		const dataOnly = await restoreAt(point, steps, {
			engine: false
		});
		expect(
			withEngine.engine!.dropped.map((drop) => [
				drop.name,
				drop.reason,
				drop.detail
			])
		).toEqual([
			[
				"Cases/Regaining",
				"off-list",
				"it waits in its entity's line for its hold back, and replaying a regain is not built"
			],
			[
				null,
				"not-marked",
				"the action has no durable name"
			]
		]);
		expect(withEngine.engine!.during).toEqual([]);
		expect(withEngine.end).toEqual(dataOnly.end);
	});
});

function* payHold(d: IOrder): IActionGenerator {
	d.Tag = "reserved";
	yield {
		Type: PAY,
		Name: "pay"
	} as never;
	d.Note = "paid";
}
named(payHold, "Cases/PayHold");
resumable(payHold);

function* cancelIfStuck(d: IOrder): IActionGenerator {
	if (d.Tag === "reserved" && d.Note !== "paid") {
		d.Key = "cancelled";
	}
}
named(cancelIfStuck, "Cases/CancelIfStuck");
resumable(cancelIfStuck);

describe("work that waited behind dropped work", () => {
	it("drops with it, and the run ends as a plain restore", async () => {
		const steps: IScriptStep[] = [
			(d) => d.dispatch(payHold, "o1"),
			(d) => d.dispatch(cancelIfStuck, "o1"),
			(d) => d.release("pay")
		];
		const script = await playScript(seed(), steps, [
			"Cases/PayHold",
			"Cases/CancelIfStuck"
		]);
		const point = script.points.find((at) => at.inFlight.length === 2)!;
		expect(point.inFlight.map((row) => row.State)).toEqual([
			"holding",
			"queued"
		]);
		expect(ended(script.endFrom(point).state).Orders.o1!.Key).toBe("");
		const withEngine = await restoreAt(point, steps, {
			engine: true,
			idempotent: []
		});
		const dataOnly = await restoreAt(point, steps, {
			engine: false
		});
		expect(
			withEngine.engine!.dropped.map((drop) => [
				drop.name,
				drop.reason,
				drop.detail
			])
		).toEqual([
			[
				"Cases/PayHold",
				"not-idempotent",
				'the wait the snapshot caught is "Resume/Pay", which isn\'t declared idempotent'
			],
			[
				"Cases/CancelIfStuck",
				"behind",
				'it waits in its entity\'s line behind "Cases/PayHold", which did not resume'
			]
		]);
		expect(ended(withEngine.end.state).Orders.o1!.Key).toBe("");
		expect(withEngine.end).toEqual(dataOnly.end);
	});
});

function* reserving(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	yield* wait("reserve");
	d.Note = `reserved:${d.Qty}`;
}
named(reserving, "Cases/Reserving");
resumable(reserving);

describe("queued", () => {
	it("dispatches queued marked actions again after the held wait, in Place order", async () => {
		const steps: IScriptStep[] = [
			(d) => d.dispatch(reserving, "o1"),
			(d) => {
				d.dispatch(setQty, "o1", 5);
				d.dispatch(setQty, "o1", 6);
			},
			(d) => d.release("reserve")
		];
		const script = await playScript(seed(), steps, [
			"Cases/Reserving",
			"Cases/SetQty"
		]);
		const point = script.points.find((at) => at.inFlight.length === 3)!;
		expect(
			point.inFlight.map((row) => [
				row.State,
				row.Place
			])
		).toEqual([
			[
				"holding",
				undefined
			],
			[
				"queued",
				0
			],
			[
				"queued",
				1
			]
		]);
		const envelope = JSON.parse(point.json) as {
			InFlight: unknown[];
		};
		envelope.InFlight = [
			envelope.InFlight[0],
			envelope.InFlight[2],
			envelope.InFlight[1]
		];
		const swapped = {
			...point,
			json: JSON.stringify(envelope)
		};
		const restored = await restoreAt(swapped, steps, {
			engine: true
		});
		expect(restored.engine!.resumed.map((resumed) => resumed.name)).toEqual([
			"Cases/Reserving",
			"Cases/SetQty",
			"Cases/SetQty"
		]);
		expect(
			restored.inFlightAfterEngine
				.map((row) => [
					row.State,
					row.Place ?? -1
				])
				.sort((a, b) => (a[1] as number) - (b[1] as number))
		).toEqual([
			[
				"holding",
				-1
			],
			[
				"queued",
				0
			],
			[
				"queued",
				1
			]
		]);
		expect(restored.end).toEqual(script.endFrom(point));
		expect(ended(restored.end.state).Orders.o1!.Qty).toBe(6);
	});

	it("drops a queued action whose line holds a dropped holder and a regaining action, and ends as a plain restore", async () => {
		const steps: IScriptStep[] = [
			(d) => d.dispatch(regainer, "o1"),
			(d) => d.dispatch(lateHolder, "o1"),
			(d) => d.dispatch(appendTag, "o1", "Q"),
			(d) => d.release("first"),
			(d) => d.release("hold")
		];
		const script = await playScript(seed(), steps, [
			"Cases/Regainer",
			"Cases/AppendTag"
		]);
		const point = script.points.find((at) => at.inFlight.some((row) => row.State === "regaining"))!;
		expect(
			point.inFlight.map((row) => [
				row.Name,
				row.State,
				row.Place
			])
		).toEqual([
			[
				"Cases/Regainer",
				"regaining",
				1
			],
			[
				null,
				"holding",
				undefined
			],
			[
				"Cases/AppendTag",
				"queued",
				0
			]
		]);
		expect(ended(script.endFrom(point).state).Orders.o1!.Tag).toBe("HQF");
		const restored = await restoreAt(point, steps, {
			engine: true
		});
		const dataOnly = await restoreAt(point, steps, {
			engine: false
		});
		expect(restored.engine!.resumed).toEqual([]);
		expect(
			restored.engine!.dropped.map((drop) => [
				drop.name,
				drop.reason
			])
		).toEqual([
			[
				"Cases/Regainer",
				"off-list"
			],
			[
				null,
				"not-marked"
			],
			[
				"Cases/AppendTag",
				"behind"
			]
		]);
		expect(restored.end).toEqual(dataOnly.end);
	});

	it("is in the line from the engine's return: a snapshot holds it, and a later dispatch queues behind it", async () => {
		const steps: IScriptStep[] = [
			(d) => d.dispatch(reserving, "o1"),
			(d) => d.dispatch(setQty, "o1", 5),
			(d) => d.release("reserve")
		];
		const script = await playScript(seed(), steps, [
			"Cases/Reserving",
			"Cases/SetQty"
		]);
		const point = script.points.find((at) => at.inFlight.length === 2)!;
		const restored = await restoreAt(point, steps, {
			engine: true,
			beforeRelease: (runtime) => {
				runtime.dispatch(setQty as never, "o1", 7).catch(() => {});
				return true;
			}
		});
		const between = restored.between!;
		expect(
			between.inFlight.map((row) => [
				row.Name,
				row.State,
				row.Place
			])
		).toEqual([
			[
				"Cases/Reserving",
				"holding",
				undefined
			],
			[
				"Cases/SetQty",
				"queued",
				0
			],
			[
				"Cases/SetQty",
				"queued",
				1
			]
		]);
		const histories = (
			JSON.parse(between.json) as {
				Histories: IHistory[];
			}
		).Histories;
		expect(histories.map((history) => history.Args)).toEqual([
			[],
			[
				5
			],
			[
				7
			]
		]);
		expect(ended(restored.end.state).Orders.o1!.Qty).toBe(7);
		const again = await restoreAt(between, steps, {
			engine: true
		});
		expect(again.engine!.dropped).toEqual([]);
		expect(again.engine!.resumed).toHaveLength(3);
		expect(again.end).toEqual(restored.end);
	});

	it("drops a queued row whose entity isn't in the restored tree", async () => {
		const steps: IScriptStep[] = [
			(d) => d.dispatch(lineHolder, "o1-l1"),
			(d) => d.dispatch(setLineQueued, "o1-l1", 4)
		];
		const script = await playScript(seed(), steps, [
			"Cases/SetLineQueued"
		]);
		const point = script.points[script.points.length - 1]!;
		const envelope = JSON.parse(point.json) as {
			AppState: IShop;
		};
		delete envelope.AppState.Orders.o1!.Lines["o1-l1"];
		const restored = await restoreAt(
			{
				...point,
				json: JSON.stringify(envelope)
			},
			[],
			{
				engine: true
			}
		);
		expect(restored.engine!.resumed).toEqual([]);
		expect(
			restored.engine!.dropped.map((drop) => [
				drop.name,
				drop.reason,
				drop.detail
			])
		).toEqual([
			[
				null,
				"not-marked",
				"the action has no durable name"
			],
			[
				"Cases/SetLineQueued",
				"off-list",
				'its entity "o1-l1" is not in the restored tree'
			]
		]);
	});
});

function* regainer(d: IOrder): IOpenGenerator {
	yield* open(wait("first"));
	d.Tag += "F";
}
named(regainer, "Cases/Regainer");
resumable(regainer);

function* lateHolder(d: IOrder): IActionGenerator {
	yield* wait("hold");
	d.Tag += "H";
}

function* appendTag(d: IOrder, tag: string): IActionGenerator {
	d.Tag += tag;
}
named(appendTag, "Cases/AppendTag");
resumable(appendTag);

function* lineHolder(d: ILine): IActionGenerator {
	yield* wait("line");
	d.Qty += 1;
}

function* setLineQueued(d: ILine, qty: number): IActionGenerator {
	d.Qty = qty;
}
named(setLineQueued, "Cases/SetLineQueued");
resumable(setLineQueued);

function* catching(d: IOrder): IOpenGenerator {
	try {
		yield* open(wait("first"));
	} catch (error) {
		d.Note = `${(error as Error).name}:${(error as Error).message}`;
	}
	d.Key = String(yield* open(wait("second")));
}
named(catching, "Cases/Catching");
resumable(catching);

// One error for both runs, so the stacks the records carry are equal.
const NO_STOCK = new RangeError("no stock");

describe("a rejection the action caught", () => {
	it("is thrown in again rebuilt from its recorded form, and the run ends as the uninterrupted one", async () => {
		const steps: IScriptStep[] = [
			(d) => d.dispatch(catching, "o1"),
			(d) => d.fail("first", NO_STOCK),
			(d) => d.release("second", "two")
		];
		const script = await playScript(seed(), steps, [
			"Cases/Catching"
		]);
		expect(script.points).toHaveLength(2);
		for (const point of script.points) {
			const restored = await restoreAt(point, steps, {
				engine: true
			});
			expectEngineFacts(point, restored);
			expect(restored.engine!.dropped).toEqual([]);
			expect(restored.end).toEqual(script.endFrom(point));
		}
	});
});

let token = "t1";

function* reading(d: IOrder): IOpenGenerator {
	const busy = yield* inFlight(setQty, d);
	const read = yield* external("Cases/Token" as never);
	d.Note = `${busy}/${String(read)}`;
	yield* open(wait("first"));
	const self = yield* inFlight(reading, d);
	d.Key = String(self);
	yield* open(wait("second"));
}
named(reading, "Cases/Reading");
resumable(reading);

describe("reads", () => {
	it("answers inFlight and external from the history", async () => {
		const provide = (runtime: IRuntime<any>) =>
			runtime.provideExternal("Cases/Token" as never, {
				read: () => token as never
			});
		const steps: IScriptStep[] = [
			(d) => {
				provide(d.runtime);
			},
			(d) => d.dispatch(reading, "o1"),
			(d) => d.release("first"),
			(d) => d.release("second")
		];
		const script = await playScript(seed(), steps, [
			"Cases/Reading"
		]);
		expect(script.points).toHaveLength(2);
		for (const point of script.points) {
			token = "t2";
			const restored = await restoreAt(point, steps, {
				engine: true,
				before: provide
			});
			token = "t1";
			expectEngineFacts(point, restored);
			expect(restored.engine!.dropped).toEqual([]);
			expect(restored.end).toEqual(script.endFrom(point));
		}
	});
});

function* twice(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	d.Note = String(yield* open(wait("first")));
	d.Qty += 1;
	d.Key = String(yield* open(wait("second")));
	d.Qty += 1;
	d.Tag = String(yield* wait("third"));
}
named(twice, "Cases/Twice");
resumable(twice);

describe("a resumed action resumed again", () => {
	it("carries its history through the first restore, so a second snapshot resumes as well", async () => {
		const steps: IScriptStep[] = [
			(d) => d.dispatch(twice, "o1"),
			(d) => d.dispatch(setLine, "o1-l1", 4),
			(d) => d.release("first", "one"),
			(d) => d.dispatch(setLine, "o1-l1", 5),
			(d) => d.release("second", "two"),
			(d) => d.release("third", "three")
		];
		const script = await playScript(seed(), steps, [
			"Cases/Twice"
		]);
		const first = script.points.find((point) => point.at === 2)!;
		for (const at of [
			3,
			4
		]) {
			const again = await resnapshot(first, steps, at);
			expect(again.firstEngine.dropped).toEqual([]);
			const history = (
				JSON.parse(again.json) as {
					Histories: IHistory[];
				}
			).Histories[0]!;
			const seqs = history.Entries.filter((entry) => entry.Kind === "effect").map(
				(entry) =>
					(
						entry as {
							Seq: number;
						}
					).Seq
			);
			expect(new Set(seqs).size).toBe(seqs.length);
			expect(seqs[0]).toBe(-1);
			expect(seqs[1]).toBeGreaterThan(0);
			const restored = await restoreAt(again, steps, {
				engine: true
			});
			expect(restored.engine!.dropped).toEqual([]);
			expectEngineFacts(again, restored);
			const uninterrupted = script.points.find((point) => point.at === at)!;
			expect(restored.end).toEqual(script.endFrom(uninterrupted));
		}
	});

	async function carriedThenSet(steps: IScriptStep[], cut: number) {
		const script = await playScript(seed(), steps, [
			"Cases/Twice"
		]);
		const point = script.points.find((at) => at.at === cut)!;
		const again = await resnapshot(point, steps, cut + 1);
		expect(again.firstEngine.dropped).toEqual([]);
		const history = (
			JSON.parse(again.json) as {
				Histories: IHistory[];
			}
		).Histories[0]!;
		const restored = await restoreAt(again, steps, {
			engine: true
		});
		expect(restored.engine!.dropped).toEqual([]);
		expectEngineFacts(again, restored);
		expect(restored.end).toEqual(script.endFrom(script.points.find((at) => at.at === cut + 1)!));
		return history.Entries.map((entry) =>
			entry.Kind === "other"
				? [
						entry.Change.Landing!.Path.join("."),
						entry.Change.Prev,
						entry.Change.Value
					]
				: entry.Kind
		);
	}

	it("doesn't merge a set after the restore across a carried change that ended the merging, and resumes exactly", async () => {
		function* setMeta(d: IOrder, text: string): IActionGenerator {
			(
				d as unknown as {
					Meta: {
						Text: string;
					};
				}
			).Meta = {
				Text: text
			};
		}
		function* setMetaText(d: IOrder, text: string): IActionGenerator {
			(
				d as unknown as {
					Meta: {
						Text: string;
					};
				}
			).Meta.Text = text;
		}
		const entries = await carriedThenSet(
			[
				(d) => d.dispatch(setMeta, "o1", "a"),
				(d) => d.dispatch(twice, "o1"),
				(d) => d.dispatch(setMetaText, "o1", "b"),
				(d) => d.dispatch(setMeta, "o1", "c"),
				(d) => d.dispatch(setMetaText, "o1", "d"),
				(d) => d.release("first", "one"),
				(d) => d.release("second", "two"),
				(d) => d.release("third", "three")
			],
			3
		);
		expect(entries).toEqual([
			"step",
			"effect",
			[
				"Meta.Text",
				"a",
				"b"
			],
			[
				"Meta",
				{
					Text: "b"
				},
				{
					Text: "c"
				}
			],
			[
				"Meta.Text",
				"c",
				"d"
			]
		]);
	});

	it("doesn't merge a set after the restore into a carried change before the action's answer, and resumes exactly", async () => {
		function* setTag(d: IOrder, tag: string): IActionGenerator {
			d.Tag = tag;
		}
		const entries = await carriedThenSet(
			[
				(d) => d.dispatch(twice, "o1"),
				(d) => d.dispatch(setTag, "o1", "x"),
				(d) => d.release("first", "one"),
				(d) => d.dispatch(setTag, "o1", "y"),
				(d) => d.release("second", "two"),
				(d) => d.release("third", "three")
			],
			2
		);
		expect(entries.filter((entry) => typeof entry !== "string")).toEqual([
			[
				"Tag",
				"",
				"x"
			],
			[
				"Tag",
				"x",
				"y"
			]
		]);
		expect(entries.indexOf("response")).toBe(3);
	});

	it("merges another writer's sets across the restore and the wait sent again, and resumes exactly from there", async () => {
		function* setTag(d: IOrder, tag: string): IActionGenerator {
			d.Tag = tag;
		}
		const steps: IScriptStep[] = [
			(d) => d.dispatch(twice, "o1"),
			(d) => d.dispatch(setLine, "o1-l1", 4),
			(d) => d.dispatch(setTag, "o1", "x"),
			(d) => d.dispatch(setLine, "o1-l1", 5),
			(d) => d.dispatch(setTag, "o1", "y"),
			(d) => d.dispatch(setLine, "o1-l1", 6),
			(d) => d.release("first", "one"),
			(d) => d.dispatch(setLine, "o1-l1", 7),
			(d) => d.release("second", "two"),
			(d) => d.release("third", "three")
		];
		const script = await playScript(seed(), steps, [
			"Cases/Twice"
		]);
		const first = script.points.find((point) => point.at === 2)!;
		const run = await restoreWithResume<IShop>(first.json, "shop");
		const engine = runEngine(run);
		expect(engine.dropped).toEqual([]);
		const driver = driverOf(run.runtime, run.waiting);
		await steps[3]!(driver);
		await settled();
		engine.release();
		await settled();
		for (const step of steps.slice(4, 6)) {
			await step(driver);
			await settled();
		}
		const json = createSnapshot(run.runtime);
		run.runtime.dispose();
		const history = (
			JSON.parse(json) as {
				Histories: IHistory[];
			}
		).Histories[0]!;
		expect(
			history.Entries.map((entry) =>
				entry.Kind === "other"
					? [
							entry.Change.Landing!.EntityId,
							entry.Change.Prev,
							entry.Change.Value
						]
					: entry.Kind
			)
		).toEqual([
			"step",
			"effect",
			[
				"o1-l1",
				1,
				6
			],
			[
				"o1",
				"",
				"y"
			]
		]);
		expect(
			(
				history.Entries[1] as {
					Seq: number;
				}
			).Seq
		).toBeGreaterThan(0);
		const uninterrupted = script.points.find((point) => point.at === 5)!;
		const again = {
			...first,
			at: 5,
			json,
			inFlight: uninterrupted.inFlight
		};
		const restored = await restoreAt(again, steps, {
			engine: true
		});
		expect(restored.engine!.dropped).toEqual([]);
		expectEngineFacts(again, restored);
		expect(restored.end).toEqual(script.endFrom(uninterrupted));
	});
});

function* lead(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	d.Note = String(yield* open(wait("first")));
}
named(lead, "Cases/Lead");
leading(lead);
resumable(lead);

function* last(d: IOrder, n: number): IOpenGenerator {
	d.Qty += 1;
	d.Note = `${n}:${String(yield* open(wait("first")))}`;
}
named(last, "Cases/Last");
latest(last);
resumable(last);

const busy = workTag("Cases/Busy");
busy.mark(lead);

async function resumedOne<T extends object>(action: Function, ...args: unknown[]) {
	const h = harness<T>(seed() as T);
	h.runtime.dispatch(action as never, "o1", ...(args as never[])).catch(() => {});
	await until(() => h.waiting.some((w) => w.name === "first"));
	const json = createSnapshot(h.runtime);
	h.runtime.dispose();
	const run = await restoreWithResume<IShop>(json, "shop");
	const engine = runEngine(run);
	expect(engine.dropped).toEqual([]);
	return {
		run,
		engine
	};
}

describe("beside the arrival marks and inFlight", () => {
	it("counts a resumed action as running for inFlight and its work tags from the engine on", async () => {
		const { run, engine } = await resumedOne(lead);
		const read = (counted: Function | typeof busy) =>
			run.runtime.processSelector(
				function* (): ISelectorGenerator<boolean> {
					return yield* inFlight(counted as never, run.runtime.state.Orders.o1!);
				},
				() => run.runtime.state
			);
		expect(read(lead)).toBe(true);
		expect(read(busy)).toBe(true);
		engine.release();
		run.release("first", "x");
		await settled();
		expect(read(lead)).toBe(false);
		expect(read(busy)).toBe(false);
		run.runtime.dispose();
	});

	it("drops a repeat of a resumed leading action", async () => {
		const { run, engine } = await resumedOne(lead);
		const from = run.records.length;
		await run.runtime.dispatch(lead, "o1");
		expect(
			run.records
				.slice(from)
				.filter((record) => record.Kind === "action:end")
				.map(
					(record) =>
						(
							record as {
								Status: string;
							}
						).Status
				)
		).toEqual([
			"dropped"
		]);
		engine.release();
		run.release("first", "x");
		await settled();
		expect(run.runtime.state.Orders.o1!.Note).toBe("x");
		expect(run.runtime.state.Orders.o1!.Qty).toBe(2);
		run.runtime.dispose();
	});

	it("lets a later latest arrival stop a resumed action, whose held wait is then never sent", async () => {
		const { run, engine } = await resumedOne(last, 1);
		const done = run.runtime.dispatch(last, "o1", 2);
		await settled();
		engine.release();
		await settled();
		expect(run.waiting.map((w) => w.name)).toEqual([
			"first"
		]);
		expect(
			run.internal
				.get("runtime/inFlightActions")()
				.map((row) => row.Name)
		).toEqual([
			"Cases/Last"
		]);
		run.release("first", "y");
		await done;
		expect(run.runtime.state.Orders.o1!.Note).toBe("2:y");
		expect(
			run.records
				.filter((record) => record.Kind === "action:end")
				.map(
					(record) =>
						(
							record as {
								Status: string;
							}
						).Status
				)
		).toEqual([
			"cancelled",
			"completed"
		]);
		expect(run.diags).toEqual([]);
		run.runtime.dispose();
	});
});

function* boom(name: string): IActionGenerator<any> {
	return yield {
		Type: BOOM,
		Name: name
	} as never;
}

function* thrownNow(d: IOrder): IOpenGenerator {
	yield* open(
		(function* () {
			try {
				yield* boom("at once");
			} catch (error) {
				d.Note = (error as Error).message;
			}
			d.Key = String(yield* wait("second"));
		})()
	);
}
named(thrownNow, "Cases/ThrownNow");
resumable(thrownNow);

describe("a yield the live run didn't park on", () => {
	it("is answered without letting go, so a catch inside open(...) still writes the draft", async () => {
		const steps: IScriptStep[] = [
			(d) => d.dispatch(thrownNow, "o1"),
			(d) => d.release("second", "two")
		];
		const script = await playScript(seed(), steps, [
			"Cases/ThrownNow"
		]);
		const point = script.points[0]!;
		expect(point.inFlight.map((row) => row.State)).toEqual([
			"open"
		]);
		const history = (
			JSON.parse(point.json) as {
				Histories: IHistory[];
			}
		).Histories[0]!;
		expect(history.Entries.find((entry) => entry.Kind === "response")).toMatchObject({
			Sync: true
		});
		const restored = await restoreAt(point, steps, {
			engine: true
		});
		expectEngineFacts(point, restored);
		expect(restored.engine!.dropped).toEqual([]);
		expect(restored.end).toEqual(script.endFrom(point));
		expect(ended(restored.end.state).Orders.o1!.Note).toBe("at once");
	});
});

const refused: string[] = [];

function* parksThenWrites(d: IOrder): IOpenGenerator {
	yield* open(
		(function* () {
			yield* wait("first");
			try {
				d.Note = "inside";
			} catch (error) {
				refused.push((error as Error).name);
			}
			yield* wait("second");
		})()
	);
	d.Key = "done";
}
named(parksThenWrites, "Cases/ParksThenWrites");
resumable(parksThenWrites);

describe("a yield the live run parked on inside open(...)", () => {
	it("lets go before its answer in the replay too, so the draft write after it is refused there as it was live", async () => {
		const steps: IScriptStep[] = [
			(d) => d.dispatch(parksThenWrites, "o1"),
			(d) => d.release("first"),
			(d) => d.release("second")
		];
		const script = await playScript(seed(), steps, [
			"Cases/ParksThenWrites"
		]);
		const point = script.points.find((at) => at.at === 1)!;
		expect(refused).toEqual([
			"DraftInsideOpenError"
		]);
		const restored = await restoreAt(point, steps, {
			engine: true
		});
		expectEngineFacts(point, restored);
		expect(restored.engine!.dropped).toEqual([]);
		expect(refused).toEqual([
			"DraftInsideOpenError",
			"DraftInsideOpenError"
		]);
		expect(restored.end).toEqual(script.endFrom(point));
		expect(ended(restored.end.state).Orders.o1).toMatchObject({
			Note: "",
			Key: "done"
		});
	});
});

function* waitsInOpen(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	d.Note = String(yield* open(wait("first")));
}
named(waitsInOpen, "Cases/WaitsInOpen");
resumable(waitsInOpen);

function* deletesLine(d: IOrder): IActionGenerator {
	delete d.Lines["o1-l1"];
}

describe("while the engine runs", () => {
	it("a tap hears nothing but the resumed start, though the replay's scope ends the life of an entity deleted before the snapshot", async () => {
		const steps: IScriptStep[] = [
			(d) => d.dispatch(waitsInOpen, "o1"),
			(d) => d.dispatch(deletesLine, "o1"),
			(d) => d.release("first", "one")
		];
		const script = await playScript(seed(), steps, [
			"Cases/WaitsInOpen"
		]);
		const point = script.points.find((at) => at.at === 1)!;
		expect(
			(
				JSON.parse(point.json) as {
					AppState: IShop;
				}
			).AppState.Orders.o1!.Lines
		).toEqual({});
		const restored = await restoreAt(point, steps, {
			engine: true
		});
		expect(restored.engine!.dropped).toEqual([]);
		expect(
			restored.engine!.during.map((record) => [
				record.Kind,
				record.Kind === "action:start" ? record.ResumedFrom : undefined
			])
		).toEqual([
			[
				"action:start",
				point.inFlight.find((row) => row.Name === "Cases/WaitsInOpen")!.ActionId
			]
		]);
		expect(restored.end).toEqual(script.endFrom(point));
	});
});

function* announced(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	d.Note = String(yield* open(wait("first")));
	d.Key = String(yield* open(wait("second")));
}
named(announced, "Cases/Announced");
resumable(announced);

describe("the resumed start", () => {
	it("reaches a tap with the carried history already kept, so a snapshot taken there resumes", async () => {
		const steps: IScriptStep[] = [
			(d) => d.dispatch(announced, "o1"),
			(d) => d.release("first", "one"),
			(d) => d.release("second", "two")
		];
		const script = await playScript(seed(), steps, [
			"Cases/Announced"
		]);
		const point = script.points.find((at) => at.at === 1)!;
		let taken: string | undefined;
		const run = await restoreWithResume<IShop>(point.json, "shop", {
			setup: (restored) => {
				restored.on("record", (record) => {
					if (record.Kind === "action:start" && record.ResumedFrom !== undefined) {
						taken = createSnapshot(restored);
					}
				});
			}
		});
		runEngine(run);
		run.runtime.dispose();
		const again = await restoreAt(
			{
				...point,
				json: taken!
			},
			steps,
			{
				engine: true
			}
		);
		expect(again.engine!.dropped).toEqual([]);
		expect(again.end).toEqual(script.endFrom(point));
	});
});

function* twin(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	d.Note = String(yield* open(wait("first")));
}
named(twin, "Cases/Twin");
resumable(twin);

function* sameAsTwin(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	d.Note = String(yield* open(wait("first")));
}
named(sameAsTwin, "Cases/SameAsTwin");
resumable(sameAsTwin);

function* unlikeTwin(d: IOrder): IOpenGenerator {
	d.Qty += 2;
	d.Note = String(yield* open(wait("first")));
}
named(unlikeTwin, "Cases/UnlikeTwin");
resumable(unlikeTwin);

const Nearest = (receiver as (id: string) => (cases: object) => object)("Cases/NearestReceiver")({
	*"Cases/Nearest"(d: { Hits: number }) {
		d.Hits += 1;
	}
});

const toNearest = publishToNearest as unknown as (entity: IEntity, topic: string) => IActionGenerator;

function* nearing(d: IOrder): IOpenGenerator {
	yield* toNearest(d, "Cases/Nearest");
	d.Note = "sent";
	yield* open(wait("first"));
	d.Key = "done";
}
named(nearing, "Cases/Nearing");
resumable(nearing);

describe("publishToNearest", () => {
	it("is answered from the history without running again, and the run ends as the uninterrupted one", async () => {
		const bound = () => ({
			...seed(),
			$Receiver: "Cases/NearestReceiver",
			Hits: 0
		});
		const setup = (runtime: IRuntime<any>) => runtime.registerReceiver(Nearest as never);
		const steps: IScriptStep[] = [
			(d) => d.dispatch(nearing, "o1"),
			(d) => d.release("first")
		];
		const script = await playScript(
			bound(),
			steps,
			[
				"Cases/Nearing"
			],
			{
				setup
			}
		);
		const point = script.points[0]!;
		const history = (
			JSON.parse(point.json) as {
				Histories: IHistory[];
			}
		).Histories[0]!;
		expect(
			history.Entries.some(
				(entry) =>
					entry.Kind === "effect" &&
					(
						entry.Descriptor as {
							Type?: unknown;
						}
					).Type === "publishToNearest"
			)
		).toBe(true);
		const restored = await restoreAt(point, steps, {
			engine: true,
			setup
		});
		expectEngineFacts(point, restored);
		expect(restored.engine!.dropped).toEqual([]);
		expect(restored.end).toEqual(script.endFrom(point));
		expect(
			(
				JSON.parse(restored.end.state) as {
					Hits: number;
				}
			).Hits
		).toBe(1);
	});
});

describe("an arrival", () => {
	async function replayedAs(name: string) {
		const h = harness<IShop>(seed());
		h.runtime.dispatch(twin, "o1").catch(() => {});
		await until(() => h.waiting.length > 0);
		const envelope = JSON.parse(createSnapshot(h.runtime)) as {
			InFlight: {
				Name: string;
			}[];
		};
		h.runtime.dispose();
		envelope.InFlight[0]!.Name = name;
		const run = await restoreWithResume<IShop>(JSON.stringify(envelope), "shop");
		const engine = runEngine(run);
		run.runtime.dispose();
		return engine;
	}

	it("is noted at the hand-over, and a dropped replay notes none", async () => {
		expect((await replayedAs("Cases/UnlikeTwin")).dropped.map((drop) => drop.reason)).toEqual([
			"diverged"
		]);
		expect(() => workTag("Cases/Unlike").mark(unlikeTwin)).not.toThrow();
		expect((await replayedAs("Cases/SameAsTwin")).dropped).toEqual([]);
		expect(() => workTag("Cases/Same").mark(sameAsTwin)).toThrow(/already been dispatched/);
	});
});

function* heldOn(d: IOrder, paying: boolean): IActionGenerator {
	d.Qty += 1;
	if (paying) {
		yield {
			Type: PAY,
			Name: "pay"
		} as never;
	} else {
		yield* wait("held");
	}
	d.Key = `after:${d.Note}`;
}
named(heldOn, "Cases/HeldOn");
resumable(heldOn);

function* fromAbove(d: IShop): IActionGenerator {
	d.Orders.o1!.Note = "above";
	d.Orders.o2!.Note = "above";
}

describe("a diag reported once per pair of actions", () => {
	it("is reported on the resumed action's entity when the uninterrupted run's one report was on work the restore dropped", async () => {
		const two = (): IShop => {
			const shop = seed();
			shop.Orders.o2 = {
				...shop.Orders.o1!,
				$Id: "o2",
				Lines: {}
			};
			return shop;
		};
		const steps: IScriptStep[] = [
			(d) => d.dispatch(heldOn, "o1", true),
			(d) => d.dispatch(heldOn, "o2", false),
			(d) => d.dispatch(fromAbove, "shop"),
			(d) => d.release("pay", "paid"),
			(d) => d.release("held")
		];
		const script = await playScript(two(), steps, [
			"Cases/HeldOn"
		]);
		const point = script.points.find((at) => at.at === 1)!;
		const uninterrupted = script.endFrom(point);
		const withEngine = await restoreAt(point, steps, {
			engine: true
		});
		const dataOnly = await restoreAt(point, steps, {
			engine: false
		});
		expect(
			withEngine.engine!.resumed.map((resumed) => [
				resumed.name,
				resumed.entityId
			])
		).toEqual([
			[
				"Cases/HeldOn",
				"o2"
			]
		]);
		expect(
			withEngine.engine!.dropped.map((drop) => [
				drop.name,
				drop.entityId,
				drop.reason
			])
		).toEqual([
			[
				"Cases/HeldOn",
				"o1",
				"not-idempotent"
			]
		]);
		const pair = "entity/written-while-held[fromAbove>Cases/HeldOn]";
		expect(uninterrupted.diags).toEqual([
			`${pair}@o1`
		]);
		expect(withEngine.end.diags).toEqual([
			`${pair}@o2`
		]);
		expect(dataOnly.end.diags).toEqual([]);
		expect(ended(withEngine.end.state).Orders.o2).toEqual(ended(uninterrupted.state).Orders.o2);
		expect(ended(withEngine.end.state).Orders.o2).toMatchObject({
			Qty: 2,
			Note: "above",
			Key: "after:above"
		});
	});
});
