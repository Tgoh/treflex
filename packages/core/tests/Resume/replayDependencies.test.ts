import type { IActionGenerator, IEntity, IOpenGenerator, IRuntime } from "../../src/index";
import type { IHistory } from "../../src/Resume/history";
import type { IPoint, IRestoredEnd, IScriptStep } from "./replayScript";
import { describe, expect, it } from "vitest";
import { ask } from "../../src/Effects/ask";
import { openResource } from "../../src/Effects/openResource";
import { resumable } from "../../src/Resume/resumable";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { PAY } from "./replayHarness";
import { playScript, restoreAt } from "./replayScript";
import { wait } from "./resumeHarness";

interface IOrder extends IEntity {
	Qty: number;
	Note: string;
	Tag: string;
}

interface IShop extends IEntity {
	Tag: string;
	Orders: Record<string, IOrder>;
}

const order = (id: string): IOrder => ({
	$Id: id,
	Qty: 1,
	Note: "",
	Tag: ""
});

function seed(): IShop {
	return {
		$Id: "shop",
		Tag: "",
		Orders: {
			o1: order("o1"),
			o2: order("o2")
		}
	};
}

const ended = (end: { state: string }) => JSON.parse(end.state) as IShop;

function* reserving(d: IOrder): IActionGenerator {
	d.Qty += 1;
	yield* wait("reserve");
	d.Note = `reserved:${d.Qty}`;
}
named(reserving, "Deps/Reserving");
resumable(reserving);

function* reservingTwice(d: IOrder): IActionGenerator {
	d.Qty += 2;
	yield* wait("reserve");
	d.Note = `reserved:${d.Qty}`;
}
named(reservingTwice, "Deps/ReservingTwice");
resumable(reservingTwice);

function* paying(d: IOrder): IActionGenerator {
	d.Tag = "reserved";
	d.Note = String(
		yield {
			Type: PAY,
			Name: "pay"
		} as never
	);
}
named(paying, "Deps/Paying");
resumable(paying);

function* setQty(d: IOrder, qty: number): IActionGenerator {
	d.Qty = qty;
}
named(setQty, "Deps/SetQty");
resumable(setQty);

function* plainSet(d: IOrder, qty: number): IActionGenerator {
	d.Qty = qty;
}

function* tagU(d: IOrder): IActionGenerator {
	d.Tag += "U";
}

function* holdThenOpen(d: IOrder): IOpenGenerator {
	d.Qty *= 2;
	yield* wait("hold");
	yield* open(wait("later"));
	d.Note = `after:${d.Tag}`;
}
named(holdThenOpen, "Deps/HoldThenOpen");
resumable(holdThenOpen);

function* regainer(d: IOrder): IOpenGenerator {
	yield* open(wait("r"));
	d.Tag += "R";
}
named(regainer, "Deps/Regainer");
resumable(regainer);

function* inOpen(d: IOrder): IOpenGenerator {
	d.Tag += "o";
	d.Note = String(yield* open(wait("first")));
}
named(inOpen, "Deps/InOpen");
resumable(inOpen);

function* asking(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	const answered = yield* open(
		ask<string>(d, {
			Path: "Deps/Ask",
			Qty: d.Qty
		})
	);
	d.Note = `${answered}:${d.Qty}`;
}
named(asking, "Deps/Asking");
resumable(asking);

function* doubling(d: IOrder): IActionGenerator {
	yield* wait("double");
	d.Qty *= 2;
}
named(doubling, "Deps/Doubling");
resumable(doubling);

function* plainDoubling(d: IOrder): IActionGenerator {
	yield* wait("double");
	d.Qty *= 2;
}

const Feed = (receiver as (id: string) => (cases: object) => object)("Deps/FeedReceiver")({
	*"Deps/Feed"(
		d: IOrder,
		message: {
			N: number;
			Open?: true;
		}
	) {
		d.Tag += `f${message.N}`;
		if (message.Open) {
			yield* open(wait(`feed-${message.N}`));
		} else {
			yield* wait(`feed-${message.N}`);
		}
		d.Tag += `F${message.N}`;
	}
});

const opening = openResource as (...args: unknown[]) => IActionGenerator;

function* openFeed(d: IOrder): IActionGenerator {
	yield* opening(d, "Deps/Feed", Feed, {
		Type: "deps/feed"
	});
}

function* openRunner(d: IOrder): IActionGenerator {
	yield* opening(d, "Deps/Runner", Feed, {
		Type: "deps/runner"
	});
}

interface IResourceContext {
	ownerId: string;
	emit(message: unknown): Promise<void>;
	run(effect: Generator): Promise<unknown>;
}

const feeds = new WeakMap<IRuntime<any>, Map<string, IResourceContext>>();

