import type { IActionGenerator, IEntity, IOpenGenerator, IRecord, IRecordChange, IRuntime } from "../../src/index";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import { describe, expect, it, vi } from "vitest";
import { createRuntime, DraftDetachedError, open, transient } from "../../src/index";
import { rawOf } from "../../src/Runtime/viewProxy";
import { settled } from "../../src/Testing/createTestRuntime";
import { minted, mountComponent } from "../testHelpers";

const host = (
	globalThis as {
		process?: {
			env?: Record<string, string | undefined>;
		};
	}
).process;

const SEEDS = Number(host?.env?.TREFLEX_LANDING_SEEDS ?? 200);
const OPS = 40;

interface IItem extends IEntity {
	Score: number;
	Note: {
		Text: string;
	};
	Tags: string[];
}
interface IList extends IEntity {
	Items: IItem[];
}
interface IBoard extends IEntity {
	Lists: IList[];
}
interface IKid extends IEntity {
	V: number;
}
type ILoose = IItem & {
	Box?: {
		Child: IItem;
	} | null;
	Kid?: IKid;
};

type IStep = Extract<
	IRecord,
	{
		Kind: "step";
	}
>;

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

const seed = (): IBoard => ({
	$Id: "B",
	Lists: [
		0,
		1,
		2
	].map((l) => ({
		$Id: `L${l}`,
		Items: [
			0,
			1
		].map((i) => ({
			$Id: `I${l * 2 + i}`,
			Score: l * 2 + i,
			Note: {
				Text: ""
			},
			Tags: []
		}))
	}))
});

function* park(): IActionGenerator {
	yield {
		Type: "park"
	};
}

function* score(d: IBoard, list: number, at: number, n: number): IActionGenerator {
	const item = d.Lists[list]?.Items[at];
	if (!item) {
		return;
	}
	item.Score = n;
	item.Note.Text = `s${n}`;
	item.Tags.push(`s${n}`);
}

function* own(d: IItem, n: number): IActionGenerator {
	d.Score += n;
	d.Note.Text += "o";
	if (d.Tags.length > 2) {
		d.Tags.shift();
	} else {
		d.Tags.push("o");
	}
}

function* add(d: IList, at: number, made: IItem): IActionGenerator {
	const pos = Math.min(at, d.Items.length);
	d.Items.splice(pos, 0, made);
	d.Items[pos]!.Score += 1;
	d.Items[pos]!.Note.Text = "new";
}

function* remove(d: IList, at: number): IActionGenerator {
	if (d.Items.length > 0) {
		d.Items.splice(at % d.Items.length, 1);
	}
}

function* reorder(d: IList, how: number): IActionGenerator {
	const n = d.Items.length;
	if (how === 0) {
		d.Items.reverse();
	} else if (how === 1) {
		d.Items.sort((a, b) => b.Score - a.Score);
	} else if (n > 1) {
		const first = d.Items[0]!;
		const last = d.Items[n - 1]!;
		d.Items[0] = last;
		d.Items[n - 1] = first;
	}
}

function* move(d: IBoard, from: number, at: number, to: number, into: number): IActionGenerator {
	const source = d.Lists[from]!.Items;
	if (source.length === 0) {
		return;
	}
	const [moved] = source.splice(at % source.length, 1);
	const target = d.Lists[to]!.Items;
	target.splice(Math.min(into, target.length), 0, moved!);
	moved!.Score += 100;
	moved!.Note.Text += "m";
}

function* moveNote(d: IBoard, from: number, to: number): IActionGenerator {
	const all = d.Lists.flatMap((list) => list.Items);
	if (all.length < 2) {
		return;
	}
	const source = all[from % all.length]!;
	const target = all[(from + 1 + (to % (all.length - 1))) % all.length]!;
	const note = source.Note;
	target.Note = note;
	source.Note = {
		Text: "left"
	};
	note.Text += "!";
}

