import type { IActionGenerator, IEffect, IEntity, IOpenGenerator, IRuntime } from "../../src/index";
import type { IResumeOption } from "../../src/Resume/createKeeper";
import type { IPrefix } from "../../src/Resume/IPrefix";
import type { IDropReason } from "../../src/Resume/plan";
import type { IPrefixSupport } from "../../src/Resume/prefix";
import type { IResumeDrop } from "../../src/Resume/resume";
import type { IWriteScope } from "../../src/Runtime/createWriteGateway";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IPoint, IRestoreAt, IScriptStep } from "./replayScript";
import { describe, expect, it } from "vitest";
import { defineEffect } from "../../src/Effects/defineEffect";
import { entity } from "../../src/Effects/entity";
import { generateGuid } from "../../src/Effects/generateGuid";
import { select } from "../../src/Reads/select";
import { resumable } from "../../src/Resume/resumable";
import { latest, leading } from "../../src/Runtime/arrivalPolicy";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { REFUSAL_LIMIT } from "../../src/Runtime/fiberMachine";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { isRefusal } from "../../src/Runtime/refusal";
import { rawOf } from "../../src/Runtime/viewProxy";
import { workTag } from "../../src/Runtime/workTag";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { settled } from "../../src/Testing/createTestRuntime";
import * as reactive from "../reactive";
import { PAY, restoreWithResume, runEngine } from "./replayHarness";
import { playScript, restoreAt } from "./replayScript";
import { harness, until, wait } from "./resumeHarness";

interface ILine extends IEntity {
	Qty: number;
}

interface IOrder extends IEntity {
	Qty: number;
	Key: string;
	Note: string;
	Tag: string;
	Closed: string;
	Lines: Record<string, ILine>;
	Rows: IRow[];
}

interface IRow {
	K: string;
	N: number;
	G: string;
}

interface IShop extends IEntity {
	Orders: Record<string, IOrder>;
}

const order = (id: string): IOrder => ({
	$Id: id,
	Qty: 1,
	Key: "",
	Note: "",
	Tag: "",
	Closed: "",
	Rows: [],
	Lines: {
		[`${id}-l1`]: {
			$Id: `${id}-l1`,
			Qty: 1
		}
	}
});

function seed(): IShop {
	return {
		$Id: "shop",
		Orders: {
			o1: order("o1"),
			o2: order("o2")
		}
	};
}

function* pay(name: string): IActionGenerator<any> {
	return yield {
		Type: PAY,
		Name: name
	} as never;
}

// Set by the finally blocks below, which a fallback must never run.
let closes = 0;

function* flow(d: IOrder, _a?: unknown, _b?: unknown): IOpenGenerator {
	try {
		d.Qty += 1;
		d.Note = String(yield* open(wait("first")));
		d.Key = String(yield* wait("second"));
	} finally {
		closes++;
		d.Closed = "closed";
	}
}
named(flow, "Fallback/Flow");
resumable(flow);

function* unmarked(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	d.Note = String(yield* open(wait("first")));
}
named(unmarked, "Fallback/Unmarked");

function* paying(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	d.Key = String(yield* pay("pay"));
}
named(paying, "Fallback/Paying");
resumable(paying);

let ticks = 0;

function* clocked(d: IOrder): IOpenGenerator {
	try {
		d.Note = `t${++ticks}`;
		yield* open(wait("first"));
	} finally {
		closes++;
		d.Closed = "closed";
	}
}
named(clocked, "Fallback/Clocked");
resumable(clocked);

let current: IRuntime<any> | null = null;

function* setLine(d: ILine, qty: number): IActionGenerator {
	d.Qty = qty;
}

function* dispatching(d: IOrder): IOpenGenerator {
	try {
		d.Qty += 1;
		current?.dispatch(setLine, "o1-l1", 3);
		d.Note = "after the dispatch";
		yield* open(wait("first"));
	} finally {
		closes++;
		d.Closed = "closed";
	}
}
named(dispatching, "Fallback/Dispatching");
resumable(dispatching);

let elsewhere: IRuntime<{
	$Id: string;
	N: number;
}> | null = null;

function* bump(d: { N: number }): IActionGenerator {
	d.N += 1;
}

function* dispatchingElsewhere(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	elsewhere?.dispatch(bump, "other").catch(() => {});
	yield* open(wait("first"));
	d.Note = "after";
}
named(dispatchingElsewhere, "Fallback/DispatchingElsewhere");
resumable(dispatchingElsewhere);

function* selecting(d: IOrder): IOpenGenerator {
	try {
		const qty = yield* select(function* (s: IOrder) {
			return s.Qty;
		});
		d.Note = String(qty);
		yield* open(wait("first"));
	} finally {
		closes++;
		d.Closed = "closed";
	}
}
named(selecting, "Fallback/Selecting");
resumable(selecting);

function* minting(d: IOrder): IOpenGenerator {
	const made = yield* entity<ILine>({
		Qty: 5
	});
	d.Lines[made.$Id] = made;
	yield* open(wait("first"));
}
named(minting, "Fallback/Minting");
resumable(minting);

function* moveOut(d: IShop): IActionGenerator {
	const line = d.Orders.o1!.Lines["o1-l1"]!;
	delete d.Orders.o1!.Lines["o1-l1"];
	d.Orders.o2!.Lines["o1-l1"] = line;
}