function setup(runtime: IRuntime<any>): void {
	runtime.registerReceiver(Feed as never);
	const register = (
		runtime as unknown as {
			registerResourceType(type: string, implementation: (params: unknown, context: IResourceContext) => void): void;
		}
	).registerResourceType.bind(runtime);
	register("deps/feed", (_params, context) => {
		const byOwner = feeds.get(runtime) ?? new Map<string, IResourceContext>();
		byOwner.set(context.ownerId, context);
		feeds.set(runtime, byOwner);
	});
	register("deps/runner", (_params, context) => {
		void context.run(wait("connect")).catch(() => {});
	});
}

const emit =
	(n: number, owner = "o1", inOpen = false): IScriptStep =>
	(d) => {
		void feeds
			.get(d.runtime)!
			.get(owner)!
			.emit({
				N: n,
				...(inOpen
					? {
							Open: true
						}
					: {})
			})
			.catch(() => {});
	};

const on =
	(action: Function, target: string, ...args: unknown[]): IScriptStep =>
	(d) =>
		d.dispatch(action, target, ...args);

async function played(steps: IScriptStep[], marked: string[]) {
	return playScript(seed(), steps, marked, {
		setup
	});
}

async function caught(steps: IScriptStep[], at: number, marked: string[]): Promise<IPoint> {
	const script = await played(steps, marked);
	const point = script.points.find((found) => found.at === at);
	if (!point) {
		throw new Error(`no point after step ${at}`);
	}
	return point;
}

function outcome(restored: IRestoredEnd) {
	const engine = restored.engine!;
	return {
		resumed: engine.resumed.map((resumed) => [
			resumed.name,
			resumed.beside.map((beside) => [
				beside.name,
				beside.state
			])
		]),
		dropped: engine.dropped.map((drop) => [
			drop.name ?? drop.label,
			drop.reason,
			drop.detail
		])
	};
}

const HOLDS = "work the snapshot's rows don't list and can't name holds its entity, and nothing resumes beside it";

function savedIn(point: IPoint): Pick<IHistory, "Unlisted" | "UnlistedLineage" | "Deliveries">[] {
	return (
		JSON.parse(point.json) as {
			Histories: IHistory[];
		}
	).Histories.map((history) => ({
		Unlisted: history.Unlisted,
		UnlistedLineage: history.UnlistedLineage,
		Deliveries: history.Deliveries
	}));
}

const FEED = "Deps/Feed";

const saved = (deliveries: IHistory["Deliveries"]) => ({
	Unlisted: "none",
	UnlistedLineage: [],
	Deliveries: deliveries
});

const deliveryOn = (entityId: string, at: "holding" | "in-line" | "open") => ({
	Key: FEED,
	OwnerId: entityId,
	EntityId: entityId,
	At: at
});

/** The state with the entity's node taken out, to compare what lies outside it. */
function outside(state: string, entityId: string): unknown {
	const tree = JSON.parse(state) as IShop;
	delete tree.Orders[entityId];
	return tree;
}

function behindDelivery(entityId: string, at: "holds its entity" | "stands in its entity's line"): string {
	return `a delivery of the resource "${FEED}" on "${entityId}" ${at}, and it could be put back ahead of it`;
}

async function besideDelivery(steps: IScriptStep[], at: number, marked: string[]) {
	const script = await played(steps, marked);
	const point = script.points.find((found) => found.at === at)!;
	const restored = await restoreAt(point, steps, {
		engine: true,
		setup
	});
	const dataOnly = await restoreAt(point, steps, {
		engine: false,
		setup
	});
	const engine = restored.engine!;
	return {
		point,
		uninterrupted: script.endFrom(point),
		restored,
		dataOnly,
		replayExact:
			restored.treeAfterEngine ===
			JSON.stringify(
				(
					JSON.parse(point.json) as {
						AppState: unknown;
					}
				).AppState
			),
		report: {
			resumed: engine.resumed.map((entry) => [
				entry.name,
				entry.wait ?? null,
				entry.resourceWork
			]),
			dropped: engine.dropped.map((drop) => [
				drop.name ?? drop.label,
				drop.reason,
				drop.detail
			])
		}
	};
}

