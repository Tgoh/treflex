import type { IActionGenerator, IEntity, IOpenGenerator } from "../../src/index";
import type { appendOther, IStretch } from "../../src/Resume/fold";
import type { IHistory, IHistoryEntry, ISnapshotHistory } from "../../src/Resume/history";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IRecordChange } from "../../src/Types/IRecord";
import { describe, expect, it, vi } from "vitest";
import { entity } from "../../src/Effects/entity";
import { resumable } from "../../src/Resume/resumable";
import { entityRewind, RewindRefusedError } from "../../src/Resume/rewind";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { transient } from "../../src/Runtime/transient";
import { rawOf } from "../../src/Runtime/viewProxy";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreTestRuntime } from "../../src/Snapshot/index";
import { harness, until, wait } from "./resumeHarness";

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

type IAppendOther = typeof appendOther;

const appended = vi.hoisted(() => ({
	log: new Map<
		object,
		{
			owns: number;
			change: unknown;
		}[]
	>(),
	mergedAcross: 0,
	original: null as IAppendOther | null
}));

vi.mock(import("../../src/Resume/fold"), async (importOriginal) => {
	const original = await importOriginal();
	appended.original = original.appendOther;
	return {
		...original,
		appendOther: (...args: Parameters<IAppendOther>) => {
			const [entries, change] = args;
			const log = appended.log.get(entries) ?? [];
			appended.log.set(entries, log);
			log.push({
				owns: entries.filter((entry) => entry.Kind !== "other").length,
				change
			});
			const before = [
				...entries
			];
			const added = original.appendOther(...args);
			if (!added && entries[entries.length - 1] === before[before.length - 1]) {
				appended.mergedAcross++;
			}
			return added;
		}
	};
});

const RUNS = Number(host?.env?.TREFLEX_REWIND_RUNS ?? 30);
const ROUNDS = 5;
const MOVED_OUT = "[treflex] resume: … would be put back in … while it lives in AppState outside it";
const COPY = "[treflex] resume: … is not as the history's copy of it";
const LANDS_OUTSIDE = "[treflex] resume: a change lands in …, which the tree holds outside …";
const CAME_BACK = "and would be put back in it";

interface IPart extends IEntity {
	W: number;
}
interface ILine extends IEntity {
	Qty: number;
	Notes: string[];
	Parts: IPart[];
	Tag?: string | null;
}
interface IOrder extends IEntity {
	Qty: number;
	Note: string;
	Maybe?: string | null;
	Tags: string[];
	Meta: {
		Text?: string;
		N?: number;
	};
	Lines: ILine[];
	Spare: Record<string, ILine>;
	Box: {
		Held: ILine | null;
		Extra?: number;
	};
	Flip:
		| string
		| {
				V: number;
		  };
}
interface IShop extends IEntity {
	Clock: number;
	Orders: Record<string, IOrder>;
}

const line = (id: string, qty: number): ILine => ({
	$Id: id,
	Qty: qty,
	Notes: [],
	Parts: [
		{
			$Id: `${id}-p1`,
			W: 1
		}
	],
	Tag: "t"
});

const order = (id: string): IOrder => ({
	$Id: id,
	Qty: 1,
	Note: "",
	Maybe: null,
	Tags: [
		"a",
		"b"
	],
	Meta: {
		Text: "",
		N: 0
	},
	Lines: [
		line(`${id}-l1`, 1),
		line(`${id}-l2`, 2),
		line(`${id}-l3`, 3)
	],
	Spare: {
		[`${id}-l5`]: line(`${id}-l5`, 5),
		[`${id}-l6`]: line(`${id}-l6`, 6)
	},
	Box: {
		Held: line(`${id}-l4`, 4),
		Extra: 0
	},
	Flip: "s"
});

const seed = (): IShop => ({
	$Id: "shop",
	Clock: 0,
	Orders: {
		o1: order("o1"),
		o2: order("o2")
	}
});

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

