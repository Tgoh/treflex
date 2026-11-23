import type { IActionGenerator, IEntity, IOpenGenerator } from "../../src/index";
import type { IHistory, IHistoryEntry } from "../../src/Resume/history";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IOrder, IShop } from "./resumeHarness";
import { describe, expect, it, vi } from "vitest";
import { ask } from "../../src/Effects/ask";
import { entity } from "../../src/Effects/entity";
import { generateGuid } from "../../src/Effects/generateGuid";
import { createKeeper, MAX_HISTORY_ENTRIES } from "../../src/Resume/createKeeper";
import { resumable } from "../../src/Resume/resumable";
import { createJournal } from "../../src/Runtime/createJournal";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { answerOn, harness, kinds, shop, until, wait } from "./resumeHarness";

function* flow(draft: IOrder): IOpenGenerator {
	const address = yield* open(
		ask<string>(draft, {
			Path: "Address"
		})
	);
	const quote = yield* open(wait("quote"));
	draft.Note = `${address}:${quote}`;
	draft.Key = yield* generateGuid();
	yield* wait("reserve");
	try {
		yield* wait("pay");
	} catch {
		draft.Note = "unpaid";
	}
	yield* open(wait("confirm"));
}
named(flow, "Keeper/Flow");
resumable(flow);

function* waits(_draft: IOrder, name: string): IOpenGenerator {
	yield* open(wait(name));
}
named(waits, "Keeper/Waits");
resumable(waits);

function* unmarked(_draft: IOrder): IOpenGenerator {
	yield* open(wait("unmarked"));
}
named(unmarked, "Keeper/Unmarked");

function* setQty(draft: IOrder, qty: number): IActionGenerator {
	draft.Qty = qty;
}
function* setNote(draft: IOrder, note: string): IActionGenerator {
	draft.Note = note;
}
function* fromShop(draft: IShop, note: string): IActionGenerator {
	draft.Orders.o1!.Note = note;
}
function* tick(draft: IShop): IActionGenerator {
	draft.Clock++;
}
function* elder(draft: IShop): IOpenGenerator {
	while (true) {
		yield* open(wait("elder"));
		draft.Orders.o1!.Qty += 100;
	}
}
function* alternate(draft: IOrder, times: number): IActionGenerator {
	for (let at = 0; at < times; at++) {
		if (at % 2 === 0) {
			draft.Note = `n${at}`;
		} else {
			(
				draft as unknown as {
					Meta: object;
				}
			).Meta = {
				At: at
			};
		}
	}
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
		prev: entry.Change.Prev,
		value: entry.Change.Value
	}));