describe("a resumed holder carries on beside dropped work on its entity, and the engine names it", () => {
	it("an unmarked row queued behind a holder that later opens: the holder resumes with it beside, and its later steps never see it", async () => {
		const steps: IScriptStep[] = [
			on(holdThenOpen, "o1"),
			on(tagU, "o1"),
			(d) => d.release("hold"),
			(d) => d.release("later")
		];
		const script = await played(steps, [
			"Deps/HoldThenOpen"
		]);
		const point = script.points.find((found) => found.at === 1)!;
		expect(ended(script.endFrom(point)).Orders.o1!.Note).toBe("after:U");
		const restored = await restoreAt(point, steps, {
			engine: true,
			setup
		});
		const dataOnly = await restoreAt(point, steps, {
			engine: false,
			setup
		});
		expect(outcome(restored)).toEqual({
			resumed: [
				[
					"Deps/HoldThenOpen",
					[
						[
							null,
							"queued"
						]
					]
				]
			],
			dropped: [
				[
					"tagU",
					"not-marked",
					"the action has no durable name"
				]
			]
		});
		expect(ended(restored.end).Orders.o1!.Note).toBe("after:");
		expect(ended(dataOnly.end).Orders.o1!.Note).toBe("");
	});

	it("a regaining row behind a holder that later opens: the holder resumes with it beside", async () => {
		const steps: IScriptStep[] = [
			on(regainer, "o1"),
			on(holdThenOpen, "o1"),
			(d) => d.release("r"),
			(d) => d.release("hold"),
			(d) => d.release("later")
		];
		const script = await played(steps, [
			"Deps/HoldThenOpen",
			"Deps/Regainer"
		]);
		const point = script.points.find((found) => found.at === 2)!;
		expect(
			point.inFlight.map((row) => [
				row.Name,
				row.State
			])
		).toEqual([
			[
				"Deps/Regainer",
				"regaining"
			],
			[
				"Deps/HoldThenOpen",
				"holding"
			]
		]);
		expect(ended(script.endFrom(point)).Orders.o1!.Note).toBe("after:R");
		const restored = await restoreAt(point, steps, {
			engine: true,
			setup
		});
		expect(outcome(restored)).toEqual({
			resumed: [
				[
					"Deps/HoldThenOpen",
					[
						[
							"Deps/Regainer",
							"regaining"
						]
					]
				]
			],
			dropped: [
				[
					"Deps/Regainer",
					"off-list",
					"it waits in its entity's line for its hold back, and replaying a regain is not built"
				]
			]
		});
		expect(ended(restored.end).Orders.o1!.Note).toBe("after:");
	});

	it("an ask flow inside open(...) beside a marked holder: the holder resumes whatever the row order, with the flow beside it", async () => {
		const steps: IScriptStep[] = [
			on(asking, "o1"),
			on(doubling, "o1"),
			(d) => d.release("double"),
			(d) => d.answer((state: IShop) => state.Orders.o1, "Deps/Ask", "yes")
		];
		const script = await played(steps, [
			"Deps/Asking",
			"Deps/Doubling"
		]);
		const point = script.points.find((found) => found.at === 1)!;
		expect(
			point.inFlight.map((row) => [
				row.Name,
				row.State
			])
		).toEqual([
			[
				"Deps/Asking",
				"open"
			],
			[
				"Deps/Doubling",
				"holding"
			]
		]);
		expect(ended(script.endFrom(point)).Orders.o1!.Note).toBe("yes:4");
		const restored = await restoreAt(point, steps, {
			engine: true,
			setup
		});
		expect(outcome(restored)).toEqual({
			resumed: [
				[
					"Deps/Doubling",
					[
						[
							"Deps/Asking",
							"open"
						]
					]
				]
			],
			dropped: [
				[
					"Deps/Asking",
					"off-list",
					'its entity\'s holder "Deps/Doubling" is resumed, and only one action per entity is replayed'
				]
			]
		});
		expect(ended(restored.end).Orders.o1).toMatchObject({
			Qty: 4,
			Note: ""
		});
	});

	it("an ask flow inside open(...) beside an unmarked holder: the flow resumes, with the holder beside it", async () => {
		const steps: IScriptStep[] = [
			on(asking, "o1"),
			on(plainDoubling, "o1"),
			(d) => d.release("double"),
			(d) => d.answer((state: IShop) => state.Orders.o1, "Deps/Ask", "yes")
		];
		const point = await caught(steps, 1, [
			"Deps/Asking"
		]);
		const restored = await restoreAt(point, steps, {
			engine: true,
			setup
		});
		expect(outcome(restored)).toEqual({
			resumed: [
				[
					"Deps/Asking",
					[
						[
							null,
							"holding"
						]
					]
				]
			],
			dropped: [
				[
					"plainDoubling",
					"not-marked",
					"the action has no durable name"
				]
			]
		});
		expect(ended(restored.end).Orders.o1!.Note).toBe("yes:2");
	});

	it("a holder whose replay diverges takes the queued work behind it along, and leaves its entity free", async () => {
		const steps: IScriptStep[] = [
			on(reserving, "o1"),
			on(setQty, "o1", 5),
			(d) => d.release("reserve")
		];
		const caughtAt = await caught(steps, 1, [
			"Deps/Reserving",
			"Deps/SetQty"
		]);
		const envelope = JSON.parse(caughtAt.json) as {
			InFlight: {
				Name: string;
			}[];
		};
		envelope.InFlight[0]!.Name = "Deps/ReservingTwice";
		const point = {
			...caughtAt,
			json: JSON.stringify(envelope)
		};
		let later: IOrder | undefined;
		const restored = await restoreAt(point, [], {
			engine: true,
			beforeRelease: (runtime) => {
				runtime.dispatch(plainSet as never, "o1", 9).catch(() => {});
				later = {
					...(runtime.state as IShop).Orders.o1!
				};
				return false;
			}
		});
		const dataOnly = await restoreAt(point, [], {
			engine: false
		});
		expect(outcome(restored)).toEqual({
			resumed: [],
			dropped: [
				[
					"Deps/ReservingTwice",
					"diverged",
					"a replayed step's changes or read answers differ from the history's"
				],
				[
					"Deps/SetQty",
					"behind",
					'it waits in its entity\'s line behind "Deps/ReservingTwice", which did not resume'
				]
			]
		});
		expect(later?.Qty).toBe(9);
		expect(restored.inFlightAfterEngine).toEqual([]);
		expect(ended(restored.end).Orders.o1!.Qty).toBe(9);
		expect(ended(dataOnly.end).Orders.o1!.Qty).toBe(2);
	});

	it("a row inside open(...) whose entity's planned holder diverges drops behind it", async () => {
		const steps: IScriptStep[] = [
			on(asking, "o1"),
			on(reserving, "o1"),
			(d) => d.release("reserve")
		];
		const caughtAt = await caught(steps, 1, [
			"Deps/Asking",
			"Deps/Reserving"
		]);
		expect(caughtAt.inFlight.map((row) => row.State)).toEqual([
			"open",
			"holding"
		]);
		const envelope = JSON.parse(caughtAt.json) as {
			InFlight: {
				Name: string;
			}[];
		};
		envelope.InFlight[1]!.Name = "Deps/ReservingTwice";
		const restored = await restoreAt(
			{
				...caughtAt,
				json: JSON.stringify(envelope)
			},
			[],
			{
				engine: true
			}
		);
		expect(outcome(restored)).toEqual({
			resumed: [],
			dropped: [
				[
					"Deps/ReservingTwice",
					"diverged",
					"a replayed step's changes or read answers differ from the history's"
				],
				[
					"Deps/Asking",
					"behind",
					'its entity\'s holder "Deps/ReservingTwice" was the one action on it planned for replay, and did not resume'
				]
			]
		});
	});

	it("lines on two entities are judged each by its own holder, and each resumed row names only its own entity's drops", async () => {
		const steps: IScriptStep[] = [
			on(reserving, "o1"),
			on(paying, "o2"),
			on(setQty, "o1", 5),
			on(setQty, "o2", 6),
			(d) => d.release("reserve"),
			(d) => d.release("pay", "paid")
		];
		const point = await caught(steps, 3, [
			"Deps/Reserving",
			"Deps/SetQty"
		]);
		const restored = await restoreAt(point, steps, {
			engine: true
		});
		const engine = restored.engine!;
		expect(
			engine.resumed.map((resumed) => [
				resumed.name,
				resumed.entityId,
				resumed.beside
			])
		).toEqual([
			[
				"Deps/Reserving",
				"o1",
				[]
			],
			[
				"Deps/SetQty",
				"o1",
				[]
			]
		]);
		expect(
			engine.dropped.map((drop) => [
				drop.name,
				drop.entityId,
				drop.detail
			])
		).toEqual([
			[
				"Deps/Paying",
				"o2",
				'the wait the snapshot caught is "Resume/Pay", which isn\'t declared idempotent'
			],
			[
				"Deps/SetQty",
				"o2",
				'it waits in its entity\'s line behind "Deps/Paying", which did not resume'
			]
		]);
		expect(ended(restored.end).Orders).toMatchObject({
			o1: {
				Qty: 5,
				Note: "reserved:2"
			},
			o2: {
				Qty: 1,
				Tag: "reserved",
				Note: ""
			}
		});
	});

	it("three queued rows with the middle one unmarked: the first is put back, the others drop and are named beside it", async () => {
		const steps: IScriptStep[] = [
			on(reserving, "o1"),
			on(setQty, "o1", 5),
			on(plainSet, "o1", 6),
			on(setQty, "o1", 7),
			(d) => d.release("reserve")
		];
		const point = await caught(steps, 3, [
			"Deps/Reserving",
			"Deps/SetQty"
		]);
		const restored = await restoreAt(point, steps, {
			engine: true
		});
		const beside = [
			[
				null,
				"queued"
			],
			[
				"Deps/SetQty",
				"queued"
			]
		];
		expect(outcome(restored)).toEqual({
			resumed: [
				[
					"Deps/Reserving",
					beside
				],
				[
					"Deps/SetQty",
					beside
				]
			],
			dropped: [
				[
					"plainSet",
					"not-marked",
					"the action has no durable name"
				],
				[
					"Deps/SetQty",
					"behind",
					'it waits in its entity\'s line behind "plainSet", which did not resume'
				]
			]
		});
		expect(ended(restored.end).Orders.o1!.Qty).toBe(5);
	});

	it("two rows inside open(...) on an entity nothing holds: the first in row order is replayed, the second drops beside it", async () => {
		const steps: IScriptStep[] = [
			on(inOpen, "o1"),
			on(asking, "o1"),
			(d) => d.release("first", "one"),
			(d) => d.answer((state: IShop) => state.Orders.o1, "Deps/Ask", "yes")
		];
		const point = await caught(steps, 1, [
			"Deps/InOpen",
			"Deps/Asking"
		]);
		expect(point.inFlight.map((row) => row.State)).toEqual([
			"open",
			"open"
		]);
		const restored = await restoreAt(point, steps, {
			engine: true
		});
		expect(outcome(restored)).toEqual({
			resumed: [
				[
					"Deps/InOpen",
					[
						[
							"Deps/Asking",
							"open"
						]
					]
				]
			],
			dropped: [
				[
					"Deps/Asking",
					"off-list",
					"a replay is planned ahead of it, in row order, on its entity, an ancestor or a descendant"
				]
			]
		});
		expect(ended(restored.end).Orders.o1).toMatchObject({
			Tag: "o",
			Note: "one"
		});
	});
});