function* refreshSpare(d: IOrder, at: number, n: number, mints: boolean): IActionGenerator {
	const spare = Object.keys(d.Spare);
	const fresh: Record<
		string,
		{
			Qty: number;
		}
	> = {};
	spare.forEach((key, i) => {
		if (i !== at % spare.length) {
			fresh[key] = {
				Qty: n + i
			};
		}
	});
	if (mints) {
		fresh[`r${n}`] = {
			Qty: n
		};
	}
	yield* reconcileRows(d.Spare, fresh, {
		add: () =>
			entity<ILine>({
				Qty: 0,
				Notes: [],
				Parts: []
			}),
		update(row, item) {
			row.Qty = item.Qty;
		}
	});
}

function* flow(d: IOrder, mints: boolean): IOpenGenerator {
	d.Qty += 1;
	for (let round = 0; round < ROUNDS; round++) {
		yield* open(wait(`flow${round}`));
		switch (round % 4) {
			case 0:
				d.Tags.push(`f${round}`);
				d.Meta.N = (d.Meta.N ?? 0) + 1;
				break;
			case 1:
				d.Lines.reverse();
				break;
			case 2:
				if (d.Lines[0]) {
					d.Lines[0].Qty += 10;
					if (d.Lines[0].Parts[0]) {
						d.Lines[0].Parts[0].W += 1;
					}
				}
				d.Note = `f${round}`;
				delete d.Meta.Text;
				break;
			default:
				if (d.Lines.length > 1) {
					d.Lines.splice(1, 1);
				}
				d.Tags.length = Math.max(0, d.Tags.length - 1);
				d.Maybe = null;
				yield* refreshSpare(d, 0, round, mints);
		}
		if (mints && round === 2) {
			d.Lines.push(
				yield* entity<ILine>({
					Qty: 100,
					Notes: [],
					Parts: []
				})
			);
		}
	}
}
named(flow, "Rewind/Flow");
resumable(flow);