function* onLine(d: ILine): IOpenGenerator {
	d.Qty = 50;
	yield* open(wait("line"));
	d.Qty = 51;
}
named(onLine, "Fallback/OnLine");
resumable(onLine);

function* second(d: IOrder): IOpenGenerator {
	d.Tag = "b0";
	d.Tag = String(yield* open(wait("other")));
}

function* replaced(d: IOrder, _a?: unknown, _b?: unknown): IOpenGenerator {
	d.Qty += 1;
	d.Note = String(yield* open(wait("first")));
}
named(replaced, "Fallback/Replaced");
latest(replaced);
resumable(replaced);
named(second, "Fallback/Second");
resumable(second);

const RELEASES: IScriptStep[] = [
	(d) => d.release("first", "one"),
	(d) => d.release("second", "two"),
	(d) => d.release("pay", "paid"),
	(d) => d.release("other", "b1"),
	(d) => d.release("line")
];

interface ICase {
	steps: IScriptStep[];
	marked: string[];
	resume?: IResumeOption;
	restore?: Partial<IRestoreAt>;
	edit?: (envelope: Record<string, any>) => void;
}

async function onlyPoint(given: ICase): Promise<IPoint> {
	const script = await playScript(seed(), given.steps, given.marked, {
		resume: given.resume
	});
	const point = script.points[script.points.length - 1];
	if (!point) {
		throw new Error("no point");
	}
	if (!given.edit) {
		return point;
	}
	const envelope = JSON.parse(point.json);
	given.edit(envelope);
	return {
		...point,
		json: JSON.stringify(envelope)
	};
}

/** The engine drops every row, and the run then ends as a restore with no engine run. */
async function dropsAsDataOnly(given: ICase, reasons: IDropReason[]): Promise<string[]> {
	return (await droppedAsDataOnly(given, reasons)).map((drop) => drop.detail ?? "");
}

async function droppedAsDataOnly(given: ICase, reasons: IDropReason[]): Promise<IResumeDrop[]> {
	const point = await onlyPoint(given);
	const steps = [
		...given.steps.slice(0, point.at + 1),
		...RELEASES
	];
	const closed = closes;
	const withEngine = await restoreAt(point, steps, {
		...given.restore,
		engine: true
	});
	const dataOnly = await restoreAt(point, steps, {
		...given.restore,
		engine: false
	});
	const engine = withEngine.engine!;
	expect(engine.resumed).toEqual([]);
	expect(engine.dropped.map((drop) => drop.reason)).toEqual(reasons);
	expect(engine.during).toEqual([]);
	expect(engine.diagsDuring).toBe(0);
	expect(withEngine.afterEngine).toEqual(withEngine.beforeEngine);
	expect(withEngine.inFlightAfterEngine).toEqual([]);
	expect(withEngine.end).toEqual(dataOnly.end);
	expect(closes).toBe(closed);
	return engine.dropped;
}

const start =
	(action: Function, ...args: unknown[]): IScriptStep =>
	(d) =>
		d.dispatch(action, "o1", ...args);

