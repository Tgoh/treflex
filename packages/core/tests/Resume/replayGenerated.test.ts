import type { IActionGenerator, IAskId, IEntity, IOpenGenerator, IRuntime } from "../../src/index";
import type { ISnapshotHistory } from "../../src/Resume/history";
import type { IResumed } from "../../src/Resume/resume";
import type { IInFlightAction } from "../../src/Runtime/processAction";
import type { IEnd, IPoint, IRestoredEnd, IScriptStep } from "./replayScript";
import { describe, expect, it, vi } from "vitest";
import { answer } from "../../src/Effects/answer";
import { ask } from "../../src/Effects/ask";
import { entity } from "../../src/Effects/entity";
import { generateGuid } from "../../src/Effects/generateGuid";
import { openResource } from "../../src/Effects/openResource";
import { publish } from "../../src/Effects/publish";
import { startTimer } from "../../src/Effects/startTimer";
import { stopTimer } from "../../src/Effects/stopTimer";
import { external } from "../../src/Reads/external";
import { resumable } from "../../src/Resume/resumable";
import { latest, leading } from "../../src/Runtime/arrivalPolicy";
import { inFlight } from "../../src/Runtime/arrivals";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { PAY } from "./replayHarness";
import { playScript, restoreAt } from "./replayScript";
import { wait } from "./resumeHarness";

const host = (
	globalThis as {
		process?: {
			env?: Record<string, string | undefined>;
			stderr?: {
				write(text: string): void;
			};
		};
	}
).process;

const RUNS = Number(host?.env?.TREFLEX_REPLAY_RUNS ?? 70);

const merges = vi.hoisted(() => ({
	counting: false,
	across: 0
}));

vi.mock(import("../../src/Resume/fold"), async (importOriginal) => {
	const original = await importOriginal();
	return {
		...original,
		appendOther: (...args: Parameters<typeof original.appendOther>) => {
			const entries = args[0];
			const last = entries[entries.length - 1];
			const added = original.appendOther(...args);
			if (merges.counting && !added && entries[entries.length - 1] === last) {
				merges.across++;
			}
			return added;
		}
	};
});

interface ILine extends IEntity {
	Qty: number;
}

interface IOrder extends IEntity {
	Qty: number;
	Key: string;
	Note: string;
	Tag: string;
	Memo: string;
	Receipt: string;
	Drift: number;
	Lines: Record<string, ILine>;
}

interface IShop extends IEntity {
	Clock: number;
	Orders: Record<string, IOrder>;
}

const order = (id: string): IOrder => ({
	$Id: id,
	Qty: 1,
	Key: "",
	Note: "",
	Tag: "",
	Memo: "",
	Receipt: "",
	Drift: 0,
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
		Clock: 0,
		Orders: {
			o1: order("o1"),
			o2: order("o2"),
			o3: order("o3"),
			o4: order("o4")
		}
	};
}

type IOp =
	| {
			Op: "add" | "line";
			N: number;
	  }
	| {
			Op: "open" | "held" | "catch" | "pay" | "loop" | "helper";
			Name: string;
	  }
	| {
			Op: "ask";
			Path: string;
	  }
	| {
			Op: "guid" | "busy" | "ext" | "timer" | "untimer" | "publish" | "answer" | "drift";
	  };

const Ticker = (receiver as (id: string) => (cases: object) => never)("Generated/Ticker")({
	*"Generated/Tick"(draft: IOrder) {
		draft.Tag += "t";
	}
});

const FEED_WAIT = "Generated/FeedWait";

const Feed = (receiver as (id: string) => (cases: object) => never)("Generated/FeedReceiver")({
	*"Generated/Feed"(
		draft: IOrder,
		message: {
			N: number;
			Open?: true;
		}
	) {
		if (message.Open) {
			yield* open(feedWait(`feed-${message.N}`));
		} else {
			yield* feedWait(`feed-${message.N}`);
		}
		draft.Tag += `F${message.N}`;
	}
});

function* feedWait(name: string): IActionGenerator {
	yield {
		Type: FEED_WAIT,
		Name: name
	} as never;
}

const startTicking = startTimer as (...args: unknown[]) => IActionGenerator;
const stopTicking = stopTimer as (...args: unknown[]) => IActionGenerator;
const send = publish as (...args: unknown[]) => IActionGenerator;
const opening = openResource as (...args: unknown[]) => IActionGenerator;

// True only while the engine runs, so a replayed `drift` step writes what the original run didn't.
let drifting = false;

function* setQty(d: IOrder, qty: number): IActionGenerator {
	d.Qty = qty;
}
named(setQty, "Generated/SetQty");
resumable(setQty);

function* plainQty(d: IOrder, qty: number): IActionGenerator {
	d.Qty = qty + 1;
}

/** Every value a yield gave each program, by the program's tag, in the runtime running now. */
const heard = new Map<string, string[]>();

function hear<T>(tag: string, value: T): T {
	const log = heard.get(tag) ?? [];
	log.push(JSON.stringify(value) ?? "undefined");
	heard.set(tag, log);
	return value;
}

function heardSoFar(): Record<string, string[]> {
	return Object.fromEntries(
		[
			...heard
		].map(([tag, log]) => [
			tag,
			[
				...log
			]
		])
	);
}

function* viaHelper(d: IOrder, name: string, tag: string): IOpenGenerator<string> {
	const got = hear(tag, yield* open(wait(name)));
	return `${String(got)}!${d.Qty}`;
}

function* program(d: IOrder, ops: IOp[], tag: string): IOpenGenerator {
	const locals: string[] = [];
	for (const op of ops) {
		switch (op.Op) {
			case "add":
				d.Qty += op.N;
				break;
			case "line": {
				const line = d.Lines[`${d.$Id}-l1`];
				if (line) {
					line.Qty += op.N;
				}
				break;
			}
			case "open":
				d.Note = `${d.Note}|${String(hear(tag, yield* open(wait(op.Name))))}:${d.Qty}`;
				break;
			case "held": {
				const got = String(hear(tag, yield* wait(op.Name)));
				locals.push(got);
				d.Key = `${got}:${d.Qty}`;
				break;
			}
			case "ask":
				locals.push(
					String(
						hear(
							tag,
							yield* open(
								ask<string>(d, {
									Path: op.Path,
									Qty: d.Qty
								})
							)
						)
					)
				);
				break;
			case "guid":
				d.Key = hear(tag, yield* generateGuid());
				break;
			case "busy":
				d.Tag = String(hear(tag, yield* inFlight(setQty, d)));
				break;
			case "catch":
				try {
					locals.push(String(hear(tag, yield* open(wait(op.Name)))));
				} catch (error) {
					hear(tag, {
						Thrown: (error as Error).name,
						Message: (error as Error).message,
						Code: (
							error as {
								Code?: unknown;
							}
						).Code
					});
					d.Note =
						(
							error as {
								Code?: unknown;
							}
						).Code === "soft"
							? `${d.Note}|soft`
							: `${d.Note}|${(error as Error).name}:${(error as Error).message}`;
				} finally {
					d.Tag += "f";
				}
				break;
			case "pay":
				d.Receipt = String(
					hear(
						tag,
						yield {
							Type: PAY,
							Name: op.Name
						} as never
					)
				);
				break;
			case "loop":
				for (let k = 0; k < 3 && (d.Qty + k) % 2 === 0; k++) {
					locals.push(String(hear(tag, yield* open(wait(`${op.Name}-${k}`)))));
				}
				break;
			case "helper":
				locals.push(yield* viaHelper(d, op.Name, tag));
				break;
			case "ext":
				locals.push(String(hear(tag, yield* external("Generated/Ext" as never))));
				break;
			case "timer":
				hear(tag, yield* startTicking(d, "Generated/Tick", Ticker, 3_600_000));
				break;
			case "untimer":
				hear(tag, yield* stopTicking(d, "Generated/Tick"));
				break;
			case "publish":
				hear(
					tag,
					yield* send("Generated/Ping", {
						From: d.$Id
					})
				);
				break;
			case "answer":
				hear(tag, yield* answer("no-such-ask" as IAskId<number>, 1));
				break;
			case "drift":
				d.Drift += drifting ? 2 : 1;
				break;
		}
	}
	d.Memo = locals.join(",");
}
named(program, "Generated/Program");
resumable(program);

