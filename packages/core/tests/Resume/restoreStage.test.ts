import type { IActionGenerator, IEffect, IEntity, IOpenGenerator, IRecord, IRuntime, IRuntimeEventOf } from "../../src/index";
import type { IRestoreOutcome, IRestoreResult } from "../../src/Snapshot/index";
import { describe, expect, it, vi } from "vitest";
import {
	bind,
	createTestRuntime,
	defineEffect,
	entity,
	getDataGlobal,
	guids,
	latest,
	leading,
	named,
	open,
	publish,
	receiver,
	resumable,
	select,
	settled,
	start,
	startTimer,
	transient,
	UnreleasedResumeError
} from "../../src/index";
import { createSnapshot, restoreRuntime, restoreTestRuntime } from "../../src/Snapshot/index";
import { drainReports } from "../../src/Testing/reports";
import * as reactive from "../reactive";

const planned = vi.hoisted(() => ({
	calls: 0
}));

vi.mock(import("../../src/Resume/plan"), async (importOriginal) => {
	const original = await importOriginal();
	return {
		...original,
		planResume: (...args: Parameters<typeof original.planResume>) => {
			planned.calls++;
			return original.planResume(...args);
		}
	};
});

interface ILine extends IEntity {
	Qty: number;
}

interface IOrder extends IEntity {
	Qty: number;
	Note: string;
	Total: number;
	Paid: boolean;
	Log: string[];
	Lines: Record<string, ILine>;
}

interface IShop extends IEntity {
	Orders: Record<string, IOrder>;
}

const order = (id: string): IOrder => ({
	$Id: id,
	Qty: 1,
	Note: "",
	Total: 0,
	Paid: false,
	Log: [],
	Lines: {
		[`${id}-l1`]: {
			$Id: `${id}-l1`,
			Qty: 1
		}
	}
});

const seed = (): IShop => ({
	$Id: "shop",
	Orders: {
		o1: order("o1"),
		o2: order("o2")
	}
});

interface IAskEffect extends IEffect {
	Type: "RestoreStage/Ask";
	Name: string;
}

interface IPayEffect extends IEffect {
	Type: "RestoreStage/Pay";
	Total: number;
}

const askFor = defineEffect<IAskEffect, string>("RestoreStage/Ask", {
	idempotent: true
});

const pay = defineEffect<IPayEffect, string>("RestoreStage/Pay");

function* checkout(draft: IOrder): IOpenGenerator {
	draft.Qty += 1;
	const size = yield* open(
		askFor({
			Name: "size"
		})
	);
	const colour = yield* open(
		askFor({
			Name: "colour"
		})
	);
	draft.Note = `${size}/${colour}`;
	draft.Log.push(
		`confirming ${yield* askFor({
			Name: "confirm"
		})}`
	);
	draft.Total = draft.Qty * 10;
	draft.Paid =
		(yield* pay({
			Total: draft.Total
		})) === "ok";
	draft.Log.push("checked out");
}
named(checkout, "RestoreStage/Checkout");
resumable(checkout);

function* noteIt(draft: IOrder, note: string): IActionGenerator {
	draft.Log.push(note);
}
named(noteIt, "RestoreStage/NoteIt");
resumable(noteIt);

function* jot(draft: IOrder, note: string): IActionGenerator {
	draft.Log.push(note);
}
named(jot, "RestoreStage/Jot");

function* browse(_draft: IOrder): IOpenGenerator {
	yield* open(
		askFor({
			Name: "browse"
		})
	);
}
named(browse, "RestoreStage/Browse");

function* starts(_draft: IShop, on: string, note: string): IActionGenerator {
	yield* start(jot, on, note);
}
named(starts, "RestoreStage/Starts");

function* argued(draft: IOrder, _first: unknown, second: string): IOpenGenerator {
	draft.Note = second;
	yield* open(
		askFor({
			Name: "argued"
		})
	);
}
named(argued, "RestoreStage/Argued");
resumable(argued);

let drift = 0;

function* drifts(draft: IOrder): IOpenGenerator {
	draft.Note = `n${drift++}`;
	yield* open(
		askFor({
			Name: "drift"
		})
	);
}
named(drifts, "RestoreStage/Drifts");
resumable(drifts);

function* startsFirst(draft: IOrder): IOpenGenerator {
	yield* start(jot, draft, "started");
	yield* open(
		askFor({
			Name: "after start"
		})
	);
}
named(startsFirst, "RestoreStage/StartsFirst");
resumable(startsFirst);

function* twoWaits(draft: IOrder): IOpenGenerator {
	draft.Qty += 1;
	yield* open(
		askFor({
			Name: "one"
		})
	);
	draft.Note = "one";
	yield* open(
		askFor({
			Name: "two"
		})
	);
	draft.Note = "two";
}
named(twoWaits, "RestoreStage/TwoWaits");
resumable(twoWaits);

function* moveLine(draft: IShop, from: string, to: string, id: string): IActionGenerator {
	const line = draft.Orders[from]!.Lines[id]!;
	delete draft.Orders[from]!.Lines[id];
	draft.Orders[to]!.Lines[id] = line;
}
named(moveLine, "RestoreStage/MoveLine");

function* leadAsk(draft: IOrder): IOpenGenerator {
	draft.Note = yield* open(
		askFor({
			Name: "lead"
		})
	);
}
named(leadAsk, "RestoreStage/LeadAsk");
leading(leadAsk);
resumable(leadAsk);

function* lastAsk(draft: IOrder): IOpenGenerator {
	draft.Note = yield* open(
		askFor({
			Name: "last"
		})
	);
}
named(lastAsk, "RestoreStage/LastAsk");
latest(lastAsk);
resumable(lastAsk);

const startRefusals: unknown[] = [];

function starterOf(action: (draft: IOrder) => IOpenGenerator, name: string) {
	function* startsIt(_draft: IShop, on: string): IActionGenerator {
		try {
			yield* start(action, on);
		} catch (error) {
			startRefusals.push(error);
		}
	}
	named(startsIt, name);
	return startsIt;
}

const startsCheckout = starterOf(checkout, "RestoreStage/StartsCheckout");
const startsLeadAsk = starterOf(leadAsk, "RestoreStage/StartsLeadAsk");
const startsLastAsk = starterOf(lastAsk, "RestoreStage/StartsLastAsk");

function* startsNoteIt(_draft: IShop, on: string): IActionGenerator {
	try {
		yield* start(noteIt, on, "again");
	} catch (error) {
		startRefusals.push(error);
	}
}
named(startsNoteIt, "RestoreStage/StartsNoteIt");

function* selects(draft: IOrder): IOpenGenerator {
	draft.Qty = yield* select(function* (order: IOrder) {
		return order.Qty + 1;
	});
	yield* open(
		askFor({
			Name: "after select"
		})
	);
}
named(selects, "RestoreStage/Selects");
resumable(selects);

function* readsGlobal(draft: IOrder): IOpenGenerator {
	draft.Note = String(yield* getDataGlobal("RestoreStage/Nothing" as never));
	yield* open(
		askFor({
			Name: "after getDataGlobal"
		})
	);
}
named(readsGlobal, "RestoreStage/ReadsGlobal");
resumable(readsGlobal);

function* readsTransient(draft: IOrder): IOpenGenerator {
	const scratch = yield* transient(draft, "RestoreStage/Scratch", {
		N: 1
	});
	draft.Qty = scratch.N;
	yield* open(
		askFor({
			Name: "after transient"
		})
	);
}
named(readsTransient, "RestoreStage/ReadsTransient");
resumable(readsTransient);

let dispatchingOn: IRuntime<IShop> | undefined;

function* dispatchesFromStep(draft: IOrder): IOpenGenerator {
	draft.Qty += 1;
	void dispatchingOn!.dispatch(jot, "o2", "from step code");
	yield* open(
		askFor({
			Name: "after dispatch"
		})
	);
}
named(dispatchesFromStep, "RestoreStage/DispatchesFromStep");
resumable(dispatchesFromStep);

let keptLine: ILine | undefined;
let keptCopy: ILine | undefined;

function* mintLine(draft: IShop): IActionGenerator {
	draft.Orders.o1!.Lines.minted = yield* entity<ILine>({
		Qty: 5
	});
}
named(mintLine, "RestoreStage/MintLine");

function* deleteLine(draft: IShop, key: string): IActionGenerator {
	keptLine = draft.Orders.o1!.Lines[key];
	keptCopy = JSON.parse(JSON.stringify(keptLine)) as ILine;
	delete draft.Orders.o1!.Lines[key];
}
named(deleteLine, "RestoreStage/DeleteLine");

function* putBackKept(draft: IShop, key: string, by: "node" | "copy"): IActionGenerator {
	draft.Orders.o1!.Lines[key] = by === "node" ? keptLine! : keptCopy!;
}
named(putBackKept, "RestoreStage/PutBackKept");

function* parkFirst(draft: IOrder): IOpenGenerator {
	draft.Qty += 1;
	draft.Note = yield* open(
		askFor({
			Name: "a"
		})
	);
}
named(parkFirst, "RestoreStage/ParkFirst");
resumable(parkFirst);

function* parkReading(draft: IOrder): IOpenGenerator {
	const before = draft.Qty;
	draft.Note = `saw ${before}`;
	const got = yield* open(
		askFor({
			Name: "b"
		})
	);
	draft.Log.push(`${got} after ${before}`);
}
named(parkReading, "RestoreStage/ParkReading");
resumable(parkReading);

function* parkConstant(draft: IOrder): IOpenGenerator {
	const before = draft.Qty;
	draft.Note = "c";
	const got = yield* open(
		askFor({
			Name: "c"
		})
	);
	draft.Log.push(`${got} after ${before}`);
}
named(parkConstant, "RestoreStage/ParkConstant");
resumable(parkConstant);