describe("a row the engine can't resume drops as a data-only restore drops it", () => {
	it("not-marked: an unmarked action", async () => {
		await dropsAsDataOnly(
			{
				steps: [
					start(unmarked)
				],
				marked: [
					"Fallback/Unmarked"
				]
			},
			[
				"not-marked"
			]
		);
	});

	it("resume-off: a runtime without the resume option", async () => {
		await dropsAsDataOnly(
			{
				steps: [
					start(flow)
				],
				marked: [
					"Fallback/Flow"
				],
				restore: {
					resume: false
				}
			},
			[
				"resume-off"
			]
		);
	});

	it("other-build", async () => {
		await dropsAsDataOnly(
			{
				steps: [
					start(flow)
				],
				marked: [
					"Fallback/Flow"
				],
				restore: {
					sameBuild: false
				}
			},
			[
				"other-build"
			]
		);
	});

	it("no-history: a snapshot without the section", async () => {
		await dropsAsDataOnly(
			{
				steps: [
					start(flow)
				],
				marked: [
					"Fallback/Flow"
				],
				edit: (envelope) => {
					delete envelope.Histories;
				}
			},
			[
				"no-history"
			]
		);
	});

	it("over-budget", async () => {
		await dropsAsDataOnly(
			{
				steps: [
					start(flow)
				],
				marked: [
					"Fallback/Flow"
				],
				resume: {
					budget: 10
				}
			},
			[
				"over-budget"
			]
		);
	});

	it("over-budget: past the total across the snapshot's histories", async () => {
		await dropsAsDataOnly(
			{
				steps: [
					start(flow)
				],
				marked: [
					"Fallback/Flow"
				],
				resume: {
					total: 10
				}
			},
			[
				"over-budget"
			]
		);
	});

	it("unknown-name", async () => {
		await dropsAsDataOnly(
			{
				steps: [
					start(flow)
				],
				marked: [
					"Fallback/Flow"
				],
				edit: (envelope) => {
					envelope.InFlight[0].Name = "Fallback/Nobody";
				}
			},
			[
				"unknown-name"
			]
		);
	});

	it("not-idempotent: a caught plain effect that isn't declared idempotent, with the wait's Type, as the action's own doing", async () => {
		const [drop] = await droppedAsDataOnly(
			{
				steps: [
					start(paying)
				],
				marked: [
					"Fallback/Paying"
				]
			},
			[
				"not-idempotent"
			]
		);
		expect(drop).toMatchObject({
			wait: PAY,
			ownDoing: true
		});
		expect(drop!.detail).toContain("isn't declared idempotent");
	});

	it("off-list: arguments the history can't give back, as the action's own doing", async () => {
		const [drop] = await droppedAsDataOnly(
			{
				steps: [
					start(flow, undefined, 1)
				],
				marked: [
					"Fallback/Flow"
				]
			},
			[
				"off-list"
			]
		);
		expect(drop!.ownDoing).toBe(true);
	});

	it("off-list: a child made with entity(), as the action's own doing", async () => {
		const [drop] = await droppedAsDataOnly(
			{
				steps: [
					start(minting)
				],
				marked: [
					"Fallback/Minting"
				]
			},
			[
				"off-list"
			]
		);
		expect(drop!.detail).toContain("entity()");
		expect(drop!.ownDoing).toBe(true);
	});

	it("watched: something tracks a read of the tree", async () => {
		let stop: (() => void) | undefined;
		const watch = (runtime: IRuntime<any>) => {
			stop = reactive.root((dispose) => {
				reactive.effect(() => runtime.state.Orders.o1.Qty);
				return dispose;
			});
		};
		const [detail] = await dropsAsDataOnly(
			{
				steps: [
					start(flow)
				],
				marked: [
					"Fallback/Flow"
				],
				restore: {
					before: watch
				}
			},
			[
				"watched"
			]
		);
		stop?.();
		expect(detail).toContain("reactive scope");
	});

	it("diverged: a step that reads a clock", async () => {
		const [detail] = await dropsAsDataOnly(
			{
				steps: [
					start(clocked)
				],
				marked: [
					"Fallback/Clocked"
				]
			},
			[
				"diverged"
			]
		);
		expect(detail).toContain("differ from the history");
	});

	it("diverged: a dispatch from step code, which starts nothing", async () => {
		const [detail] = await dropsAsDataOnly(
			{
				steps: [
					(d) => {
						current = d.runtime;
					},
					start(dispatching)
				],
				marked: [
					"Fallback/Dispatching"
				],
				restore: {
					before: (runtime) => {
						current = runtime;
					}
				}
			},
			[
				"diverged"
			]
		);
		current = null;
		expect(detail).toContain("step code dispatched");
	});

	it("a dispatch from step code on another runtime runs there and diverges nothing: what is running a prefix is per runtime", async () => {
		const other = createRuntime<{
			$Id: string;
			N: number;
		}>({
			$Id: "other",
			N: 0
		});
		elsewhere = other;
		const steps: IScriptStep[] = [
			start(dispatchingElsewhere),
			(d) => d.release("first")
		];
		const script = await playScript(seed(), steps, [
			"Fallback/DispatchingElsewhere"
		]);
		await settled();
		expect(other.state.N).toBe(1);
		const restored = await restoreAt(script.points[0]!, steps, {
			engine: true
		});
		elsewhere = null;
		expect(restored.engine!.dropped).toEqual([]);
		expect(restored.end).toEqual(script.endFrom(script.points[0]!));
		expect(other.state.N).toBe(2);
		other.dispose();
	});

	it("diverged: a read other than inFlight and external", async () => {
		const [detail] = await dropsAsDataOnly(
			{
				steps: [
					start(selecting)
				],
				marked: [
					"Fallback/Selecting"
				]
			},
			[
				"diverged"
			]
		);
		expect(detail).toContain('read "select"');
	});

	it("diverged: another writer moved a child out of the entity", async () => {
		await dropsAsDataOnly(
			{
				steps: [
					start(flow),
					(d) => d.dispatch(moveOut, "shop")
				],
				marked: [
					"Fallback/Flow"
				]
			},
			[
				"diverged"
			]
		);
	});

	it("off-list: an action the runtime had stopped", async () => {
		const h = harness<IShop>(seed());
		h.runtime.dispatch(replaced, "o1").catch(() => {});
		await until(() => h.waiting.some((w) => w.name === "first"));
		// The replacing arrival's arguments aren't exact, so it drops too, and the run is a data-only one.
		h.runtime.dispatch(replaced, "o1", undefined, 1).catch(() => {});
		const json = createSnapshot(h.runtime);
		const rows = (
			JSON.parse(json) as {
				InFlight: {
					State: string;
				}[];
			}
		).InFlight;
		expect(rows.map((row) => row.State)).toEqual([
			"stopping",
			"open"
		]);
		const point: IPoint = {
			at: 0,
			json,
			cut: {
				records: 0,
				diags: 0,
				failures: 0,
				onError: 0
			},
			guids: {},
			inFlight: []
		};
		const withEngine = await restoreAt(point, [], {
			engine: true
		});
		const dataOnly = await restoreAt(point, [], {
			engine: false
		});
		expect(
			withEngine.engine!.dropped.map((drop) => [
				drop.reason,
				drop.detail
			])
		).toEqual([
			[
				"off-list",
				"the runtime had stopped it"
			],
			[
				"off-list",
				"its arguments hold an undefined before a set argument, which the history can't give back"
			]
		]);
		expect(withEngine.end).toEqual(dataOnly.end);
		h.runtime.dispose();
	});
});