function* leadOp(d: IOrder, name: string): IOpenGenerator {
	d.Tag += "L";
	d.Note = String(yield* open(wait(name)));
}
named(leadOp, "Generated/Lead");
leading(leadOp);
resumable(leadOp);

function* lastOp(d: IOrder, name: string): IOpenGenerator {
	d.Tag += "T";
	d.Note = String(yield* open(wait(name)));
}
named(lastOp, "Generated/Last");
latest(lastOp);
resumable(lastOp);

function* setLine(d: ILine, qty: number): IActionGenerator {
	d.Qty = qty;
}

function* addLine(d: IOrder, qty: number): IActionGenerator {
	const made = yield* entity<ILine>({
		Qty: qty
	});
	d.Lines[made.$Id] = made;
}

function* dropLine(d: IOrder): IActionGenerator {
	const extra = Object.keys(d.Lines)
		.filter((key) => key !== `${d.$Id}-l1`)
		.sort();
	if (extra.length > 0) {
		delete d.Lines[extra[extra.length - 1]!];
	}
}

function* setClock(d: IShop, n: number): IActionGenerator {
	d.Clock = n;
}

function* fromShop(d: IShop, id: string, n: number): IActionGenerator {
	const target = d.Orders[id];
	if (target) {
		target.Note = `${target.Note}~${n}`;
	}
}

function* holder(d: IOrder, name: string): IActionGenerator {
	d.Tag = `${d.Tag}h`;
	yield* wait(name);
	d.Tag = `${d.Tag}H`;
}

function* markedHolder(d: IOrder, name: string): IActionGenerator {
	d.Qty *= 2;
	yield* wait(name);
	d.Tag = `${d.Tag}M`;
}
named(markedHolder, "Generated/Holder");
resumable(markedHolder);

function* lineHolder(d: ILine, name: string): IActionGenerator {
	yield* wait(name);
	d.Qty += 100;
}

function* shopHolder(d: IShop, name: string, id: string): IActionGenerator {
	yield* wait(name);
	const line = d.Orders[id]?.Lines[`${id}-l1`];
	if (line) {
		line.Qty += 10;
	}
}

function* openFeed(d: IEntity): IActionGenerator {
	yield* opening(d, "Generated/Feed", Feed, {
		Type: "generated/feed",
		On: d.$Id
	});
}