function* bumpHundred(draft: IOrder): IActionGenerator {
	draft.Qty += 100;
}
named(bumpHundred, "RestoreStage/BumpHundred");

function* setLine(draft: ILine, qty: number): IActionGenerator {
	draft.Qty = qty;
}
named(setLine, "RestoreStage/SetLine");

function* quietly(draft: IOrder): IOpenGenerator {
	yield* open(
		askFor({
			Name: "quiet"
		})
	);
	draft.Note = "quiet";
	yield* askFor({
		Name: "quiet held"
	});
}
named(quietly, "RestoreStage/Quietly");
resumable(quietly);

function* guarded(draft: ILine): IActionGenerator {
	try {
		yield* askFor({
			Name: "guard"
		});
	} finally {
		draft.Qty = 0;
	}
}
named(guarded, "RestoreStage/Guarded");
resumable(guarded);

function* bumpQty(draft: IOrder): IActionGenerator {
	draft.Qty += 1;
}
named(bumpQty, "RestoreStage/BumpQty");

function* removeOrder(draft: IShop, id: string): IActionGenerator {
	delete draft.Orders[id];
}
named(removeOrder, "RestoreStage/RemoveOrder");

function* startsTheStarter(_draft: IShop, on: string): IActionGenerator {
	yield* start(startsCheckout, "shop", on);
}
named(startsTheStarter, "RestoreStage/StartsTheStarter");

declare module "../../src/Registries/ITimerRegistry" {
	interface ITimerRegistry {
		"RestoreStage/Tick": {};
	}
}

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"RestoreStage/Poke": {};
	}
}

const Pokes = receiver<IOrder>("RestoreStage/Pokes")({
	*"RestoreStage/Tick"(draft) {
		draft.Log.push("tick");
	},
	*"RestoreStage/Poke"(draft) {
		draft.Log.push("poked");
	}
});

function* wire(draft: IOrder): IActionGenerator {
	bind(draft, Pokes);
	yield* startTimer(draft, "RestoreStage/Tick", Pokes, 100);
}
named(wire, "RestoreStage/Wire");

function* poke(_draft: IShop): IActionGenerator {
	yield* publish("RestoreStage/Poke");
}
named(poke, "RestoreStage/Poke");

const BUILD = "build-1";

interface IWaits {
	readonly pending: {
		type: string;
		name: string;
		resolve: (value: string) => void;
	}[];
	readonly sent: string[];
	answer(name: string, value: string): void;
	has(name: string): boolean;
}

function waits(): IWaits {
	const pending: IWaits["pending"] = [];
	const sent: string[] = [];
	return {
		pending,
		sent,
		answer(name, value) {
			const at = pending.findIndex((wait) => wait.name === name);
			if (at < 0) {
				throw new Error(`nothing waits on ${name}: ${pending.map((wait) => wait.name).join(", ")}`);
			}
			pending.splice(at, 1)[0]!.resolve(value);
		},
		has: (name) => pending.some((wait) => wait.name === name)
	};
}

function stubsOf(w: IWaits) {
	const wait = (type: string, name: string) => {
		w.sent.push(name);
		return new Promise<string>((resolve) => {
			w.pending.push({
				type,
				name,
				resolve
			});
		});
	};
	return {
		"RestoreStage/Ask": (effect: IAskEffect) => wait(effect.Type, effect.Name),
		"RestoreStage/Pay": (effect: IPayEffect) => wait(effect.Type, "pay")
	};
}

async function until(predicate: () => boolean): Promise<void> {
	for (let turn = 0; turn < 50; turn++) {
		if (predicate()) {
			return;
		}
		await settled();
	}
	throw new Error("timed out");
}

interface ILive {
	runtime: IRuntime<IShop>;
	w: IWaits;
}

function live(options: Parameters<typeof createTestRuntime>[2] = {}): ILive {
	const w = waits();
	return {
		runtime: createTestRuntime<IShop>(seed(), stubsOf(w), {
			build: BUILD,
			resume: true,
			...options
		}),
		w
	};
}

/** A save with `checkout` on o1 answered at "size" and waiting inside `open` at "colour". */
async function atColour(): Promise<string> {
	const { runtime, w } = live();
	void runtime.dispatch(checkout, "o1");
	await until(() => w.has("size"));
	w.answer("size", "M");
	await until(() => w.has("colour"));
	const json = createSnapshot(runtime);
	runtime.dispose();
	return json;
}

/** A save with `checkout` on o1 holding it at "confirm". */
async function atConfirm(): Promise<string> {
	const { runtime, w } = live();
	void runtime.dispatch(checkout, "o1");
	await until(() => w.has("size"));
	w.answer("size", "M");
	await until(() => w.has("colour"));
	w.answer("colour", "red");
	await until(() => w.has("confirm"));
	const json = createSnapshot(runtime);
	runtime.dispose();
	return json;
}

/** A save with `checkout` holding o1 at "confirm" and `noteIt` queued behind it. */
async function queuedBehindConfirm(): Promise<string> {
	const { runtime, w } = live();
	void runtime.dispatch(checkout, "o1");
	for (const step of [
		"size",
		"colour"
	]) {
		await until(() => w.has(step));
		w.answer(step, "x");
	}
	await until(() => w.has("confirm"));
	void runtime.dispatch(noteIt, "o1", "queued");
	const json = createSnapshot(runtime);
	runtime.dispose();
	return json;
}

interface IRestored {
	runtime: IRuntime<IShop>;
	result: IRestoreOutcome;
	w: IWaits;
	diags: IRuntimeEventOf<"diag">[];
	starts: Extract<
		IRecord,
		{
			Kind: "action:start";
		}
	>[];
}

async function restored(
	json: string,
	given: {
		resume?: boolean;
		build?: string;
		repair?: (runtime: IRuntime<IShop>, result: IRestoreResult) => unknown;
		setup?: (runtime: IRuntime<IShop>) => void;
		allowDiags?: string[];
	} = {}
): Promise<IRestored> {
	const w = waits();
	const diags: IRuntimeEventOf<"diag">[] = [];
	const starts: IRestored["starts"] = [];
	const { runtime, result } = await restoreTestRuntime<IShop>(json, {
		rootId: "shop",
		effectStubs: stubsOf(w),
		options: {
			build: given.build ?? BUILD,
			...(given.allowDiags === undefined
				? {}
				: {
						allowDiags: given.allowDiags
					}),
			...(given.resume === false
				? {}
				: {
						resume: true
					})
		},
		setup: (fresh) => {
			fresh.on("diag", (event) => {
				diags.push(event);
			});
			fresh.on(
				"record",
				(record) => {
					starts.push(record);
				},
				{
					kinds: [
						"action:start"
					]
				}
			);
			given.setup?.(fresh);
		},
		...(given.repair
			? {
					repair: given.repair
				}
			: {})
	});
	return {
		runtime,
		result,
		w,
		diags,
		starts
	};
}

function rowOf(
	json: string,
	name: string
): {
	ActionId: string;
} {
	return (
		JSON.parse(json) as {
			InFlight: {
				ActionId: string;
				Name: string | null;
			}[];
		}
	).InFlight.find((row) => row.Name === name)!;
}

function edited(json: string, edit: (envelope: any) => void): string {
	const envelope = JSON.parse(json);
	edit(envelope);
	return JSON.stringify(envelope);
}

const nameOfFlow = (flow: Function): string => `RestoreStage/${flow.name[0]!.toUpperCase()}${flow.name.slice(1)}`;

const plain = (runtime: IRuntime<IShop>) => JSON.parse(JSON.stringify(runtime.state)) as IShop;

describe("a marked flow, resumed by a restore", () => {
	it("comes back to the wait the save caught it at, its answers in locals kept, and ends as the uninterrupted run", async () => {
		const whole = live();
		const finished = whole.runtime.dispatch(checkout, "o1");
		await until(() => whole.w.has("size"));
		whole.w.answer("size", "M");
		await until(() => whole.w.has("colour"));
		whole.w.answer("colour", "red");
		await until(() => whole.w.has("confirm"));
		whole.w.answer("confirm", "yes");
		await until(() => whole.w.has("pay"));
		whole.w.answer("pay", "ok");
		await finished;
		const uninterrupted = plain(whole.runtime);
		whole.runtime.dispose();

		const json = await atColour();
		const run = await restored(json);
		expect(run.result.resumed).toEqual([
			{
				actionId: rowOf(json, "RestoreStage/Checkout").ActionId,
				name: "RestoreStage/Checkout",
				entityId: "o1",
				wait: "RestoreStage/Ask",
				resourceWork: []
			}
		]);
		expect(run.result.dropped).toEqual([]);
		expect(run.w.sent).toEqual([
			"colour"
		]);
		run.w.answer("colour", "red");
		await until(() => run.w.has("confirm"));
		run.w.answer("confirm", "yes");
		await until(() => run.w.has("pay"));
		run.w.answer("pay", "ok");
		await until(() => run.runtime.state.Orders.o1!.Paid);
		expect(plain(run.runtime)).toEqual(uninterrupted);
		expect(uninterrupted.Orders.o1!.Note).toBe("M/red");
		run.runtime.dispose();
	});

	it("gives its start ResumedFrom, the id its row had in the save", async () => {
		const json = await atColour();
		const run = await restored(json);
		expect(
			run.starts.map((record) => [
				record.Name,
				record.ResumedFrom
			])
		).toEqual([
			[
				"RestoreStage/Checkout",
				rowOf(json, "RestoreStage/Checkout").ActionId
			]
		]);
		run.runtime.dispose();
	});

	it("drops it with not-idempotent at a wait whose type isn't declared idempotent, and resumes it at one that is", async () => {
		const { runtime, w } = live();
		void runtime.dispatch(checkout, "o1");
		void runtime.dispatch(checkout, "o2");
		await until(() => w.pending.length === 2);
		w.answer("size", "S");
		w.answer("size", "S");
		await until(() => w.pending.length === 2);
		w.answer("colour", "blue");
		await until(() => w.pending.length === 2);
		w.answer("confirm", "yes");
		await until(() => w.has("pay"));
		const json = createSnapshot(runtime);
		runtime.dispose();
		const run = await restored(json);
		const paying = (
			JSON.parse(json) as {
				InFlight: {
					ActionId: string;
					EntityId: string;
				}[];
			}
		).InFlight;
		expect(
			run.result.resumed.map((entry) => [
				entry.entityId,
				entry.wait
			])
		).toEqual([
			[
				paying.find((row) => run.result.resumed[0]!.actionId === row.ActionId)!.EntityId,
				"RestoreStage/Ask"
			]
		]);
		expect(
			run.result.dropped.map((entry) => [
				entry.reason,
				entry.wait,
				entry.state
			])
		).toEqual([
			[
				"not-idempotent",
				"RestoreStage/Pay",
				"holding"
			]
		]);
		expect(run.result.dropped[0]!.detail).toContain("RestoreStage/Pay");
		run.runtime.dispose();
	});
});