function* outAndBack(d: IBoard, from: number, at: number, to: number, into: number, n: number): IActionGenerator {
	const source = d.Lists[from]!.Items;
	if (source.length === 0) {
		return;
	}
	const [out] = source.splice(at % source.length, 1);
	out!.Score = n;
	out!.Note.Text += "w";
	out!.Tags.push("w");
	const target = d.Lists[to]!.Items;
	target.splice(Math.min(into, target.length), 0, out!);
}

function* held(d: IBoard, list: number, at: number, n: number): IOpenGenerator {
	const item = d.Lists[list]?.Items[at];
	if (!item) {
		return;
	}
	const note = item.Note;
	const tags = item.Tags;
	yield* open(park());
	try {
		item.Score = n;
		note.Text = `h${n}`;
		tags.push(`h${n}`);
	} catch (error) {
		if (!(error instanceof DraftDetachedError)) {
			throw error;
		}
	}
}

interface IReport {
	steps: number;
	changes: number;
	unlanded: number;
	unfound: number;
	twice: number;
	searched: number;
	failures: string[];
}

const emptyReport = (): IReport => ({
	steps: 0,
	changes: 0,
	unlanded: 0,
	unfound: 0,
	twice: 0,
	searched: 0,
	failures: []
});

const copy = <T>(value: T): T => structuredClone(value);

function canonical(value: unknown): string {
	if (value === undefined) {
		return "undefined";
	}
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${Array.from(value, (v, i) => (i in value ? canonical(v) : "hole")).join(",")}]`;
	}
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
		.join(",")}}`;
}

function entitiesNamed(tree: unknown, id: string, found: object[] = []): object[] {
	if (tree === null || typeof tree !== "object") {
		return found;
	}
	if ((tree as IEntity).$Id === id) {
		found.push(tree);
	}
	for (const value of Object.values(tree)) {
		entitiesNamed(value, id, found);
	}
	return found;
}

// Found by a change's Landing alone, never its Path. A change whose entity isn't in the tree at that point is
// skipped: the change that puts the entity back carries a copy holding the write.
function placesOf(
	tree: unknown,
	change: IRecordChange,
	report: IReport,
	where: string,
	everyMatch: boolean
): [
	Record<string, unknown>,
	string
][] {
	const landing = change.Landing;
	if (!landing) {
		report.unlanded++;
		return [];
	}
	const named = entitiesNamed(tree, landing.EntityId);
	if (named.length === 0) {
		report.unfound++;
		return [];
	}
	if (named.length > 1) {
		report.twice++;
	}
	const places: [
		Record<string, unknown>,
		string
	][] = [];
	for (const entity of everyMatch ? named : named.slice(0, 1)) {
		let container: unknown = entity;
		for (const key of landing.Path.slice(0, -1)) {
			container = (container as Record<PropertyKey, unknown> | undefined)?.[key];
		}
		if (container === null || typeof container !== "object") {
			report.failures.push(`${where}: ${landing.EntityId}.${landing.Path.join(".")} reaches no container`);
			continue;
		}
		places.push([
			container as Record<string, unknown>,
			String(landing.Path.at(-1))
		]);
	}
	return places;
}

function forward(tree: unknown, change: IRecordChange, report: IReport, where: string, everyMatch: boolean): void {
	for (const [container, key] of placesOf(tree, change, report, where, everyMatch)) {
		if (change.Deleted) {
			delete container[key];
		} else if (key === "length" && Array.isArray(container)) {
			container.length = change.Value as number;
		} else {
			container[key] = copy(change.Value);
		}
	}
}

function backward(tree: unknown, change: IRecordChange, report: IReport, where: string, everyMatch: boolean): void {
	for (const [container, key] of placesOf(tree, change, report, where, everyMatch)) {
		if (key === "length" && Array.isArray(container)) {
			container.length = change.Prev as number;
		} else if (change.Created) {
			delete container[key];
			if (change.GrewFrom !== undefined) {
				(container as unknown as unknown[]).length = change.GrewFrom;
			}
		} else {
			container[key] = copy(change.Prev);
		}
	}
}