function* shopHolding(d: IShop): IActionGenerator {
	d.Tag += "S";
	yield* wait("shop");
	d.Tag += "s";
}
named(shopHolding, "Deps/ShopHolding");
resumable(shopHolding);

describe("a resource's delivery beside a resumed action: the save names it, and the resumed entry says so", () => {
	it("in the holder's line: the holder resumes naming the resource, a marked row queued on the entity drops behind it, and the run is a data-only restore's outside the entity", async () => {
		const { point, restored, dataOnly, replayExact, report } = await besideDelivery(
			[
				on(openFeed, "o1"),
				on(holdThenOpen, "o1"),
				emit(1),
				on(setQty, "o1", 5),
				(d) => d.release("hold"),
				(d) => d.release("feed-1"),
				(d) => d.release("later")
			],
			3,
			[
				"Deps/HoldThenOpen",
				"Deps/SetQty"
			]
		);
		expect(savedIn(point)).toEqual([
			saved([
				deliveryOn("o1", "in-line")
			]),
			saved([
				deliveryOn("o1", "in-line")
			])
		]);
		expect(report).toEqual({
			resumed: [
				[
					"Deps/HoldThenOpen",
					"Resume/Wait",
					[
						{
							key: FEED,
							ownerId: "o1"
						}
					]
				]
			],
			dropped: [
				[
					"Deps/SetQty",
					"behind",
					behindDelivery("o1", "stands in its entity's line")
				]
			]
		});
		expect(replayExact).toBe(true);
		expect(outside(restored.end.state, "o1")).toEqual(outside(dataOnly.end.state, "o1"));
		expect(ended(restored.end).Orders.o1).toMatchObject({
			Qty: 2,
			Note: "after:"
		});
		expect(ended(dataOnly.end).Orders.o1).toMatchObject({
			Qty: 2,
			Note: ""
		});
	});

	it("holding the entity after a partial write, beside an action inside open(...): the action resumes and ends its own writes as the uninterrupted run, and a marked row queued behind the delivery drops", async () => {
		const { point, uninterrupted, restored, dataOnly, replayExact, report } = await besideDelivery(
			[
				on(openFeed, "o1"),
				on(inOpen, "o1"),
				emit(1),
				on(setQty, "o1", 5),
				(d) => d.release("feed-1"),
				(d) => d.release("first", "one")
			],
			3,
			[
				"Deps/InOpen",
				"Deps/SetQty"
			]
		);
		expect(savedIn(point)).toEqual([
			saved([
				deliveryOn("o1", "holding")
			]),
			saved([
				deliveryOn("o1", "holding")
			])
		]);
		expect(report).toEqual({
			resumed: [
				[
					"Deps/InOpen",
					"Resume/Wait",
					[
						{
							key: FEED,
							ownerId: "o1"
						}
					]
				]
			],
			dropped: [
				[
					"Deps/SetQty",
					"behind",
					behindDelivery("o1", "holds its entity")
				]
			]
		});
		expect(replayExact).toBe(true);
		expect(outside(restored.end.state, "o1")).toEqual(outside(dataOnly.end.state, "o1"));
		const resumedOrder = ended(restored.end).Orders.o1!;
		expect(resumedOrder.Note).toBe(ended(uninterrupted).Orders.o1!.Note);
		expect(resumedOrder.Note).toBe("one");
		expect(resumedOrder.Tag).toBe(ended(dataOnly.end).Orders.o1!.Tag);
		expect(resumedOrder.Tag).toBe("of1");
	});

	it("parked inside open(...) on the entity: the holder resumes and the marked row queued behind it is put back, each naming the resource", async () => {
		const { point, uninterrupted, restored, dataOnly, replayExact, report } = await besideDelivery(
			[
				on(openFeed, "o1"),
				emit(1, "o1", true),
				on(reserving, "o1"),
				on(setQty, "o1", 5),
				(d) => d.release("feed-1"),
				(d) => d.release("reserve")
			],
			3,
			[
				"Deps/Reserving",
				"Deps/SetQty"
			]
		);
		expect(point.inFlight.map((row) => row.State)).toEqual([
			"holding",
			"queued"
		]);
		expect(savedIn(point)).toEqual([
			saved([
				deliveryOn("o1", "open")
			]),
			saved([
				deliveryOn("o1", "open")
			])
		]);
		const work = [
			{
				key: FEED,
				ownerId: "o1"
			}
		];
		expect(report).toEqual({
			resumed: [
				[
					"Deps/Reserving",
					"Resume/Wait",
					work
				],
				[
					"Deps/SetQty",
					null,
					work
				]
			],
			dropped: []
		});
		expect(replayExact).toBe(true);
		expect(outside(restored.end.state, "o1")).toEqual(outside(dataOnly.end.state, "o1"));
		const order = ended(restored.end).Orders.o1!;
		expect(order).toMatchObject({
			Qty: ended(uninterrupted).Orders.o1!.Qty,
			Note: ended(uninterrupted).Orders.o1!.Note,
			Tag: ended(dataOnly.end).Orders.o1!.Tag
		});
		expect(order).toMatchObject({
			Qty: 5,
			Note: "reserved:2",
			Tag: "f1"
		});
	});

	it("holding the entity above: the order's holder and the marked row queued behind it resume, naming the root's resource", async () => {
		const { point, uninterrupted, restored, dataOnly, replayExact, report } = await besideDelivery(
			[
				on(openFeed, "shop"),
				on(reserving, "o1"),
				emit(1, "shop"),
				on(setQty, "o1", 5),
				(d) => d.release("reserve"),
				(d) => d.release("feed-1")
			],
			3,
			[
				"Deps/Reserving",
				"Deps/SetQty"
			]
		);
		expect(savedIn(point)).toEqual([
			saved([
				deliveryOn("shop", "holding")
			]),
			saved([
				deliveryOn("shop", "holding")
			])
		]);
		const work = [
			{
				key: FEED,
				ownerId: "shop"
			}
		];
		expect(report).toEqual({
			resumed: [
				[
					"Deps/Reserving",
					"Resume/Wait",
					work
				],
				[
					"Deps/SetQty",
					null,
					work
				]
			],
			dropped: []
		});
		expect(replayExact).toBe(true);
		expect(outside(restored.end.state, "o1")).toEqual(outside(dataOnly.end.state, "o1"));
		expect(ended(restored.end).Orders.o1).toEqual(ended(uninterrupted).Orders.o1);
	});

	it("holding an entity below: the root's holder resumes naming the order's resource, and the order ends as a data-only restore's", async () => {
		const { point, uninterrupted, restored, dataOnly, replayExact, report } = await besideDelivery(
			[
				on(openFeed, "o1"),
				on(shopHolding, "shop"),
				emit(1),
				(d) => d.release("shop"),
				(d) => d.release("feed-1")
			],
			2,
			[
				"Deps/ShopHolding"
			]
		);
		expect(savedIn(point)).toEqual([
			saved([
				deliveryOn("o1", "holding")
			])
		]);
		expect(report).toEqual({
			resumed: [
				[
					"Deps/ShopHolding",
					"Resume/Wait",
					[
						{
							key: FEED,
							ownerId: "o1"
						}
					]
				]
			],
			dropped: []
		});
		expect(replayExact).toBe(true);
		expect(ended(restored.end).Orders).toEqual(ended(dataOnly.end).Orders);
		expect(ended(restored.end).Tag).toBe(ended(uninterrupted).Tag);
		expect(ended(restored.end).Tag).toBe("Ss");
	});

	it("an r.run in flight is not named: it takes no gate, and the reopened resource connects again", async () => {
		const connected: boolean[] = [];
		const { point, report } = await besideDelivery(
			[
				on(openRunner, "o1"),
				on(reserving, "o1"),
				(d) => d.release("reserve"),
				(d) => {
					connected.push(d.release("connect"));
				}
			],
			1,
			[
				"Deps/Reserving"
			]
		);
		expect(connected[0]).toBe(true);
		expect(savedIn(point)).toEqual([
			saved([])
		]);
		expect(report).toEqual({
			resumed: [
				[
					"Deps/Reserving",
					"Resume/Wait",
					[]
				]
			],
			dropped: []
		});
	});

	for (const [field, value] of [
		[
			"Unlisted",
			undefined
		],
		[
			"Unlisted",
			"foo"
		],
		[
			"Unlisted",
			{}
		],
		[
			"Unlisted",
			null
		],
		[
			"Deliveries",
			undefined
		],
		[
			"Deliveries",
			null
		],
		[
			"Deliveries",
			"none"
		],
		[
			"Deliveries",
			[
				{
					Key: FEED,
					EntityId: "o1",
					At: "in-line"
				}
			]
		]
	] as const) {
		it(`${field} ${value === undefined ? "deleted" : JSON.stringify(value)} in the envelope is read as work holding the entity that can't be named: every row on it drops, unlisted`, async () => {
			const steps: IScriptStep[] = [
				on(openFeed, "o1"),
				on(reserving, "o1"),
				emit(1),
				on(setQty, "o1", 5),
				(d) => d.release("reserve"),
				(d) => d.release("feed-1")
			];
			const point = await caught(steps, 3, [
				"Deps/Reserving",
				"Deps/SetQty"
			]);
			const envelope = JSON.parse(point.json) as {
				Histories: Record<string, unknown>[];
			};
			for (const history of envelope.Histories) {
				if (value === undefined) {
					delete history[field];
				} else {
					history[field] = value;
				}
			}
			const edited = {
				...point,
				json: JSON.stringify(envelope)
			};
			const restored = await restoreAt(edited, steps, {
				engine: true,
				setup
			});
			const dataOnly = await restoreAt(edited, steps, {
				engine: false,
				setup
			});
			expect(outcome(restored)).toEqual({
				resumed: [],
				dropped: [
					[
						"Deps/Reserving",
						"unlisted",
						HOLDS
					],
					[
						"Deps/SetQty",
						"unlisted",
						HOLDS
					]
				]
			});
			expect(restored.end).toEqual(dataOnly.end);
		});
	}
});