function rng(seedValue: number): () => number {
	let a = seedValue >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SOFT = Object.assign(new RangeError("refused"), {
	Code: "soft"
});
const HARD = new TypeError("broken");

/** A resource's delivery in flight: work no row lists, which every restore drops. */
interface IDelivery {
	entityId: string;
	key: string;
	ownerId: string;
	/** Its case waits inside open(...). */
	inOpen: boolean;
	/**
	 * In its line until it runs, then holding its entity at its wait, or parked inside open(...) and,
	 * once answered, in its line for its hold back until its next step.
	 */
	at: "in-line" | "holding" | "open";
}

interface IFeedWaits {
	readonly waiting: Map<string, () => void>;
	readonly banked: Set<string>;
	/** The deliveries started and not ended, by action id. */
	readonly live: Map<string, IDelivery>;
	/** Each open feed's emit, by the entity it delivers to. */
	readonly emits: Map<string, (message: unknown) => Promise<void>>;
	/** The action id of each delivery's unanswered yield, by its `Seq`. */
	readonly effects: Map<number, string>;
}

const feeds = new WeakMap<IRuntime<any>, IFeedWaits>();

function feedOf(runtime: IRuntime<any>): IFeedWaits {
	let feed = feeds.get(runtime);
	if (!feed) {
		feed = {
			waiting: new Map(),
			banked: new Set(),
			live: new Map(),
			emits: new Map(),
			effects: new Map()
		};
		feeds.set(runtime, feed);
	}
	return feed;
}

function deliveriesIn(runtime: IRuntime<any>): IDelivery[] {
	return [
		...feedOf(runtime).live.values()
	].map((delivery) => ({
		...delivery
	}));
}

const emitted =
	(n: number, on: string, inOpen: boolean): IScriptStep =>
	(d) => {
		void (
			feedOf(d.runtime).emits.get(on)?.({
				N: n,
				...(inOpen
					? {
							Open: true
						}
					: {})
			}) ?? Promise.resolve()
		).catch(() => {});
	};

const banked =
	(n: number): IScriptStep =>
	(d) => {
		const feed = feedOf(d.runtime);
		const name = `feed-${n}`;
		const resolve = feed.waiting.get(name);
		if (resolve) {
			feed.waiting.delete(name);
			resolve();
		} else {
			feed.banked.add(name);
		}
	};

const answered =
	(owner: (state: IShop) => IEntity | undefined, path: string, value: string): IScriptStep =>
	(d) => {
		void d.answer(owner, path, value);
	};

/** A program for one order and the steps that answer its waits, with other writers in them. */
function generate(
	pick: () => number,
	id: string,
	tag: string,
	feed: {
		n: number;
	}
): {
	ops: IOp[];
	segments: IScriptStep[][];
} {
	const int = (n: number) => Math.floor(pick() * n);
	const ops: IOp[] = [];
	const segments: IScriptStep[][] = [];
	const length = 2 + int(7);
	const owner = (state: IShop) => state.Orders[id];
	const writers = (
		inOpen: boolean
	): {
		steps: IScriptStep[];
		after: IScriptStep[];
	} => {
		const steps: IScriptStep[] = [];
		const after: IScriptStep[] = [];
		const count = int(4);
		for (let at = 0; at < count; at++) {
			const n = int(100);
			const roll = pick();
			if (id === "o1" && pick() < 0.1) {
				const delivery = ++feed.n;
				const where = pick();
				steps.push(emitted(delivery, where < 0.6 ? "o1" : where < 0.85 ? "o1-l1" : "shop", delivery % 2 === 0));
				after.push(banked(delivery));
				continue;
			}
			if (inOpen && pick() < 0.15) {
				steps.push((d) => {
					d.dispatch(plainQty, id, n);
					d.dispatch(fromShop, "shop", id, n);
					d.dispatch(plainQty, id, n + 1);
					d.dispatch(setLine, `${id}-l1`, n);
					d.dispatch(fromShop, "shop", id, n + 1);
					d.dispatch(plainQty, id, n + 2);
				});
				continue;
			}
			if (pick() < 0.08) {
				const hold = `${pick() < 0.6 ? `${id}-l1` : "shop"}-hold${++feed.n}`;
				steps.push(
					hold.startsWith("shop") ? (d) => d.dispatch(shopHolder, "shop", hold, id) : (d) => d.dispatch(lineHolder, `${id}-l1`, hold)
				);
				after.push((d) => d.release(hold));
				continue;
			}
			if (!inOpen) {
				if (roll < 0.35) {
					steps.push((d) => d.dispatch(setQty, id, n));
				} else if (roll < 0.5) {
					steps.push((d) => d.dispatch(plainQty, id, n));
				} else if (roll < 0.75) {
					steps.push((d) => d.dispatch(setClock, "shop", n));
				} else {
					steps.push((d) => d.dispatch(setLine, `${id}-l1`, n));
				}
				continue;
			}
			if (roll < 0.2) {
				steps.push((d) => d.dispatch(setQty, id, n));
			} else if (roll < 0.28) {
				steps.push((d) => d.dispatch(plainQty, id, n));
			} else if (roll < 0.4) {
				steps.push((d) => d.dispatch(setLine, `${id}-l1`, n));
			} else if (roll < 0.55) {
				steps.push((d) => d.dispatch(addLine, id, n));
			} else if (roll < 0.65) {
				steps.push((d) => d.dispatch(dropLine, id));
			} else if (roll < 0.8) {
				steps.push((d) => d.dispatch(fromShop, "shop", id, n));
			} else {
				steps.push((d) => d.dispatch(setClock, "shop", n));
			}
		}
		return {
			steps,
			after
		};
	};
	const holding = (at: number, steps: IScriptStep[]): IScriptStep | null => {
		if (pick() >= 0.3) {
			return null;
		}
		const hold = `${tag}-hold${at}`;
		const by = pick() < 0.5 ? markedHolder : holder;
		steps.push((d) => d.dispatch(by, id, hold));
		if (pick() < 0.5) {
			const qty = int(100);
			steps.push((d) => d.dispatch(setQty, id, qty));
		}
		return (d) => d.release(hold);
	};
	let timing = false;
	for (let at = 0; at < length; at++) {
		const roll = pick();
		const name = `${tag}-w${at}`;
		if (roll < 0.07) {
			ops.push({
				Op: "add",
				N: 1 + int(5)
			});
		} else if (roll < 0.11) {
			ops.push({
				Op: "line",
				N: 1 + int(5)
			});
		} else if (roll < 0.27) {
			ops.push({
				Op: "open",
				Name: name
			});
			const { steps, after } = writers(true);
			const release = holding(at, steps);
			steps.push((d) => d.release(name, `v${at}`));
			if (release) {
				steps.push(release);
			}
			segments.push([
				...steps,
				...after
			]);
		} else if (roll < 0.37) {
			ops.push({
				Op: "held",
				Name: name
			});
			const { steps, after } = writers(false);
			segments.push([
				...steps,
				(d) => d.release(name, `h${at}`),
				...after
			]);
		} else if (roll < 0.47) {
			const path = `${tag}-q${at}`;
			ops.push({
				Op: "ask",
				Path: path
			});
			const { steps, after } = writers(true);
			const release = holding(at, steps);
			if (release) {
				steps.push(release);
			}
			segments.push([
				...steps,
				answered(owner, path, `a${at}`),
				...after
			]);
		} else if (roll < 0.51) {
			ops.push({
				Op: "guid"
			});
		} else if (roll < 0.55) {
			ops.push({
				Op: "busy"
			});
		} else if (roll < 0.62) {
			ops.push({
				Op: "catch",
				Name: name
			});
			const how = pick();
			const { steps, after } = writers(true);
			segments.push([
				...steps,
				how < 0.35 ? (d) => d.fail(name, SOFT) : how < 0.7 ? (d) => d.fail(name, HARD) : (d) => d.release(name, `c${at}`),
				...after
			]);
		} else if (roll < 0.65) {
			ops.push({
				Op: "pay",
				Name: name
			});
			segments.push([
				(d) => d.release(name, `p${at}`)
			]);
		} else if (roll < 0.7) {
			ops.push({
				Op: "loop",
				Name: name
			});
			const { steps, after } = writers(true);
			segments.push([
				...steps,
				(d) => d.release(`${name}-0`, `l${at}a`),
				(d) => d.release(`${name}-1`, `l${at}b`),
				(d) => d.release(`${name}-2`, `l${at}c`),
				...after
			]);
		} else if (roll < 0.75) {
			ops.push({
				Op: "helper",
				Name: name
			});
			const { steps, after } = writers(true);
			segments.push([
				...steps,
				(d) => d.release(name, `x${at}`),
				...after
			]);
		} else if (roll < 0.79) {
			ops.push({
				Op: "ext"
			});
		} else if (roll < 0.84) {
			ops.push({
				Op: timing ? "untimer" : "timer"
			});
			timing = !timing;
		} else if (roll < 0.88) {
			ops.push({
				Op: "publish"
			});
		} else if (roll < 0.92) {
			ops.push({
				Op: "answer"
			});
		} else {
			ops.push({
				Op: "drift"
			});
		}
	}
	return {
		ops,
		segments
	};
}

/** Steps for the arrival marks on their own orders: a repeat of a leading action, and a latest one replacing itself. */
function marks(pick: () => number): IScriptStep[][] {
	const segments: IScriptStep[][] = [];
	if (pick() < 0.5) {
		segments.push([
			(d) => d.dispatch(leadOp, "o3", "lead-1")
		]);
		segments.push([
			(d) => d.dispatch(leadOp, "o3", "lead-2"),
			(d) => d.release("lead-1", "l1"),
			(d) => d.release("lead-2", "l2")
		]);
	}
	if (pick() < 0.5) {
		segments.push([
			(d) => d.dispatch(lastOp, "o4", "last-1")
		]);
		segments.push([
			(d) => d.dispatch(lastOp, "o4", "last-2"),
			(d) => d.release("last-2", "t2"),
			(d) => d.release("last-1", "t1")
		]);
	}
	return segments;
}

function setup(runtime: IRuntime<any>): void {
	runtime.registerReceiver(Ticker);
	runtime.registerReceiver(Feed);
	runtime.provideExternal("Generated/Ext" as never, {
		read: () => "ext" as never
	});
	const feed = feedOf(runtime);
	runtime.on("record", (record) => {
		if (record.Kind === "action:start" && record.Origin?.Kind === "resource:deliver") {
			feed.live.set(record.ActionId, {
				entityId: record.EntityId,
				key: record.Origin.Key,
				ownerId: record.Origin.OwnerId,
				inOpen:
					(
						record.Args[0] as
							| {
									Open?: true;
							  }
							| undefined
					)?.Open === true,
				at: "in-line"
			});
		} else if (record.Kind === "effect") {
			const delivery = feed.live.get(record.ActionId);
			if (delivery) {
				delivery.at = delivery.inOpen ? "open" : "holding";
				feed.effects.set(record.Seq, record.ActionId);
			}
		} else if (record.Kind === "response") {
			const delivery = feed.live.get(feed.effects.get(record.ForSeq) ?? "");
			feed.effects.delete(record.ForSeq);
			if (delivery?.inOpen) {
				delivery.at = "in-line";
			}
		} else if (record.Kind === "step") {
			const delivery = feed.live.get(record.ActionId);
			if (delivery?.inOpen && delivery.at === "in-line") {
				delivery.at = "holding";
			}
		} else if (record.Kind === "action:end") {
			feed.live.delete(record.ActionId);
		}
	});
	runtime.registerImplementation(FEED_WAIT, (effect) => {
		const name = (
			effect as unknown as {
				Name: string;
			}
		).Name;
		if (feed.banked.delete(name)) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			feed.waiting.set(name, resolve);
		});
	});
	(
		runtime as unknown as {
			registerResourceType(
				type: string,
				implementation: (
					params: {
						On: string;
					},
					context: {
						emit(message: unknown): Promise<void>;
					}
				) => void
			): void;
		}
	).registerResourceType("generated/feed", (params, context) => {
		feed.emits.set(params.On, (message) => context.emit(message));
	});
}

