import type { IActionGenerator, IOpenGenerator } from "../../src/index";
import type { IHistory, IHistoryEntry } from "../../src/Resume/history";
import type { IOrder, IShop } from "./resumeHarness";
import { describe, expect, it } from "vitest";
import { generateGuid } from "../../src/Effects/generateGuid";
import { resumable } from "../../src/Resume/resumable";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import * as reactive from "../reactive";
import { harness, shop, until, wait } from "./resumeHarness";

function* waits(_draft: IOrder, _given?: unknown): IOpenGenerator {
	yield* open(wait("waits"));
}
named(waits, "Edges/Waits");
resumable(waits);

function* writesItself(draft: IOrder): IOpenGenerator {
	yield* open(wait("first"));
	draft.Qty = 5;
	yield* open(wait("second"));
}
named(writesItself, "Edges/WritesItself");
resumable(writesItself);

function* setQty(draft: IOrder, qty: number): IActionGenerator {
	draft.Qty = qty;
}

function* shopSetsQty(draft: IShop, qty: number): IActionGenerator {
	draft.Orders.o1!.Qty = qty;
}

const others = (history: IHistory) =>
	history.Entries.filter(
		(
			entry
		): entry is Extract<
			IHistoryEntry,
			{
				Kind: "other";
			}
		> => entry.Kind === "other"
	).map((entry) => ({
		at: entry.Change.Landing!.EntityId,
		path: entry.Change.Landing!.Path.join("."),
		value: entry.Change.Value,
		deleted: entry.Change.Deleted === true
	}));

function historyIn(
	json: string,
	name: string
):
	| IHistory
	| {
			Unusable: string;
	  } {
	const envelope = JSON.parse(json);
	const row = envelope.InFlight.find((entry: { Name: string }) => entry.Name === name);
	return envelope.Histories.find((entry: { ActionId: string }) => entry.ActionId === row.ActionId);
}

function snapshotWhenQtyIs(runtime: ReturnType<typeof harness<IShop>>["runtime"], qty: number, taken: string[]) {
	return reactive.root((dispose) => {
		reactive.effect(() => {
			if (runtime.state.Orders.o1!.Qty === qty) {
				taken.push(createSnapshot(runtime));
			}
		});
		return dispose;
	});
}

describe("a snapshot taken from a reactive effect", () => {
	it("holds another writer's step that the effect saw", async () => {
		const h = harness(shop());
		void h.runtime.dispatch(waits, "o1");
		await until(() => h.waiting.length === 1);
		const taken: string[] = [];
		const dispose = snapshotWhenQtyIs(h.runtime, 5, taken);
		await h.runtime.dispatch(setQty, "o1", 5);
		expect(taken).toHaveLength(1);
		expect(JSON.parse(taken[0]!).AppState.Orders.o1.Qty).toBe(5);
		expect(others(historyIn(taken[0]!, "Edges/Waits") as IHistory)).toEqual([
			{
				at: "o1",
				path: "Qty",
				value: 5,
				deleted: false
			}
		]);
		expect(others(h.historyOf("Edges/Waits"))).toHaveLength(1);
		dispose();
		h.runtime.dispose();
	});

	it("holds the marked action's own step that the effect saw", async () => {
		const h = harness(shop());
		void h.runtime.dispatch(writesItself, "o1");
		await until(() => h.waiting.length === 1);
		const taken: string[] = [];
		const dispose = snapshotWhenQtyIs(h.runtime, 5, taken);
		h.release("first");
		await until(() => h.waiting.some((w) => w.name === "second"));
		expect(taken).toHaveLength(1);
		const history = historyIn(taken[0]!, "Edges/WritesItself") as IHistory;
		expect(history.Entries.map((entry) => entry.Kind)).toEqual([
			"effect",
			"response",
			"step"
		]);
		expect(h.historyOf("Edges/WritesItself").Entries.map((entry) => entry.Kind)).toEqual([
			"effect",
			"response",
			"step",
			"effect"
		]);
		dispose();
		h.runtime.dispose();
	});
});

describe("work a reactive effect dispatches", () => {
	it("folds after the ancestor's write that triggered it, first before to last after", async () => {
		const h = harness(shop());
		void h.runtime.dispatch(waits, "o1");
		await until(() => h.waiting.length === 1);
		const dispose = reactive.root((done) => {
			reactive.effect(() => {
				if (h.runtime.state.Orders.o1!.Qty === 7) {
					void h.runtime.dispatch(setQty, "o1", 8);
				}
			});
			return done;
		});
		await h.runtime.dispatch(shopSetsQty, "shop", 7);
		await until(() => h.runtime.state.Orders.o1!.Qty === 8);
		const [entry] = h.historyOf("Edges/Waits").Entries.filter((item) => item.Kind === "other");
		expect(entry).toMatchObject({
			Change: {
				Prev: 1,
				Value: 8
			}
		});
		expect(others(h.historyOf("Edges/Waits"))).toHaveLength(1);
		dispose();
		h.runtime.dispose();
	});

	it("doesn't keep the write that started a marked action as a change after it began", async () => {
		const h = harness(shop());
		const dispose = reactive.root((done) => {
			reactive.effect(() => {
				if (h.runtime.state.Orders.o1!.Qty === 7) {
					void h.runtime.dispatch(waits, "o1");
				}
			});
			return done;
		});
		await h.runtime.dispatch(shopSetsQty, "shop", 7);
		await until(() => h.waiting.length === 1);
		expect(others(h.historyOf("Edges/Waits"))).toEqual([]);
		dispose();
		h.runtime.dispose();
	});
});