let broken: "first" | "later" | null = null;

function* throwing(d: IOrder): IOpenGenerator {
	if (broken === "first") {
		throw new Error("first step");
	}
	d.Qty += 1;
	yield* open(wait("first"));
	if (broken === "later") {
		throw new Error("later step");
	}
	d.Note = "x";
	yield* open(wait("second"));
}
named(throwing, "Fallback/Throwing");
resumable(throwing);

function* quitting(_d: IOrder): IOpenGenerator {
	if (broken === "first") {
		return;
	}
	yield* open(wait("first"));
	if (broken === "later") {
		return;
	}
	yield* open(wait("second"));
}
named(quitting, "Fallback/Quitting");
resumable(quitting);

function* thenable(_d: IOrder): IOpenGenerator {
	yield* open(wait("first"));
	if (broken === "later") {
		return Promise.resolve(1) as never;
	}
	yield* open(wait("second"));
}
named(thenable, "Fallback/Thenable");
resumable(thenable);

function* guarded(d: IOrder): IOpenGenerator {
	try {
		d.Qty += 1;
		yield* open(wait("first"));
		d.Note = `t${++ticks}`;
		yield* open(wait("second"));
	} finally {
		closes++;
		d.Closed = "closed";
	}
}
named(guarded, "Fallback/Guarded");
resumable(guarded);

describe("a divergence inside the prefix", () => {
	async function divergedIn(action: Function, at: "first" | "later" | null, release: string[], detail: string) {
		const h = harness<IShop>(seed());
		h.runtime.dispatch(action as never, "o1").catch(() => {});
		for (const name of release) {
			await until(() => h.waiting.some((w) => w.name === name));
			h.release(name);
		}
		await until(() => h.waiting.length > 0);
		const json = createSnapshot(h.runtime);
		const run = await restoreWithResume<IShop>(json, "shop");
		const before = closes;
		const tree = JSON.stringify(rawOf(run.runtime.state));
		const loop = watchLoop(run.internal);
		broken = at;
		const engine = runEngine(run);
		broken = null;
		engine.release();
		await settled();
		expect(loop.settled).toBe(false);
		expect(loop.made).not.toContain("action:end");
		expect(
			engine.dropped.map((drop) => [
				drop.reason,
				drop.detail
			])
		).toEqual([
			[
				"diverged",
				detail
			]
		]);
		expect(closes).toBe(before);
		expect(JSON.stringify(rawOf(run.runtime.state))).toBe(tree);
		expect(engine.during).toEqual([]);
		expect(run.records).toEqual([]);
		expect(run.diags).toEqual([]);
		expect(run.failures).toEqual([]);
		expect(run.onError).toEqual([]);
		expect(run.internal.get("runtime/inFlightActions")()).toEqual([]);
		run.runtime.dispose();
		h.runtime.dispose();
	}

	const THREW = "the action threw where the history holds it in flight";

	it("leaves the generator discarded with its finally blocks unrun, and nothing of a live end", async () => {
		await divergedIn(
			guarded,
			null,
			[
				"first"
			],
			"a replayed step's changes or read answers differ from the history's"
		);
	});

	it("is a throw in a later step, which ends nothing", async () => {
		await divergedIn(
			throwing,
			"later",
			[
				"first"
			],
			THREW
		);
	});

	it("is a throw in the first step, which ends nothing", async () => {
		await divergedIn(throwing, "first", [], THREW);
	});

	const ENDED = "the action ended where the history holds it in flight";

	it("is a return in the first step, halted there: its loop never settles and no action:end is made", async () => {
		await divergedIn(quitting, "first", [], ENDED);
	});

	it("is a thenable returned in a later step, halted there with no failure: no onError and no failure event", async () => {
		await divergedIn(
			thenable,
			"later",
			[
				"first"
			],
			ENDED
		);
	});

	it("is a return in a later step, halted there: its loop never settles and no action:end is made", async () => {
		await divergedIn(
			quitting,
			"later",
			[
				"first"
			],
			ENDED
		);
	});
});

/**
 * Watches the next prefix the engine dispatches: whether its action's promise settles, and the kind of
 * every record the action makes, before its prefix's journal holds or discards it.
 */
function watchLoop(runtime: IRuntimeInternal<IShop>): {
	readonly settled: boolean;
	readonly made: string[];
} {
	const support = runtime.get("runtime/prefixes") as {
		dispatch: (...args: unknown[]) => Promise<unknown>;
	};
	const real = support.dispatch;
	const watched = {
		settled: false,
		made: [] as string[]
	};
	support.dispatch = (...args) => {
		const prefix = (
			args[5] as
				| {
						prefix?: IPrefix;
				  }
				| undefined
		)?.prefix;
		if (prefix !== undefined) {
			const journal = prefix.journal.bind(prefix);
			prefix.journal = (inner) => {
				const outer = journal(inner);
				return {
					get asking() {
						return outer.asking;
					},
					append(record, live) {
						watched.made.push(record.Kind);
						return outer.append(record, live);
					}
				};
			};
		}
		const running = real(...args);
		running.then(
			() => {
				watched.settled = true;
			},
			() => {
				watched.settled = true;
			}
		);
		return running;
	};
	return watched;
}

interface ICountEffect extends IEffect {
	Type: "Fallback/Count";
	Nonce: number;
}