function leaves(value: unknown, path: string, into: Map<string, string>): void {
	if (value !== null && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			leaves(child, `${path}.${key}`, into);
		}
		return;
	}
	into.set(path, JSON.stringify(value));
}

// Minted ids are numbered in the order they are minted, so a dropped action shifts every later one; a
// line minted by another writer is named by its place among its order's minted lines instead.
function paired(state: string): unknown {
	const shop = JSON.parse(state) as IShop;
	for (const placed of Object.values(shop.Orders)) {
		const lines: Record<string, ILine> = {};
		let minted = 0;
		for (const [key, line] of Object.entries(placed.Lines)) {
			if (key.startsWith("~")) {
				const name = `~minted-${minted++}`;
				lines[name] = {
					...line,
					$Id: name
				};
			} else {
				lines[key] = line;
			}
		}
		placed.Lines = lines;
	}
	return shop;
}

/**
 * A difference is a state path, or one diag, failure, onError call, unfinished action, pending wait or
 * open ask. One more of a diag kind `from`'s runtime had raised before its cut is none: a restored
 * runtime's "once" memories start empty.
 */
function differences(from: IEnd, to: IEnd): Set<string> {
	const items = new Set<string>();
	const a = new Map<string, string>();
	const b = new Map<string, string>();
	leaves(paired(from.state), "", a);
	leaves(paired(to.state), "", b);
	for (const key of new Set([
		...a.keys(),
		...b.keys()
	])) {
		if (a.get(key) !== b.get(key)) {
			items.add(`state${key}`);
		}
	}
	const count = (list: readonly string[], item: string) => list.filter((x) => x === item).length;
	for (const field of [
		"onError",
		"inFlight",
		"waiting",
		"asks"
	] as const) {
		for (const item of new Set([
			...from[field],
			...to[field]
		])) {
			if (count(to[field], item) !== count(from[field], item)) {
				items.add(`${field}:${item}`);
			}
		}
	}
	// By what a diag's once-memory keys on (`diagKey`) and count: that memory decides which occurrence is
	// reported, and so on which entity, by what else ran, so the entity only attributes a surplus or a shortfall.
	for (const field of [
		"diags",
		"failures"
	] as const) {
		const codeOf = (item: string) => (item.includes("@") ? item.slice(0, item.lastIndexOf("@")) : item);
		for (const code of new Set(
			[
				...from[field],
				...to[field]
			].map(codeOf)
		)) {
			const left = from[field].filter((item) => codeOf(item) === code);
			const right = to[field].filter((item) => codeOf(item) === code);
			if (right.length === left.length || (field === "diags" && from.raised.includes(code) && right.length === left.length + 1)) {
				continue;
			}
			for (const item of new Set([
				...left,
				...right
			])) {
				if (count(right, item) !== count(left, item)) {
					items.add(`${field}:${item}`);
				}
			}
		}
	}
	return items;
}

const MARKED = [
	"Generated/Program",
	"Generated/SetQty",
	"Generated/Lead",
	"Generated/Last",
	"Generated/Holder"
];

/** What the rule says of one row: it resumes, or it drops with this reason. */
type IFate = "resumed" | "not-marked" | "not-idempotent" | "behind" | "off-list" | "diverged";

type IRow = IInFlightAction;

function historiesOf(point: IPoint): Map<string, ISnapshotHistory> {
	const histories =
		(
			JSON.parse(point.json) as {
				Histories?: ISnapshotHistory[];
			}
		).Histories ?? [];
	return new Map(
		histories.map((history) => [
			history.ActionId,
			history
		])
	);
}

function entriesOf(histories: Map<string, ISnapshotHistory>, row: IRow) {
	const history = histories.get(row.ActionId);
	return history !== undefined && "Entries" in history ? history : undefined;
}

function caughtOn(histories: Map<string, ISnapshotHistory>, row: IRow): string | undefined {
	const effects = entriesOf(histories, row)?.Entries.filter((entry) => entry.Kind === "effect") ?? [];
	return (
		effects[effects.length - 1]?.Descriptor as
			| {
					Type?: string;
			  }
			| undefined
	)?.Type;
}

function drifted(histories: Map<string, ISnapshotHistory>, row: IRow): boolean {
	return (
		entriesOf(histories, row)?.Entries.some(
			(entry) => entry.Kind === "step" && entry.Changes.some((change) => change.Path[change.Path.length - 1] === "Drift")
		) === true
	);
}

/** The `$Id`s from the root to an entity of this test's tree. */
function lineOf(id: string): string[] {
	if (id === "shop") {
		return [
			"shop"
		];
	}
	const order = /^(o\d)/.exec(id)?.[1];
	return order === undefined || order === id
		? [
				"shop",
				id
			]
		: [
				"shop",
				order,
				id
			];
}

