import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator, IActionYield } from "../../src/Types/IAction";
import type { IActionContext } from "../../src/Types/IActionContext";
import type { IRecord } from "../../src/Types/IRecord";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { rawOf } from "../../src/Runtime/viewProxy";
import { frameWrite, minted, treeWrite } from "../testHelpers";

type IMarkable = {
	$Id: string;
	Name: string;
	Marked?: boolean;
};

type IRow = IMarkable & {
	Kid?: IMarkable;
	Code?: string;
	Flag?: boolean;
	Fn?: unknown;
};

type IPanel = IMarkable & {
	Row?: IMarkable;
	Wrap?: {
		Row?: IMarkable;
	};
};

type IWorld = {
	$Id: string;
	Rows: IRow[];
	Other: IRow[];
	Panel: IPanel;
	Slot: {
		A?: IMarkable;
		B?: IMarkable;
	} | null;
};

type IDeferred = {
	open: (value?: unknown) => void;
	fail: (error: unknown) => void;
	signal: AbortSignal;
};

const row = (n: number): IRow => ({
	$Id: `row-${n}`,
	Name: [
		"one",
		"two",
		"three"
	][n - 1],
	Kid: {
		$Id: `kid-${n}`,
		Name: `k${n}`
	}
});

const seed = (): IWorld => ({
	$Id: "root",
	Rows: [
		row(1),
		row(2),
		row(3)
	],
	Other: [],
	Panel: {
		$Id: "panel",
		Name: "panel",
		Row: {
			$Id: "inner",
			Name: "inner"
		}
	},
	Slot: {
		A: {
			$Id: "a",
			Name: "a"
		},
		B: {
			$Id: "b",
			Name: "b"
		}
	}
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const settle = (run: Promise<unknown>): Promise<string> =>
	run.then(
		() => "resolved",
		(error: Error) => `rejected: ${error.message}`
	);

function findById(node: unknown, id: string): IMarkable | undefined {
	if (node === null || typeof node !== "object") {
		return undefined;
	}
	if ((node as IMarkable).$Id === id) {
		return node as IMarkable;
	}
	for (const value of Object.values(node)) {
		const hit = findById(value, id);
		if (hit) {
			return hit;
		}
	}
	return undefined;
}

function* gate(name: string): Generator<IActionYield, any, any> {
	return yield {
		Type: "gate",
		Name: name
	} as IActionYield;
}

function build(journal: boolean) {
	const gates: Record<string, IDeferred> = {};
	const errors: unknown[] = [];
	const runtime = createRuntime<IWorld>(seed(), {
		onError: (error) => errors.push(error),
		implementations: {
			gate: (
				effect: {
					Name: string;
				},
				action?: IActionContext
			) =>
				new Promise((resolve, reject) => {
					gates[effect.Name] = {
						open: resolve,
						fail: reject,
						signal: action!.signal
					};
				})
		}
	}) as IRuntimeInternal<IWorld>;
	const records: IRecord[] = [];
	if (journal) {
		runtime.on("record", (record) => records.push(record));
	}
	return {
		runtime,
		gates,
		errors,
		records,
		rawNode: <N extends IMarkable>(id: string) => rawOf(runtime.resolveCell(id)!.state) as N
	};
}

type IHarness = ReturnType<typeof build>;

let harness: IHarness | undefined;

function start(journal = true): IHarness {
	harness = build(journal);
	return harness;
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	harness?.runtime.dispose();
	harness = undefined;
	vi.restoreAllMocks();
});

type IRoute = {
	name: string;
	asked: string;
	move: (s: IWorld) => void;
	removesAsked?: true;
};

const routes: IRoute[] = [
	{
		name: "shift, target moved down",
		asked: "row-2",
		move: (s) => {
			s.Rows.shift();
		}
	},
	{
		name: "shift, target was last",
		asked: "row-3",
		move: (s) => {
			s.Rows.shift();
		}
	},
	{
		name: "shift, target is the removed row",
		asked: "row-1",
		removesAsked: true,
		move: (s) => {
			s.Rows.shift();
		}
	},
	{
		name: "length = 0",
		asked: "row-3",
		removesAsked: true,
		move: (s) => {
			s.Rows.length = 0;
		}
	},
	{
		name: "splice removing before the target",
		asked: "row-3",
		move: (s) => {
			s.Rows.splice(1, 1);
		}
	},
	{
		name: "splice inserting before the target",
		asked: "row-2",
		move: (s) => {
			s.Rows.splice(
				0,
				0,
				minted("new", {
					Name: "new"
				})
			);
		}
	},
	{
		name: "unshift",
		asked: "row-1",
		move: (s) => {
			s.Rows.unshift(
				minted("new", {
					Name: "new"
				})
			);
		}
	},
	{
		name: "reverse",
		asked: "row-1",
		move: (s) => {
			s.Rows.reverse();
		}
	},
	{
		name: "sort",
		asked: "row-1",
		move: (s) => {
			s.Rows.sort((a, b) => (a.Name < b.Name ? 1 : -1));
		}
	},
	{
		name: "swap",
		asked: "row-1",
		move: (s) => {
			const first = s.Rows[0];
			s.Rows[0] = s.Rows[1];
			s.Rows[1] = first;
		}
	},
	{
		name: "moved to another container",
		asked: "row-1",
		move: (s) => {
			s.Other.push(s.Rows.shift()!);
		}
	},
	{
		name: "nested entity under a shifted row",
		asked: "kid-2",
		move: (s) => {
			s.Rows.shift();
		}
	},
	{
		name: "nested entity under a shifted row, where the old keys dead-end",
		asked: "kid-3",
		move: (s) => {
			s.Rows.shift();
		}
	},
	{
		name: "nested entity under a moved row",
		asked: "kid-1",
		move: (s) => {
			s.Other.push(s.Rows.shift()!);
		}
	},
	{
		name: "object keys swapped",
		asked: "a",
		move: (s) => {
			const slot = s.Slot!;
			const first = slot.A;
			slot.A = slot.B;
			slot.B = first;
		}
	},
	{
		name: "object key deleted",
		asked: "a",
		removesAsked: true,
		move: (s) => {
			delete s.Slot!.A;
		}
	},
	{
		name: "a parent of the target set to null",
		asked: "a",
		removesAsked: true,
		move: (s) => {
			s.Slot = null;
		}
	},
	{
		name: "reparented under a new wrapper",
		asked: "inner",
		move: (s) => {
			s.Panel.Wrap = {
				Row: s.Panel.Row
			};
			delete s.Panel.Row;
		}
	},
	{
		name: "control: pop",
		asked: "row-2",
		move: (s) => {
			s.Rows.pop();
		}
	},
	{
		name: "control: an unrelated write",
		asked: "row-2",
		move: (s) => {
			s.Panel.Name = "written";
		}
	}
];

type IDrive = (h: IHarness, route: IRoute, write: (node: IMarkable) => void) => Promise<string>;

const fromSlice: IDrive = async (h, route, write) => {
	function* worker(draft: IMarkable): IActionGenerator {
		write(draft);
	}
	let inner!: Promise<unknown>;
	await h.runtime.dispatch(function* outer(draft: IWorld): IActionGenerator {
		route.move(draft);
		inner = h.runtime.dispatch(worker, route.asked);
	}, "root");
	return settle(inner);
};

const fromMutate: IDrive = (h, route, write) => {
	function* worker(draft: IMarkable): IActionGenerator {
		write(draft);
	}
	let inner!: Promise<unknown>;
	treeWrite(h.runtime, (s) => {
		route.move(s);
		inner = h.runtime.dispatch(worker, route.asked);
	});
	return settle(inner);
};

const heldSetter: IDrive = async (h, route, write) => {
	const setter = h.runtime.resolveCell(route.asked)!.setState;
	try {
		frameWrite(h.runtime, (s) => {
			route.move(s);
			setter(write);
		});
		return "resolved";
	} catch (error) {
		return `rejected: ${(error as Error).message}`;
	}
};

// A dispatch made inside a frame starts after it, so one on an entity the frame removed never runs.
const drivers: [
	string,
	boolean,
	IDrive,
	boolean
][] = [
	[
		"runtime.dispatch from an action's slice, journal on",
		true,
		fromSlice,
		true
	],
	[
		"runtime.dispatch from an action's slice, journal off",
		false,
		fromSlice,
		true
	],
	[
		"runtime.dispatch from a test write, journal on",
		true,
		fromMutate,
		true
	],
	[
		"a held cell setter from a test write, journal on",
		true,
		heldSetter,
		false
	]
];

describe.each(drivers)("%s", (_driver, journal, drive, defers) => {
	it.each(
		routes.map(
			(route) =>
				[
					route.name,
					route
				] as const
		)
	)("binds and writes the asked node: %s", async (_name, route) => {
		const h = start(journal);
		expect(h.runtime.get("runtime/journal").enabled).toBe(journal);
		const before = h.rawNode(route.asked);
		const runs = !(defers && route.removesAsked);
		const expected = seed();
		route.move(expected);
		const expectedTarget = findById(expected, route.asked);
		if (expectedTarget && runs) {
			expectedTarget.Marked = true;
		}

		const bound: (IMarkable | undefined)[] = [];
		const settled = await drive(h, route, (node) => {
			bound.push(node === undefined ? undefined : rawOf(node));
			node.Marked = true;
		});
		await tick();

		expect(settled).toBe("resolved");
		if (!runs) {
			expect(bound).toEqual([]);
			expect(before.Marked).toBeUndefined();
			expect(rawOf(h.runtime.state)).toStrictEqual(expected);
			expect(h.errors).toEqual([]);
			return;
		}
		expect(bound.map((node) => node?.$Id)).toEqual([
			route.asked
		]);
		const boundTo = before;
		expect(bound[0]).toBe(boundTo);
		expect(boundTo.Marked).toBe(true);
		expect(rawOf(h.runtime.state)).toStrictEqual(expected);
		expect(h.errors).toEqual([]);
	});
});

function* worker(draft: IRow): IActionGenerator<string> {
	yield* gate("a");
	draft.Flag = true;
	return "carried on";
}

async function askAfterShift(h: IHarness) {
	let inner!: Promise<string | undefined>;
	await h.runtime.dispatch(function* outer(draft: IWorld): IActionGenerator {
		draft.Rows.shift();
		inner = h.runtime.dispatch(worker, "row-2");
	}, "root");
	await tick();
	return {
		inner
	};
}

describe("the node binding, for an action asked for a row after a same-frame shift", () => {
	it("carries on when the row that took its old key is removed", async () => {
		const h = start();
		const { inner } = await askAfterShift(h);

		treeWrite(h.runtime, (s) => {
			s.Rows.splice(1, 1);
		});

		expect(h.gates.a.signal.aborted).toBe(false);
		h.gates.a.open();
		await expect(inner).resolves.toBe("carried on");
		expect(
			h.runtime.state.Rows.map((r) => [
				r.$Id,
				r.Flag
			])
		).toEqual([
			[
				"row-2",
				true
			]
		]);
		expect(h.errors).toEqual([]);
	});

	it("names on action:start the row that is really written", async () => {
		const h = start();
		const { inner } = await askAfterShift(h);
		h.gates.a.open();
		await inner;

		const started = h.records.find(
			(
				r
			): r is Extract<
				IRecord,
				{
					Kind: "action:start";
				}
			> => r.Kind === "action:start" && r.Name === "worker"
		)!;
		expect(h.runtime.state.Rows.filter((r) => r.Flag).map((r) => r.$Id)).toEqual([
			started.EntityId
		]);
	});
});

describe("a dispatch on a row removed in this frame", () => {
	it.each([
		[
			"after the removal",
			(s: IWorld, dispatchWorker: () => void) => {
				s.Rows.shift();
				dispatchWorker();
			}
		],
		[
			"just before the removal",
			(s: IWorld, dispatchWorker: () => void) => {
				dispatchWorker();
				s.Rows.shift();
			}
		]
	] as const)("starts after the frame, finds the row gone, and settles cancelled unrun, dispatched %s", async (_order, body) => {
		const h = start();
		const old = h.rawNode<IRow>("row-1");
		const bound: IRow[] = [];
		const started: (string | null)[] = [];
		h.runtime.on("record", (record) => {
			if (record.Kind === "action:start") {
				started.push(record.Name);
			}
		});
		function* parkedWorker(draft: IRow): IActionGenerator<string> {
			bound.push(rawOf(draft));
			draft.Marked = true;
			yield* gate("a");
			draft.Flag = true;
			return "carried on";
		}
		let inner!: Promise<string | undefined>;
		await h.runtime.dispatch(function* outer(draft: IWorld): IActionGenerator {
			body(draft, () => {
				inner = h.runtime.dispatch(parkedWorker, "row-1");
			});
		}, "root");

		expect(bound).toEqual([]);
		expect(h.gates.a).toBeUndefined();
		await expect(inner).resolves.toBeUndefined();
		expect(started).toEqual([
			"outer"
		]);

		expect(old.Marked).toBeUndefined();
		expect(old.Flag).toBeUndefined();
		expect(
			rawOf(h.runtime.state).Rows.map((r) => [
				r.$Id,
				r.Marked,
				r.Flag
			])
		).toEqual([
			[
				"row-2",
				undefined,
				undefined
			],
			[
				"row-3",
				undefined,
				undefined
			]
		]);
		expect(h.errors).toEqual([]);
	});
});

describe("a move split by a dispatch", () => {
	it("leaves an action parked on the moving row running, and the dispatch reaches its own row", async () => {
		const h = start();
		const parked = h.runtime.dispatch(worker, "row-1");
		await tick();

		function* mark(draft: IMarkable): IActionGenerator {
			draft.Marked = true;
		}
		let inner!: Promise<unknown>;
		await h.runtime.dispatch(function* mover(draft: IWorld): IActionGenerator {
			const moving = draft.Rows.shift()!;
			inner = h.runtime.dispatch(mark, "row-3");
			draft.Other.push(moving);
		}, "root");

		expect(await settle(inner)).toBe("resolved");
		expect(h.gates.a.signal.aborted).toBe(false);
		h.gates.a.open();
		await expect(parked).resolves.toBe("carried on");
		expect(
			h.runtime.state.Other.map((r) => [
				r.$Id,
				r.Flag
			])
		).toEqual([
			[
				"row-1",
				true
			]
		]);
		expect(
			h.runtime.state.Rows.map((r) => [
				r.$Id,
				r.Marked
			])
		).toEqual([
			[
				"row-2",
				undefined
			],
			[
				"row-3",
				true
			]
		]);
		expect(h.errors).toEqual([]);
	});
});

describe("the location a code write reports", () => {
	it("is the node's place from the action's own draft, with a tap or without", async () => {
		for (const journal of [
			false,
			true
		]) {
			const h = start(journal);
			function* seatFunction(draft: IRow): IActionGenerator {
				draft.Fn = () => {};
			}

			await expect(h.runtime.dispatch(seatFunction, "row-2")).rejects.toThrow(/not plain: function at \[Fn\]/);
		}
	});
});