const count = defineEffect<ICountEffect, number>("Fallback/Count", {
	settles: "sync"
});

let nonce = 0;
const called = {
	count: 0,
	guid: 0
};
const answered: unknown[][] = [];

function* reconciling(d: IOrder): IOpenGenerator {
	try {
		yield* reconcileRows(
			d.Rows,
			[
				{
					K: "a"
				}
			],
			(row: { K: string }) => row.K,
			{
				*add(item: { K: string }) {
					const n = yield* count({
						Nonce: ++nonce
					});
					const g = yield* generateGuid();
					answered.push([
						n,
						g
					]);
					return {
						K: item.K,
						N: n,
						G: g
					};
				},
				update: () => {}
			} as never
		);
		yield* open(wait("first"));
	} finally {
		closes++;
		d.Closed = "closed";
	}
}
named(reconciling, "Fallback/Reconciling");
resumable(reconciling);

// Counted by the catch blocks below: a throw into the generator would show here.
let caught = 0;
let sneaking: IRuntime<IShop> | null = null;
let aliasing = false;

function* sneaky(d: IOrder): IOpenGenerator {
	try {
		try {
			d.Note = "n";
			if (sneaking) {
				(rawOf(sneaking.state) as IShop).Orders.o1!.Note = "behind the gateway";
			}
			yield* open(wait("first"));
		} catch (error) {
			caught++;
			throw error;
		}
	} finally {
		closes++;
	}
}
named(sneaky, "Fallback/Sneaky");
resumable(sneaky);

function* refusing(d: IOrder): IActionGenerator {
	try {
		d.Qty += 1;
		for (;;) {
			if (aliasing) {
				(
					d as unknown as {
						Twin: unknown;
					}
				).Twin = d.Lines;
			}
			try {
				yield* wait("first");
				break;
			} catch (error) {
				caught++;
				if (!isRefusal(error)) {
					throw error;
				}
			}
		}
		d.Note = "after";
		yield* wait("second");
	} finally {
		closes++;
	}
}
named(refusing, "Fallback/Refusing");
resumable(refusing);

function* sneakyTwin(d: IOrder): IOpenGenerator {
	try {
		try {
			d.Note = "n";
			if (sneaking) {
				(rawOf(sneaking.state) as IShop).Orders.o1!.Note = "behind the gateway";
			}
			yield* open(wait("first"));
		} catch (error) {
			caught++;
			throw error;
		}
	} finally {
		closes++;
	}
}
named(sneakyTwin, "Fallback/SneakyTwin");
resumable(sneakyTwin);

describe("a replay dropped at the hand-over", () => {
	it("leaves its function unmarked as arrived, since the engine never accepted it", async () => {
		const h = harness<IShop>(seed());
		h.runtime.dispatch(sneaky, "o1").catch(() => {});
		await until(() => h.waiting.length > 0);
		const envelope = JSON.parse(createSnapshot(h.runtime)) as {
			InFlight: {
				Name: string;
			}[];
		};
		h.runtime.dispose();
		envelope.InFlight[0]!.Name = "Fallback/SneakyTwin";
		const run = await restoreWithResume<IShop>(JSON.stringify(envelope), "shop");
		sneaking = run.runtime;
		const engine = runEngine(run);
		sneaking = null;
		expect(engine.dropped.map((drop) => drop.detail)).toEqual([
			"the entity at the hand-over is not the snapshot's"
		]);
		expect(() => workTag("Fallback/Twin").mark(sneakyTwin)).not.toThrow();
		run.runtime.dispose();
	});
});