function* onOrder(d: IOrder, op: number, at: number, n: number): IActionGenerator {
	const lines = d.Lines;
	const spare = Object.keys(d.Spare);
	switch (op) {
		case 0:
			d.Qty = n;
			break;
		case 1:
			d.Note = `n${n}`;
			break;
		case 2:
			d.Tags.push(`t${n}`);
			break;
		case 3:
			d.Tags.splice(at % (d.Tags.length + 1), 1, `s${n}`, `u${n}`);
			break;
		case 4:
			d.Tags.reverse();
			break;
		case 5:
			lines.splice(
				at % (lines.length + 1),
				0,
				yield* entity<ILine>({
					Qty: n,
					Notes: [],
					Parts: []
				})
			);
			break;
		case 6:
			if (lines.length > 0) {
				lines.splice(at % lines.length, 1);
			}
			break;
		case 7:
			if (lines.length > 0) {
				lines[at % lines.length] = yield* entity<ILine>({
					Qty: n,
					Notes: [
						"fresh"
					],
					Parts: []
				});
			}
			break;
		case 8:
			if (lines.length > 0) {
				const [moved] = lines.splice(at % lines.length, 1);
				d.Spare[moved!.$Id] = moved!;
			}
			break;
		case 9:
			if (spare.length > 0) {
				const key = spare[at % spare.length]!;
				const moved = d.Spare[key]!;
				delete d.Spare[key];
				lines.splice(at % (lines.length + 1), 0, moved);
			}
			break;
		case 10:
			lines.reverse();
			break;
		case 11:
			lines.sort((a, b) => b.Qty - a.Qty);
			break;
		case 12:
			if (lines.length > 1) {
				const first = lines[0]!;
				lines[0] = lines[lines.length - 1]!;
				lines[lines.length - 1] = first;
			}
			break;
		case 13:
			d.Meta = {
				Text: `m${n}`,
				N: n
			};
			break;
		case 14:
			d.Meta.Text = `x${n}`;
			break;
		case 15: {
			const scratch = yield* transient(d, "Rewind/Scratch", {
				N: 0
			});
			scratch.N += n;
			break;
		}
		case 16:
			if (lines.length > 0) {
				lines[at % lines.length]!.Parts.push(
					yield* entity<IPart>({
						W: n
					})
				);
			}
			break;
		case 17:
			if (lines.length > 0) {
				lines[at % lines.length]!.Parts.splice(0, 1);
			}
			break;
		case 18: {
			const part = lines[at % Math.max(1, lines.length)]?.Parts[0];
			if (part) {
				part.W = n;
			}
			break;
		}
		case 19:
			if (lines.length > 0 && d.Box.Held === null) {
				const [moved] = lines.splice(at % lines.length, 1);
				d.Box.Held = moved!;
			}
			break;
		case 20:
			if (d.Box.Held !== null) {
				const moved = d.Box.Held;
				d.Box.Held = null;
				lines.splice(at % (lines.length + 1), 0, moved);
			}
			break;
		case 21:
			d.Box = {
				Held: d.Box.Held,
				Extra: n
			};
			break;
		case 22:
			d.Tags.length = at % (d.Tags.length + 1);
			break;
		case 23: {
			const end = d.Tags.length;
			d.Tags.length = end + 2;
			d.Tags[end] = `g${n}`;
			d.Tags[end + 1] = `h${n}`;
			break;
		}
		case 24:
			if (lines.length > 1) {
				lines.length = lines.length - 1;
			}
			break;
		case 25:
			d.Maybe = at % 2 === 0 ? null : `m${n}`;
			if (lines.length > 0) {
				lines[at % lines.length]!.Tag = null;
			}
			break;
		case 26:
			if (at % 5 === 0) {
				delete d.Maybe;
			} else if (at % 5 === 1) {
				delete d.Meta.Text;
			} else if (at % 5 === 2) {
				delete d.Meta.N;
			} else if (at % 5 === 3) {
				delete d.Box.Extra;
			} else if (lines.length > 0) {
				delete lines[at % lines.length]!.Tag;
			}
			break;
		case 27:
			d.Meta.N = n;
			break;
		case 28:
		case 29:
			yield* refreshSpare(d, at, n, true);
			break;
		case 31:
			d.Flip =
				at % 2 === 0
					? `f${n}`
					: {
							V: n
						};
			break;
		case 32:
			if (typeof d.Flip === "object") {
				d.Flip.V = n;
			} else {
				d.Flip = `g${n}`;
			}
			break;
		case 33:
			d.Tags.sort();
			break;
		case 34:
			for (let k = 0; k < 4; k++) {
				if (k % 2 === 0) {
					d.Qty = n + k;
				} else if (d.Meta.N !== undefined) {
					d.Meta.N = n + k;
				} else {
					d.Note = `r${n + k}`;
				}
			}
			break;
		default:
			if (lines.length > 0) {
				const [moved] = lines.splice(at % lines.length, 1);
				moved!.Qty = n;
				if (d.Box.Held === null) {
					d.Box.Held = moved!;
				} else {
					d.Spare[moved!.$Id] = moved!;
				}
			}
	}
}
const ORDER_OPS = 35;
const ROTATING = [
	0,
	1,
	14,
	27,
	32,
	34
];

function* onLine(d: ILine, op: number, n: number): IActionGenerator {
	switch (op) {
		case 0:
			d.Qty = n;
			break;
		case 1:
			d.Notes.push(`k${n}`);
			break;
		case 2:
			d.Notes.splice(0, 1);
			break;
		case 3:
			d.Tag = null;
			break;
		case 4:
			delete d.Tag;
			break;
		case 5:
			d.Tag = `t${n}`;
			break;
		default:
			if (d.Parts[0]) {
				d.Parts[0].W = n;
			}
	}
}
const LINE_OPS = 7;

function* onPart(d: IPart, n: number): IActionGenerator {
	d.W = n;
}