describe("what a restore reports", () => {
	it("lists every in-flight row in exactly one list, the drops in row order with their reasons", async () => {
		const { runtime, w } = live();
		void runtime.dispatch(checkout, "o1");
		void runtime.dispatch(checkout, "o2");
		void runtime.dispatch(browse, "o2");
		await until(() => w.pending.length === 3);
		w.answer("size", "M");
		w.answer("size", "M");
		await until(() => w.pending.filter((wait) => wait.name === "colour").length === 2);
		w.answer("colour", "red");
		await until(() => w.has("confirm"));
		w.answer("confirm", "yes");
		await until(() => w.has("pay"));
		void runtime.dispatch(noteIt, "o1", "queued");
		await settled();
		const json = createSnapshot(runtime);
		runtime.dispose();
		const rows = (
			JSON.parse(json) as {
				InFlight: {
					ActionId: string;
					Name: string;
					EntityId: string;
					State: string;
				}[];
			}
		).InFlight;
		const run = await restored(json);
		const { resumed, dropped } = run.result;
		expect(
			[
				...resumed.map((entry) => entry.actionId),
				...dropped.map((entry) => entry.actionId)
			].sort()
		).toEqual(rows.map((row) => row.ActionId).sort());
		const o1Checkout = rows.find((row) => row.Name === "RestoreStage/Checkout" && row.EntityId === "o1")!;
		const o2Checkout = rows.find((row) => row.Name === "RestoreStage/Checkout" && row.EntityId === "o2")!;
		expect(resumed).toEqual([
			{
				actionId: o2Checkout.ActionId,
				name: "RestoreStage/Checkout",
				entityId: "o2",
				wait: "RestoreStage/Ask",
				resourceWork: []
			}
		]);
		expect(dropped.map((entry) => entry.actionId)).toEqual(rows.filter((row) => row !== o2Checkout).map((row) => row.ActionId));
		const byName = Object.fromEntries(
			dropped.map((entry) => [
				`${entry.name}@${entry.entityId}`,
				entry
			])
		);
		expect(byName["RestoreStage/Checkout@o1"]).toEqual({
			actionId: o1Checkout.ActionId,
			name: "RestoreStage/Checkout",
			label: "checkout",
			entityId: "o1",
			state: "holding",
			reason: "not-idempotent",
			detail: expect.stringContaining("RestoreStage/Pay"),
			wait: "RestoreStage/Pay"
		});
		expect(byName["RestoreStage/NoteIt@o1"]).toMatchObject({
			state: "queued",
			place: 0,
			reason: "behind"
		});
		expect(byName["RestoreStage/Browse@o2"]).toMatchObject({
			state: "open",
			reason: "not-marked"
		});
		expect(Object.keys(byName["RestoreStage/Browse@o2"]!).sort()).toEqual([
			"actionId",
			"entityId",
			"label",
			"name",
			"reason",
			"state"
		]);
		run.runtime.dispose();
	});

	it("reaches each reason through the public restore", async () => {
		const colour = await atColour();
		const reasonOf = async (json: string, given: Parameters<typeof restored>[1] = {}) => {
			const run = await restored(json, given);
			const reasons = run.result.dropped.map((entry) => entry.reason);
			run.runtime.dispose();
			return reasons;
		};
		const flowOnly = async (dispatch: (runtime: IRuntime<IShop>) => void, waitName: string) => {
			const { runtime, w } = live();
			dispatch(runtime);
			await until(() => w.has(waitName));
			const json = createSnapshot(runtime);
			runtime.dispose();
			return json;
		};
		const overBudget = async () => {
			const { runtime, w } = live({
				resume: {
					budget: 50
				},
				allowDiags: [
					"resume/over-budget"
				]
			});
			void runtime.dispatch(checkout, "o1");
			await until(() => w.has("size"));
			const json = createSnapshot(runtime);
			runtime.dispose();
			return json;
		};
		const rowName = (json: string) => rowOf(json, "RestoreStage/Checkout").ActionId;
		expect(
			await reasonOf(colour, {
				resume: false
			})
		).toEqual([
			"resume-off"
		]);
		expect(
			await reasonOf(colour, {
				build: "build-2"
			})
		).toEqual([
			"other-build"
		]);
		expect(await reasonOf(edited(colour, (envelope) => delete envelope.Histories))).toEqual([
			"no-history"
		]);
		expect(await reasonOf(await overBudget())).toEqual([
			"over-budget"
		]);
		expect(
			await reasonOf(
				edited(colour, (envelope) => {
					envelope.InFlight[0].Name = "RestoreStage/Nobody";
				})
			)
		).toEqual([
			"unknown-name"
		]);
		expect(
			await reasonOf(
				edited(colour, (envelope) => {
					envelope.Histories.find((history: { ActionId: string }) => history.ActionId === rowName(colour)).Unlisted = "holding";
				})
			)
		).toEqual([
			"unlisted"
		]);
		expect(
			await reasonOf(colour, {
				allowDiags: [
					"resume/tree-watched"
				],
				setup: (fresh) => {
					reactive.root(() => {
						reactive.effect(() => {
							void fresh.state.Orders.o2!.Qty;
						});
					});
				}
			})
		).toEqual([
			"watched"
		]);
		expect(
			await reasonOf(
				await flowOnly((runtime) => {
					void runtime.dispatch(argued, "o1", undefined, "set");
				}, "argued")
			)
		).toEqual([
			"off-list"
		]);
		expect(
			await reasonOf(
				await flowOnly((runtime) => {
					void runtime.dispatch(startsFirst, "o1");
				}, "after start")
			)
		).toEqual([
			"off-list"
		]);
		expect(
			await reasonOf(
				await flowOnly((runtime) => {
					void runtime.dispatch(browse, "o1");
				}, "browse")
			)
		).toEqual([
			"not-marked"
		]);
		expect(
			await reasonOf(
				await flowOnly((runtime) => {
					void runtime.dispatch(drifts, "o1");
				}, "drift")
			)
		).toEqual([
			"diverged"
		]);
	});

	it("drops with diverged, as a refusal, a flow whose entity another writer moved a child out of and back between its steps", async () => {
		const { runtime, w } = live();
		void runtime.dispatch(twoWaits, "o1");
		await until(() => w.has("one"));
		await runtime.dispatch(moveLine, "shop", "o1", "o2", "o1-l1");
		w.answer("one", "1");
		await until(() => w.has("two"));
		await runtime.dispatch(moveLine, "shop", "o2", "o1", "o1-l1");
		const json = createSnapshot(runtime);
		runtime.dispose();
		const run = await restored(json);
		expect(run.result.resumed).toEqual([]);
		expect(
			run.result.dropped.map((entry) => [
				entry.reason,
				entry.detail
			])
		).toEqual([
			[
				"diverged",
				expect.stringContaining('"o1-l1" left "o1" and would be put back in it')
			]
		]);
		expect(plain(run.runtime).Orders.o1!.Lines["o1-l1"]).toEqual({
			$Id: "o1-l1",
			Qty: 1
		});
		run.runtime.dispose();
	});

	for (const [shape, key, by] of [
		[
			"a seeded child put back by the kept node",
			"o1-l1",
			"node"
		],
		[
			"a child made with entity() put back by the kept node",
			"minted",
			"node"
		],
		[
			"a child made with entity() put back by a plain copy",
			"minted",
			"copy"
		]
	] as const) {
		it(`drops with diverged a flow whose entity another writer deleted a child of and put back between its steps: ${shape}`, async () => {
			const w = waits();
			const runtime = createTestRuntime<IShop>(
				seed(),
				{
					...stubsOf(w),
					generateGuid: guids("line")
				},
				{
					build: BUILD,
					resume: true
				}
			);
			await runtime.dispatch(mintLine, "shop");
			void runtime.dispatch(twoWaits, "o1");
			await until(() => w.has("one"));
			await runtime.dispatch(deleteLine, "shop", key);
			w.answer("one", "1");
			await until(() => w.has("two"));
			await runtime.dispatch(putBackKept, "shop", key, by);
			expect(runtime.state.Orders.o1!.Lines[key]).toBeDefined();
			const json = createSnapshot(runtime);
			runtime.dispose();
			const run = await restored(json);
			expect(run.result.resumed).toEqual([]);
			expect(
				run.result.dropped.map((entry) => [
					entry.reason,
					entry.detail
				])
			).toEqual([
				[
					"diverged",
					expect.stringMatching(/" left "o1" and would be put back in it$/)
				]
			]);
			run.runtime.dispose();
		});
	}
});

describe("the release of the held waits", () => {
	it("with no repair, sends the held wait synchronously after the stage, before the restore resolves", async () => {
		const json = await atConfirm();
		const w = waits();
		let sentAtResolve: string[] | undefined;
		const restoring = restoreTestRuntime<IShop>(json, {
			rootId: "shop",
			effectStubs: stubsOf(w),
			options: {
				build: BUILD,
				resume: true
			},
			setup: () => {
				expect(w.sent).toEqual([]);
			}
		});
		expect(w.sent).toEqual([
			"confirm"
		]);
		const { runtime } = await restoring.then((outcome) => {
			sentAtResolve = [
				...w.sent
			];
			return outcome;
		});
		expect(sentAtResolve).toEqual([
			"confirm"
		]);
		runtime.dispose();
	});

	it("with a repair that settles, sends it once the repair has settled and not before", async () => {
		const json = await atConfirm();
		const w = waits();
		let during: string[] | undefined;
		const { runtime, result } = await restoreTestRuntime<IShop>(json, {
			rootId: "shop",
			effectStubs: stubsOf(w),
			options: {
				build: BUILD,
				resume: true
			},
			repair: async (_runtime, given) => {
				await settled();
				during = [
					...w.sent
				];
				expect(given.resumed).toHaveLength(1);
			}
		});
		expect(result.resumed).toHaveLength(1);
		expect(during).toEqual([]);
		expect(w.sent).toEqual([
			"confirm"
		]);
		runtime.dispose();
	});

	it("with a repair that throws, sends it all the same, and the throw rides the result", async () => {
		const json = await atConfirm();
		const run = await restored(json, {
			repair: () => {
				throw new Error("repair broke");
			}
		});
		expect((run.result.repairError as Error).message).toBe("repair broke");
		expect(run.w.sent).toEqual([
			"confirm"
		]);
		run.runtime.dispose();
	});

	it("with an asynchronous repair, doesn't send it until the repair settles", async () => {
		const json = await atConfirm();
		const w = waits();
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const restoring = restoreTestRuntime<IShop>(json, {
			rootId: "shop",
			effectStubs: stubsOf(w),
			options: {
				build: BUILD,
				resume: true
			},
			repair: () => gate
		});
		for (let turn = 0; turn < 5; turn++) {
			await settled();
		}
		expect(w.sent).toEqual([]);
		finish();
		const { runtime } = await restoring;
		expect(w.sent).toEqual([
			"confirm"
		]);
		w.answer("confirm", "yes");
		await until(() => w.has("pay"));
		runtime.dispose();
	});

	it("leaves nothing held and sends nothing when the restore fails after the stage", async () => {
		const json = await atConfirm();
		const w = waits();
		let seen: IRuntime<IShop> | undefined;
		await expect(
			restoreTestRuntime<IShop>(json, {
				rootId: "shop",
				effectStubs: stubsOf(w),
				options: {
					build: BUILD,
					resume: true
				},
				setup: (fresh) => {
					seen = fresh;
					(
						fresh as unknown as {
							get(key: string): {
								drained: () => Promise<void>;
							};
						}
					).get("runtime/resources").drained = () => Promise.reject(new Error("drain broke"));
				},
				repair: () => {}
			})
		).rejects.toThrow("drain broke");
		for (let turn = 0; turn < 5; turn++) {
			await settled();
		}
		expect(seen).toBeDefined();
		expect(w.sent).toEqual([]);
		expect(w.pending).toEqual([]);
	});
});

describe("the window before the release", () => {
	it("rejects a public dispatch behind a resumed action's hold, naming it, and takes the same dispatch after the release", async () => {
		const json = await atConfirm();
		const saved = rowOf(json, "RestoreStage/Checkout").ActionId;
		const refused: unknown[] = [];
		const run = await restored(json, {
			repair: async (runtime) => {
				for (const attempt of [
					() => runtime.dispatch(jot, "o1", "in the repair"),
					() => runtime.dispatch(checkout, "o1")
				]) {
					try {
						await attempt();
					} catch (error) {
						refused.push(error);
					}
				}
				await runtime.dispatch(jot, "o2", "elsewhere");
			}
		});
		expect(refused).toHaveLength(2);
		for (const error of refused) {
			expect(error).toBeInstanceOf(UnreleasedResumeError);
			expect(error).toMatchObject({
				actionName: "RestoreStage/Checkout",
				actionId: saved,
				entityId: "o1"
			});
		}
		expect((refused[0] as Error).message).toContain('"RestoreStage/Jot" on "o1" would wait behind "RestoreStage/Checkout"');
		expect(run.runtime.state.Orders.o2!.Log).toEqual([
			"elsewhere"
		]);
		const after = run.runtime.dispatch(jot, "o1", "after the release");
		run.w.answer("confirm", "yes");
		await until(() => run.w.has("pay"));
		run.w.answer("pay", "ok");
		await after;
		expect(run.runtime.state.Orders.o1!.Log).toEqual([
			"confirming yes",
			"checked out",
			"after the release"
		]);
		run.runtime.dispose();
	});

	it("rejects a public dispatch of the resumed function onto its entity though it holds nothing, through dispatch and processAction", async () => {
		const json = await atColour();
		const refused: unknown[] = [];
		const run = await restored(json, {
			repair: async (runtime) => {
				try {
					await runtime.dispatch(checkout, "o1");
				} catch (error) {
					refused.push(error);
				}
				try {
					await runtime.processAction(
						checkout,
						() => runtime.state.Orders.o1!,
						(
							runtime as unknown as {
								resolveCell(id: string): {
									setState: never;
								};
							}
						).resolveCell("o1").setState,
						() => "o1"
					);
				} catch (error) {
					refused.push(error);
				}
				await runtime.dispatch(jot, "o1", "beside");
			}
		});
		expect(refused.map((error) => (error as UnreleasedResumeError).actionName)).toEqual([
			"RestoreStage/Checkout",
			"RestoreStage/Checkout"
		]);
		expect((refused[0] as Error).message).toContain("A repair acts on result.dropped");
		expect(run.runtime.state.Orders.o1!.Log).toEqual([
			"beside"
		]);
		const second = run.runtime.dispatch(checkout, "o2");
		await until(() => run.w.has("size"));
		expect(run.w.sent).toEqual([
			"colour",
			"size"
		]);
		run.runtime.dispose();
		await second;
	});

	it("lets an internal arrival in the window line up behind the hold and run after the release", async () => {
		const json = await atConfirm();
		const run = await restored(json, {
			repair: (runtime) => runtime.dispatch(starts, "shop", "o1", "started in the repair")
		});
		await settled();
		expect(run.runtime.state.Orders.o1!.Log).toEqual([]);
		run.w.answer("confirm", "yes");
		await until(() => run.w.has("pay"));
		run.w.answer("pay", "ok");
		await until(() => run.runtime.state.Orders.o1!.Log.length === 3);
		expect(run.runtime.state.Orders.o1!.Log).toEqual([
			"confirming yes",
			"checked out",
			"started in the repair"
		]);
		run.runtime.dispose();
	});

	it("lets a start of another function onto the entity of a resumed flow parked inside open run in the window", async () => {
		const json = await atColour();
		let during: string[] | undefined;
		const run = await restored(json, {
			repair: async (runtime) => {
				await runtime.dispatch(starts, "shop", "o1", "started in the repair");
				await until(() => runtime.state.Orders.o1!.Log.length > 0);
				during = [
					...runtime.state.Orders.o1!.Log
				];
			}
		});
		expect(during).toEqual([
			"started in the repair"
		]);
		run.runtime.dispose();
	});

	it("lets a tick and a delivery onto a resumed action's held entity line up behind it and run after the release", async () => {
		vi.useFakeTimers();
		try {
			const { runtime, w } = live();
			runtime.registerReceiver(Pokes);
			await runtime.dispatch(wire, "o1");
			void runtime.dispatch(checkout, "o1");
			await until(() => w.has("size"));
			w.answer("size", "M");
			await until(() => w.has("colour"));
			w.answer("colour", "red");
			await until(() => w.has("confirm"));
			const json = createSnapshot(runtime);
			runtime.dispose();
			const restoredWaits = waits();
			let during: string[] | undefined;
			const run = await restoreRuntime<IShop>(json, {
				rootId: "shop",
				options: {
					build: BUILD,
					resume: true,
					implementations: stubsOf(restoredWaits)
				},
				setup: (fresh) => fresh.registerReceiver(Pokes),
				repair: async (restoredRuntime) => {
					await restoredRuntime.dispatch(poke, "shop");
					await vi.advanceTimersByTimeAsync(200);
					during = [
						...restoredRuntime.state.Orders.o1!.Log
					];
				}
			});
			expect(run.result.resumed.map((entry) => entry.name)).toEqual([
				"RestoreStage/Checkout"
			]);
			expect(during).toEqual([]);
			restoredWaits.answer("confirm", "yes");
			await until(() => restoredWaits.has("pay"));
			restoredWaits.answer("pay", "ok");
			await until(() => run.runtime.state.Orders.o1!.Log.length === 4);
			expect(run.runtime.state.Orders.o1!.Log).toEqual([
				"confirming yes",
				"checked out",
				"poked",
				"tick"
			]);
			run.runtime.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a save with an in-flight row twice", () => {
	for (const [where, entityOf] of [
		[
			"on the same entity",
			(entityId: string) => entityId
		],
		[
			"on another entity",
			() => "o2"
		]
	] as const) {
		for (const resume of [
			true,
			false
		]) {
			it(`keeps the first ${where}, with resume ${resume ? "on: the action is in exactly one list" : "off: one dropped entry"}`, async () => {
				const json = await atColour();
				const actionId = rowOf(json, "RestoreStage/Checkout").ActionId;
				const doubled = edited(json, (envelope) => {
					const row = envelope.InFlight[0];
					envelope.InFlight.push({
						...row,
						EntityId: entityOf(row.EntityId)
					});
				});
				const w = waits();
				const { runtime, result } = await restoreRuntime<IShop>(doubled, {
					rootId: "shop",
					options: {
						build: BUILD,
						...(resume
							? {
									resume: true
								}
							: {}),
						implementations: stubsOf(w)
					}
				});
				expect(
					result.resumed.map((entry) => [
						entry.actionId,
						entry.entityId
					])
				).toEqual(
					resume
						? [
								[
									actionId,
									"o1"
								]
							]
						: []
				);
				expect(
					result.dropped.map((entry) => [
						entry.actionId,
						entry.entityId
					])
				).toEqual(
					resume
						? []
						: [
								[
									actionId,
									"o1"
								]
							]
				);
				runtime.dispose();
			});
		}
	}
});

describe("a restore started inside a tracked computation", () => {
	it("resumes, and the replay doesn't run the computation again", async () => {
		const json = await atColour();
		let runs = 0;
		let restoring: Promise<IRestored> | undefined;
		reactive.root(() => {
			reactive.effect(() => {
				runs++;
				restoring = restored(json);
			});
		});
		const run = await restoring!;
		expect(run.result.resumed.map((entry) => entry.name)).toEqual([
			"RestoreStage/Checkout"
		]);
		run.w.answer("colour", "red");
		await until(() => run.w.has("confirm"));
		expect(runs).toBe(1);
		run.runtime.dispose();
	});

	it("without resume, doesn't subscribe the computation to what setup reads, and setup's own effect keeps tracking", async () => {
		const { runtime: saving } = live();
		const json = createSnapshot(saving);
		saving.dispose();
		let outerRuns = 0;
		let innerRuns = 0;
		let restoring: Promise<IRestored> | undefined;
		reactive.root(() => {
			reactive.effect(() => {
				outerRuns++;
				restoring ??= restored(json, {
					resume: false,
					setup: (fresh) => {
						void fresh.state.Orders.o1!.Qty;
						reactive.effect(() => {
							innerRuns++;
							void fresh.state.Orders.o1!.Qty;
						});
					}
				});
			});
		});
		const run = await restoring!;
		expect([
			outerRuns,
			innerRuns
		]).toEqual([
			1,
			1
		]);
		await run.runtime.dispatch(bumpQty, "o1");
		await settled();
		expect([
			outerRuns,
			innerRuns
		]).toEqual([
			1,
			2
		]);
		run.runtime.dispose();
	});

	it("still drops a row as watched for an effect setup creates over the tree", async () => {
		const json = await atColour();
		let restoring: Promise<IRestored> | undefined;
		reactive.root(() => {
			reactive.effect(() => {
				restoring = restored(json, {
					allowDiags: [
						"resume/tree-watched"
					],
					setup: (fresh) => {
						reactive.effect(() => {
							void fresh.state.Orders.o1!.Qty;
						});
					}
				});
			});
		});
		const run = await restoring!;
		expect(run.result.dropped.map((entry) => entry.reason)).toEqual([
			"watched"
		]);
		run.runtime.dispose();
	});
});

describe("a live run of a saved function on its entity", () => {
	it("drops a holding saved run with diverged when setup dispatched the function there, so it runs once", async () => {
		const { runtime, w } = live();
		void runtime.dispatch(quietly, "o1");
		await until(() => w.has("quiet"));
		w.answer("quiet", "x");
		await until(() => w.has("quiet held"));
		const json = createSnapshot(runtime);
		runtime.dispose();
		const run = await restored(json, {
			setup: (fresh) => {
				void fresh.dispatch(quietly, "o1");
			}
		});
		expect(run.result.resumed).toEqual([]);
		expect(
			run.result.dropped.map((entry) => [
				entry.reason,
				entry.detail
			])
		).toEqual([
			[
				"diverged",
				'live work of "RestoreStage/Quietly" is on the entity "o1", and a second run would do its work again'
			]
		]);
		await settled();
		expect(run.w.sent).toEqual([
			"quiet"
		]);
		expect(run.diags).toEqual([]);
		run.runtime.dispose();
	});

	it("drops a queued saved run with off-list when setup dispatched the function there, so it runs once", async () => {
		const { runtime, w } = live();
		void runtime.dispatch(checkout, "o1");
		for (const step of [
			"size",
			"colour"
		]) {
			await until(() => w.has(step));
			w.answer(step, "x");
		}
		await until(() => w.has("confirm"));
		void runtime.dispatch(quietly, "o1");
		const json = createSnapshot(runtime);
		runtime.dispose();
		const run = await restored(json, {
			setup: (fresh) => {
				void fresh.dispatch(quietly, "o1");
			}
		});
		expect(run.result.resumed.map((entry) => entry.name)).toEqual([
			"RestoreStage/Checkout"
		]);
		expect(
			run.result.dropped.map((entry) => [
				entry.name,
				entry.reason,
				entry.detail
			])
		).toEqual([
			[
				"RestoreStage/Quietly",
				"off-list",
				'live work of "RestoreStage/Quietly" is on its entity, and a second run would do its work again'
			]
		]);
		run.w.answer("confirm", "yes");
		await until(() => run.w.has("pay"));
		run.w.answer("pay", "ok");
		await until(() => run.runtime.state.Orders.o1!.Paid);
		await settled();
		expect(run.w.sent.filter((name) => name === "quiet")).toEqual([
			"quiet"
		]);
		run.runtime.dispose();
	});
});

describe("an entity setup changed before the stage", () => {
	const parkedConstant = async (): Promise<string> => {
		const { runtime, w } = live();
		void runtime.dispatch(parkConstant, "o2");
		await until(() => w.has("c"));
		const json = createSnapshot(runtime);
		runtime.dispose();
		return json;
	};

	it("drops the flow on it with diverged, which would otherwise resume on a local the change made wrong", async () => {
		const run = await restored(await parkedConstant(), {
			setup: (fresh) => {
				void fresh.dispatch(bumpHundred, "o2");
			}
		});
		expect(run.result.resumed).toEqual([]);
		expect(
			run.result.dropped.map((entry) => [
				entry.reason,
				entry.detail
			])
		).toEqual([
			[
				"diverged",
				'the entity "o2" changed between the load and the stage'
			]
		]);
		expect(run.diags).toEqual([]);
		run.runtime.dispose();
	});

	it("drops the flow when setup changed a child entity below it", async () => {
		const run = await restored(await atColour(), {
			setup: (fresh) => {
				void fresh.dispatch(setLine, "o1-l1", 9);
			}
		});
		expect(
			run.result.dropped.map((entry) => [
				entry.reason,
				entry.detail
			])
		).toEqual([
			[
				"diverged",
				'the entity "o1" changed between the load and the stage'
			]
		]);
		run.runtime.dispose();
	});

	it("resumes the flow when setup changed another entity", async () => {
		const run = await restored(await atColour(), {
			setup: (fresh) => {
				void fresh.dispatch(bumpHundred, "o2");
			}
		});
		expect(run.result.resumed.map((entry) => entry.name)).toEqual([
			"RestoreStage/Checkout"
		]);
		expect(run.result.dropped).toEqual([]);
		run.runtime.dispose();
	});
});

describe("the keeper, beside a listener that writes on hearing a resumed start", () => {
	const twoParked = async (later: (draft: IOrder) => IOpenGenerator, wait: string): Promise<string> => {
		const { runtime, w } = live();
		void runtime.dispatch(parkFirst, "o1");
		void runtime.dispatch(later, "o2");
		await until(() => w.has("a") && w.has(wait));
		const json = createSnapshot(runtime);
		runtime.dispose();
		return json;
	};

	const onFirstStart = (fresh: IRuntime<IShop>) => {
		let fired = false;
		fresh.on(
			"record",
			(record) => {
				if (!fired && record.ResumedFrom !== undefined && record.Name === "RestoreStage/ParkFirst") {
					fired = true;
					void fresh.dispatch(bumpHundred, "o2");
				}
			},
			{
				kinds: [
					"action:start"
				]
			}
		);
	};

	for (const [flow, wait] of [
		[
			parkReading,
			"b"
		],
		[
			parkConstant,
			"c"
		]
	] as const) {
		for (const when of [
			"in a listener on the first resumed start",
			"after the restore"
		] as const) {
			it(`keeps the write onto ${nameOfFlow(flow)}'s entity ${when} as another writer's, so a second restore resumes it on its original local`, async () => {
				const json = await twoParked(flow, wait);
				const first = await restored(json, {
					setup: (fresh) => {
						if (when !== "after the restore") {
							onFirstStart(fresh);
						}
					}
				});
				expect(first.result.resumed.map((entry) => entry.name)).toEqual([
					"RestoreStage/ParkFirst",
					nameOfFlow(flow)
				]);
				if (when === "after the restore") {
					void first.runtime.dispatch(bumpHundred, "o2");
				}
				await settled();
				expect(first.runtime.state.Orders.o2!.Qty).toBe(101);
				const again = createSnapshot(first.runtime);
				first.runtime.dispose();
				const second = await restored(again);
				expect(second.result.resumed.map((entry) => entry.name)).toEqual([
					"RestoreStage/ParkFirst",
					nameOfFlow(flow)
				]);
				second.w.answer(wait, "done");
				await until(() => second.runtime.state.Orders.o2!.Log.length > 0);
				expect(second.runtime.state.Orders.o2!.Log).toEqual([
					"done after 1"
				]);
				second.runtime.dispose();
			});
		}
	}
});

describe("a listener that acts on hearing a resumed start", () => {
	type IRecorded = Extract<
		IRecord,
		{
			ActionId: string;
		}
	>;

	const listening = (fresh: IRuntime<IShop>, records: IRecorded[], act: () => void) => {
		fresh.on("record", (record) => {
			if ("ActionId" in record) {
				records.push(record as IRecorded);
			}
		});
		fresh.on(
			"record",
			(record) => {
				if (record.ResumedFrom !== undefined && record.Name === "RestoreStage/Checkout") {
					act();
				}
			},
			{
				kinds: [
					"action:start"
				]
			}
		);
	};

	const wellFormed = (records: readonly IRecorded[]): void => {
		const started = new Set<string>();
		for (const record of records) {
			if (record.Kind === "action:start") {
				expect(started.has(record.ActionId)).toBe(false);
				started.add(record.ActionId);
			} else {
				expect(started.has(record.ActionId)).toBe(true);
			}
		}
	};

	const kindsOf = (records: readonly IRecorded[], name: string): string[] => {
		const ids = new Set(
			records.filter((record) => record.Kind === "action:start" && record.Name === name).map((record) => record.ActionId)
		);
		return records.filter((record) => ids.has(record.ActionId)).map((record) => record.Kind);
	};

	for (const withRepair of [
		false,
		true
	]) {
		it(`leaves the report as the stage made it when it deletes the entity of a held start, and that action is heard to start and then end, ${withRepair ? "with" : "without"} a repair`, async () => {
			const json = await queuedBehindConfirm();
			const w = waits();
			const records: IRecorded[] = [];
			const { runtime, result } = await restoreRuntime<IShop>(json, {
				rootId: "shop",
				options: {
					build: BUILD,
					resume: true,
					implementations: stubsOf(w)
				},
				setup: (fresh) => {
					listening(fresh, records, () => {
						void fresh.dispatch(removeOrder, "shop", "o1");
					});
				},
				...(withRepair
					? {
							repair: () => {}
						}
					: {})
			});
			expect(result.resumed.map((entry) => entry.name)).toEqual([
				"RestoreStage/Checkout",
				"RestoreStage/NoteIt"
			]);
			expect(result.dropped).toEqual([]);
			wellFormed(records);
			expect(
				records
					.filter((record) => record.Kind === "action:start" && record.ResumedFrom !== undefined)
					.map(
						(record) =>
							(
								record as IRecorded & {
									Name: string;
								}
							).Name
					)
			).toEqual([
				"RestoreStage/Checkout",
				"RestoreStage/NoteIt"
			]);
			expect(kindsOf(records, "RestoreStage/NoteIt")).toEqual([
				"action:start",
				"action:end"
			]);
			expect(w.sent).toEqual([]);
			runtime.dispose();
		});

		it(`returns the report when it disposes the runtime, every start heard once and before anything else of its action, ${withRepair ? "with" : "without"} a repair`, async () => {
			const json = await queuedBehindConfirm();
			const w = waits();
			const records: IRecorded[] = [];
			const { runtime, result } = await restoreRuntime<IShop>(json, {
				rootId: "shop",
				options: {
					build: BUILD,
					resume: true,
					implementations: stubsOf(w)
				},
				setup: (fresh) => {
					listening(fresh, records, () => fresh.dispose());
				},
				...(withRepair
					? {
							repair: () => {}
						}
					: {})
			});
			expect(result.resumed.map((entry) => entry.name)).toEqual([
				"RestoreStage/Checkout",
				"RestoreStage/NoteIt"
			]);
			wellFormed(records);
			expect(w.sent).toEqual([]);
			runtime.dispose();
		});
	}

	const holderAndGuard = async (): Promise<string> => {
		const { runtime: saving, w: saved } = live();
		void saving.dispatch(checkout, "o1");
		for (const step of [
			"size",
			"colour"
		]) {
			await until(() => saved.has(step));
			saved.answer(step, "x");
		}
		await until(() => saved.has("confirm"));
		void saving.dispatch(guarded, "o2-l1" as never);
		await until(() => saved.has("guard"));
		const json = createSnapshot(saving);
		saving.dispose();
		return json;
	};

	it("takes a snapshot that holds a history for a later replayed action, so restoring that snapshot resumes it", async () => {
		let taken: string | undefined;
		const run = await restored(await holderAndGuard(), {
			setup: (fresh) => {
				listening(fresh, [], () => {
					taken = createSnapshot(fresh);
				});
			}
		});
		expect(run.result.resumed).toHaveLength(2);
		const again = await restored(taken!);
		expect(again.result.resumed.map((entry) => entry.name)).toEqual([
			"RestoreStage/Checkout",
			"RestoreStage/Guarded"
		]);
		expect(again.result.dropped).toEqual([]);
		again.runtime.dispose();
		run.runtime.dispose();
	});

	it("leaves a later replayed action resumed when it deletes that action's entity, and the action is heard to start and then end", async () => {
		const json = await holderAndGuard();
		const w = waits();
		const records: IRecorded[] = [];
		let first = true;
		const { runtime, result } = await restoreRuntime<IShop>(json, {
			rootId: "shop",
			options: {
				build: BUILD,
				resume: true,
				implementations: stubsOf(w)
			},
			setup: (fresh) => {
				fresh.on("record", (record) => {
					if ("ActionId" in record) {
						records.push(record as IRecorded);
					}
					if (record.Kind === "action:start" && record.ResumedFrom !== undefined && first) {
						first = false;
						void fresh.dispatch(removeOrder, "shop", "o2");
					}
				});
			}
		});
		await settled();
		expect(result.resumed.map((entry) => entry.name)).toEqual([
			"RestoreStage/Checkout",
			"RestoreStage/Guarded"
		]);
		wellFormed(records);
		expect(kindsOf(records, "RestoreStage/Guarded")).toEqual([
			"action:start",
			"step",
			"action:end"
		]);
		runtime.dispose();
	});

	it("lines a start of another function up behind the queued action put back on that entity", async () => {
		const json = await queuedBehindConfirm();
		const run = await restored(json, {
			setup: (fresh) => {
				listening(fresh, [], () => {
					void fresh.dispatch(starts, "shop", "o1", "started on hearing the holder");
				});
			}
		});
		run.w.answer("confirm", "yes");
		await until(() => run.w.has("pay"));
		run.w.answer("pay", "ok");
		await until(() => run.runtime.state.Orders.o1!.Log.length === 4);
		expect(run.runtime.state.Orders.o1!.Log).toEqual([
			"confirming yes",
			"checked out",
			"queued",
			"started on hearing the holder"
		]);
		run.runtime.dispose();
	});

	it("takes a snapshot that holds the queued row behind the holder and its history, so restoring that snapshot puts it back", async () => {
		const json = await queuedBehindConfirm();
		let taken: string | undefined;
		const run = await restored(json, {
			setup: (fresh) => {
				listening(fresh, [], () => {
					taken = createSnapshot(fresh);
				});
			}
		});
		const envelope = JSON.parse(taken!) as {
			InFlight: {
				Name: string | null;
			}[];
		};
		expect(envelope.InFlight.map((row) => row.Name)).toEqual([
			"RestoreStage/Checkout",
			"RestoreStage/NoteIt"
		]);
		const again = await restored(taken!);
		expect(again.result.resumed.map((entry) => entry.name)).toEqual([
			"RestoreStage/Checkout",
			"RestoreStage/NoteIt"
		]);
		expect(again.result.dropped).toEqual([]);
		again.runtime.dispose();
		run.runtime.dispose();
	});
});

describe("the window, for a listener that hears the restore", () => {
	it("refuses a dispatch of the resumed function from a record listener on its resumed start", async () => {
		const json = await atColour();
		const refused: unknown[] = [];
		const run = await restored(json, {
			setup: (fresh) => {
				fresh.on(
					"record",
					(record) => {
						if (record.ResumedFrom !== undefined) {
							fresh.dispatch(checkout, "o1").catch((error: unknown) => refused.push(error));
						}
					},
					{
						kinds: [
							"action:start"
						]
					}
				);
			}
		});
		await settled();
		expect(refused).toHaveLength(1);
		expect(refused[0]).toBeInstanceOf(UnreleasedResumeError);
		expect(run.w.sent).toEqual([
			"colour"
		]);
		run.runtime.dispose();
	});

	it("refuses a start of the resumed function from an action a record listener dispatches on its resumed start", async () => {
		const json = await atColour();
		startRefusals.length = 0;
		const run = await restored(json, {
			setup: (fresh) => {
				fresh.on(
					"record",
					(record) => {
						if (record.ResumedFrom !== undefined) {
							void fresh.dispatch(startsCheckout, "shop", "o1");
						}
					},
					{
						kinds: [
							"action:start"
						]
					}
				);
			}
		});
		await until(() => startRefusals.length > 0);
		expect(startRefusals[0]).toBeInstanceOf(UnreleasedResumeError);
		expect(run.w.sent).toEqual([
			"colour"
		]);
		run.runtime.dispose();
	});

	for (const heard of [
		"RestoreStage/NoteIt",
		"RestoreStage/Checkout"
	]) {
		it(`refuses a start of a queued action's function, put back, from a record listener on ${heard}'s resumed start`, async () => {
			const json = await queuedBehindConfirm();
			startRefusals.length = 0;
			const run = await restored(json, {
				setup: (fresh) => {
					fresh.on(
						"record",
						(record) => {
							if (record.ResumedFrom !== undefined && record.Name === heard) {
								void fresh.dispatch(startsNoteIt, "shop", "o1");
							}
						},
						{
							kinds: [
								"action:start"
							]
						}
					);
				}
			});
			expect(run.result.resumed.map((entry) => entry.name)).toEqual([
				"RestoreStage/Checkout",
				"RestoreStage/NoteIt"
			]);
			await until(() => startRefusals.length > 0);
			expect(startRefusals[0]).toMatchObject({
				actionName: "RestoreStage/NoteIt",
				entityId: "o1"
			});
			run.w.answer("confirm", "yes");
			await until(() => run.w.has("pay"));
			run.w.answer("pay", "ok");
			await until(() => run.runtime.state.Orders.o1!.Log.includes("queued"));
			await settled();
			expect(run.runtime.state.Orders.o1!.Log).toEqual([
				"confirming yes",
				"checked out",
				"queued"
			]);
			run.runtime.dispose();
		});
	}

	it("refuses a dispatch of the resumed function from a diag listener on resume/never-resumes", async () => {
		const { runtime, w } = live();
		void runtime.dispatch(checkout, "o2");
		for (const step of [
			"size",
			"colour",
			"confirm"
		]) {
			await until(() => w.has(step));
			w.answer(step, "x");
		}
		await until(() => w.has("pay"));
		void runtime.dispatch(checkout, "o1");
		await until(() => w.has("size"));
		w.answer("size", "M");
		await until(() => w.has("colour"));
		const json = createSnapshot(runtime);
		runtime.dispose();
		const refused: unknown[] = [];
		const run = await restored(json, {
			setup: (fresh) => {
				fresh.on("diag", (event) => {
					if (event.code === "resume/never-resumes") {
						fresh.dispatch(checkout, "o1").catch((error: unknown) => refused.push(error));
					}
				});
			}
		});
		await settled();
		expect(run.result.resumed.map((entry) => entry.entityId)).toEqual([
			"o1"
		]);
		expect(run.diags.map((diag) => diag.code)).toEqual([
			"resume/never-resumes"
		]);
		expect(refused).toHaveLength(1);
		expect(refused[0]).toBeInstanceOf(UnreleasedResumeError);
		expect(run.w.sent).toEqual([
			"colour"
		]);
		run.runtime.dispose();
	});
});

describe("a start in the window before the release", () => {
	async function parkedAt(action: (draft: IOrder) => IOpenGenerator, wait: string): Promise<string> {
		const { runtime, w } = live();
		void runtime.dispatch(action, "o1");
		await until(() => w.has(wait));
		const json = createSnapshot(runtime);
		runtime.dispose();
		return json;
	}

	async function refusedIn(json: string, starter: (runtime: IRuntime<IShop>) => Promise<unknown>): Promise<IRestored> {
		startRefusals.length = 0;
		const run = await restored(json, {
			repair: async (runtime) => {
				await starter(runtime);
				await until(() => startRefusals.length > 0);
			}
		});
		expect(startRefusals).toHaveLength(1);
		expect(startRefusals[0]).toBeInstanceOf(UnreleasedResumeError);
		return run;
	}

	it("throws into a repair's action that starts the resumed function onto its entity, parked inside open, which catches it", async () => {
		const json = await atColour();
		const run = await refusedIn(json, (runtime) => runtime.dispatch(startsCheckout, "shop", "o1"));
		expect(startRefusals[0]).toMatchObject({
			actionName: "RestoreStage/Checkout",
			actionId: rowOf(json, "RestoreStage/Checkout").ActionId,
			entityId: "o1"
		});
		expect((startRefusals[0] as Error).message).toContain('start: "RestoreStage/Checkout" on "o1" is refused');
		expect(run.starts.map((record) => record.Name)).toEqual([
			"RestoreStage/Checkout",
			"RestoreStage/StartsCheckout"
		]);
		expect(run.w.sent).toEqual([
			"colour"
		]);
		run.runtime.dispose();
	});

	it("throws into a repair's action that starts the resumed function onto the entity it holds", async () => {
		const json = await atConfirm();
		const run = await refusedIn(json, (runtime) => runtime.dispatch(startsCheckout, "shop", "o1"));
		expect(startRefusals[0]).toMatchObject({
			actionName: "RestoreStage/Checkout",
			entityId: "o1"
		});
		run.w.answer("confirm", "yes");
		await until(() => run.w.has("pay"));
		run.w.answer("pay", "ok");
		await until(() => run.runtime.state.Orders.o1!.Paid);
		for (let turn = 0; turn < 5; turn++) {
			await settled();
		}
		expect(run.w.sent).toEqual([
			"confirm",
			"pay"
		]);
		run.runtime.dispose();
	});

	it("throws into an action the repair's action started, at its start of the resumed function", async () => {
		const json = await atColour();
		const run = await refusedIn(json, (runtime) => runtime.dispatch(startsTheStarter, "shop", "o1"));
		expect(startRefusals[0]).toMatchObject({
			actionName: "RestoreStage/Checkout",
			entityId: "o1"
		});
		expect(run.w.sent).toEqual([
			"colour"
		]);
		run.runtime.dispose();
	});

	it("runs the same start once the window has closed, beside the flow parked inside open and behind the one holding", async () => {
		startRefusals.length = 0;
		const parked = await restored(await atColour());
		await parked.runtime.dispatch(startsCheckout, "shop", "o1");
		await until(() => parked.w.has("size"));
		expect(parked.w.sent).toEqual([
			"colour",
			"size"
		]);
		parked.runtime.dispose();

		const held = await restored(await atConfirm());
		await held.runtime.dispatch(startsCheckout, "shop", "o1");
		held.w.answer("confirm", "yes");
		await until(() => held.w.has("pay"));
		held.w.answer("pay", "ok");
		await until(() => held.w.has("size"));
		expect(held.w.sent).toEqual([
			"confirm",
			"pay",
			"size"
		]);
		expect(startRefusals).toEqual([]);
		held.runtime.dispose();
	});

	for (const [mark, action, starter, wait] of [
		[
			"leading",
			leadAsk,
			startsLeadAsk,
			"lead"
		],
		[
			"latest",
			lastAsk,
			startsLastAsk,
			"last"
		]
	] as const) {
		it(`leaves a resumed ${mark} flow untouched: its mark doesn't act on the refused arrival`, async () => {
			const json = await parkedAt(action, wait);
			const run = await refusedIn(json, (runtime) => runtime.dispatch(starter, "shop", "o1"));
			expect(run.result.dropped).toEqual([]);
			expect(run.starts.map((record) => record.Name)).toEqual([
				`RestoreStage/${mark === "leading" ? "LeadAsk" : "LastAsk"}`,
				`RestoreStage/${mark === "leading" ? "StartsLeadAsk" : "StartsLastAsk"}`
			]);
			run.w.answer(wait, "answered");
			await until(() => run.runtime.state.Orders.o1!.Note === "answered");
			expect(run.w.sent).toEqual([
				wait
			]);
			run.runtime.dispose();
		});
	}
});

describe("a malformed history section", () => {
	const shapes: [
		string,
		(envelope: any, actionId: string) => void,
		string
	][] = [
		[
			"a section that isn't an array",
			(envelope) => {
				envelope.Histories = {
					oops: true
				};
			},
			"the snapshot's Histories section is malformed"
		],
		[
			"a section nested too deep",
			(envelope) => {
				let deep: unknown[] = [];
				const top = deep;
				for (let level = 0; level < 1100; level++) {
					const next: unknown[] = [];
					deep.push(next);
					deep = next;
				}
				envelope.Histories[0].Args = top;
			},
			"the snapshot's Histories section is malformed"
		],
		[
			"entries that aren't objects or name no action",
			(envelope) => {
				envelope.Histories = [
					5,
					null,
					{
						Args: []
					}
				];
			},
			"the snapshot carries no history for it"
		],
		[
			"two entries for one action",
			(envelope) => {
				envelope.Histories.push(envelope.Histories[0]);
			},
			"its history in the snapshot is malformed"
		],
		[
			"an unknown Unusable",
			(envelope, actionId) => {
				envelope.Histories = [
					{
						ActionId: actionId,
						Unusable: "banana",
						Unlisted: "none",
						UnlistedLineage: [],
						Deliveries: []
					}
				];
			},
			"its history in the snapshot is malformed"
		],
		[
			"Args that aren't an array",
			(envelope) => {
				envelope.Histories[0].Args = "a";
			},
			"its history in the snapshot is malformed"
		],
		[
			"an entry of an unknown kind",
			(envelope) => {
				envelope.Histories[0].Entries.push({
					Kind: "bogus"
				});
			},
			"its history in the snapshot is malformed"
		],
		[
			"a change whose Path isn't a list of keys",
			(envelope) => {
				envelope.Histories[0].Entries.find((entry: { Kind: string }) => entry.Kind === "step").Changes[0].Path = "Qty";
			},
			"its history in the snapshot is malformed"
		],
		[
			"a Landing that names no entity",
			(envelope) => {
				envelope.Histories[0].Entries.find((entry: { Kind: string }) => entry.Kind === "step").Changes[0].Landing.EntityId = 7;
			},
			"its history in the snapshot is malformed"
		],
		[
			"an answer whose error isn't a serialized throw",
			(envelope) => {
				const answer = envelope.Histories[0].Entries.find((entry: { Kind: string }) => entry.Kind === "response");
				delete answer.Value;
				answer.Error = {
					Thrown: "error",
					Name: 5
				};
			},
			"its history in the snapshot is malformed"
		],
		[
			"a yield whose Seq isn't a whole number",
			(envelope) => {
				envelope.Histories[0].Entries.find((entry: { Kind: string }) => entry.Kind === "effect").Seq = "3";
			},
			"its history in the snapshot is malformed"
		]
	];

	for (const [shape, edit, detail] of shapes) {
		it(`reads ${shape} as no history: the restore resolves and the flow drops with no-history`, async () => {
			const colour = await atColour();
			const actionId = rowOf(colour, "RestoreStage/Checkout").ActionId;
			const run = await restored(edited(colour, (envelope) => edit(envelope, actionId)));
			expect(run.result.resumed).toEqual([]);
			expect(
				run.result.dropped.map((entry) => [
					entry.reason,
					entry.detail
				])
			).toEqual([
				[
					"no-history",
					expect.stringContaining(detail)
				]
			]);
			expect(plain(run.runtime).Orders.o1).toEqual(JSON.parse(colour).AppState.Orders.o1);
			run.runtime.dispose();
		});
	}

	it("isn't read from a save of another build", async () => {
		const colour = await atColour();
		const run = await restored(
			edited(colour, (envelope) => {
				envelope.Histories = {
					oops: true
				};
			}),
			{
				build: "build-2"
			}
		);
		expect(
			run.result.dropped.map((entry) => [
				entry.reason,
				entry.detail
			])
		).toEqual([
			[
				"other-build",
				undefined
			]
		]);
		run.runtime.dispose();
	});
});

describe("the test runtime", () => {
	it("forwards build and resume to the runtime it builds, so a save carries both", async () => {
		const on = live();
		const off = live({
			resume: undefined
		});
		for (const { runtime } of [
			on,
			off
		]) {
			void runtime.dispatch(checkout, "o1");
		}
		await until(() => on.w.has("size") && off.w.has("size"));
		const withResume = JSON.parse(createSnapshot(on.runtime));
		const without = JSON.parse(createSnapshot(off.runtime));
		expect([
			withResume.Build,
			without.Build
		]).toEqual([
			BUILD,
			BUILD
		]);
		expect(withResume.Histories).toHaveLength(1);
		expect(without.Histories).toBeUndefined();
		on.runtime.dispose();
		off.runtime.dispose();
	});

	it("doesn't fail a test on a drop: a restore that drops a marked action for its own doing passes under the strict preset", async () => {
		const { runtime, w } = live();
		void runtime.dispatch(checkout, "o1");
		await until(() => w.has("size"));
		w.answer("size", "M");
		await until(() => w.has("colour"));
		w.answer("colour", "red");
		await until(() => w.has("confirm"));
		w.answer("confirm", "yes");
		await until(() => w.has("pay"));
		const json = createSnapshot(runtime);
		runtime.dispose();
		const run = await restored(json);
		expect(run.result.dropped.map((entry) => entry.reason)).toEqual([
			"not-idempotent"
		]);
		expect(run.diags.map((diag) => diag.code)).toEqual([
			"resume/never-resumes"
		]);
		run.runtime.dispose();
	});

	it("fails a test on resume/tree-watched unless it allows it", async () => {
		const json = await atColour();
		const watching = (fresh: IRuntime<IShop>) => {
			reactive.root(() => {
				reactive.effect(() => {
					void fresh.state.Orders.o1!.Qty;
				});
			});
		};
		const loud = await restored(json, {
			setup: watching
		});
		loud.runtime.dispose();
		await settled();
		expect(drainReports().map((error) => error.message)).toEqual([
			expect.stringContaining('an unexpected diag, "resume/tree-watched"')
		]);
		const allowed = await restored(json, {
			setup: watching,
			allowDiags: [
				"resume/tree-watched"
			]
		});
		expect(allowed.result.dropped.map((entry) => entry.reason)).toEqual([
			"watched"
		]);
		allowed.runtime.dispose();
	});
});

describe("the diags", () => {
	const paying = async () => {
		const { runtime, w } = live();
		void runtime.dispatch(checkout, "o1");
		void runtime.dispatch(checkout, "o2");
		void runtime.dispatch(browse, "shop");
		await until(() => w.pending.length === 3);
		for (const step of [
			"size",
			"colour",
			"confirm"
		]) {
			w.answer(step, "x");
			w.answer(step, "x");
			await until(() => w.pending.filter((wait) => wait.name !== "browse").length === 2);
		}
		const json = createSnapshot(runtime);
		runtime.dispose();
		return json;
	};

	it("raise resume/never-resumes once per action name, for a drop for its own doing and for no other drop", async () => {
		const run = await restored(await paying());
		expect(run.result.dropped.map((entry) => entry.reason).sort()).toEqual([
			"not-idempotent",
			"not-idempotent",
			"not-marked"
		]);
		expect(
			run.diags.map((diag) => [
				diag.severity,
				diag.code,
				(
					diag.data as {
						name: string;
					}
				).name
			])
		).toEqual([
			[
				"warn",
				"resume/never-resumes",
				"RestoreStage/Checkout"
			]
		]);
		run.runtime.dispose();
		const colour = await atColour();
		for (const json of [
			colour,
			edited(colour, (envelope) => delete envelope.Histories)
		]) {
			const quiet = await restored(json);
			expect(quiet.diags).toEqual([]);
			quiet.runtime.dispose();
		}
	});

	for (const [flow, wait] of [
		[
			selects,
			"after select"
		],
		[
			readsGlobal,
			"after getDataGlobal"
		],
		[
			readsTransient,
			"after transient"
		],
		[
			dispatchesFromStep,
			"after dispatch"
		]
	] as const) {
		it(`raise resume/never-resumes once for ${nameOfFlow(flow)}, which drops with diverged for what its step does`, async () => {
			const { runtime, w } = live();
			dispatchingOn = runtime;
			void runtime.dispatch(flow, "o1");
			await until(() => w.has(wait));
			const json = createSnapshot(runtime);
			runtime.dispose();
			const run = await restored(json, {
				setup: (fresh) => {
					dispatchingOn = fresh;
				}
			});
			expect(run.result.dropped.map((entry) => entry.reason)).toEqual([
				"diverged"
			]);
			expect(
				run.diags.map((diag) => [
					diag.code,
					(
						diag.data as {
							name: string;
						}
					).name
				])
			).toEqual([
				[
					"resume/never-resumes",
					nameOfFlow(flow)
				]
			]);
			run.runtime.dispose();
		});
	}

	it("raise nothing for a step that does otherwise than its record, which drops with diverged", async () => {
		const { runtime, w } = live();
		void runtime.dispatch(drifts, "o1");
		await until(() => w.has("drift"));
		const json = createSnapshot(runtime);
		runtime.dispose();
		const run = await restored(json);
		expect(run.result.dropped.map((entry) => entry.reason)).toEqual([
			"diverged"
		]);
		expect(run.diags).toEqual([]);
		run.runtime.dispose();
	});

	it("raise resume/tree-watched once when a restore drops for a watched tree, and not otherwise", async () => {
		const { runtime, w } = live();
		void runtime.dispatch(checkout, "o1");
		void runtime.dispatch(checkout, "o2");
		await until(() => w.pending.length === 2);
		const json = createSnapshot(runtime);
		runtime.dispose();
		const watched = await restored(json, {
			allowDiags: [
				"resume/tree-watched"
			],
			setup: (fresh) => {
				reactive.root(() => {
					reactive.effect(() => {
						void fresh.state.Orders.o1!.Qty;
					});
				});
			}
		});
		expect(watched.result.dropped.map((entry) => entry.reason)).toEqual([
			"watched",
			"watched"
		]);
		expect(
			watched.diags.map((diag) => [
				diag.code,
				(
					diag.data as {
						count: number;
					}
				).count
			])
		).toEqual([
			[
				"resume/tree-watched",
				2
			]
		]);
		watched.runtime.dispose();
		const unwatched = await restored(json);
		expect(unwatched.result.resumed).toHaveLength(2);
		expect(unwatched.diags).toEqual([]);
		unwatched.runtime.dispose();
	});

	it("raise resume/no-build on a restored runtime with resume and no build, which resumes nothing", async () => {
		const json = await atColour();
		const diags: IRuntimeEventOf<"diag">[] = [];
		const { runtime, result } = await restoreRuntime<IShop>(json, {
			rootId: "shop",
			options: {
				resume: true
			},
			setup: (fresh) => {
				fresh.registerImplementation("RestoreStage/Ask", () => new Promise(() => {}));
				fresh.on("diag", (event) => {
					diags.push(event);
				});
			}
		});
		await Promise.resolve();
		expect(result.dropped.map((entry) => entry.reason)).toEqual([
			"other-build"
		]);
		expect(diags.map((diag) => diag.code)).toEqual([
			"resume/no-build"
		]);
		runtime.dispose();
	});
});

describe("a runtime without resume", () => {
	it("plans nothing, refuses no dispatch, and drops every row with resume-off and nothing else", async () => {
		const json = await atConfirm();
		const before = planned.calls;
		const run = await restored(json, {
			resume: false,
			repair: (runtime) => runtime.dispatch(jot, "o1", "in the repair")
		});
		expect(planned.calls).toBe(before);
		expect(run.result.resumed).toEqual([]);
		const row = (
			JSON.parse(json) as {
				InFlight: {
					ActionId: string;
				}[];
			}
		).InFlight[0]!;
		expect(run.result.dropped).toEqual([
			{
				actionId: row.ActionId,
				name: "RestoreStage/Checkout",
				label: "checkout",
				entityId: "o1",
				state: "holding",
				reason: "resume-off"
			}
		]);
		expect(run.runtime.state.Orders.o1!.Log).toEqual([
			"in the repair"
		]);
		expect(run.w.sent).toEqual([]);
		expect(run.starts.every((record) => record.ResumedFrom === undefined)).toBe(true);
		run.runtime.dispose();
		const on = await restored(json);
		expect(planned.calls).toBe(before + 1);
		on.runtime.dispose();
	});
});