describe("each way a replay falls back, against a plain restore", () => {
	async function fallsBack(
		action: Function,
		arm: (runtime: IRuntimeInternal<IShop>) => void,
		disarm: (runtime: IRuntimeInternal<IShop>) => void,
		detail: string,
		throwsIn = 0
	) {
		const h = harness<IShop>(seed());
		h.runtime.dispatch(action as never, "o1").catch(() => {});
		await until(() => h.waiting.length > 0);
		const point: IPoint = {
			at: 0,
			json: createSnapshot(h.runtime),
			cut: {
				records: 0,
				diags: 0,
				failures: 0,
				onError: 0
			},
			guids: {},
			inFlight: []
		};
		const before = {
			closes,
			caught
		};
		const withEngine = await restoreAt(point, [], {
			engine: true,
			before: (runtime) => arm(runtime as IRuntimeInternal<IShop>),
			beforeRelease: (runtime) => {
				disarm(runtime as IRuntimeInternal<IShop>);
				return false;
			}
		});
		const dataOnly = await restoreAt(point, [], {
			engine: false
		});
		expect(
			withEngine.engine!.dropped.map((drop) => [
				drop.reason,
				drop.detail
			])
		).toEqual([
			[
				"diverged",
				detail
			]
		]);
		expect({
			closes,
			caught
		}).toEqual({
			closes: before.closes,
			caught: before.caught + throwsIn
		});
		expect(withEngine.afterEngine).toEqual(withEngine.beforeEngine);
		expect(withEngine.end).toEqual(dataOnly.end);
		h.runtime.dispose();
	}

	it("the entity at the hand-over is not the snapshot's: step code wrote it behind the gateway", async () => {
		await fallsBack(
			sneaky,
			(runtime) => {
				sneaking = runtime;
			},
			() => {
				sneaking = null;
			},
			"the entity at the hand-over is not the snapshot's"
		);
	});

	it("the write scope's end was refused: reached only by making the scope's end throw", async () => {
		let real: (() => IWriteScope) | null = null;
		await fallsBack(
			flow,
			(runtime) => {
				const gateway = runtime.get("runtime/writeGateway");
				const open = gateway.openScope;
				real = open;
				gateway.openScope = () => {
					const scope = open();
					return {
						unwind: () => scope.unwind(),
						end: () => {
							scope.end();
							throw new Error("refused for the test");
						}
					};
				};
			},
			(runtime) => {
				runtime.get("runtime/writeGateway").openScope = real!;
			},
			"the write scope's end was refused: refused for the test"
		);
	});

	it("the replay stopped short of the wait the snapshot caught: reached only by a dispatch that runs nothing", async () => {
		let real: IPrefixSupport["dispatch"] | null = null;
		await fallsBack(
			flow,
			(runtime) => {
				const support = runtime.get("runtime/prefixes") as {
					dispatch: IPrefixSupport["dispatch"];
				};
				real = support.dispatch;
				support.dispatch = () => Promise.resolve(undefined);
			},
			(runtime) => {
				(
					runtime.get("runtime/prefixes") as {
						dispatch: IPrefixSupport["dispatch"];
					}
				).dispatch = real!;
			},
			"the replay stopped short of the wait the snapshot caught"
		);
	});

	it("the action ended where the history holds it in flight: it returned before the wait the snapshot caught", async () => {
		await fallsBack(
			quitting,
			() => {
				broken = "first";
			},
			() => {
				broken = null;
			},
			"the action ended where the history holds it in flight"
		);
	});

	it("a frame refused at a yield until the refusal loop ends it: failSlice closes nothing in a prefix", async () => {
		await fallsBack(
			refusing,
			() => {
				aliasing = true;
			},
			() => {
				aliasing = false;
			},
			"the action threw where the history holds it in flight",
			REFUSAL_LIMIT
		);
	});
});

describe("an effect answered in the step that diverges", () => {
	it("is given undefined, as is every in-step effect after it, and the step runs on to its yield: no implementation called, no finally run", async () => {
		const h = harness<IShop>(seed(), {
			implementations: {
				generateGuid: () => `g${++called.guid}`
			}
		});
		h.runtime.registerImplementation("Fallback/Count", () => ++called.count);
		h.runtime.dispatch(reconciling, "o1").catch(() => {});
		await until(() => h.waiting.some((w) => w.name === "first"));
		expect(h.runtime.state.Orders.o1!.Rows).toEqual([
			{
				K: "a",
				N: 1,
				G: "g1"
			}
		]);
		const json = createSnapshot(h.runtime);
		h.runtime.dispose();
		const run = await restoreWithResume<IShop>(json, "shop", {
			implementations: {
				generateGuid: () => `g${++called.guid}`
			},
			setup: (restored) => {
				restored.registerImplementation("Fallback/Count", () => ++called.count);
			}
		});
		const before = {
			...called,
			closes
		};
		const tree = JSON.stringify(rawOf(run.runtime.state));
		answered.length = 0;
		const engine = runEngine(run);
		engine.release();
		await settled();
		expect(
			engine.dropped.map((drop) => [
				drop.reason,
				drop.detail
			])
		).toEqual([
			[
				"diverged",
				'the replay yielded "Fallback/Count" with another descriptor than the history\'s'
			]
		]);
		expect(answered).toEqual([
			[
				undefined,
				undefined
			]
		]);
		expect({
			...called,
			closes
		}).toEqual(before);
		expect(JSON.stringify(rawOf(run.runtime.state))).toBe(tree);
		expect(run.records).toEqual([]);
		expect(run.diags).toEqual([]);
		expect(run.failures).toEqual([]);
		run.runtime.dispose();
	});
});

function* refresh(d: IOrder, name: string): IOpenGenerator {
	try {
		d.Note = String(yield* open(wait(name)));
	} finally {
		closes++;
		d.Closed = "closed";
	}
}
named(refresh, "Fallback/Refresh");
latest(refresh);
resumable(refresh);

function* refreshFirst(d: IOrder, name: string): IOpenGenerator {
	try {
		d.Note = String(yield* open(wait(name)));
	} finally {
		closes++;
		d.Closed = "closed";
	}
}
named(refreshFirst, "Fallback/RefreshFirst");
leading(refreshFirst);
resumable(refreshFirst);