function* onShop(d: IShop, op: number, at: number, n: number): IActionGenerator {
	const mine = d.Orders.o1!;
	const theirs = d.Orders.o2!;
	switch (op) {
		case 0:
			mine.Note = `a${n}`;
			break;
		case 1:
			if (mine.Lines.length > 0) {
				mine.Lines[at % mine.Lines.length]!.Qty = n;
			}
			break;
		case 2:
			d.Clock = n;
			break;
		case 3:
			theirs.Qty = n;
			break;
		case 4:
			if (theirs.Lines.length > 0) {
				const [moved] = theirs.Lines.splice(at % theirs.Lines.length, 1);
				mine.Lines.push(moved!);
			}
			break;
		case 5:
			if (mine.Lines.length > 0) {
				const [moved] = mine.Lines.splice(at % mine.Lines.length, 1);
				theirs.Lines.push(moved!);
			}
			break;
		case 6: {
			const back = theirs.Lines.findIndex((item) => !item.$Id.startsWith("o2-"));
			if (back >= 0) {
				const [moved] = theirs.Lines.splice(back, 1);
				mine.Lines.splice(at % (mine.Lines.length + 1), 0, moved!);
			}
			break;
		}
		case 7: {
			const part = mine.Lines[at % Math.max(1, mine.Lines.length)]?.Parts[0];
			if (part) {
				part.W = n;
			}
			break;
		}
		case 8:
			if (mine.Box.Held) {
				mine.Box.Held.Qty = n;
			}
			break;
		default: {
			const away = theirs.Lines.find((item) => !item.$Id.startsWith("o2-"));
			if (away) {
				away.Qty = n;
			}
		}
	}
}
const SHOP_OPS = 10;

function copy<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function nodesOf(root: object, skip?: object): Map<object, string> {
	const nodes = new Map<object, string>();
	const visit = (node: object, at: string): void => {
		if (node === skip) {
			return;
		}
		nodes.set(node, at);
		for (const [key, child] of Object.entries(node)) {
			if (child !== null && typeof child === "object") {
				visit(child, `${at}.${key}`);
			}
		}
	};
	visit(root, "");
	return nodes;
}

function forwardGroups(entries: readonly IHistoryEntry[]): IRecordChange[][] {
	const groups: IRecordChange[][] = [];
	let others: IRecordChange[] | null = null;
	for (const entry of entries) {
		if (entry.Kind === "step") {
			others = null;
			groups.push(entry.Changes);
		} else if (entry.Kind === "other") {
			if (!others) {
				others = [];
				groups.push(others);
			}
			others.push(entry.Change);
		}
	}
	return groups;
}

type IJson = any;

function sameJson(a: IJson, b: IJson): boolean {
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
		return a === b;
	}
	if (Array.isArray(a) !== Array.isArray(b)) {
		return false;
	}
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

function findIn(node: IJson, id: string, skip?: IJson): IJson | undefined {
	if (node === null || typeof node !== "object" || node === skip) {
		return undefined;
	}
	if (node.$Id === id) {
		return node;
	}
	for (const child of Object.values(node)) {
		const found = findIn(child, id, skip);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

function predictRefusal(tree: IJson, markedId: string, entries: readonly IHistoryEntry[]): string | null {
	const marked = findIn(tree, markedId);
	const loose = new Map<string, IJson>();
	const entityNamed = (id: string): IJson | undefined => findIn(marked, id) ?? loose.get(id);
	const takeOut = (old: IJson): void => {
		if (old !== null && typeof old === "object") {
			if (typeof old.$Id === "string") {
				loose.set(old.$Id, old);
			}
			for (const child of Object.values(old)) {
				takeOut(child);
			}
		}
	};
	const build = (value: IJson): IJson => {
		if (value === null || typeof value !== "object") {
			return value;
		}
		if (typeof value.$Id === "string") {
			const node = entityNamed(value.$Id);
			if (node !== undefined) {
				if (!sameJson(node, value)) {
					throw COPY;
				}
				return node;
			}
			if (findIn(tree, value.$Id, marked) !== undefined) {
				throw MOVED_OUT;
			}
		}
		if (Array.isArray(value)) {
			return value.map(build);
		}
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [
				key,
				build(child)
			])
		);
	};
	const changes = entries.flatMap((entry) =>
		entry.Kind === "step"
			? entry.Changes
			: entry.Kind === "other"
				? [
						entry.Change
					]
				: []
	);
	try {
		for (let at = changes.length - 1; at >= 0; at--) {
			const change = changes[at]!;
			if (!change.Landing) {
				continue;
			}
			const { EntityId, Path } = change.Landing;
			let node = EntityId === markedId ? marked : entityNamed(EntityId);
			if (node === undefined) {
				if (findIn(tree, EntityId, marked) !== undefined) {
					throw LANDS_OUTSIDE;
				}
				continue;
			}
			for (const key of Path.slice(0, -1)) {
				node = node[key as string];
			}
			const key = String(Path[Path.length - 1]);
			if (Array.isArray(node) && key === "length") {
				node.length = change.Prev as number;
				continue;
			}
			const old = node[key];
			if (change.Created && change.GrewFrom !== undefined) {
				node.length = change.GrewFrom;
			} else if (change.Created) {
				delete node[key];
			} else {
				node[key] = build(change.Prev);
			}
			takeOut(old);
		}
	} catch (refusal) {
		return refusal as string;
	}
	return null;
}

