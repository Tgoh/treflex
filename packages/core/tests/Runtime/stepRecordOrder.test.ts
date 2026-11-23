import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator, IActionYield } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import { describe, expect, it, onTestFinished } from "vitest";
import { generateGuid } from "../../src/Effects/generateGuid";
import { parallel } from "../../src/Effects/parallel";
import { latest } from "../../src/Runtime/arrivalPolicy";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import * as reactive from "../reactive";

interface IOrder {
	$Id: string;
	Qty: number;
	Note: string;
}

interface IShop {
	$Id: string;
	Orders: Record<string, IOrder>;
}

function world(options: { tap?: boolean } = {}) {
	const gates: (() => void)[] = [];
	const runtime = createRuntime<IShop>(
		{
			$Id: "shop",
			Orders: {
				o1: {
					$Id: "o1",
					Qty: 1,
					Note: ""
				},
				o2: {
					$Id: "o2",
					Qty: 1,
					Note: ""
				}
			}
		},
		{
			onError: () => {},
			implementations: {
				gate: () =>
					new Promise<void>((resolve) => {
						gates.push(resolve);
					})
			}
		}
	) as IRuntimeInternal<IShop>;
	const log: string[] = [];
	const records: IRecord[] = [];
	const labels = new Map<string, string>();
	const label = (record: IRecord) => ("ActionId" in record ? (labels.get(record.ActionId) ?? "?") : "?");
	if (options.tap !== false) {
		runtime.on("record", (record) => {
			records.push(record);
			if (record.Kind === "action:start") {
				labels.set(record.ActionId, record.Label ?? "?");
			}
			if (record.Kind === "step") {
				log.push(
					`step ${label(record)} ${record.Changes.map((change) => `${change.Path.join(".")} ${String(change.Prev)}>${String(change.Value)}`).join(", ")}`
				);
			}
		});
	}
	onTestFinished(() => runtime.dispose());
	return {
		runtime,
		log,
		records,
		label,
		gated: () => gates.length,
		release: () => gates.shift()?.(),
		effect(fn: () => void) {
			const dispose = reactive.root((done) => {
				reactive.effect(fn);
				return done;
			});
			onTestFinished(dispose);
		}
	};
}

const gate = {
	Type: "gate"
} as IActionYield;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function* setQty(draft: IOrder, qty: number): IActionGenerator {
	draft.Qty = qty;
}

function* setNote(draft: IOrder, note: string): IActionGenerator {
	draft.Note = note;
}

function* shopSetsQty(draft: IShop, qty: number): IActionGenerator {
	draft.Orders.o1!.Qty = qty;
}

const steps = (records: IRecord[]) =>
	records.filter(
		(
			record
		): record is Extract<
			IRecord,
			{
				Kind: "step";
			}
		> => record.Kind === "step"
	);