describe("a replay that finds live work of its function on the entity", () => {
	for (const [mark, action, name] of [
		[
			"latest",
			refresh,
			"Fallback/Refresh"
		],
		[
			"leading",
			refreshFirst,
			"Fallback/RefreshFirst"
		]
	] as const) {
		it(`${mark}: diverges before the mark stops or drops anything, and the live action runs on as with no engine`, async () => {
			const steps = [
				start(action, "caught")
			];
			const point = await onlyPoint({
				steps,
				marked: [
					name
				]
			});
			const live = (runtime: IRuntime<any>) => {
				runtime.dispatch(action as never, "o1", "live").catch(() => {});
			};
			let closed = closes;
			const withEngine = await restoreAt(point, steps, {
				engine: true,
				setup: live
			});
			const closedWithEngine = closes - closed;
			closed = closes;
			const dataOnly = await restoreAt(point, steps, {
				engine: false,
				setup: live
			});
			expect(closedWithEngine).toBe(closes - closed);
			const engine = withEngine.engine!;
			expect(
				engine.dropped.map((drop) => [
					drop.reason,
					drop.detail
				])
			).toEqual([
				[
					"diverged",
					`live work of "${name}" is on the entity "o1", and a second run would do its work again`
				]
			]);
			expect(engine.during).toEqual([]);
			expect(engine.diagsDuring).toBe(0);
			expect(withEngine.afterEngine).toEqual(withEngine.beforeEngine);
			expect(withEngine.end).toEqual(dataOnly.end);
			expect(withEngine.end.waiting).toEqual([
				"live"
			]);
			expect(withEngine.end.inFlight).toEqual([
				`${name}:open@o1`
			]);
		});
	}

	it("held by live work: the replay diverges at its arrival, and the live holder runs on as with no engine", async () => {
		const steps = [
			start(flow)
		];
		const point = await onlyPoint({
			steps,
			marked: [
				"Fallback/Flow"
			]
		});
		const live = (runtime: IRuntime<any>) => {
			runtime.dispatch(sitting as never, "o1").catch(() => {});
		};
		const withEngine = await restoreAt(point, steps, {
			engine: true,
			setup: live
		});
		const dataOnly = await restoreAt(point, steps, {
			engine: false,
			setup: live
		});
		expect(
			withEngine.engine!.dropped.map((drop) => [
				drop.reason,
				drop.detail
			])
		).toEqual([
			[
				"diverged",
				'the entity "o1" is held by live work'
			]
		]);
		expect(withEngine.afterEngine).toEqual(withEngine.beforeEngine);
		expect(withEngine.end).toEqual(dataOnly.end);
		expect(withEngine.end.inFlight).toEqual([
			"Fallback/Sitting:holding@o1"
		]);
	});
});

function* sitting(_d: IOrder): IActionGenerator {
	yield* wait("live");
}
named(sitting, "Fallback/Sitting");

function* holds(d: IOrder): IActionGenerator {
	d.Qty += 1;
	d.Key = String(yield* wait("hold"));
}
named(holds, "Fallback/Holds");
resumable(holds);

/** A snapshot of `holds` holding o1 with `queued` and then `second` in its line. */
async function lineSnapshot(queued: Function): Promise<string> {
	const h = harness<IShop>(seed());
	h.runtime.dispatch(holds, "o1").catch(() => {});
	await until(() => h.waiting.some((w) => w.name === "hold"));
	h.runtime.dispatch(queued as never, "o1", "caught").catch(() => {});
	h.runtime.dispatch(second, "o1").catch(() => {});
	const json = createSnapshot(h.runtime);
	h.runtime.dispose();
	expect(
		(
			JSON.parse(json) as {
				InFlight: {
					State: string;
				}[];
			}
		).InFlight.map((row) => row.State)
	).toEqual([
		"holding",
		"queued",
		"queued"
	]);
	return json;
}

function entitiesInFlight(runtime: IRuntime<IShop>): string[] {
	const rows = (
		JSON.parse(createSnapshot(runtime)) as {
			InFlight: {
				EntityId: string;
			}[];
		}
	).InFlight;
	return [
		...new Set(rows.map((row) => row.EntityId))
	];
}

describe("a put-back that finds live work of its function on the entity", () => {
	for (const [mark, action, name] of [
		[
			"latest",
			refresh,
			"Fallback/Refresh"
		],
		[
			"leading",
			refreshFirst,
			"Fallback/RefreshFirst"
		]
	] as const) {
		it(`${mark}: drops before anything is dispatched, the rows behind it follow, and the live run is as with no engine`, async () => {
			const json = await lineSnapshot(action);
			const arm = async (engineToo: boolean) => {
				const run = await restoreWithResume<IShop>(json, "shop", {
					setup: (restored) => {
						restored.dispatch(action as never, "o1", "live").catch(() => {});
					}
				});
				const closed = closes;
				const engine = engineToo ? runEngine(run) : null;
				engine?.release();
				await settled();
				run.runtime.dispatch(unmarked, "o2").catch(() => {});
				await settled();
				const ofAction = (kind: string) =>
					run.records.filter(
						(record) =>
							record.Kind === kind &&
							"ActionId" in record &&
							run.records.some((start) => start.Kind === "action:start" && start.ActionId === record.ActionId && start.Name === name)
					).length;
				const seen = {
					starts: ofAction("action:start"),
					ends: ofAction("action:end"),
					failures: run.failures.map((event) => `${event.Name}:${event.Status}@${event.EntityId}`),
					onError: run.onError.map(String),
					live: run.internal
						.get("runtime/inFlightActions")()
						.filter((row) => row.Name === name)
						.map((row) => `${row.State}@${row.EntityId}`),
					entities: entitiesInFlight(run.runtime),
					closes: closes - closed
				};
				run.runtime.dispose();
				return {
					engine,
					seen
				};
			};
			const withEngine = await arm(true);
			const dataOnly = await arm(false);
			expect(withEngine.engine!.resumed.map((resumed) => resumed.name)).toEqual([
				"Fallback/Holds"
			]);
			expect(
				withEngine.engine!.dropped.map((drop) => [
					drop.name,
					drop.reason,
					drop.detail
				])
			).toEqual([
				[
					name,
					"off-list",
					`live work of "${name}" is on its entity, and a second run would do its work again`
				],
				[
					"Fallback/Second",
					"behind",
					`it waits in its entity's line behind "${name}", which did not resume`
				]
			]);
			expect(withEngine.seen).toEqual(dataOnly.seen);
			expect(withEngine.seen).toMatchObject({
				starts: 1,
				ends: 0,
				failures: [],
				onError: [],
				live: [
					"open@o1"
				],
				entities: [
					"o1",
					"o2"
				],
				closes: 0
			});
		});
	}
});