function related(a: string, b: string): boolean {
	return lineOf(a).includes(b) || lineOf(b).includes(a);
}

/**
 * Each row's fate by the rule, worked out from the rows, the histories and the deliveries the
 * uninterrupted run had in flight, not by the planner: a resource's delivery stops only a queued row
 * on its own entity, holding it or in its line; a queued row is put back only behind a replayed holder
 * and rows ahead of it that came back; a regaining row drops; the holder is replayed if it can be by
 * itself; a row inside open(...) is replayed only where no holder is, first in row order.
 */
function fatesOf(point: IPoint): Map<string, IFate> {
	const rows = point.inFlight;
	const histories = historiesOf(point);
	const deliveries = noteOf(point).deliveries;
	const fates = new Map<string, IFate>();
	const own = (row: IRow): IFate | null => {
		if (row.Name === null || !MARKED.includes(row.Name)) {
			return "not-marked";
		}
		if (row.State === "stopping") {
			return "off-list";
		}
		if ((row.State === "holding" || row.State === "open") && caughtOn(histories, row) === PAY) {
			return "not-idempotent";
		}
		return null;
	};
	const onEntity = (row: IRow) => rows.filter((other) => other.EntityId === row.EntityId);
	const candidates: IRow[] = [];
	const besideHolder = new Map<IRow, IRow>();
	for (const row of rows) {
		const mine = own(row);
		if (mine !== null) {
			fates.set(row.ActionId, mine);
			continue;
		}
		if (row.State === "queued" && deliveries.some((delivery) => delivery.entityId === row.EntityId && delivery.at !== "open")) {
			fates.set(row.ActionId, "behind");
			continue;
		}
		const holding = onEntity(row).find((other) => other.State === "holding");
		if (row.State === "holding" || (row.State === "open" && (holding === undefined || own(holding) !== null))) {
			candidates.push(row);
		} else if (row.State === "open") {
			besideHolder.set(row, holding!);
		} else if (row.State !== "queued") {
			fates.set(row.ActionId, "off-list");
		}
	}
	const replayed: IRow[] = [];
	for (const row of candidates) {
		if (replayed.some((earlier) => related(earlier.EntityId, row.EntityId))) {
			fates.set(row.ActionId, "off-list");
			continue;
		}
		replayed.push(row);
		fates.set(row.ActionId, drifted(histories, row) ? "diverged" : "resumed");
	}
	for (const [row, holder] of besideHolder) {
		fates.set(row.ActionId, fates.get(holder.ActionId) === "resumed" ? "off-list" : "behind");
	}
	const byPlace = rows.filter((row) => row.State === "queued" || row.State === "regaining").sort((a, b) => (a.Place ?? 0) - (b.Place ?? 0));
	for (const row of byPlace) {
		if (fates.has(row.ActionId)) {
			continue;
		}
		const there = onEntity(row);
		const holders = there.filter((other) => other.State === "holding" || other.State === "stopping");
		const ahead = byPlace.filter((other) => other.EntityId === row.EntityId && (other.Place ?? 0) < (row.Place ?? 0));
		const back =
			holders.length > 0 &&
			[
				...holders,
				...ahead
			].every((other) => fates.get(other.ActionId) === "resumed");
		fates.set(row.ActionId, back ? "resumed" : "behind");
	}
	return fates;
}

/** For each row the rule resumes, the resources with a delivery in flight on its entity, above it or below it, as `key@ownerId`. */
function resourceWorkOf(point: IPoint, fates: Map<string, IFate>): Map<string, string[]> {
	const work = new Map<string, string[]>();
	for (const row of point.inFlight) {
		if (fates.get(row.ActionId) !== "resumed") {
			continue;
		}
		work.set(
			row.ActionId,
			[
				...new Set(
					noteOf(point)
						.deliveries.filter((delivery) => related(delivery.entityId, row.EntityId))
						.map((delivery) => `${delivery.key}@${delivery.ownerId}`)
				)
			].sort()
		);
	}
	return work;
}

/** For each row the rule resumes, the rows it drops on its entity, above it or below it, as `actionId:state@entityId`. */
function besideOf(point: IPoint, fates: Map<string, IFate>): Map<string, string[]> {
	const beside = new Map<string, string[]>();
	for (const row of point.inFlight) {
		if (fates.get(row.ActionId) !== "resumed") {
			continue;
		}
		beside.set(
			row.ActionId,
			point.inFlight
				.filter((other) => related(other.EntityId, row.EntityId) && fates.get(other.ActionId) !== "resumed")
				.map((other) => `${other.ActionId}:${other.State}@${other.EntityId}`)
				.sort()
		);
	}
	return beside;
}

/**
 * The kind of a difference's subject and the entity it is on, or null when it is on none: a path, an
 * unfinished action, a pending wait, an ask, a diag that names an entity, or a failure.
 */
function subjectOf(item: string): {
	kind: "path" | "action" | "wait" | "ask" | "diag" | "failure";
	entityId: string;
} | null {
	if (item.startsWith("state.")) {
		// A minted line's key is renamed by `paired`, so it is named by the order it is in.
		const line = /^state\.Orders\.[^.]+\.Lines\.([^.~][^.]*)\./.exec(item)?.[1];
		const order = /^state\.Orders\.([^.]+)\./.exec(item)?.[1];
		return {
			kind: "path",
			entityId: line ?? order ?? "shop"
		};
	}
	const [field, ...rest] = item.split(":");
	const body = rest.join(":");
	const at = (text: string) => (text.includes("@") ? text.slice(text.lastIndexOf("@") + 1) : null);
	switch (field) {
		case "inFlight": {
			const entityId = at(body);
			return entityId === null
				? null
				: {
						kind: "action",
						entityId
					};
		}
		case "waiting": {
			const entityId = waitOwner(body);
			return entityId === undefined
				? null
				: {
						kind: "wait",
						entityId
					};
		}
		case "asks":
			return {
				kind: "ask",
				entityId: (
					JSON.parse(body) as {
						OwnerId: string;
					}
				).OwnerId
			};
		case "diags": {
			const entityId = at(body);
			return entityId === null
				? null
				: {
						kind: "diag",
						entityId
					};
		}
		case "failures": {
			const entityId = at(body);
			return entityId === null
				? null
				: {
						kind: "failure",
						entityId
					};
		}
		default:
			return null;
	}
}

/** The order the action waiting under this name runs on, by this test's names for its waits. */
function waitOwner(name: string): string | undefined {
	if (name.startsWith("lead-")) {
		return "o3";
	}
	if (name.startsWith("last-")) {
		return "o4";
	}
	if (name.startsWith("shop-")) {
		return "shop";
	}
	return /^(o\d(?:-l\d)?)/.exec(name)?.[1];
}

/** What `note` reads from the uninterrupted runtime at a snapshot. */
interface INote {
	deliveries: IDelivery[];
	/** What each program had been given by its yields. */
	heard: Record<string, string[]>;
}