function idsIn(value: IJson, into: Set<string>): Set<string> {
	if (value !== null && typeof value === "object") {
		if (typeof value.$Id === "string") {
			into.add(value.$Id);
		}
		for (const child of Object.values(value)) {
			idsIn(child, into);
		}
	}
	return into;
}

/**
 * The forward group that puts back an entity an earlier group took out of the marked entity, or null: each
 * group is one frame, and an entity whose places a frame's changes take away, net, has left at its end.
 */
function predictForwardRefusal(groups: readonly IRecordChange[][]): number | null {
	const gone = new Set<string>();
	for (let at = 0; at < groups.length; at++) {
		const places = new Map<string, number>();
		for (const change of groups[at]!) {
			if (!change.Landing) {
				continue;
			}
			for (const id of idsIn(change.Prev, new Set())) {
				places.set(id, (places.get(id) ?? 0) - 1);
			}
			for (const id of idsIn(change.Value, new Set())) {
				if (gone.has(id)) {
					return at;
				}
				places.set(id, (places.get(id) ?? 0) + 1);
			}
		}
		for (const [id, net] of places) {
			if (net < 0) {
				gone.add(id);
			}
		}
	}
	return null;
}

interface ITally {
	snapshots: number;
	rewound: number;
	ended: number;
	unwound: number;
	refused: Map<string, number>;
	unusable: number;
	shorter: number;
	refusedUnmergedOnly: number;
}

const reasonOf = (error: Error) => error.message.replace(/"[^"]*"/g, "…");

function unmerged(entries: readonly IHistoryEntry[]): IHistoryEntry[] {
	const logs = [
		...appended.log.values()
	];
	expect(logs.length).toBeLessThanOrEqual(1);
	const log = logs[0] ?? [];
	const own = entries.filter((entry) => entry.Kind !== "other");
	const shadow: IHistoryEntry[] = [];
	for (let owns = 0; owns <= own.length; owns++) {
		for (const item of log) {
			if (item.owns === owns) {
				shadow.push({
					Kind: "other",
					Change: item.change as IRecordChange
				});
			}
		}
		if (owns < own.length) {
			shadow.push(own[owns]!);
		}
	}
	const copied = copy(shadow);
	const rebuilt: IHistoryEntry[] = [];
	const stretch: IStretch = {
		places: null
	};
	for (const entry of copied) {
		if (entry.Kind === "other") {
			appended.original!(rebuilt, entry.Change as Parameters<IAppendOther>[1], stretch);
		} else {
			rebuilt.push(entry);
			stretch.places = null;
		}
	}
	expect(rebuilt).toEqual(entries);
	return copied;
}

interface ITrace {
	refused: string | null;
	rewound: string | null;
	forwards: string[];
}