describe("what a fallback leaves of the runtime", () => {
	it("a dropped replay leaves the order of later in-flight rows as a restore with no engine does", async () => {
		const h = harness<IShop>(seed());
		h.runtime.dispatch(clocked, "o2").catch(() => {});
		await until(() => h.waiting.length > 0);
		const json = createSnapshot(h.runtime);
		h.runtime.dispose();
		const entities = async (engineToo: boolean) => {
			const run = await restoreWithResume<IShop>(json, "shop");
			if (engineToo) {
				const engine = runEngine(run);
				expect(engine.dropped.map((drop) => drop.reason)).toEqual([
					"diverged"
				]);
				engine.release();
			}
			run.runtime.dispatch(unmarked, "o1").catch(() => {});
			run.runtime.dispatch(unmarked, "o2").catch(() => {});
			await settled();
			const order = entitiesInFlight(run.runtime);
			run.runtime.dispose();
			return order;
		};
		expect(await entities(true)).toEqual(await entities(false));
		expect(await entities(false)).toEqual([
			"o1",
			"o2"
		]);
	});

	it("asks whether anything watches the tree once per engine run, however many replays it plans", async () => {
		const h = harness<IShop>(seed());
		h.runtime.dispatch(flow, "o1").catch(() => {});
		h.runtime.dispatch(flow, "o2").catch(() => {});
		await until(() => h.waiting.length === 2);
		const json = createSnapshot(h.runtime);
		h.runtime.dispose();
		const run = await restoreWithResume<IShop>(json, "shop");
		const gateway = run.internal.get("runtime/writeGateway");
		const root = gateway.rootNode;
		let asked = 0;
		gateway.rootNode = () => {
			asked++;
			return root();
		};
		const engine = runEngine(run);
		gateway.rootNode = root;
		expect(engine.resumed).toHaveLength(2);
		// Each replay's rewind asks for the root once; the walk for watchers is the one ask left.
		expect(asked).toBe(engine.resumed.length + 1);
		run.runtime.dispose();
	});
});

describe("one resumed action per lineage", () => {
	async function lineage(steps: IScriptStep[], marked: string[], own: (state: IShop) => unknown, theirs: (state: IShop) => unknown) {
		const script = await playScript(seed(), steps, marked);
		const point = script.points[script.points.length - 1]!;
		const all = [
			...steps,
			...RELEASES
		];
		const full = await playScript(seed(), all, marked);
		const uninterrupted = full.endFrom(full.points[0]!);
		const withEngine = await restoreAt(point, all, {
			engine: true
		});
		const dataOnly = await restoreAt(point, all, {
			engine: false
		});
		const engine = withEngine.engine!;
		expect(engine.resumed.map((resumed) => resumed.name)).toEqual([
			marked[0]
		]);
		expect(
			engine.dropped.map((drop) => [
				drop.name,
				drop.reason,
				drop.detail
			])
		).toEqual([
			[
				marked[1],
				"off-list",
				"a replay is planned ahead of it, in row order, on its entity, an ancestor or a descendant"
			]
		]);
		const ended = (end: { state: string }) => JSON.parse(end.state) as IShop;
		expect(own(ended(withEngine.end))).toEqual(own(ended(uninterrupted)));
		expect(theirs(ended(withEngine.end))).toEqual(theirs(ended(dataOnly.end)));
		expect(withEngine.end.inFlight).toEqual([]);
		expect(withEngine.end.diags).toEqual([]);
	}

	it("drops a second candidate on the same entity", async () => {
		await lineage(
			[
				start(flow),
				start(second)
			],
			[
				"Fallback/Flow",
				"Fallback/Second"
			],
			(state) => [
				state.Orders.o1!.Note,
				state.Orders.o1!.Qty
			],
			(state) => state.Orders.o1!.Tag
		);
	});

	it("drops a second candidate on a child", async () => {
		await lineage(
			[
				start(flow),
				(d) => d.dispatch(onLine, "o1-l1")
			],
			[
				"Fallback/Flow",
				"Fallback/OnLine"
			],
			(state) => [
				state.Orders.o1!.Note,
				state.Orders.o1!.Key
			],
			(state) => state.Orders.o1!.Lines["o1-l1"]!.Qty
		);
	});

	it("drops a later candidate on an ancestor of an earlier candidate's entity", async () => {
		await lineage(
			[
				(d) => d.dispatch(onLine, "o1-l1"),
				start(flow)
			],
			[
				"Fallback/OnLine",
				"Fallback/Flow"
			],
			(state) => state.Orders.o1!.Lines["o1-l1"]!.Qty,
			(state) => [
				state.Orders.o1!.Note,
				state.Orders.o1!.Key,
				state.Orders.o1!.Qty
			]
		);
	});
});