function noteOf(point: IPoint): INote {
	return point.note as INote;
}

interface IShapes {
	/** A holder whose program waits inside open(...) after the wait it holds at, with rows in its line. */
	holderOpensLater: number;
	/** A marked queued row on an entity with a delivery in its line. */
	deliveryWaiter: number;
	/** Marked rows on an entity a delivery holds. */
	deliveryHolder: number;
	/** A marked queued row on an entity with a delivery parked inside open(...). */
	queuedBesideOpenDelivery: number;
	/** A resumed row with a delivery in flight on its entity, above it or below it. */
	resumedBesideDelivery: number;
	/** A marked row inside open(...) on an entity a marked row holds. */
	openBesideMarkedHolder: number;
	/** A holder whose replay diverges, with a row that depends on it. */
	divergedHolder: number;
	/** Queued rows on two entities. */
	twoLines: number;
	/** A marked queued row, an unmarked one and a marked one, in that order on one entity. */
	unmarkedBetween: number;
	/** Two marked rows inside open(...) on an entity nothing holds. */
	twoOpen: number;
	/** Unmarked work in flight on a line, below an order a marked row is on. */
	unmarkedBelow: number;
	/** Unmarked work in flight on the root, above an order a marked row is on. */
	unmarkedAbove: number;
	/** A delivery in flight on a line, below an order a marked row is on. */
	deliveryBelow: number;
	/** A delivery in flight on the root, above an order a marked row is on. */
	deliveryAbove: number;
}

function shapesAt(point: IPoint, shapes: IShapes): void {
	const rows = point.inFlight;
	const histories = historiesOf(point);
	const marked = (row: IRow) => row.Name !== null && MARKED.includes(row.Name);
	const entities = new Set(rows.map((row) => row.EntityId));
	const lines = new Set<string>();
	const deliveries = noteOf(point).deliveries;
	for (const id of entities) {
		const there = rows.filter((row) => row.EntityId === id);
		const delivered = deliveries.filter((delivery) => delivery.entityId === id);
		const queued = there.filter((row) => row.State === "queued").sort((a, b) => (a.Place ?? 0) - (b.Place ?? 0));
		const holding = there.find((row) => row.State === "holding");
		if (queued.length > 0) {
			lines.add(id);
		}
		if (holding?.Name === "Generated/Program" && queued.length > 0) {
			const ops = (entriesOf(histories, holding)?.Args[0] ?? []) as IOp[];
			const held = ops.findIndex((op) => op.Op === "held");
			if (held >= 0 && ops.slice(held + 1).some((op) => op.Op === "open" || op.Op === "ask" || op.Op === "catch" || op.Op === "helper")) {
				shapes.holderOpensLater++;
			}
		}
		if (delivered.some((delivery) => delivery.at === "in-line") && queued.some(marked)) {
			shapes.deliveryWaiter++;
		}
		if (delivered.some((delivery) => delivery.at === "holding") && there.some(marked)) {
			shapes.deliveryHolder++;
		}
		if (delivered.some((delivery) => delivery.at === "open") && queued.some(marked)) {
			shapes.queuedBesideOpenDelivery++;
		}
		if (holding !== undefined && marked(holding) && there.some((row) => row.State === "open" && marked(row))) {
			shapes.openBesideMarkedHolder++;
		}
		if (holding !== undefined && marked(holding) && drifted(histories, holding) && there.length > 1) {
			shapes.divergedHolder++;
		}
		if (
			queued.some(
				(row, at) => at > 0 && at < queued.length - 1 && !marked(row) && marked(queued[at - 1]!) && queued.slice(at + 1).some(marked)
			)
		) {
			shapes.unmarkedBetween++;
		}
		if (holding === undefined && there.filter((row) => row.State === "open" && marked(row)).length > 1) {
			shapes.twoOpen++;
		}
	}
	if (lines.size > 1) {
		shapes.twoLines++;
	}
	const markedOn = new Set(rows.filter(marked).map((row) => row.EntityId));
	const below = (id: string) => lineOf(id).length === 3 && markedOn.has(lineOf(id)[1]!);
	const above = (id: string) =>
		id === "shop" &&
		[
			...markedOn
		].some((on) => on !== "shop");
	const unmarkedAt = rows.filter((row) => !marked(row)).map((row) => row.EntityId);
	const deliveredAt = deliveries.map((delivery) => delivery.entityId);
	shapes.unmarkedBelow += unmarkedAt.some(below) ? 1 : 0;
	shapes.unmarkedAbove += unmarkedAt.some(above) ? 1 : 0;
	shapes.deliveryBelow += deliveredAt.some(below) ? 1 : 0;
	shapes.deliveryAbove += deliveredAt.some(above) ? 1 : 0;
}

interface ITally {
	runs: number;
	points: number;
	resumed: number;
	/** The resumed rows by the state the snapshot caught them in. */
	states: Record<string, number>;
	exact: number;
	dropped: Record<string, number>;
	/** Points snapshotted again between the engine's return and the release, after a fresh dispatch, and restored from there. */
	between: number;
	/** Resumed rows whose `beside` names dropped work, the states of what it names, and the rows naming work on their entity, above it and below it. */
	beside: {
		rows: number;
		states: Record<string, number>;
		where: Record<"same" | "above" | "below", number>;
	};
	/** Resumed rows whose lineage had no drop, at points where something dropped, whose entity and those below it ended as in the uninterrupted run. */
	lineageExact: number;
	/** Resumed programs whose yields gave them, up to the cut, what the uninterrupted run's gave them. */
	prefixesHeard: number;
	/** Points with a difference waived because a resumed action's `beside` names the work that caused it. */
	waivedPoints: number;
	/** The differences waived, by kind. */
	waived: Record<string, number>;
	wrong: number;
	shapes: IShapes;
	unexpected: string[];
}