function check(before: IBoard, step: IStep, after: IBoard, report: IReport, where: string, everyMatch = true): void {
	report.steps++;
	report.changes += step.Changes.length;
	const redone = copy(before);
	for (let i = 0; i < step.Changes.length; i++) {
		forward(redone, step.Changes[i]!, report, `${where} step ${step.Seq} change ${i}`, everyMatch);
	}
	if (canonical(redone) !== canonical(after)) {
		report.failures.push(`${where} step ${step.Seq}: replayed forward by Landing, the tree differs from the tree after the step`);
	}
	const undone = copy(after);
	for (let i = step.Changes.length - 1; i >= 0; i--) {
		backward(undone, step.Changes[i]!, report, `${where} step ${step.Seq} change ${i}`, everyMatch);
	}
	if (canonical(undone) !== canonical(before)) {
		report.failures.push(`${where} step ${step.Seq}: undone by Landing and Prev, the tree differs from the tree before the step`);
	}
}

async function run(seedValue: number, report: IReport): Promise<void> {
	const random = rng(seedValue);
	const pick = (n: number): number => Math.floor(random() * n);
	const parks: (() => void)[] = [];
	const runtime: IRuntime<IBoard> = createRuntime<IBoard>(seed(), {
		onError: () => {}
	});
	runtime.registerImplementation(
		"park",
		() =>
			new Promise<void>((resolve) => {
				parks.push(resolve);
			})
	);
	const search = vi.spyOn((runtime as IRuntimeInternal<IBoard>).get("runtime/writeGateway"), "landingOf");
	const tree = (): IBoard => copy(rawOf(runtime.state));
	let before = tree();
	runtime.on(
		"record",
		(record) => {
			if (record.Kind !== "step") {
				return;
			}
			const after = tree();
			check(before, record, after, report, `seed ${seedValue}`);
			before = after;
		},
		{
			kinds: [
				"step"
			],
			landing: true
		}
	);
	const listId = (): string => `L${pick(3)}`;
	const itemIds = (): string[] => runtime.state.Lists.flatMap((list) => list.Items.map((item) => item.$Id));
	let made = 0;
	for (let op = 0; op < OPS; op++) {
		const roll = pick(11);
		if (roll === 0) {
			runtime.dispatch(score, "B", pick(3), pick(3), pick(1000));
		} else if (roll === 1) {
			const ids = itemIds();
			if (ids.length > 0) {
				runtime.dispatch(own, ids[pick(ids.length)]!, pick(9) + 1);
			}
		} else if (roll === 2) {
			made++;
			runtime.dispatch(
				add,
				listId(),
				pick(4),
				minted(`n${made}`, {
					Score: made,
					Note: {
						Text: ""
					},
					Tags: [] as string[]
				})
			);
		} else if (roll === 3) {
			runtime.dispatch(remove, listId(), pick(4));
		} else if (roll === 4) {
			runtime.dispatch(reorder, listId(), pick(3));
		} else if (roll === 5) {
			runtime.dispatch(move, "B", pick(3), pick(4), pick(3), pick(4));
		} else if (roll === 6) {
			runtime.dispatch(moveNote, "B", pick(20), pick(20));
		} else if (roll <= 8) {
			runtime.dispatch(held, "B", pick(3), pick(3), pick(1000));
		} else if (roll === 9) {
			runtime.dispatch(outAndBack, "B", pick(3), pick(4), pick(3), pick(4), pick(1000));
		} else if (parks.length > 0) {
			parks.splice(pick(parks.length), 1)[0]!();
		}
		await settled();
	}
	while (parks.length > 0) {
		parks.shift()!();
		await settled();
	}
	report.searched += search.mock.calls.length;
	runtime.dispose();
}

describe("a step's changes replayed by their landing entity", () => {
	it(`rebuild the tree after each step, and undo to the tree before it, over ${SEEDS} generated runs`, async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const report = emptyReport();
		for (let s = 1; s <= SEEDS; s++) {
			await run(s, report);
		}
		expect(report.failures.slice(0, 10)).toEqual([]);
		expect(report.unlanded).toBe(0);
		expect(report.unfound).toBeGreaterThan(0);
		expect(report.steps).toBeGreaterThan(SEEDS * 10);
		expect(report.searched).toBeGreaterThan(0);
		vi.restoreAllMocks();
	}, 60_000);
});