describe("a snapshot taken during a step", () => {
	it("from step code marks every history not whole for that snapshot only", async () => {
		const taken: string[] = [];
		const h = harness(shop());
		function* snapshotsMidStep(draft: IOrder): IActionGenerator {
			draft.Qty = 7;
			taken.push(createSnapshot(h.runtime));
			draft.Key = "k";
		}
		void h.runtime.dispatch(waits, "o1");
		await until(() => h.waiting.length === 1);
		await h.runtime.dispatch(snapshotsMidStep, "o1");
		expect(taken).toHaveLength(1);
		expect(historyIn(taken[0]!, "Edges/Waits")).toMatchObject({
			Unusable: "not-whole"
		});
		expect(others(h.historyOf("Edges/Waits")).map((change) => change.path)).toEqual([
			"Qty",
			"Key"
		]);
		h.runtime.dispose();
	});

	it("from an in-step effect's implementation holds the writes before the yield, which ended a frame", async () => {
		const taken: string[] = [];
		const h = harness(shop(), {
			implementations: {
				generateGuid: () => {
					taken.push(createSnapshot(h.runtime));
					return "guid";
				}
			}
		});
		function* mints(draft: IOrder): IActionGenerator {
			draft.Qty = 7;
			draft.Key = yield* generateGuid();
		}
		void h.runtime.dispatch(waits, "o1");
		await until(() => h.waiting.length === 1);
		await h.runtime.dispatch(mints, "o1");
		expect(JSON.parse(taken[0]!).AppState.Orders.o1).toMatchObject({
			Qty: 7,
			Key: ""
		});
		expect(others(historyIn(taken[0]!, "Edges/Waits") as IHistory).map((change) => change.path)).toEqual([
			"Qty"
		]);
		h.runtime.dispose();
	});
});

describe("membership as the tree stood when a write was made", () => {
	it("keeps a write into a child the same step then deletes, and the delete, in order", async () => {
		const h = harness(shop());
		void h.runtime.dispatch(waits, "o1");
		await until(() => h.waiting.length === 1);
		function* writesThenDeletes(draft: IOrder): IActionGenerator {
			draft.Lines["o1-l1"]!.Qty = 42;
			delete draft.Lines["o1-l1"];
		}
		await h.runtime.dispatch(writesThenDeletes, "o1");
		expect(others(h.historyOf("Edges/Waits"))).toEqual([
			{
				at: "o1-l1",
				path: "Qty",
				value: 42,
				deleted: false
			},
			{
				at: "o1",
				path: "Lines.o1-l1",
				value: undefined,
				deleted: true
			}
		]);
		h.runtime.dispose();
	});

	it("keeps a write into a child the same step then moves out", async () => {
		const h = harness(shop());
		void h.runtime.dispatch(waits, "o1");
		await until(() => h.waiting.length === 1);
		function* writesThenMovesOut(draft: IShop): IActionGenerator {
			const line = draft.Orders.o1!.Lines["o1-l1"]!;
			line.Qty = 42;
			draft.Orders.o2!.Lines["o1-l1"] = line;
			delete draft.Orders.o1!.Lines["o1-l1"];
		}
		await h.runtime.dispatch(writesThenMovesOut, "shop");
		expect(h.runtime.state.Orders.o2!.Lines["o1-l1"]!.Qty).toBe(42);
		expect(others(h.historyOf("Edges/Waits"))).toEqual([
			{
				at: "o1-l1",
				path: "Qty",
				value: 42,
				deleted: false
			},
			{
				at: "o1",
				path: "Lines.o1-l1",
				value: undefined,
				deleted: true
			}
		]);
		h.runtime.dispose();
	});

	it("keeps the arrival but not a write made outside before the same step moved the node in", async () => {
		const h = harness(shop());
		void h.runtime.dispatch(waits, "o1");
		await until(() => h.waiting.length === 1);
		function* writesThenMovesIn(draft: IShop): IActionGenerator {
			const line = draft.Orders.o2!.Lines["o2-l1"]!;
			line.Qty = 42;
			draft.Orders.o1!.Lines["o2-l1"] = line;
			delete draft.Orders.o2!.Lines["o2-l1"];
		}
		await h.runtime.dispatch(writesThenMovesIn, "shop");
		expect(h.runtime.state.Orders.o1!.Lines["o2-l1"]!.Qty).toBe(42);
		expect(others(h.historyOf("Edges/Waits"))).toEqual([
			{
				at: "o1",
				path: "Lines.o2-l1",
				value: {
					$Id: "o2-l1",
					Qty: 42
				},
				deleted: false
			}
		]);
		h.runtime.dispose();
	});
});

describe("a history nested too deep", () => {
	it("is left out and marked, and the snapshot is still written", async () => {
		let deep: Record<string, unknown> = {};
		for (let level = 0; level < 1000; level++) {
			deep = {
				In: deep
			};
		}
		const h = harness(shop());
		void h.runtime.dispatch(waits, "o1", deep);
		await until(() => h.waiting.length === 1);
		for (let round = 0; round < 2; round++) {
			const envelope = h.envelope();
			expect(envelope.Histories).toEqual([
				{
					ActionId: envelope.InFlight[0]!.ActionId,
					Unusable: "too-deep",
					Unlisted: "none",
					UnlistedLineage: [],
					Deliveries: []
				}
			]);
		}
		h.runtime.dispose();
		const off = harness(shop(), {
			resume: false
		});
		void off.runtime.dispatch(waits, "o1", deep);
		await until(() => off.waiting.length === 1);
		expect(off.envelope().Histories).toBeUndefined();
		off.runtime.dispose();
	});
});