describe("the keeper", () => {
	it("keeps a flow's arguments, yields, answers, own steps and other writers' changes in its entity, in order", async () => {
		const h = harness(shop());
		const { runtime } = h;
		const order = () => runtime.state.Orders.o1!;
		const running = runtime.dispatch(flow, "o1");
		await until(() => runtime.state.Orders.o1 !== undefined && h.diags.length === 0);

		await runtime.dispatch(setQty, "o1", 2);
		await runtime.dispatch(setQty, "o1-l1", 3);
		await runtime.dispatch(fromShop, "shop", "from the shop");
		await runtime.dispatch(tick, "shop");
		await runtime.dispatch(setQty, "o2", 9);
		await answerOn(runtime, order(), "home");
		await until(() => h.waiting.some((w) => w.name === "quote"));
		await runtime.dispatch(setQty, "o1", 4);
		h.release("quote", "fast");
		await until(() => h.waiting.some((w) => w.name === "reserve"));
		await runtime.dispatch(fromShop, "shop", "while held");
		h.release("reserve");
		await until(() => h.waiting.some((w) => w.name === "pay"));
		h.fail("pay", new TypeError("declined"));
		await until(() => h.waiting.some((w) => w.name === "confirm"));

		const history = h.historyOf("Keeper/Flow");
		expect(history.Args).toEqual([]);
		expect(history.ArgsExact).toBe(true);
		expect(kinds(history)).toEqual([
			"effect",
			"other",
			"other",
			"other",
			"response",
			"effect",
			"other",
			"response",
			"step",
			"effect",
			"response",
			"step",
			"effect",
			"other",
			"response",
			"effect",
			"response",
			"step",
			"effect"
		]);
		expect(others(history)).toEqual([
			{
				at: "o1",
				path: "Qty",
				prev: 1,
				value: 2
			},
			{
				at: "o1-l1",
				path: "Qty",
				prev: 1,
				value: 3
			},
			{
				at: "o1",
				path: "Note",
				prev: "",
				value: "from the shop"
			},
			{
				at: "o1",
				path: "Qty",
				prev: 2,
				value: 4
			},
			{
				at: "o1",
				path: "Note",
				prev: "home:fast",
				value: "while held"
			}
		]);
		const entries = history.Entries;
		expect(entries[0]).toMatchObject({
			Kind: "effect",
			Descriptor: {
				Type: "ask"
			}
		});
		expect(entries[4]).toMatchObject({
			Kind: "response",
			ForSeq: (
				entries[0] as {
					Seq: number;
				}
			).Seq,
			Value: "home"
		});
		expect(entries[5]).toMatchObject({
			Kind: "effect",
			Descriptor: {
				Type: "Resume/Wait",
				Name: "quote"
			}
		});
		const changesOf = (entry: IHistoryEntry | undefined) =>
			(
				entry as Extract<
					IHistoryEntry,
					{
						Kind: "step";
					}
				>
			).Changes.map((change) => [
				change.Path.join("."),
				change.Value
			]);
		expect(changesOf(entries[8])).toEqual([
			[
				"Note",
				"home:fast"
			]
		]);
		expect(entries[9]).toMatchObject({
			Kind: "effect",
			Descriptor: {
				Type: "generateGuid"
			}
		});
		const key = (
			entries[10] as {
				Value: string;
			}
		).Value;
		expect(typeof key).toBe("string");
		expect(changesOf(entries[11])).toEqual([
			[
				"Key",
				key
			]
		]);
		expect(entries[12]).toMatchObject({
			Kind: "effect",
			Descriptor: {
				Type: "Resume/Wait",
				Name: "reserve"
			}
		});
		expect(entries[16]).toMatchObject({
			Kind: "response",
			Error: {
				Name: "TypeError",
				Message: "declined"
			}
		});
		expect(changesOf(entries[17])).toEqual([
			[
				"Note",
				"unpaid"
			]
		]);
		expect(entries[18]).toMatchObject({
			Kind: "effect",
			Descriptor: {
				Name: "confirm"
			}
		});

		h.release("confirm");
		await running;
		expect(h.envelope().Histories).toBeUndefined();
		runtime.dispose();
	});

	it("keeps the write of an action that arrived long before the marked one, made during the marked one's wait", async () => {
		const h = harness(shop());
		const { runtime } = h;
		void runtime.dispatch(elder, "shop");
		await until(() => h.waiting.some((w) => w.name === "elder"));
		void runtime.dispatch(waits, "o1", "flow");
		await until(() => h.waiting.some((w) => w.name === "flow"));
		h.release("elder");
		await until(() => runtime.state.Orders.o1!.Qty === 101);
		const history = h.historyOf("Keeper/Waits");
		expect(kinds(history)).toEqual([
			"effect",
			"other"
		]);
		expect(others(history)).toEqual([
			{
				at: "o1",
				path: "Qty",
				prev: 1,
				value: 101
			}
		]);
		runtime.dispose();
	});

	it("keeps a queued marked action's arguments, and no other writer's change until it has begun", async () => {
		const h = harness(shop());
		const { runtime } = h;
		function* holds(_draft: IOrder): IActionGenerator {
			yield* wait("hold");
		}
		void runtime.dispatch(holds, "o1");
		await until(() => h.waiting.length === 1);
		void runtime.dispatch(waits, "o1", "queued");
		await runtime.dispatch(fromShop, "shop", "before it began");
		const queued = h.historyOf("Keeper/Waits");
		expect(queued.Args).toEqual([
			"queued"
		]);
		expect(queued.Entries).toEqual([]);
		const row = h.envelope().InFlight.find((entry) => entry.Name === "Keeper/Waits");
		expect(row).toMatchObject({
			State: "queued"
		});

		h.release("hold");
		await until(() => h.waiting.some((w) => w.name === "queued"));
		await runtime.dispatch(fromShop, "shop", "after");
		expect(others(h.historyOf("Keeper/Waits"))).toEqual([
			{
				at: "o1",
				path: "Note",
				prev: "before it began",
				value: "after"
			}
		]);
		runtime.dispose();
	});

	it("keeps two marked actions on different entities apart", async () => {
		const h = harness(shop());
		const { runtime } = h;
		void runtime.dispatch(waits, "o1", "one");
		void runtime.dispatch(waits, "o2", "two");
		await until(() => h.waiting.length === 2);
		await runtime.dispatch(setQty, "o1", 5);
		await runtime.dispatch(setQty, "o2", 6);
		await runtime.dispatch(setQty, "o2-l1", 7);
		const histories = h.envelope().Histories!;
		expect(histories).toHaveLength(2);
		const [one, two] = histories as IHistory[];
		expect(one!.Args).toEqual([
			"one"
		]);
		expect(others(one!)).toEqual([
			{
				at: "o1",
				path: "Qty",
				prev: 1,
				value: 5
			}
		]);
		expect(two!.Args).toEqual([
			"two"
		]);
		expect(others(two!)).toEqual([
			{
				at: "o2",
				path: "Qty",
				prev: 1,
				value: 6
			},
			{
				at: "o2-l1",
				path: "Qty",
				prev: 1,
				value: 7
			}
		]);
		runtime.dispose();
	});

	it("keeps no history for unmarked work", async () => {
		const h = harness(shop());
		const { runtime } = h;
		void runtime.dispatch(unmarked, "o1");
		await until(() => h.waiting.length === 1);
		expect(h.envelope().Histories).toBeUndefined();
		runtime.dispose();
	});

	it("keeps no history for work on a transient or component-state entity, a delivery or an r.run", () => {
		const journal = createJournal();
		const keeper = createKeeper(true, {
			journal,
			lookup: () => ({}),
			rootNameOf: () => "AppState",
			emitDiag: () => {},
			frameOpen: () => false,
			unlisted: () => ({
				unnamed: new Map(),
				deliveries: []
			})
		});
		const start = (id: string, extra: object) =>
			journal.append({
				T: 0,
				Kind: "action:start",
				Root: "AppState",
				ActionId: id,
				Name: "Keeper/Waits",
				Label: "waits",
				EntityId: "o1",
				Path: [],
				Args: [],
				...extra
			});
		start("kept", {});
		start("transient", {
			Root: "TransientState"
		});
		start("component", {
			Root: "ComponentState"
		});
		start("delivery", {
			Receiver: "Some/Receiver"
		});
		start("run", {
			Origin: {
				Kind: "resource:run",
				Key: "k",
				OwnerId: "o1"
			}
		});
		start("deliver", {
			Origin: {
				Kind: "resource:deliver",
				Key: "k",
				OwnerId: "o1"
			}
		});
		start("unnamed", {
			Name: null
		});
		expect(
			keeper.section(
				[
					"kept",
					"transient",
					"component",
					"delivery",
					"run",
					"deliver",
					"unnamed"
				],
				() => false
			)
		).toEqual([
			{
				ActionId: "kept",
				Args: [],
				ArgsExact: true,
				Entries: [],
				Unlisted: "none",
				UnlistedLineage: [],
				Deliveries: []
			}
		]);
	});

	it("writes on a history the unnamed work and the deliveries on its entity, above it and below it, and none on a sibling", () => {
		const journal = createJournal();
		const path = (...ids: string[]) => ({
			path: ids
		});
		const delivery = (entityId: string, at: "holding" | "in-line" | "open") => ({
			Key: "Feed",
			OwnerId: entityId,
			EntityId: entityId,
			At: at
		});
		const keeper = createKeeper(true, {
			journal,
			lookup: () =>
				({
					shop: path("shop"),
					o1: path("shop", "o1"),
					"o1-l1": path("shop", "o1", "o1-l1"),
					o2: path("shop", "o2")
				}) as never,
			rootNameOf: () => "AppState",
			emitDiag: () => {},
			frameOpen: () => false,
			unlisted: () => ({
				unnamed: new Map([
					[
						"o1",
						"in-line"
					],
					[
						"shop",
						"holding"
					],
					[
						"o2",
						"holding"
					]
				]),
				deliveries: [
					delivery("o1", "open"),
					delivery("o1-l1", "holding"),
					delivery("shop", "in-line"),
					delivery("o2", "holding")
				]
			})
		});
		journal.append({
			T: 0,
			Kind: "action:start",
			Root: "AppState",
			ActionId: "kept",
			Name: "Keeper/Waits",
			Label: "waits",
			EntityId: "o1",
			Path: [],
			Args: []
		});
		expect(
			keeper.section(
				[
					"kept"
				],
				() => false
			)
		).toEqual([
			{
				ActionId: "kept",
				Args: [],
				ArgsExact: true,
				Entries: [],
				Unlisted: "in-line",
				UnlistedLineage: [
					{
						EntityId: "shop",
						Unlisted: "holding"
					}
				],
				Deliveries: [
					delivery("o1", "open"),
					delivery("o1-l1", "holding"),
					delivery("shop", "in-line")
				]
			}
		]);
	});

	it("writes no section, and asks nothing of the dispatch loop or the gateway, when no row written is a kept action", () => {
		const journal = createJournal();
		const asked: string[] = [];
		const keeper = createKeeper(true, {
			journal,
			lookup: () => {
				asked.push("lookup");
				return {};
			},
			rootNameOf: () => "AppState",
			emitDiag: () => {},
			frameOpen: () => {
				asked.push("frameOpen");
				return false;
			},
			unlisted: () => {
				asked.push("unlisted");
				return {
					unnamed: new Map(),
					deliveries: []
				};
			}
		});
		journal.append({
			T: 0,
			Kind: "action:start",
			Root: "AppState",
			ActionId: "kept",
			Name: "Keeper/Waits",
			Label: "waits",
			EntityId: "o1",
			Path: [],
			Args: []
		});
		expect(
			keeper.section(
				[
					"unmarked"
				],
				() => false
			)
		).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it("says ArgsExact exactly where the recorded arguments, as JSON, differ from what the action received", async () => {
		const same = (a: unknown, b: unknown): boolean => {
			if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
				return Object.is(a, b);
			}
			if (Array.isArray(a) !== Array.isArray(b)) {
				return false;
			}
			const keys = Object.keys(a);
			return (
				keys.length === Object.keys(b).length &&
				keys.every((key) => Object.hasOwn(b, key) && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
			);
		};
		const cases: [
			string,
			unknown[]
		][] = [
			[
				"an undefined before a set argument",
				[
					undefined,
					1
				]
			],
			[
				"a trailing undefined",
				[
					1,
					undefined
				]
			],
			[
				"an undefined field",
				[
					{
						a: undefined,
						b: 1
					}
				]
			],
			[
				"-0",
				[
					-0
				]
			],
			[
				"a nested -0",
				[
					{
						x: [
							-0
						]
					}
				]
			]
		];
		const received = new Map<string, unknown[]>();
		function* given(_draft: IOrder, label: string, ...args: unknown[]): IOpenGenerator {
			received.set(label, args);
			yield* open(wait(label));
		}
		named(given, "Keeper/Given");
		resumable(given);
		const h = harness({
			...shop(),
			Orders: Object.fromEntries(
				cases.map(([label], at) => [
					`c${at}`,
					{
						...shop().Orders.o1!,
						$Id: `c${at}`,
						Lines: {}
					}
				])
			)
		});
		cases.forEach(([label, args], at) => {
			void h.runtime.dispatch(given, `c${at}`, label, ...args);
		});
		await until(() => h.waiting.length === cases.length);
		const envelope = h.envelope();
		const found = cases.map(([label]) => {
			const row = envelope.InFlight.find(
				(entry) =>
					(
						entry as {
							EntityId?: string;
						}
					).EntityId === `c${cases.findIndex(([l]) => l === label)}`
			)!;
			const history = (envelope.Histories as IHistory[]).find((entry) => entry.ActionId === row.ActionId)!;
			const restored = (JSON.parse(JSON.stringify(history.Args)) as unknown[]).slice(1);
			return {
				label,
				received: received.get(label),
				differs: !same(received.get(label), restored),
				argsExact: history.ArgsExact
			};
		});
		expect(
			found.map(({ label, differs, argsExact }) => [
				label,
				differs,
				argsExact
			])
		).toEqual([
			[
				"an undefined before a set argument",
				true,
				false
			],
			[
				"a trailing undefined",
				false,
				true
			],
			[
				"an undefined field",
				false,
				true
			],
			[
				"-0",
				false,
				true
			],
			[
				"a nested -0",
				false,
				true
			]
		]);
		expect(found.map(({ received }) => received)).toEqual([
			[
				undefined,
				1
			],
			[
				1
			],
			[
				{
					b: 1
				}
			],
			[
				0
			],
			[
				{
					x: [
						0
					]
				}
			]
		]);
		expect(Object.is((found[3]!.received as number[])[0], 0)).toBe(true);
		expect(Object.hasOwn((found[2]!.received as object[])[0]!, "a")).toBe(false);
		h.runtime.dispose();
	});
});

describe("folding", () => {
	it("folds a repeated set of one field during one wait into one entry", async () => {
		const h = harness(shop());
		const { runtime } = h;
		void runtime.dispatch(waits, "o1", "long");
		await until(() => h.waiting.length === 1);
		for (let at = 1; at <= 50; at++) {
			await runtime.dispatch(setNote, "o1", `tick ${at}`);
		}
		expect(others(h.historyOf("Keeper/Waits"))).toEqual([
			{
				at: "o1",
				path: "Note",
				prev: "",
				value: "tick 50"
			}
		]);
		runtime.dispose();
	});

	it("merges a set of one field across a set of another during one wait, at the first one's position", async () => {
		const h = harness(shop());
		const { runtime } = h;
		void runtime.dispatch(waits, "o1", "long");
		await until(() => h.waiting.length === 1);
		await runtime.dispatch(setNote, "o1", "a");
		await runtime.dispatch(setQty, "o1", 2);
		await runtime.dispatch(setNote, "o1", "b");
		await runtime.dispatch(setQty, "o1", 3);
		expect(others(h.historyOf("Keeper/Waits"))).toEqual([
			{
				at: "o1",
				path: "Note",
				prev: "",
				value: "b"
			},
			{
				at: "o1",
				path: "Qty",
				prev: 1,
				value: 3
			}
		]);
		runtime.dispose();
	});

	it("starts a new entry after the action's next own entry", async () => {
		const h = harness(shop());
		const { runtime } = h;
		function* twice(_draft: IOrder): IOpenGenerator {
			yield* open(wait("first"));
			yield* open(wait("second"));
		}
		named(twice, "Keeper/Twice");
		resumable(twice);
		void runtime.dispatch(twice, "o1");
		await until(() => h.waiting.length === 1);
		await runtime.dispatch(setNote, "o1", "a");
		await runtime.dispatch(setNote, "o1", "b");
		h.release("first");
		await until(() => h.waiting.some((w) => w.name === "second"));
		await runtime.dispatch(setNote, "o1", "c");
		const history = h.historyOf("Keeper/Twice");
		expect(kinds(history)).toEqual([
			"effect",
			"other",
			"response",
			"effect",
			"other"
		]);
		expect(others(history)).toEqual([
			{
				at: "o1",
				path: "Note",
				prev: "",
				value: "b"
			},
			{
				at: "o1",
				path: "Note",
				prev: "b",
				value: "c"
			}
		]);
		runtime.dispose();
	});
});

interface IRow extends IEntity {
	Qty: number;
	Tag: string;
	b?: number;
	Options: {
		A: number;
		B: number;
	};
}

interface IWide extends IEntity {
	Qty: number;
	Note: string;
	Tags: string[];
	Meta: {
		N: number;
	};
	"a.b": number;
	a: {
		b: number;
	};
	Rows: Record<string, IRow>;
}

const row = (id: string): IRow => ({
	$Id: id,
	Qty: 1,
	Tag: "",
	b: 0,
	Options: {
		A: 0,
		B: 0
	}
});

function wide(id = "o1"): {
	$Id: string;
	Orders: Record<string, IWide>;
} {
	return {
		$Id: "shop",
		Orders: {
			[id]: {
				$Id: id,
				Qty: 1,
				Note: "",
				Tags: [
					"x",
					"y"
				],
				Meta: {
					N: 0
				},
				"a.b": 0,
				a: {
					b: 0
				},
				Rows: {
					[`${id}-r0`]: row(`${id}-r0`),
					[`${id}.a`]: row(`${id}.a`),
					[`${id}","a`]: row(`${id}","a`)
				}
			}
		}
	};
}

function* change(draft: IWide, how: string, n: number): IActionGenerator {
	switch (how) {
		case "note":
			draft.Note = `n${n}`;
			break;
		case "object note":
			(
				draft as unknown as {
					Note: object;
				}
			).Note = {
				V: n
			};
			break;
		case "null note":
			(
				draft as unknown as {
					Note: string | null;
				}
			).Note = null;
			break;
		case "qty":
			draft.Qty = n;
			break;
		case "create":
			draft.Rows[`made${n}`] = yield* entity<IRow>({
				Qty: n,
				Tag: "",
				Options: {
					A: 0,
					B: 0
				}
			});
			break;
		case "delete":
			delete draft.Rows[`${draft.$Id}-r0`];
			break;
		case "push":
			draft.Tags.push(`t${n}`);
			break;
		case "object":
			draft.Meta = {
				N: n
			};
			break;
		case "same length":
			draft.Tags.length = draft.Tags.length - 0;
			break;
		case "dot":
			draft["a.b"] = n;
			break;
		case "nested":
			draft.a.b = n;
			break;
		case "dotted entity":
			draft.Rows[`${draft.$Id}.a`]!.b = n;
			break;
		case "quoted entity":
			draft.Rows[`${draft.$Id}","a`]!.b = n;
			break;
		case "options": {
			const polled = draft.Rows[`${draft.$Id}-r0`]!;
			polled.Options.A = n;
			polled.Options.B = n + 1;
			break;
		}
	}
}

function* onRow(draft: IRow, how: string, n: number): IActionGenerator {
	if (how === "qty") {
		draft.Qty = n;
	} else {
		draft.Tag = `t${n}`;
	}
}

function* waitsOn(_draft: IEntity, name: string): IOpenGenerator {
	yield* open(wait(name));
}
named(waitsOn, "Keeper/WaitsOn");
resumable(waitsOn);

const placed = (history: IHistory) =>
	history.Entries.filter(
		(
			entry
		): entry is Extract<
			IHistoryEntry,
			{
				Kind: "other";
			}
		> => entry.Kind === "other"
	).map((entry) => [
		entry.Change.Landing!.EntityId,
		entry.Change.Landing!.Path,
		entry.Change.Prev,
		entry.Change.Value
	]);

describe("merging per place", () => {
	async function between(how: string) {
		const h = harness(wide());
		const { runtime } = h;
		void runtime.dispatch(waitsOn, "o1", "long");
		await until(() => h.waiting.length === 1);
		await runtime.dispatch(change, "o1", "note", 1);
		await runtime.dispatch(change, "o1", how, 5);
		await runtime.dispatch(change, "o1", "note", 2);
		const notes = placed(h.historyOf("Keeper/WaitsOn")).filter(([, path]) => (path as string[]).join() === "Note");
		runtime.dispose();
		return notes;
	}

	it("merges across another place's plain set, and not across a creation, a deletion, a push or a set of an object", async () => {
		expect(await between("qty")).toEqual([
			[
				"o1",
				[
					"Note"
				],
				"",
				"n2"
			]
		]);
		for (const how of [
			"create",
			"delete",
			"push",
			"object"
		]) {
			expect([
				how,
				await between(how)
			]).toEqual([
				how,
				[
					[
						"o1",
						[
							"Note"
						],
						"",
						"n1"
					],
					[
						"o1",
						[
							"Note"
						],
						"n1",
						"n2"
					]
				]
			]);
		}
	});

	it("merges a set of an array's length that changes nothing, and across it", async () => {
		const h = harness(wide());
		const { runtime } = h;
		void runtime.dispatch(waitsOn, "o1", "long");
		await until(() => h.waiting.length === 1);
		for (const how of [
			"note",
			"same length",
			"qty",
			"same length",
			"note"
		]) {
			await runtime.dispatch(change, "o1", how, 3);
		}
		await runtime.dispatch(change, "o1", "note", 4);
		expect(placed(h.historyOf("Keeper/WaitsOn"))).toEqual([
			[
				"o1",
				[
					"Note"
				],
				"",
				"n4"
			],
			[
				"o1",
				[
					"Tags",
					"length"
				],
				2,
				2
			],
			[
				"o1",
				[
					"Qty"
				],
				1,
				3
			]
		]);
		runtime.dispose();
	});

	it("doesn't merge across a set of an object that folded into the entry right before it", async () => {
		const h = harness(wide());
		const { runtime } = h;
		void runtime.dispatch(waitsOn, "o1", "long");
		await until(() => h.waiting.length === 1);
		for (const [how, n] of [
			[
				"qty",
				2
			],
			[
				"note",
				1
			],
			[
				"object note",
				5
			],
			[
				"qty",
				3
			]
		] as const) {
			await runtime.dispatch(change, "o1", how, n);
		}
		expect(placed(h.historyOf("Keeper/WaitsOn"))).toEqual([
			[
				"o1",
				[
					"Qty"
				],
				1,
				2
			],
			[
				"o1",
				[
					"Note"
				],
				"",
				{
					V: 5
				}
			],
			[
				"o1",
				[
					"Qty"
				],
				2,
				3
			]
		]);
		runtime.dispose();
	});

	it("merges a set to null and a set from null as it does any scalar's", async () => {
		const h = harness(wide());
		const { runtime } = h;
		void runtime.dispatch(waitsOn, "o1", "long");
		await until(() => h.waiting.length === 1);
		for (const [how, n] of [
			[
				"note",
				1
			],
			[
				"qty",
				2
			],
			[
				"null note",
				0
			],
			[
				"qty",
				3
			],
			[
				"note",
				4
			]
		] as const) {
			await runtime.dispatch(change, "o1", how, n);
		}
		expect(placed(h.historyOf("Keeper/WaitsOn"))).toEqual([
			[
				"o1",
				[
					"Note"
				],
				"",
				"n4"
			],
			[
				"o1",
				[
					"Qty"
				],
				1,
				3
			]
		]);
		runtime.dispose();
	});

	it("ends a run at each of the action's own entries: a step, a yield and an answer", () => {
		const run = (own: (journal: ReturnType<typeof createJournal>, yielded: number) => void) => {
			const journal = createJournal();
			const keeper = createKeeper(true, {
				journal,
				lookup: () =>
					({
						o1: {
							path: [
								"shop",
								"o1"
							]
						}
					}) as never,
				rootNameOf: () => "AppState",
				emitDiag: () => {},
				frameOpen: () => false,
				unlisted: () => ({
					unnamed: new Map(),
					deliveries: []
				})
			});
			journal.append({
				T: 0,
				Kind: "action:start",
				Root: "AppState",
				ActionId: "kept",
				Name: "Keeper/WaitsOn",
				Label: "waitsOn",
				EntityId: "o1",
				Path: [],
				Args: []
			});
			const yielded = journal.append({
				T: 0,
				Kind: "effect",
				Root: "AppState",
				ActionId: "kept",
				BranchId: "b",
				Type: "Resume/Wait",
				Descriptor: {
					Type: "Resume/Wait",
					Name: "w"
				}
			});
			const set = (path: string, prev: unknown, value: unknown) =>
				journal.append({
					T: 0,
					Kind: "step",
					Root: "AppState",
					ActionId: "writer",
					BranchId: "w",
					Changes: [
						{
							Path: [
								path
							],
							Prev: prev,
							Value: value,
							Landing: {
								EntityId: "o1",
								Path: [
									path
								]
							}
						}
					]
				});
			set("Note", "", "a");
			set("Qty", 1, 2);
			own(journal, yielded);
			set("Note", "a", "b");
			const [history] = keeper.section(
				[
					"kept"
				],
				() => false
			)! as IHistory[];
			return [
				kinds(history!).join(),
				placed(history!).length
			];
		};
		expect(run(() => {})).toEqual([
			"effect,other,other",
			2
		]);
		expect(
			run((journal) =>
				journal.append({
					T: 0,
					Kind: "step",
					Root: "AppState",
					ActionId: "kept",
					BranchId: "b",
					Changes: []
				})
			)
		).toEqual([
			"effect,other,other,step,other",
			3
		]);
		expect(
			run((journal) =>
				journal.append({
					T: 0,
					Kind: "effect",
					Root: "AppState",
					ActionId: "kept",
					BranchId: "b",
					Type: "Resume/Wait",
					Descriptor: {
						Type: "Resume/Wait",
						Name: "again"
					}
				})
			)
		).toEqual([
			"effect,other,other,effect,other",
			3
		]);
		expect(
			run((journal, yielded) =>
				journal.append({
					T: 0,
					Kind: "response",
					Root: "AppState",
					ForSeq: yielded,
					Value: "answer"
				})
			)
		).toEqual([
			"effect,other,other,response,other",
			3
		]);
	});

	it("keeps places apart whose keys a join would make one: a dotted key and a path, and entity ids holding a dot or a quote", async () => {
		const h = harness(wide("x"));
		const { runtime } = h;
		void runtime.dispatch(waitsOn, "x", "keys");
		await until(() => h.waiting.length === 1);
		for (let n = 1; n <= 8; n++) {
			await runtime.dispatch(
				change,
				"x",
				[
					"dot",
					"nested",
					"dotted entity",
					"quoted entity"
				][n % 4]!,
				n
			);
		}
		expect(placed(h.historyOf("Keeper/WaitsOn"))).toEqual([
			[
				"x",
				[
					"a",
					"b"
				],
				0,
				5
			],
			[
				"x.a",
				[
					"b"
				],
				0,
				6
			],
			[
				'x","a',
				[
					"b"
				],
				0,
				7
			],
			[
				"x",
				[
					"a.b"
				],
				0,
				8
			]
		]);
		runtime.dispose();
	});

	it("changes no record a tap holds, with marked actions on an order and its row each keeping the other's writes", async () => {
		function* parent(draft: IWide): IOpenGenerator {
			yield* open(wait("parent 1"));
			draft.Rows["o1-r0"]!.Qty = 50;
			draft.Rows["o1-r0"]!.Tag = "from the parent";
			yield* open(wait("parent 2"));
		}
		named(parent, "Keeper/Parent");
		resumable(parent);
		function* child(draft: IRow): IOpenGenerator {
			yield* open(wait("child 1"));
			draft.Qty = 70;
			draft.Tag = "from the child";
			yield* open(wait("child 2"));
		}
		named(child, "Keeper/Child");
		resumable(child);
		const h = harness(wide());
		const { runtime } = h;
		const taken: {
			record: unknown;
			json: string;
		}[] = [];
		runtime.on("record", (record) => {
			taken.push({
				record,
				json: JSON.stringify(record)
			});
		});
		void runtime.dispatch(parent, "o1");
		void runtime.dispatch(child, "o1-r0");
		await until(() => h.waiting.length === 2);
		let n = 0;
		const rotate = async (times: number) => {
			for (let at = 0; at < times; at++) {
				n++;
				if (at % 3 === 2) {
					await runtime.dispatch(change, "o1", "qty", n);
				} else {
					await runtime.dispatch(onRow, "o1-r0", at % 3 === 0 ? "qty" : "tag", n);
				}
			}
		};
		await rotate(6);
		h.release("parent 1");
		await until(() => h.waiting.some((w) => w.name === "parent 2"));
		await rotate(6);
		h.release("child 1");
		await until(() => h.waiting.some((w) => w.name === "child 2"));
		await rotate(6);
		expect(taken.length).toBeGreaterThan(20);
		for (const { record, json } of taken) {
			expect(JSON.stringify(record)).toBe(json);
		}
		const parentHistory = h.historyOf("Keeper/Parent");
		const childHistory = h.historyOf("Keeper/Child");
		expect(kinds(parentHistory)).toEqual([
			"effect",
			"other",
			"other",
			"other",
			"response",
			"step",
			"effect",
			"other",
			"other",
			"other"
		]);
		expect(kinds(childHistory)).toEqual([
			"effect",
			"other",
			"other",
			"response",
			"step",
			"effect",
			"other",
			"other"
		]);
		const rowSet = (path: string, prev: unknown, value: unknown) => [
			"o1-r0",
			[
				path
			],
			prev,
			value
		];
		expect(placed(childHistory)).toEqual([
			rowSet("Qty", 1, 10),
			rowSet("Tag", "", "t11"),
			rowSet("Qty", 70, 16),
			rowSet("Tag", "from the child", "t17")
		]);
		expect(placed(parentHistory)).toEqual([
			rowSet("Qty", 1, 4),
			rowSet("Tag", "", "t5"),
			[
				"o1",
				[
					"Qty"
				],
				1,
				6
			],
			rowSet("Qty", 50, 16),
			rowSet("Tag", "from the parent", "t17"),
			[
				"o1",
				[
					"Qty"
				],
				6,
				18
			]
		]);
		runtime.dispose();
	});

	it("keeps one entry per place for a parent writing two fields of a marked child on each poll", async () => {
		const h = harness(wide());
		const { runtime } = h;
		void runtime.dispatch(waitsOn, "o1-r0", "polled");
		await until(() => h.waiting.length === 1);
		for (let poll = 1; poll <= 200; poll++) {
			await runtime.dispatch(change, "o1", "options", poll);
		}
		const history = h.historyOf("Keeper/WaitsOn");
		expect(placed(history)).toEqual([
			[
				"o1-r0",
				[
					"Options",
					"A"
				],
				0,
				200
			],
			[
				"o1-r0",
				[
					"Options",
					"B"
				],
				0,
				201
			]
		]);
		expect(JSON.stringify(history).length).toBeLessThan(1000);
		runtime.dispose();
	});
});

describe("the history budget", () => {
	it("counts the budget in UTF-8 bytes, not characters", async () => {
		const run = async (budget: number) => {
			const h = harness(shop(), {
				resume: {
					budget
				}
			});
			void h.runtime.dispatch(waits, "o1", "wide");
			await until(() => h.waiting.length === 1);
			await h.runtime.dispatch(setNote, "o1", "é€".repeat(100));
			const [history] = h.envelope().Histories!;
			h.runtime.dispose();
			return history!;
		};
		const json = JSON.stringify(await run(1e9));
		const bytes = new TextEncoder().encode(json).byteLength;
		expect(bytes).toBeGreaterThan(json.length + 200);
		expect("Entries" in (await run(bytes))).toBe(true);
		expect(await run(json.length)).toMatchObject({
			Unusable: "over-budget"
		});
		expect(await run(bytes - 1)).toMatchObject({
			Unusable: "over-budget"
		});
	});

	it("leaves a history over the byte budget out of the envelope, marked, and raises resume/over-budget once for the action's name", async () => {
		const h = harness(shop(), {
			resume: {
				budget: 400
			}
		});
		const { runtime } = h;
		void runtime.dispatch(waits, "o1", "a");
		void runtime.dispatch(waits, "o2", "b");
		await until(() => h.waiting.length === 2);
		expect((h.envelope().Histories as IHistory[]).every((history) => "Entries" in history)).toBe(true);
		await runtime.dispatch(setNote, "o1", "x".repeat(400));
		await runtime.dispatch(setNote, "o2", "y".repeat(400));
		const envelope = h.envelope();
		expect(envelope.Histories).toEqual(
			envelope.InFlight.map((row) => ({
				ActionId: row.ActionId,
				Unusable: "over-budget",
				Unlisted: "none",
				UnlistedLineage: [],
				Deliveries: []
			}))
		);
		await runtime.dispatch(setNote, "o1", "short");
		expect(h.envelope().Histories).toEqual(envelope.Histories);
		expect(
			h.diags.map((diag) => [
				diag.code,
				diag.data
			])
		).toEqual([
			[
				"resume/over-budget",
				{
					name: "Keeper/Waits",
					actionId: envelope.InFlight[0]!.ActionId,
					entityId: "o1",
					limit: "budget"
				}
			]
		]);
		runtime.dispose();
	});

	describe("the total across a snapshot's histories", () => {
		const sized = async (
			total: number | undefined,
			names: [
				string,
				string
			][]
		) => {
			const h = harness(shop(), {
				resume:
					total === undefined
						? true
						: {
								total
							}
			});
			for (const [on, name] of names) {
				void h.runtime.dispatch(waits, on, name);
			}
			await until(() => h.waiting.length === names.length);
			return h;
		};
		const NAMES: [
			string,
			string
		][] = [
			[
				"o1",
				"a".repeat(300)
			],
			[
				"o2",
				"b".repeat(600)
			],
			[
				"o1-l1",
				"c".repeat(100)
			]
		];
		const sizesOf = async (
			names: [
				string,
				string
			][]
		) => {
			const h = await sized(1e9, names);
			const sizes = h.envelope().Histories!.map((history) => new TextEncoder().encode(JSON.stringify(history)).byteLength);
			h.runtime.dispose();
			return sizes;
		};
		const usable = (histories: IHistory[] | undefined) =>
			(histories ?? []).map((history) =>
				"Entries" in history
					? "kept"
					: (
							history as {
								Unusable: string;
							}
						).Unusable
			);

		it("leaves the largest out first, each marked over-budget, until the rest fit", async () => {
			const [a, b, c] = (await sizesOf(NAMES)) as [
				number,
				number,
				number
			];
			expect(b).toBeGreaterThan(a);
			expect(a).toBeGreaterThan(c);
			for (const [total, want] of [
				[
					a + b + c,
					[
						"kept",
						"kept",
						"kept"
					]
				],
				[
					a + b + c - 1,
					[
						"kept",
						"over-budget",
						"kept"
					]
				],
				[
					a + c,
					[
						"kept",
						"over-budget",
						"kept"
					]
				],
				[
					a + c - 1,
					[
						"over-budget",
						"over-budget",
						"kept"
					]
				],
				[
					c - 1,
					[
						"over-budget",
						"over-budget",
						"over-budget"
					]
				]
			] as const) {
				const h = await sized(total, NAMES);
				expect([
					total,
					usable(h.envelope().Histories as IHistory[])
				]).toEqual([
					total,
					want
				]);
				expect(
					h.diags.map((diag) => [
						diag.code,
						(
							diag.data as {
								limit: string;
							}
						).limit
					])
				).toEqual(
					(want as readonly string[]).includes("over-budget")
						? [
								[
									"resume/over-budget",
									"total"
								]
							]
						: []
				);
				h.runtime.dispose();
			}
		});

		it("leaves a snapshot under the total as it would be with no total", async () => {
			const [a, b, c] = (await sizesOf(NAMES)) as [
				number,
				number,
				number
			];
			const under = await sized(a + b + c, NAMES);
			const unbounded = await sized(1e9, NAMES);
			expect(under.envelope().Histories).toEqual(unbounded.envelope().Histories);
			under.runtime.dispose();
			unbounded.runtime.dispose();
		});

		it("of two equal sizes, leaves the later row out first", async () => {
			const twins: [
				string,
				string
			][] = [
				[
					"o1",
					"a".repeat(300)
				],
				[
					"o2",
					"b".repeat(300)
				]
			];
			const [a, b] = (await sizesOf(twins)) as [
				number,
				number
			];
			expect(a).toBe(b);
			const h = await sized(a + b - 1, twins);
			expect(usable(h.envelope().Histories as IHistory[])).toEqual([
				"kept",
				"over-budget"
			]);
			h.runtime.dispose();
		});

		it("stops keeping a history it left out, so it stays marked once the rest would fit", async () => {
			const [a, b, c] = (await sizesOf(NAMES)) as [
				number,
				number,
				number
			];
			const h = await sized(a + b + c - 1, NAMES);
			expect(usable(h.envelope().Histories as IHistory[])).toEqual([
				"kept",
				"over-budget",
				"kept"
			]);
			h.release("a".repeat(300));
			await until(() => h.envelope().InFlight.length === 2);
			expect(usable(h.envelope().Histories as IHistory[])).toEqual([
				"over-budget",
				"kept"
			]);
			h.runtime.dispose();
		});

		it("is 512KB by default", async () => {
			const many: [
				string,
				string
			][] = Array.from(
				{
					length: 9
				},
				(
					_,
					at
				): [
					string,
					string
				] => [
					at < 2 ? `o${at + 1}` : at < 4 ? `o${at - 1}-l1` : "shop",
					String(at).repeat(30_000)
				]
			);
			const sizes = await sizesOf(many);
			const sum = sizes.reduce((total, size) => total + size, 0);
			expect(sum).toBeGreaterThan(512 * 1024);
			expect(sum - Math.min(...sizes)).toBeLessThanOrEqual(512 * 1024);
			const past = await sized(undefined, many);
			expect(usable(past.envelope().Histories as IHistory[]).filter((state) => state === "over-budget")).toHaveLength(1);
			past.runtime.dispose();
		});
	});

	it("stops keeping a history past the entry cap, marked the same way", async () => {
		const h = harness(shop(), {
			resume: {
				budget: 1e9,
				total: 1e9
			}
		});
		const { runtime } = h;
		void runtime.dispatch(waits, "o1", "capped");
		await until(() => h.waiting.length === 1);
		await runtime.dispatch(alternate, "o1", MAX_HISTORY_ENTRIES - 1);
		expect("Entries" in h.envelope().Histories![0]!).toBe(true);
		await runtime.dispatch(alternate, "o1", 2);
		expect(
			h.diags.map((diag) => [
				diag.code,
				(
					diag.data as {
						limit: string;
					}
				).limit
			])
		).toEqual([
			[
				"resume/over-budget",
				"entries"
			]
		]);
		expect(h.envelope().Histories).toEqual([
			{
				ActionId: h.envelope().InFlight[0]!.ActionId,
				Unusable: "over-budget",
				Unlisted: "none",
				UnlistedLineage: [],
				Deliveries: []
			}
		]);
		runtime.dispose();
	});
});

describe("the option", () => {
	it("keeps histories with no build, and raises resume/no-build once, after construction", async () => {
		const h = harness(shop(), {
			build: undefined
		});
		expect(h.diags).toEqual([]);
		void h.runtime.dispatch(waits, "o1", "unbuilt");
		await until(() => h.waiting.length === 1);
		expect(h.historyOf("Keeper/Waits").Args).toEqual([
			"unbuilt"
		]);
		await h.runtime.dispatch(setNote, "o1", "again");
		expect(
			h.diags.map((diag) => [
				diag.severity,
				diag.code
			])
		).toEqual([
			[
				"warn",
				"resume/no-build"
			]
		]);
		h.runtime.dispose();
	});

	it("raises no resume/no-build with a build, with resume off, or once disposed before its microtask", async () => {
		const built = harness(shop());
		const off = harness(shop(), {
			build: undefined,
			resume: undefined
		});
		const disposed = harness(shop(), {
			build: undefined
		});
		disposed.runtime.dispose();
		await Promise.resolve();
		await Promise.resolve();
		expect([
			built.diags,
			off.diags,
			disposed.diags
		]).toEqual([
			[],
			[],
			[]
		]);
		built.runtime.dispose();
		off.runtime.dispose();
	});

	it("raises no resume/no-build for a runtime whose resume value was refused", async () => {
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(() =>
				createRuntime(shop(), {
					resume: {
						budget: -1
					}
				} as never)
			).toThrow(TypeError);
			await Promise.resolve();
			await Promise.resolve();
			expect(warned.mock.calls.filter(([message]) => String(message).includes("no build"))).toEqual([]);
		} finally {
			warned.mockRestore();
		}
	});

	it("refuses a value that is neither true, false nor { budget, total }, and takes either alone", () => {
		for (const resume of [
			{
				budget: -1
			},
			{
				total: 0
			},
			{
				total: Number.POSITIVE_INFINITY
			},
			{
				budget: 1000,
				total: "512KB"
			},
			[]
		]) {
			expect(() =>
				harness(shop(), {
					resume: resume as never
				})
			).toThrow(/positive number of bytes/);
		}
		for (const resume of [
			{},
			{
				total: 1000
			},
			{
				budget: 1000
			}
		]) {
			harness(shop(), {
				resume
			}).runtime.dispose();
		}
		expect(() =>
			harness(shop(), {
				resume: "yes" as never
			})
		).toThrow(/positive number of bytes/);
	});

	it("keeps nothing when off", async () => {
		const h = harness(shop(), {
			resume: false
		});
		void h.runtime.dispatch(waits, "o1", "off");
		await until(() => h.waiting.length === 1);
		expect(h.envelope().Histories).toBeUndefined();
		h.runtime.dispose();
	});

	it("taps the records only when on", () => {
		const tapped = (resume: unknown) => {
			const h = harness(shop(), {
				resume: resume as never
			});
			const enabled = (h.runtime as IRuntimeInternal<IShop>).get("runtime/journal").enabled;
			h.runtime.dispose();
			return enabled;
		};
		expect(
			[
				undefined,
				false,
				true,
				{
					budget: 1000
				}
			].map(tapped)
		).toEqual([
			false,
			false,
			true,
			true
		]);
	});
});