type IOutcome = "holds" | "fails";

type IReplayed = {
	forward: IOutcome;
	undo: IOutcome;
	twice: number;
	unfound: number;
	unlanded: number;
	firstMatch: {
		forward: IOutcome;
		undo: IOutcome;
	};
};

function directions(report: IReport): {
	forward: IOutcome;
	undo: IOutcome;
} {
	return {
		forward: report.failures.some((failure) => failure.includes("replayed forward")) ? "fails" : "holds",
		undo: report.failures.some((failure) => failure.includes("undone by Landing")) ? "fails" : "holds"
	};
}

function pinned() {
	const parks: (() => void)[] = [];
	const runtime = createRuntime<IBoard>(seed(), {
		onError: () => {}
	});
	runtime.registerImplementation(
		"park",
		() =>
			new Promise<void>((resolve) => {
				parks.push(resolve);
			})
	);
	const steps: IStep[] = [];
	const replayed: IReplayed[] = [];
	const tree = (): IBoard => copy(rawOf(runtime.state));
	let before = tree();
	runtime.on(
		"record",
		(record) => {
			if (record.Kind !== "step") {
				return;
			}
			const after = tree();
			const report = emptyReport();
			check(before, record, after, report, "pin");
			const first = emptyReport();
			check(before, record, after, first, "pin", false);
			steps.push(record);
			replayed.push({
				...directions(report),
				twice: report.twice,
				unfound: report.unfound,
				unlanded: report.unlanded,
				firstMatch: directions(first)
			});
			before = after;
		},
		{
			kinds: [
				"step"
			],
			landing: true
		}
	);
	return {
		runtime,
		parks,
		steps,
		replayed
	};
}

const textLanding = (step: IStep): IRecordChange["Landing"] => step.Changes.find((change) => change.Path.at(-1) === "Text")!.Landing;

function* reverseFirstList(d: IBoard): IActionGenerator {
	d.Lists[0]!.Items.reverse();
}

async function afterAReverse(then: (d: IBoard, note: IItem["Note"]) => void) {
	const world = pinned();
	function* holdFirstNote(d: IBoard): IOpenGenerator {
		const note = d.Lists[0]!.Items[0]!.Note;
		yield* open(park());
		then(d, note);
	}
	const held = world.runtime.dispatch(holdFirstNote, "B");
	await settled();
	await world.runtime.dispatch(reverseFirstList, "B");
	world.parks.shift()!();
	await held;
	return world;
}