describe("a step's record", () => {
	it("reaches a tap before the reactive effect its write triggers, so the work that effect dispatches is heard after it", async () => {
		const w = world();
		w.effect(() => {
			if (w.runtime.state.Orders.o1!.Qty === 7) {
				w.log.push("effect");
				void w.runtime.dispatch(setQty, "o1", 8);
			}
		});
		await w.runtime.dispatch(shopSetsQty, "shop", 7);
		await settle();
		expect(w.log).toEqual([
			"step shopSetsQty Orders.o1.Qty 1>7",
			"effect",
			"step setQty Qty 7>8"
		]);
		const replayed = steps(w.records).reduce(
			(qty, record) => record.Changes.reduce((q, change) => (change.Path.at(-1) === "Qty" ? (change.Value as number) : q), qty),
			1
		);
		expect(replayed).toBe(8);
		expect(w.runtime.state.Orders.o1!.Qty).toBe(8);
	});

	it("reaches a tap before the start of work an effect queues on the entity the stepping action holds", async () => {
		const w = world();
		function* holds(draft: IOrder): IActionGenerator {
			draft.Qty = 7;
			yield gate;
		}
		w.effect(() => {
			if (w.runtime.state.Orders.o1!.Qty === 7) {
				void w.runtime.dispatch(setNote, "o1", "fx");
			}
		});
		void w.runtime.dispatch(holds, "o1");
		await settle();
		expect(w.gated()).toBe(1);
		w.release();
		await settle();
		expect(w.records.map((record) => `${record.Kind} ${w.label(record)}`)).toEqual([
			"action:start holds",
			"step holds",
			"action:start setNote",
			"effect holds",
			"response ?",
			"step setNote",
			"action:end holds",
			"action:end setNote"
		]);
		expect(w.runtime.state.Orders.o1!.Note).toBe("fx");
	});

	it("keeps Seq contiguous in arrival order and every other record where it was", async () => {
		const w = world();
		w.effect(() => {
			if (w.runtime.state.Orders.o1!.Qty === 7) {
				void w.runtime.dispatch(setQty, "o1", 8);
			}
		});
		await w.runtime.dispatch(shopSetsQty, "shop", 7);
		await settle();
		expect(w.records.map((record) => record.Seq)).toEqual(w.records.map((_, i) => w.records[0]!.Seq + i));
		expect(w.records.map((record) => `${record.Kind} ${w.label(record)}`)).toEqual([
			"action:start shopSetsQty",
			"step shopSetsQty",
			"action:start setQty",
			"step setQty",
			"action:end setQty",
			"action:end shopSetsQty"
		]);
	});

	it("is heard by a listener that runs before the step's effects, and a snapshot it takes holds the tree after that step alone", async () => {
		const w = world();
		const seen: unknown[] = [];
		w.runtime.on("record", (record) => {
			if (record.Kind === "step" && w.label(record) === "shopSetsQty") {
				w.log.push("listener");
				const envelope = JSON.parse(createSnapshot(w.runtime));
				seen.push([
					envelope.AppState.Orders.o1.Qty,
					envelope.AppState.Orders.o2.Note
				]);
			}
		});
		w.effect(() => {
			if (w.runtime.state.Orders.o1!.Qty === 7) {
				w.log.push("effect");
				void w.runtime.dispatch(setNote, "o2", "fx");
			}
		});
		await w.runtime.dispatch(shopSetsQty, "shop", 7);
		await settle();
		expect(w.log).toEqual([
			"step shopSetsQty Orders.o1.Qty 1>7",
			"listener",
			"effect",
			"step setNote Note >fx"
		]);
		expect(seen).toEqual([
			[
				7,
				""
			]
		]);
		expect(w.runtime.state.Orders.o2!.Note).toBe("fx");
	});

	it("is delivered before a reactive effect can snapshot the write", async () => {
		const w = world();
		let heard = 1;
		w.runtime.on("record", (record) => {
			if (record.Kind === "step") {
				for (const change of record.Changes) {
					if (change.Path.at(-1) === "Qty" && change.Path.at(-2) !== "o2") {
						heard = change.Value as number;
					}
				}
			}
		});
		const taken: [
			number,
			number
		][] = [];
		w.effect(() => {
			const qty = w.runtime.state.Orders.o1!.Qty;
			const envelope = JSON.parse(createSnapshot(w.runtime));
			taken.push([
				envelope.AppState.Orders.o1.Qty,
				heard
			]);
			if (qty === 7) {
				void w.runtime.dispatch(setQty, "o1", 8);
			}
		});
		await w.runtime.dispatch(shopSetsQty, "shop", 7);
		await settle();
		expect(taken).toEqual([
			[
				1,
				1
			],
			[
				7,
				7
			],
			[
				8,
				8
			]
		]);
	});

	it("lets a listener's dispatch start before the effects, queues one on the held entity, and lands the effect's write last", async () => {
		const w = world();
		function* holder(draft: IOrder): IActionGenerator {
			draft.Qty = 7;
			yield gate;
			draft.Qty = 9;
		}
		function* tapped(draft: IOrder, mark: string): IActionGenerator {
			draft.Note = `${draft.Note}+${mark}`;
		}
		let fired = false;
		w.runtime.on("record", (record) => {
			if (record.Kind === "action:start") {
				w.log.push(`start ${record.Label}`);
			} else if (record.Kind === "action:end") {
				w.log.push(`end ${w.label(record)}`);
			}
			if (record.Kind === "step" && w.label(record) === "holder" && !fired) {
				fired = true;
				w.log.push("listener dispatches");
				void w.runtime.dispatch(tapped, "o2", "o2");
				void w.runtime.dispatch(tapped, "o1", "o1");
				w.log.push("listener returns");
			}
		});
		w.effect(() => {
			if (w.runtime.state.Orders.o1!.Qty === 7) {
				w.log.push("effect");
				void w.runtime.dispatch(setNote, "o2", "fx");
			}
		});
		void w.runtime.dispatch(holder, "o1");
		await settle();
		expect(w.gated()).toBe(1);
		w.log.push("holder parked");
		w.release();
		await settle();
		expect(w.log).toEqual([
			"start holder",
			"step holder Qty 1>7",
			"listener dispatches",
			"start tapped",
			"step tapped Note >+o2",
			"start tapped",
			"listener returns",
			"effect",
			"start setNote",
			"step setNote Note +o2>fx",
			"end tapped",
			"end setNote",
			"holder parked",
			"step holder Qty 7>9",
			"step tapped Note >+o1",
			"end holder",
			"end tapped"
		]);
		expect(w.runtime.state.Orders.o2!.Note).toBe("fx");
		expect(w.runtime.state.Orders.o1!.Note).toBe("+o1");
	});

	it("lets a listener's signal writes join the step's batch, read back at once and flushed with the step's effects", async () => {
		const w = world();
		const [count, setCount] = reactive.signal(0);
		const doubled = reactive.root(() => reactive.memo(() => count() * 2));
		w.runtime.on("record", (record) => {
			if (record.Kind === "step" && w.label(record) === "shopSetsQty") {
				setCount(1);
				w.log.push(`listener reads ${count()} and ${doubled()}`);
			}
		});
		w.effect(() => {
			if (count() === 1) {
				w.log.push("signal effect");
			}
		});
		w.effect(() => {
			if (w.runtime.state.Orders.o1!.Qty === 7) {
				w.log.push("qty effect");
			}
		});
		await w.runtime.dispatch(shopSetsQty, "shop", 7);
		expect(w.log).toEqual([
			"step shopSetsQty Orders.o1.Qty 1>7",
			"listener reads 1 and 2",
			"qty effect",
			"signal effect"
		]);
	});

	it("on a close lands before the effects the close's writes trigger", async () => {
		const w = world();
		const replaced = latest(function* parks(draft: IShop, n: number): IActionGenerator {
			if (n > 1) {
				return;
			}
			try {
				yield gate;
			} finally {
				draft.Orders.o1!.Qty = 7;
			}
		});
		w.effect(() => {
			if (w.runtime.state.Orders.o1!.Qty === 7) {
				w.log.push("effect");
				void w.runtime.dispatch(setQty, "o1", 8);
			}
		});
		void w.runtime.dispatch(replaced, "shop", 1);
		await settle();
		expect(w.gated()).toBe(1);
		await w.runtime.dispatch(replaced, "shop", 2);
		await settle();
		expect(w.log).toEqual([
			"step parks Orders.o1.Qty 1>7",
			"effect",
			"step setQty Qty 7>8"
		]);
		expect(steps(w.records)[0]!.Cancelling).toBe(true);
		expect(w.runtime.state.Orders.o1!.Qty).toBe(8);
	});

	it("of a step the tree rule refuses is not made, and the slice the refusal is thrown into lands before its effects", async () => {
		const w = world();
		let refused: unknown;
		function* aliases(draft: IShop): IActionGenerator {
			try {
				(draft as any).Copy = {
					Same: draft.Orders.o2
				};
				yield gate;
			} catch (error) {
				refused = error;
				draft.Orders.o1!.Qty = 7;
			}
		}
		w.effect(() => {
			if (w.runtime.state.Orders.o1!.Qty === 7) {
				w.log.push("effect");
				void w.runtime.dispatch(setQty, "o1", 8);
			}
		});
		await w.runtime.dispatch(aliases, "shop");
		await settle();
		expect((refused as Error).name).toBe("StateAliasError");
		expect(w.log).toEqual([
			"step aliases Orders.o1.Qty 1>7",
			"effect",
			"step setQty Qty 7>8"
		]);
		expect(w.gated()).toBe(0);
	});

	it("splits around an in-step effect, each part landing before the effects its writes trigger", async () => {
		const w = world();
		function* mints(draft: IShop): IActionGenerator {
			draft.Orders.o1!.Qty = 7;
			const guid = yield* generateGuid();
			draft.Orders.o2!.Note = typeof guid;
		}
		w.effect(() => {
			if (w.runtime.state.Orders.o1!.Qty === 7) {
				w.log.push("qty effect");
			}
		});
		w.effect(() => {
			if (w.runtime.state.Orders.o2!.Note === "string") {
				w.log.push("note effect");
			}
		});
		await w.runtime.dispatch(mints, "shop");
		expect(w.log).toEqual([
			"step mints Orders.o1.Qty 1>7",
			"qty effect",
			"step mints Orders.o2.Note >string",
			"note effect"
		]);
	});

	it("of a step that dispatches lands before the step's effects, and the dispatched work starts after them", async () => {
		const w = world();
		function* dispatches(draft: IShop): IActionGenerator {
			draft.Orders.o1!.Qty = 7;
			void w.runtime.dispatch(setNote, "o2", "nested");
		}
		w.effect(() => {
			if (w.runtime.state.Orders.o1!.Qty === 7) {
				w.log.push("effect");
				void w.runtime.dispatch(setQty, "o1", 8);
			}
		});
		await w.runtime.dispatch(dispatches, "shop");
		await settle();
		expect(w.log).toEqual([
			"step dispatches Orders.o1.Qty 1>7",
			"effect",
			"step setQty Qty 7>8",
			"step setNote Note >nested"
		]);
	});

	it("of a fan-out branch's step lands before the effects its writes trigger", async () => {
		const w = world();
		function* leg(draft: IShop, qty: number): IActionGenerator {
			draft.Orders.o1!.Qty = qty;
		}
		function* fans(draft: IShop): IActionGenerator {
			yield* parallel(leg(draft, 7));
		}
		w.effect(() => {
			if (w.runtime.state.Orders.o1!.Qty === 7) {
				w.log.push("effect");
				void w.runtime.dispatch(setQty, "o1", 8);
			}
		});
		await w.runtime.dispatch(fans, "shop");
		await settle();
		const branchStep = steps(w.records)[0]!;
		expect(branchStep.BranchId).not.toBe(w.records.find((record) => record.Kind === "action:start")!.ActionId);
		expect(w.log).toEqual([
			"step fans Orders.o1.Qty 1>7",
			"effect",
			"step setQty Qty 7>8"
		]);
	});

	it("is not made with no tap, and the effects run as before", async () => {
		const w = world({
			tap: false
		});
		const journal = w.runtime.get("runtime/journal");
		expect(journal.enabled).toBe(false);
		w.effect(() => {
			if (w.runtime.state.Orders.o1!.Qty === 7) {
				w.log.push("effect");
				void w.runtime.dispatch(setQty, "o1", 8);
			}
		});
		await w.runtime.dispatch(shopSetsQty, "shop", 7);
		await settle();
		expect(w.log).toEqual([
			"effect"
		]);
		expect(w.runtime.state.Orders.o1!.Qty).toBe(8);
		const seqs: number[] = [];
		w.runtime.on("record", (record) => {
			seqs.push(record.Seq);
		});
		await w.runtime.dispatch(setQty, "o1", 9);
		expect(seqs).toEqual([
			1,
			2,
			3
		]);
	});
});