function tallyDrops(seedValue: number, point: IPoint, restored: IRestoredEnd, inPrefix: Record<string, string[]>, tally: ITally): void {
	const engine = restored.engine!;
	const snapshot = JSON.stringify(
		(
			JSON.parse(point.json) as {
				AppState: unknown;
			}
		).AppState
	);
	if (restored.treeAfterEngine !== snapshot) {
		tally.unexpected.push(`seed ${seedValue} step ${point.at}: the tree after the engine is not the snapshot's`);
	}
	const histories = historiesOf(point);
	for (const resumed of engine.resumed) {
		const history = entriesOf(histories, point.inFlight.find((row) => row.ActionId === resumed.actionId)!);
		if (resumed.name !== "Generated/Program" || history === undefined) {
			continue;
		}
		const tag = history.Args[1] as string;
		const got = inPrefix[tag] ?? [];
		const want = noteOf(point).heard[tag] ?? [];
		if (JSON.stringify(got) === JSON.stringify(want)) {
			tally.prefixesHeard++;
		} else {
			tally.unexpected.push(
				`seed ${seedValue} step ${point.at}: program ${tag} was given ${got.join(", ")} in its prefix, and ${want.join(", ")} before the cut`
			);
		}
	}
	tally.resumed += engine.resumed.length;
	shapesAt(point, tally.shapes);
	for (const { actionId } of engine.resumed) {
		const state = point.inFlight.find((row) => row.ActionId === actionId)?.State ?? "?";
		tally.states[state] = (tally.states[state] ?? 0) + 1;
	}
	for (const drop of engine.dropped) {
		const key = `${drop.reason}: ${drop.detail ?? ""}`;
		tally.dropped[key] = (tally.dropped[key] ?? 0) + 1;
	}
	const fates = fatesOf(point);
	const got = new Map<string, IFate>([
		...engine.resumed.map(
			(resumed) =>
				[
					resumed.actionId,
					"resumed"
				] as const
		),
		...engine.dropped.map(
			(drop) =>
				[
					drop.actionId,
					drop.reason as IFate
				] as const
		)
	]);
	for (const row of point.inFlight) {
		const want = fates.get(row.ActionId);
		if (got.get(row.ActionId) !== want) {
			const detail = engine.dropped.find((drop) => drop.actionId === row.ActionId)?.detail ?? "";
			tally.unexpected.push(
				`seed ${seedValue} step ${point.at}: ${row.Name} ${row.State} on ${row.EntityId} is ${got.get(row.ActionId)} (${detail}), the rule says ${want}`
			);
		}
	}
	const resourceWork = resourceWorkOf(point, fates);
	for (const resumed of engine.resumed) {
		const gotWork = resumed.resourceWork.map((work) => `${work.key}@${work.ownerId}`).sort();
		if (JSON.stringify(gotWork) !== JSON.stringify(resourceWork.get(resumed.actionId) ?? [])) {
			tally.unexpected.push(
				`seed ${seedValue} step ${point.at}: ${resumed.name} on ${resumed.entityId} names resources ${gotWork.join(", ")}, the rule says ${(resourceWork.get(resumed.actionId) ?? []).join(", ")}`
			);
		}
		if (gotWork.length > 0) {
			tally.shapes.resumedBesideDelivery++;
		}
	}
	const besides = besideOf(point, fates);
	for (const resumed of engine.resumed) {
		const gotBeside = resumed.beside.map((entry) => `${entry.actionId}:${entry.state}@${entry.entityId}`).sort();
		if (JSON.stringify(gotBeside) !== JSON.stringify(besides.get(resumed.actionId) ?? [])) {
			tally.unexpected.push(
				`seed ${seedValue} step ${point.at}: ${resumed.name} on ${resumed.entityId} has beside ${gotBeside.join(", ")}, the rule says ${(besides.get(resumed.actionId) ?? []).join(", ")}`
			);
		}
		if (resumed.beside.length > 0) {
			tally.beside.rows++;
			for (const entry of resumed.beside) {
				const state = entry.state ?? "unknown";
				tally.beside.states[state] = (tally.beside.states[state] ?? 0) + 1;
			}
			for (const where of [
				"same",
				"above",
				"below"
			] as const) {
				if (
					resumed.beside.some((entry) =>
						where === "same"
							? entry.entityId === resumed.entityId
							: where === "above"
								? entry.entityId !== resumed.entityId && lineOf(resumed.entityId).includes(entry.entityId)
								: entry.entityId !== resumed.entityId && lineOf(entry.entityId).includes(resumed.entityId)
					)
				) {
					tally.beside.where[where]++;
				}
			}
		}
	}
}

/** The resumed end equals the expected one where nothing dropped, and differs from it nowhere a data-only restore doesn't. */
async function judge(
	seedValue: number,
	point: IPoint,
	steps: readonly IScriptStep[],
	expected: IEnd,
	restored: IRestoredEnd,
	tally: ITally
): Promise<void> {
	const own = differences(expected, restored.end);
	if (restored.engine!.dropped.length === 0 && noteOf(point).deliveries.length === 0) {
		expect({
			...restored.end,
			diags: [],
			raised: []
		}).toEqual({
			...expected,
			diags: [],
			raised: []
		});
		expect([
			...own
		]).toEqual([]);
		tally.exact++;
		return;
	}
	const reported = (resumed: IResumed) => resumed.beside.length > 0 || resumed.resourceWork.length > 0;
	for (const resumed of restored.engine!.resumed) {
		if (reported(resumed)) {
			continue;
		}
		const off = [
			...own
		].filter((item) => {
			const subject = subjectOf(item);
			return subject !== null && lineOf(subject.entityId).includes(resumed.entityId);
		});
		if (off.length === 0) {
			tally.lineageExact++;
		} else {
			tally.unexpected.push(
				`seed ${seedValue} step ${point.at}: ${resumed.name} on ${resumed.entityId} had no drop in its lineage, and its entity differs by ${off.join(", ")}`
			);
		}
	}
	if (own.size === 0) {
		tally.exact++;
		return;
	}
	const dataOnly = await restoreAt(point, steps, {
		engine: false,
		setup
	});
	const theirs = differences(expected, dataOnly.end);
	const engine = restored.engine!;
	const excuses = (item: string) => {
		const subject = subjectOf(item);
		return subject === null
			? []
			: engine.resumed.filter((resumed) => reported(resumed) && lineOf(subject.entityId).includes(resumed.entityId));
	};
	const differing = [
		...own
	].filter((item) => !theirs.has(item));
	const worse = differing.filter((item) => excuses(item).length === 0);
	if (differing.length > worse.length) {
		tally.waivedPoints++;
		for (const item of differing.filter((found) => excuses(found).length > 0)) {
			const { kind } = subjectOf(item)!;
			tally.waived[kind] = (tally.waived[kind] ?? 0) + 1;
			if (host?.env?.TREFLEX_REPLAY_WAIVED) {
				host.stderr?.write(
					`[waived] seed ${seedValue} step ${point.at}: ${kind} ${item}, beside ${JSON.stringify(
						excuses(item).map((resumed) => [
							resumed.name,
							resumed.entityId,
							resumed.beside
						])
					)}\n`
				);
			}
		}
	}
	if (worse.length > 0) {
		tally.wrong++;
		tally.unexpected.push(`seed ${seedValue} step ${point.at}: worse than data-only by ${worse.join(", ")}`);
	}
}

const engineHooks = {
	before: () => {
		drifting = true;
	},
	after: () => {
		drifting = false;
	}
};

/** A delivery parked inside open(...) on the first order before its program arrives, at a quarter of the seeds. */
const PARKED = 1000;