describe("a step that writes a node while it sits in two places, or in none, replayed by its landing entity", () => {
	it("a plain node written between a move's halves through a reference whose path still reaches it: Landing names that route, the forward replay fails", async () => {
		const { runtime, steps, replayed } = pinned();
		function* moveAroundAWrite(d: IBoard): IActionGenerator {
			const source = d.Lists[0]!.Items[0]!;
			const note = source.Note;
			d.Lists[1]!.Items[0]!.Note = note;
			note.Text = "written while held twice";
			source.Note = {
				Text: "left"
			};
		}
		await runtime.dispatch(moveAroundAWrite, "B");
		expect(runtime.state.Lists[1]!.Items[0]!.Note.Text).toBe("written while held twice");
		expect(textLanding(steps[0]!)).toEqual({
			EntityId: "I0",
			Path: [
				"Note",
				"Text"
			]
		});
		expect(replayed[0]).toMatchObject({
			forward: "fails",
			undo: "holds",
			twice: 0
		});
		runtime.dispose();
	});

	it("the same through a reference held across an earlier move: Landing names the newest place, the undo fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { runtime, steps, replayed } = await afterAReverse((d, note) => {
			d.Lists[1]!.Items[0]!.Note = note;
			note.Text = "written while held twice";
			d.Lists[0]!.Items[1]!.Note = {
				Text: "left"
			};
		});
		expect(runtime.state.Lists[1]!.Items[0]!.Note.Text).toBe("written while held twice");
		expect(textLanding(steps.at(-1)!)).toEqual({
			EntityId: "I2",
			Path: [
				"Note",
				"Text"
			]
		});
		expect(replayed.at(-1)).toMatchObject({
			forward: "holds",
			undo: "fails",
			twice: 0
		});
		runtime.dispose();
		vi.restoreAllMocks();
	});

	it("the node put back where it started: Landing names the place it left, both directions fail", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { runtime, steps, replayed } = await afterAReverse((d, note) => {
			d.Lists[1]!.Items[0]!.Note = note;
			note.Text = "written while held twice";
			d.Lists[1]!.Items[0]!.Note = {
				Text: "fresh"
			};
		});
		expect(runtime.state.Lists[0]!.Items[1]!.Note.Text).toBe("written while held twice");
		expect(textLanding(steps.at(-1)!)).toEqual({
			EntityId: "I2",
			Path: [
				"Note",
				"Text"
			]
		});
		expect(replayed.at(-1)).toMatchObject({
			forward: "fails",
			undo: "fails",
			twice: 0
		});
		runtime.dispose();
		vi.restoreAllMocks();
	});

	it("a plain node moved on to a third place and written through a reference to its first: Landing names the newest place, and both directions hold", async () => {
		const { runtime, steps, replayed } = pinned();
		function* moveTwiceAroundAWrite(d: IBoard): IActionGenerator {
			const source = d.Lists[0]!.Items[0]!;
			const note = source.Note;
			d.Lists[0]!.Items[1]!.Note = note;
			source.Note = {
				Text: "left"
			};
			d.Lists[1]!.Items[0]!.Note = note;
			note.Text = "written while held twice";
			d.Lists[0]!.Items[1]!.Note = {
				Text: ""
			};
		}
		await runtime.dispatch(moveTwiceAroundAWrite, "B");
		expect(runtime.state.Lists[1]!.Items[0]!.Note.Text).toBe("written while held twice");
		expect(textLanding(steps[0]!)).toEqual({
			EntityId: "I2",
			Path: [
				"Note",
				"Text"
			]
		});
		expect(replayed[0]).toMatchObject({
			forward: "holds",
			undo: "holds",
			twice: 0
		});
		runtime.dispose();
	});

	it("a plain node moved away, put back and written through its own path while the second place still holds it: Landing names that route, and both directions hold", async () => {
		const { runtime, steps, replayed } = pinned();
		function* putBackAroundAWrite(d: IBoard): IActionGenerator {
			const source = d.Lists[0]!.Items[0]!;
			const note = source.Note;
			d.Lists[0]!.Items[1]!.Note = note;
			source.Note = {
				Text: "away"
			};
			source.Note = note;
			note.Text = "written while held twice";
			d.Lists[0]!.Items[1]!.Note = {
				Text: ""
			};
		}
		await runtime.dispatch(putBackAroundAWrite, "B");
		expect(runtime.state.Lists[0]!.Items[0]!.Note.Text).toBe("written while held twice");
		expect(textLanding(steps[0]!)).toEqual({
			EntityId: "I0",
			Path: [
				"Note",
				"Text"
			]
		});
		expect(replayed[0]).toMatchObject({
			forward: "holds",
			undo: "holds",
			twice: 0
		});
		runtime.dispose();
	});

	it("an entity added before it is removed and written in between, the step keeping the added: a lookup finds it twice, applying at every match holds both ways and the first match alone fails forward", async () => {
		const { runtime, steps, replayed } = pinned();
		function* addThenRemove(d: IBoard): IActionGenerator {
			const moved = d.Lists[0]!.Items[0]!;
			d.Lists[1]!.Items.push(moved);
			moved.Score = 50;
			d.Lists[0]!.Items.splice(0, 1);
		}
		await runtime.dispatch(addThenRemove, "B");
		const changes = steps[0]!.Changes;
		expect(changes[0]).toMatchObject({
			Path: [
				"Lists",
				"1",
				"Items",
				"2"
			],
			Created: true,
			Value: {
				$Id: "I0"
			}
		});
		expect(changes.find((change) => change.Path.at(-1) === "Score")!.Landing).toEqual({
			EntityId: "I0",
			Path: [
				"Score"
			]
		});
		expect(replayed[0]).toMatchObject({
			forward: "holds",
			undo: "holds",
			twice: 2,
			firstMatch: {
				forward: "fails"
			}
		});
		runtime.dispose();
	});

	it("an entity added before it is removed and written in between, the step keeping the original: applying at every match holds both ways", async () => {
		const { runtime, replayed } = pinned();
		function* addThenRemoveTheAdded(d: IBoard): IActionGenerator {
			const moved = d.Lists[0]!.Items[0]!;
			d.Lists[1]!.Items.push(moved);
			moved.Score = 50;
			d.Lists[1]!.Items.splice(2, 1);
		}
		await runtime.dispatch(addThenRemoveTheAdded, "B");
		expect(runtime.state.Lists[0]!.Items[0]!.Score).toBe(50);
		expect(replayed[0]).toMatchObject({
			forward: "holds",
			undo: "holds",
			twice: 2
		});
		runtime.dispose();
	});

	it("an entity inside a plain node that sits in two places, written in between: applying at every match holds both ways", async () => {
		const { runtime, replayed } = pinned();
		function* boxedTwice(d: IBoard): IActionGenerator {
			const [kid] = d.Lists[1]!.Items.splice(0, 1);
			const first = d.Lists[0]!.Items[0] as ILoose;
			const second = d.Lists[0]!.Items[1] as ILoose;
			first.Box = {
				Child: kid!
			};
			second.Box = first.Box;
			second.Box.Child.Score = 6;
			first.Box = null;
		}
		await runtime.dispatch(boxedTwice, "B");
		expect((runtime.state.Lists[0]!.Items[1] as ILoose).Box!.Child.Score).toBe(6);
		expect(replayed[0]).toMatchObject({
			forward: "holds",
			undo: "holds",
			twice: 2
		});
		runtime.dispose();
	});

	const entityInSeveralPlaces: Record<string, (d: IBoard, kid: IKid) => IActionGenerator> = {
		"written through each of its routes and through a plain node inside it": function* (d) {
			const moved = d.Lists[0]!.Items[0]!;
			d.Lists[1]!.Items.push(moved);
			d.Lists[0]!.Items[0]!.Score = 1;
			d.Lists[1]!.Items[2]!.Score = 2;
			moved.Note.Text = "both";
			d.Lists[0]!.Items.splice(0, 1);
		},
		"written twice": function* (d) {
			const moved = d.Lists[0]!.Items[0]!;
			d.Lists[1]!.Items.push(moved);
			moved.Score = 1;
			moved.Score = 2;
			d.Lists[0]!.Items.splice(0, 1);
		},
		"given a plain child and an entity child, the entity child then written": function* (d, kid) {
			const moved = d.Lists[0]!.Items[0]! as ILoose;
			d.Lists[1]!.Items.push(moved);
			moved.Tags.push("t");
			moved.Kid = kid;
			moved.Kid.V = 1;
			d.Lists[0]!.Items.splice(0, 1);
		},
		"one copy removed and the other written again": function* (d) {
			const moved = d.Lists[0]!.Items[0]!;
			d.Lists[1]!.Items.push(moved);
			moved.Score = 1;
			d.Lists[0]!.Items.splice(0, 1);
			moved.Score = 2;
		},
		"twice in the same list": function* (d) {
			const moved = d.Lists[0]!.Items[0]!;
			d.Lists[0]!.Items.push(moved);
			moved.Score = 1;
			d.Lists[0]!.Items.splice(0, 1);
		},
		"in three places": function* (d) {
			const moved = d.Lists[0]!.Items[0]!;
			d.Lists[1]!.Items.push(moved);
			d.Lists[2]!.Items.push(moved);
			moved.Score = 1;
			d.Lists[0]!.Items.splice(0, 1);
			d.Lists[1]!.Items.splice(2, 1);
		}
	};

	for (const [shape, action] of Object.entries(entityInSeveralPlaces)) {
		it(`an entity in more than one place, ${shape}: applying at every match holds both ways`, async () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const { runtime, replayed } = pinned();
			await runtime.dispatch(
				action,
				"B",
				minted("k", {
					V: 0
				})
			);
			expect(replayed).toHaveLength(1);
			expect(replayed[0]!.twice).toBeGreaterThan(0);
			expect(replayed[0]).toMatchObject({
				forward: "holds",
				undo: "holds"
			});
			runtime.dispose();
			vi.restoreAllMocks();
		});
	}

	it("an entity and a plain node taken out, written and put back elsewhere: the changes are skipped, and both directions hold", async () => {
		const { runtime, steps, replayed } = pinned();
		function* outAndIn(d: IBoard): IActionGenerator {
			const [out] = d.Lists[0]!.Items.splice(0, 1);
			out!.Score = 7;
			out!.Note.Text = "while out";
			d.Lists[1]!.Items.push(out!);
			const note = d.Lists[2]!.Items[0]!.Note;
			delete (
				d.Lists[2]!.Items[0] as {
					Note?: unknown;
				}
			).Note;
			note.Text = "while out too";
			d.Lists[2]!.Items[1]!.Note = note;
		}
		await runtime.dispatch(outAndIn, "B");
		expect(runtime.state.Lists[1]!.Items[2]!.Note.Text).toBe("while out");
		expect(runtime.state.Lists[2]!.Items[1]!.Note.Text).toBe("while out too");
		const landingsOf = (key: string, value: string | number) =>
			steps[0]!.Changes.filter((change) => change.Path.at(-1) === key && change.Value === value).map((change) => change.Landing);
		expect([
			...landingsOf("Score", 7),
			...landingsOf("Text", "while out"),
			...landingsOf("Text", "while out too")
		]).toEqual([
			{
				EntityId: "I0",
				Path: [
					"Score"
				]
			},
			{
				EntityId: "I0",
				Path: [
					"Note",
					"Text"
				]
			},
			undefined
		]);
		expect(replayed[0]).toEqual({
			forward: "holds",
			undo: "holds",
			twice: 0,
			unfound: 4,
			unlanded: 2,
			firstMatch: {
				forward: "holds",
				undo: "holds"
			}
		});
		runtime.dispose();
	});

	it("an entity inside a transient and component state, replayed over runtime.state: their changes are skipped, and both directions hold", async () => {
		const { runtime, steps, replayed } = pinned();
		function* progress(d: IBoard, row: IKid): IActionGenerator {
			const p = yield* transient(d, "Landing/Rows", {
				Rows: [] as IKid[]
			});
			p.Rows.push(row);
			p.Rows[0]!.V = 1;
			d.Lists[0]!.Items[0]!.Score = 9;
		}
		await runtime.dispatch(
			progress,
			"B",
			minted("r", {
				V: 0
			})
		);
		const id = mountComponent(runtime, "B", {
			Open: false
		});
		function* toggle(d: { Open: boolean }): IActionGenerator {
			d.Open = true;
		}
		await runtime.dispatch(toggle, id);
		expect(steps.map((step) => step.Root)).toEqual([
			"AppState",
			"ComponentState"
		]);
		expect(runtime.state.Lists[0]!.Items[0]!.Score).toBe(9);
		expect(replayed).toEqual([
			{
				forward: "holds",
				undo: "holds",
				twice: 0,
				unfound: 2,
				unlanded: 4,
				firstMatch: {
					forward: "holds",
					undo: "holds"
				}
			},
			{
				forward: "holds",
				undo: "holds",
				twice: 0,
				unfound: 2,
				unlanded: 0,
				firstMatch: {
					forward: "holds",
					undo: "holds"
				}
			}
		]);
		runtime.dispose();
	});
});