async function trace(json: string, entries: readonly IHistoryEntry[]): Promise<ITrace> {
	const { runtime } = await restoreTestRuntime<IShop>(json, {
		rootId: "shop"
	});
	const gateway = (runtime as IRuntimeInternal<IShop>).get("runtime/writeGateway");
	const root = rawOf(runtime.state) as IShop;
	const scope = gateway.openScope();
	const session = entityRewind(gateway, "o1");
	const refusal = (error: unknown): string => {
		if (!(error instanceof RewindRefusedError)) {
			throw error;
		}
		return reasonOf(error);
	};
	try {
		try {
			session.rewind(entries);
		} catch (error) {
			return {
				refused: refusal(error),
				rewound: null,
				forwards: []
			};
		}
		const rewound = JSON.stringify(root.Orders.o1);
		const forwards: string[] = [];
		for (const changes of forwardGroups(entries)) {
			try {
				session.forward(changes);
			} catch (error) {
				forwards.push(`refused: ${refusal(error)}`);
				break;
			}
			forwards.push(JSON.stringify(root));
		}
		return {
			refused: null,
			rewound,
			forwards
		};
	} finally {
		scope.unwind();
		runtime.dispose();
	}
}

async function check(json: string, began: IOrder, pick: () => number, tally: ITally): Promise<void> {
	const envelope = JSON.parse(json) as {
		InFlight: {
			ActionId: string;
			Name: string | null;
		}[];
		Histories?: ISnapshotHistory[];
	};
	const row = envelope.InFlight.find((entry) => entry.Name === "Rewind/Flow");
	const kept = envelope.Histories?.find((entry) => entry.ActionId === row?.ActionId);
	if (!kept || !("Entries" in kept)) {
		tally.unusable++;
		return;
	}
	const history: IHistory = kept;
	tally.snapshots++;
	const shadow = unmerged(history.Entries);
	if (shadow.length > history.Entries.length) {
		tally.shorter++;
	}
	const merged = await trace(json, history.Entries);
	const plain = await trace(json, shadow);
	if (merged.refused !== null) {
		expect(plain.refused).not.toBeNull();
	} else if (plain.refused !== null) {
		tally.refusedUnmergedOnly++;
	} else {
		expect(merged.rewound).toBe(plain.rewound);
		expect(merged.forwards).toEqual(plain.forwards);
	}
	const { runtime } = await restoreTestRuntime<IShop>(json, {
		rootId: "shop"
	});
	const internal = runtime as IRuntimeInternal<IShop>;
	const gateway = internal.get("runtime/writeGateway");
	const root = rawOf(runtime.state) as IShop;
	const restored = JSON.stringify(root);
	const nodes = nodesOf(root);
	const cells = new Map(
		gateway.cellIds().map((id) => [
			id,
			gateway.cellOf(id)
		])
	);
	const disposed: string[] = [];
	gateway.onDispose((id) => disposed.push(id), "cancel");
	const asRestored = () => {
		expect(JSON.stringify(root)).toBe(restored);
		const now = nodesOf(root);
		expect(
			[
				...now.keys()
			].every((node) => nodes.has(node))
		).toBe(true);
		expect(now.size).toBe(nodes.size);
		for (const node of now.keys()) {
			expect(gateway.isDetached(node)).toBe(false);
		}
		expect(gateway.cellIds().sort()).toEqual(
			[
				...cells.keys()
			].sort()
		);
		for (const [id, node] of cells) {
			expect(gateway.cellOf(id)).toBe(node);
		}
	};

	const marked = root.Orders.o1!;
	const predicted = predictRefusal(copy(root), "o1", history.Entries);
	const outside = () =>
		JSON.stringify({
			...root,
			Orders: {
				...root.Orders,
				o1: null
			}
		});
	const outsideBefore = outside();
	const outsideNodes = nodesOf(root, marked);
	const entities = new Map(
		[
			...nodes.keys()
		]
			.filter((node) => typeof (node as IEntity).$Id === "string")
			.map((node) => [
				(node as IEntity).$Id,
				node
			])
	);

	const scope = gateway.openScope();
	const session = entityRewind(gateway, "o1");
	try {
		session.rewind(history.Entries);
	} catch (error) {
		if (!(error instanceof RewindRefusedError)) {
			throw error;
		}
		const reason = reasonOf(error);
		tally.refused.set(reason, (tally.refused.get(reason) ?? 0) + 1);
		expect(reason).toBe(predicted);
		scope.unwind();
		tally.unwound++;
		asRestored();
		expect(disposed).toEqual([]);
		runtime.dispose();
		return;
	}
	tally.rewound++;
	expect(predicted).toBeNull();
	expect(copy(root.Orders.o1)).toEqual(began);
	expect(root.Orders.o1).toBe(marked);
	expect(outside()).toBe(outsideBefore);
	const outsideNow = nodesOf(root, marked);
	expect(outsideNow.size).toBe(outsideNodes.size);
	for (const [node, at] of outsideNow) {
		expect(outsideNodes.get(node)).toBe(at);
	}
	for (const node of nodesOf(marked).keys()) {
		const kept = entities.get((node as IEntity).$Id);
		if (kept !== undefined) {
			expect(node).toBe(kept);
		}
	}
	const groups = forwardGroups(history.Entries);
	const cut = pick() < 0.3 ? Math.floor(pick() * groups.length) : groups.length;
	const refusesAt = predictForwardRefusal(groups);
	for (let at = 0; at < cut; at++) {
		if (at !== refusesAt) {
			session.forward(groups[at]!);
			continue;
		}
		let refused: unknown;
		try {
			session.forward(groups[at]!);
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(RewindRefusedError);
		expect((refused as Error).message.endsWith(CAME_BACK)).toBe(true);
		tally.refused.set(CAME_BACK, (tally.refused.get(CAME_BACK) ?? 0) + 1);
		scope.unwind();
		tally.unwound++;
		asRestored();
		expect(disposed).toEqual([]);
		runtime.dispose();
		return;
	}
	if (cut === groups.length) {
		expect(JSON.stringify(root)).toBe(restored);
		expect(
			[
				...nodesOf(root).keys()
			].every((node) => nodes.has(node))
		).toBe(true);
	}
	if (cut < groups.length || pick() < 0.5) {
		scope.unwind();
		tally.unwound++;
		expect(disposed).toEqual([]);
	} else {
		scope.end();
		tally.ended++;
		// Only an entity the rewind made again from a copy, which the forward took out again.
		expect(disposed.filter((id) => cells.has(id) || id === "o1")).toEqual([]);
	}
	asRestored();
	runtime.dispose();
}

async function run(seedValue: number, tally: ITally): Promise<void> {
	const pick = rng(seedValue);
	const int = (n: number) => Math.floor(pick() * n);
	const h = harness(seed(), {
		verifyIndex: "always"
	});
	const { runtime } = h;
	const began = copy(rawOf(runtime.state).Orders.o1!);
	appended.log.clear();
	const flowing = runtime.dispatch(flow, "o1", pick() < 0.3);
	for (let round = 0; round < ROUNDS; round++) {
		await until(() => h.waiting.some((w) => w.name === `flow${round}`));
		let writes = int(4);
		const rotation =
			pick() < 0.5
				? [
						ROTATING[int(ROTATING.length)]!,
						ROTATING[int(ROTATING.length)]!,
						...(pick() < 0.5
							? [
									ROTATING[int(ROTATING.length)]!
								]
							: [])
					]
				: [];
		let rotated = rotation.length === 0 ? 0 : 2 + int(4);
		while (writes + rotated > 0) {
			if (rotated > 0 && (writes === 0 || pick() < 0.5)) {
				await runtime.dispatch(onOrder, "o1", rotation[rotated % rotation.length]!, int(7), int(1000));
				rotated--;
				if (pick() < 0.35) {
					await check(createSnapshot(runtime), began, pick, tally);
				}
				continue;
			}
			writes--;
			const mine = runtime.state.Orders.o1!;
			const lines = [
				...mine.Lines,
				...(mine.Box.Held
					? [
							mine.Box.Held
						]
					: [])
			];
			const parts = lines.flatMap((item) => item.Parts);
			const roll = pick();
			if (roll < 0.5) {
				await runtime.dispatch(onOrder, "o1", int(ORDER_OPS), int(7), int(1000));
			} else if (roll < 0.65 && lines.length > 0) {
				await runtime.dispatch(onLine, lines[int(lines.length)]!.$Id, int(LINE_OPS), int(1000));
			} else if (roll < 0.75 && parts.length > 0) {
				await runtime.dispatch(onPart, parts[int(parts.length)]!.$Id, int(1000));
			} else {
				await runtime.dispatch(onShop, "shop", int(SHOP_OPS), int(7), int(1000));
			}
			if (pick() < 0.35) {
				await check(createSnapshot(runtime), began, pick, tally);
			}
		}
		h.release(`flow${round}`);
	}
	await flowing;
	runtime.dispose();
}

describe("an entity another writer moved out of the marked entity and back", () => {
	it("is refused by the forward as a refusal, not a DraftDetachedError, though the rewind passes it", async () => {
		const h = harness(seed(), {
			verifyIndex: "always"
		});
		const { runtime } = h;
		const flowing = runtime.dispatch(flow, "o1", false);
		await until(() => h.waiting.some((w) => w.name === "flow0"));
		await runtime.dispatch(onShop, "shop", 5, 2, 0);
		h.release("flow0");
		await until(() => h.waiting.some((w) => w.name === "flow1"));
		await runtime.dispatch(onShop, "shop", 6, 0, 0);
		await runtime.dispatch(onLine, "o1-l3", 1, 7);
		expect(runtime.state.Orders.o1!.Lines[0]!.$Id).toBe("o1-l3");
		const json = createSnapshot(runtime);
		const history = h.historyOf("Rewind/Flow");
		const groups = forwardGroups(history.Entries);
		expect(predictForwardRefusal(groups)).toBe(groups.length - 1);

		const { runtime: restored } = await restoreTestRuntime<IShop>(json, {
			rootId: "shop"
		});
		const gateway = (restored as IRuntimeInternal<IShop>).get("runtime/writeGateway");
		const scope = gateway.openScope();
		const session = entityRewind(gateway, "o1");
		session.rewind(history.Entries);
		for (const changes of groups.slice(0, -1)) {
			session.forward(changes);
		}
		let refused: unknown;
		try {
			session.forward(groups[groups.length - 1]!);
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(RewindRefusedError);
		expect((refused as Error).message).toBe(`[treflex] resume: "o1-l3" left "o1" ${CAME_BACK}`);
		scope.unwind();
		expect(JSON.stringify(rawOf(restored.state))).toBe(JSON.stringify(JSON.parse(json).AppState));
		restored.dispose();
		h.release("flow1");
		for (let round = 2; round < ROUNDS; round++) {
			await until(() => h.waiting.some((w) => w.name === `flow${round}`));
			h.release(`flow${round}`);
		}
		await flowing;
		runtime.dispose();
	});
});

describe("the rewind, over generated runs", () => {
	it(`rewinds the marked entity to its start, applies the history again, unwinds to the restored tree, and agrees with the history unmerged, over ${RUNS} runs`, async () => {
		const tally: ITally = {
			snapshots: 0,
			rewound: 0,
			ended: 0,
			unwound: 0,
			refused: new Map(),
			unusable: 0,
			shorter: 0,
			refusedUnmergedOnly: 0
		};
		appended.mergedAcross = 0;
		const first = Number(host?.env?.TREFLEX_REWIND_FIRST ?? 1);
		for (let at = 0; at < RUNS; at++) {
			await run(at + first, tally);
		}
		if (host?.env?.TREFLEX_REWIND_REPORT) {
			host.stderr?.write(
				`${JSON.stringify({
					...tally,
					refused: Object.fromEntries(tally.refused),
					mergedAcross: appended.mergedAcross
				})}\n`
			);
		}
		expect(tally.unusable).toBe(0);
		expect(tally.rewound).toBeGreaterThan(RUNS);
		expect(appended.mergedAcross).toBeGreaterThan(2 * RUNS);
		expect(tally.shorter).toBeGreaterThan(2 * RUNS);
		for (const kind of [
			"is not as the history's copy of it",
			"while it lives in AppState outside it"
		]) {
			expect([
				kind,
				[
					...tally.refused
				].some(([refusal, count]) => refusal.endsWith(kind) && count > 0)
			]).toEqual([
				kind,
				true
			]);
		}
	}, 600_000);
});