async function check(seedValue: number, tally: ITally): Promise<void> {
	const pick = rng(seedValue);
	const feed = {
		n: 0
	};
	const a = generate(pick, "o1", "o1", feed);
	const c = pick() < 0.3 ? generate(pick, "o1", "o1b", feed) : null;
	const b = pick() < 0.5 ? generate(pick, "o2", "o2", feed) : null;
	const parkedFirst = seedValue % 4 === 0;
	const steps: IScriptStep[] = [
		(d) => {
			for (const on of [
				"o1",
				"o1-l1",
				"shop"
			]) {
				d.dispatch(openFeed, on);
			}
		},
		...(parkedFirst
			? [
					emitted(PARKED, "o1", true)
				]
			: []),
		(d) => d.dispatch(program, "o1", a.ops, "o1"),
		...(c
			? [
					(d: Parameters<IScriptStep>[0]) => d.dispatch(program, "o1", c.ops, "o1b")
				]
			: []),
		...(b
			? [
					(d: Parameters<IScriptStep>[0]) => d.dispatch(program, "o2", b.ops, "o2")
				]
			: [])
	];
	const queues = [
		[
			...a.segments
		],
		[
			...(c?.segments ?? [])
		],
		[
			...(b?.segments ?? [])
		],
		marks(pick),
		parkedFirst
			? [
					[
						banked(PARKED)
					]
				]
			: []
	];
	while (queues.some((queue) => queue.length > 0)) {
		const open = queues.filter((queue) => queue.length > 0);
		steps.push(...open[Math.floor(pick() * open.length)]!.shift()!);
	}
	heard.clear();
	merges.counting = true;
	const script = await playScript(seed(), steps, MARKED, {
		setup,
		note: (runtime): INote => ({
			deliveries: deliveriesIn(runtime),
			heard: heardSoFar()
		})
	});
	merges.counting = false;
	tally.runs++;
	for (const point of script.points) {
		tally.points++;
		const betweenToo = pick() < 0.2;
		let inPrefix: Record<string, string[]> = {};
		let deliveries: IDelivery[] = [];
		const resumed = await restoreAt(point, steps, {
			engine: true,
			setup,
			before: () => {
				engineHooks.before();
				heard.clear();
			},
			beforeRelease: (runtime: IRuntime<any>) => {
				engineHooks.after();
				inPrefix = heardSoFar();
				if (!betweenToo) {
					return false;
				}
				runtime.dispatch(setQty as never, "o1", 555).catch(() => {});
				deliveries = deliveriesIn(runtime);
				return true;
			}
		});
		tallyDrops(seedValue, point, resumed, inPrefix, tally);
		if (!betweenToo) {
			await judge(seedValue, point, steps, script.endFrom(point), resumed, tally);
			continue;
		}
		tally.between++;
		const between: IPoint = {
			...resumed.between!,
			note: {
				deliveries,
				heard: noteOf(point).heard
			} satisfies INote
		};
		const again = await restoreAt(between, steps, {
			engine: true,
			setup,
			before: () => {
				engineHooks.before();
				heard.clear();
			},
			beforeRelease: () => {
				engineHooks.after();
				inPrefix = heardSoFar();
				return false;
			}
		});
		tallyDrops(seedValue, between, again, inPrefix, tally);
		await judge(seedValue, between, steps, resumed.end, again, tally);
	}
}

describe("the comparison of two ends", () => {
	const end = (diags: string[], raised: string[] = []): IEnd => ({
		state: JSON.stringify(seed()),
		tables: "",
		cells: [],
		records: [],
		diags,
		failures: [],
		onError: [],
		inFlight: [],
		waiting: [],
		asks: [],
		raised
	});
	const HELD = "entity/written-while-held[fromShop>Generated/Program]";

	it("takes a once-per-pair diag by its pair, wherever it was reported, and locates a surplus on the entity it was reported on", () => {
		expect([
			...differences(
				end([
					`${HELD}@o1`
				]),
				end([
					`${HELD}@o2`
				])
			)
		]).toEqual([]);
		expect([
			...differences(
				end([]),
				end([
					`${HELD}@o2`
				])
			)
		]).toEqual([
			`diags:${HELD}@o2`
		]);
		expect(
			[
				...differences(
					end([
						"entity/written-while-held[fromShop>Generated/Holder]@o1"
					]),
					end([
						`${HELD}@o1`
					])
				)
			].sort()
		).toEqual([
			"diags:entity/written-while-held[fromShop>Generated/Holder]@o1",
			`diags:${HELD}@o1`
		]);
		expect([
			...differences(
				end(
					[],
					[
						HELD
					]
				),
				end([
					`${HELD}@o2`
				])
			)
		]).toEqual([]);
	});
});

describe("resume, over generated runs", () => {
	it(`ends as the uninterrupted run, or never worse than a data-only restore, over ${RUNS} runs`, async () => {
		const tally: ITally = {
			runs: 0,
			points: 0,
			resumed: 0,
			states: {},
			exact: 0,
			dropped: {},
			between: 0,
			beside: {
				rows: 0,
				states: {},
				where: {
					same: 0,
					above: 0,
					below: 0
				}
			},
			lineageExact: 0,
			prefixesHeard: 0,
			waivedPoints: 0,
			waived: {},
			wrong: 0,
			shapes: {
				holderOpensLater: 0,
				deliveryWaiter: 0,
				deliveryHolder: 0,
				queuedBesideOpenDelivery: 0,
				resumedBesideDelivery: 0,
				openBesideMarkedHolder: 0,
				divergedHolder: 0,
				twoLines: 0,
				unmarkedBetween: 0,
				twoOpen: 0,
				unmarkedBelow: 0,
				unmarkedAbove: 0,
				deliveryBelow: 0,
				deliveryAbove: 0
			},
			unexpected: []
		};
		merges.across = 0;
		const first = Number(host?.env?.TREFLEX_REPLAY_FIRST ?? 1);
		for (let at = 0; at < RUNS; at++) {
			await check(at + first, tally);
		}
		if (host?.env?.TREFLEX_REPLAY_REPORT) {
			host.stderr?.write(
				`${JSON.stringify({
					...tally,
					mergedAcross: merges.across
				})}\n`
			);
		}
		expect(tally.unexpected).toEqual([]);
		expect(merges.across).toBeGreaterThan(RUNS / 2);
		expect(tally.wrong).toBe(0);
		expect(tally.resumed).toBeGreaterThan(RUNS);
		expect(tally.between).toBeGreaterThan(0);
		expect(tally.lineageExact).toBeGreaterThan(0);
		expect(tally.prefixesHeard).toBeGreaterThan(0);
		for (const [where, count] of Object.entries(tally.beside.where)) {
			expect([
				where,
				count
			]).not.toEqual([
				where,
				0
			]);
		}
		for (const state of [
			"holding",
			"open",
			"queued"
		]) {
			expect(tally.states[state] ?? 0).toBeGreaterThan(0);
		}
		expect(tally.states.regaining).toBeUndefined();
		for (const [shape, count] of Object.entries(tally.shapes)) {
			expect([
				shape,
				count
			]).not.toEqual([
				shape,
				0
			]);
		}
	}, 600_000);
});