interface ILine extends IEntity {
	Qty: number;
}

interface ILinedOrder extends IOrder {
	Lines: Record<string, ILine>;
}

interface ILinedShop extends IEntity {
	Orders: Record<string, ILinedOrder>;
}

function lined(): ILinedShop {
	return {
		$Id: "shop",
		Orders: {
			o1: {
				...order("o1"),
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

function* flagFromLine(d: ILinedOrder): IActionGenerator {
	yield* wait("flag");
	d.Note = `qty:${d.Lines["o1-l1"]!.Qty}`;
}
named(flagFromLine, "Deps/FlagFromLine");
resumable(flagFromLine);

function* lineLater(d: ILine): IActionGenerator {
	yield* wait("line");
	d.Qty = 7;
}

function* lineMarked(d: ILine): IActionGenerator {
	yield* wait("line");
	d.Qty = 7;
}
named(lineMarked, "Deps/LineMarked");
resumable(lineMarked);

function* shopLater(d: ILinedShop): IActionGenerator {
	yield* wait("shop");
	d.Orders.o1!.Lines["o1-l1"]!.Qty = 5;
}

function* shopMarked(d: ILinedShop): IActionGenerator {
	yield* wait("shop");
	d.Orders.o1!.Lines["o1-l1"]!.Qty = 5;
}
named(shopMarked, "Deps/ShopMarked");
resumable(shopMarked);

function* openLineFeed(d: ILine): IActionGenerator {
	yield* opening(d, "Deps/Feed", Feed, {
		Type: "deps/feed"
	});
}

const ONE_PER_LINEAGE = "a replay is planned ahead of it, in row order, on its entity, an ancestor or a descendant";

describe("a resumed action's report covers its lineage: its entity, the entities above it and those below it", () => {
	async function lineage(steps: IScriptStep[], at: number, marked: string[]) {
		const script = await playScript(lined(), steps, marked, {
			setup
		});
		const point = script.points.find((found) => found.at === at)!;
		const restored = await restoreAt(point, steps, {
			engine: true,
			setup
		});
		const dataOnly = await restoreAt(point, steps, {
			engine: false,
			setup
		});
		const engine = restored.engine!;
		return {
			point,
			uninterrupted: (JSON.parse(script.endFrom(point).state) as ILinedShop).Orders.o1!,
			resumed: (JSON.parse(restored.end.state) as ILinedShop).Orders.o1!,
			restored,
			dataOnly,
			report: {
				resumed: engine.resumed.map((entry) => [
					entry.name,
					entry.entityId,
					entry.beside.map((beside) => [
						beside.name,
						beside.entityId,
						beside.state
					])
				]),
				dropped: engine.dropped.map((drop) => [
					drop.name ?? drop.label,
					drop.entityId,
					drop.reason,
					drop.detail
				])
			}
		};
	}

	it("unmarked work on a line below: the order's action resumes, reads a quantity the line's action never set, and names that action beside it", async () => {
		const { uninterrupted, resumed, report } = await lineage(
			[
				on(flagFromLine, "o1"),
				on(lineLater, "o1-l1"),
				(d) => d.release("line"),
				(d) => d.release("flag")
			],
			1,
			[
				"Deps/FlagFromLine"
			]
		);
		expect(uninterrupted.Note).toBe("qty:7");
		expect(resumed.Note).toBe("qty:1");
		expect(report).toEqual({
			resumed: [
				[
					"Deps/FlagFromLine",
					"o1",
					[
						[
							null,
							"o1-l1",
							"holding"
						]
					]
				]
			],
			dropped: [
				[
					"lineLater",
					"o1-l1",
					"not-marked",
					"the action has no durable name"
				]
			]
		});
	});

	it("unmarked work holding the root above: the order's action resumes and names it beside it", async () => {
		const { uninterrupted, resumed, report } = await lineage(
			[
				on(flagFromLine, "o1"),
				on(shopLater, "shop"),
				(d) => d.release("shop"),
				(d) => d.release("flag")
			],
			1,
			[
				"Deps/FlagFromLine"
			]
		);
		expect(uninterrupted.Note).toBe("qty:5");
		expect(resumed.Note).toBe("qty:1");
		expect(report).toEqual({
			resumed: [
				[
					"Deps/FlagFromLine",
					"o1",
					[
						[
							null,
							"shop",
							"holding"
						]
					]
				]
			],
			dropped: [
				[
					"shopLater",
					"shop",
					"not-marked",
					"the action has no durable name"
				]
			]
		});
	});

	it("a marked action on the root, dropped by the one-per-lineage rule: the order's action names it beside it", async () => {
		const { resumed, report } = await lineage(
			[
				on(flagFromLine, "o1"),
				on(shopMarked, "shop"),
				(d) => d.release("shop"),
				(d) => d.release("flag")
			],
			1,
			[
				"Deps/FlagFromLine",
				"Deps/ShopMarked"
			]
		);
		expect(resumed.Note).toBe("qty:1");
		expect(report).toEqual({
			resumed: [
				[
					"Deps/FlagFromLine",
					"o1",
					[
						[
							"Deps/ShopMarked",
							"shop",
							"holding"
						]
					]
				]
			],
			dropped: [
				[
					"Deps/ShopMarked",
					"shop",
					"off-list",
					ONE_PER_LINEAGE
				]
			]
		});
	});

	it("a marked action on a line, dropped by the one-per-lineage rule: the order's action names it beside it", async () => {
		const { resumed, report } = await lineage(
			[
				on(flagFromLine, "o1"),
				on(lineMarked, "o1-l1"),
				(d) => d.release("line"),
				(d) => d.release("flag")
			],
			1,
			[
				"Deps/FlagFromLine",
				"Deps/LineMarked"
			]
		);
		expect(resumed.Note).toBe("qty:1");
		expect(report).toEqual({
			resumed: [
				[
					"Deps/FlagFromLine",
					"o1",
					[
						[
							"Deps/LineMarked",
							"o1-l1",
							"holding"
						]
					]
				]
			],
			dropped: [
				[
					"Deps/LineMarked",
					"o1-l1",
					"off-list",
					ONE_PER_LINEAGE
				]
			]
		});
	});

	it("a resource's delivery holding a line below: the order's action resumes naming it, and the line ends as a data-only restore's", async () => {
		const { point, uninterrupted, resumed, restored, dataOnly, report } = await lineage(
			[
				on(openLineFeed, "o1-l1"),
				on(flagFromLine, "o1"),
				emit(1, "o1-l1"),
				(d) => d.release("feed-1"),
				(d) => d.release("flag")
			],
			2,
			[
				"Deps/FlagFromLine"
			]
		);
		expect(
			(
				JSON.parse(point.json) as {
					Histories: IHistory[];
				}
			).Histories.map((history) => [
				history.Unlisted,
				history.UnlistedLineage,
				history.Deliveries
			])
		).toEqual([
			[
				"none",
				[],
				[
					deliveryOn("o1-l1", "holding")
				]
			]
		]);
		expect(report).toEqual({
			resumed: [
				[
					"Deps/FlagFromLine",
					"o1",
					[]
				]
			],
			dropped: []
		});
		expect(restored.engine!.resumed[0]!.resourceWork).toEqual([
			{
				key: FEED,
				ownerId: "o1-l1"
			}
		]);
		expect(resumed.Note).toBe(uninterrupted.Note);
		expect(resumed.Lines["o1-l1"]).toEqual((JSON.parse(dataOnly.end.state) as ILinedShop).Orders.o1!.Lines["o1-l1"]);
		expect(
			(
				JSON.parse(restored.end.state) as {
					Orders: Record<string, unknown>;
				}
			).Orders.o2
		).toEqual(
			(
				JSON.parse(dataOnly.end.state) as {
					Orders: Record<string, unknown>;
				}
			).Orders.o2
		);
	});
});
