import type {
	IActionGenerator,
	IActionTrace,
	IEntity,
	IOpenGenerator,
	IRecord,
	IRecordChange,
	IRecordLanding,
	IRuntime
} from "../../src/index";
import type { IRecordTapOptions } from "../../src/Runtime/createEventBus";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IResourceContext } from "../../src/Types/IResource";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { startTimer } from "../../src/Effects/startTimer";
import {
	createRuntime,
	createTraceAggregator,
	latest,
	open,
	openResource,
	parallel,
	publish,
	StateAliasError,
	start,
	transient
} from "../../src/index";
import { bind } from "../../src/Runtime/bind";
import { createJournal } from "../../src/Runtime/createJournal";
import { createWriteGateway } from "../../src/Runtime/createWriteGateway";
import { receiver } from "../../src/Runtime/receiver";
import { createSnapshot, restoreRuntime } from "../../src/Snapshot/index";
import { settled } from "../../src/Testing/createTestRuntime";
import { isEnded } from "../../src/Types/IResource";
import { createTreeState, minted, mountComponent } from "../testHelpers";

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"Landing/Ping": {
			Text: string;
		};
	}
}
declare module "../../src/Registries/ITimerRegistry" {
	interface ITimerRegistry {
		"Landing/Tick": {};
	}
}
declare module "../../src/Registries/IResourceRegistry" {
	interface IResourceTypeRegistry {
		"landing/feed": {
			Message: {
				Text: string;
			};
		};
	}
	interface IResourceRegistry {
		"Landing/Feed": {
			Type: "landing/feed";
		};
	}
}

const idReads = vi.hoisted(() => ({
	count: 0
}));

vi.mock(import("../../src/Runtime/draftNode"), async (importOriginal) => {
	const original = await importOriginal();
	return {
		...original,
		entityIdOf: (node: object) => {
			idReads.count++;
			return original.entityIdOf(node);
		}
	};
});

interface ISwatch extends IEntity {
	Hue: number;
}
interface IItem extends IEntity {
	Score: number;
	Note?: {
		Text: string;
	};
	Sub?: ISwatch;
	Tags: string[];
}
interface IList extends IEntity {
	Items: IItem[];
}
interface IBoard extends IEntity {
	Title: string;
	Meta?: {
		Tags: string[];
	};
	Lists: IList[];
}
interface IRow extends IEntity {
	V: number;
}

type IStep = Extract<
	IRecord,
	{
		Kind: "step";
	}
>;

const seed = (): IBoard => ({
	$Id: "B",
	Title: "board",
	Meta: {
		Tags: [
			"a"
		]
	},
	Lists: [
		{
			$Id: "L1",
			Items: [
				{
					$Id: "I1",
					Score: 1,
					Note: {
						Text: "one"
					},
					Sub: {
						$Id: "S1",
						Hue: 1
					},
					Tags: []
				},
				{
					$Id: "I2",
					Score: 2,
					Note: {
						Text: "two"
					},
					Tags: []
				}
			]
		},
		{
			$Id: "L2",
			Items: [
				{
					$Id: "I3",
					Score: 3,
					Tags: []
				}
			]
		}
	]
});

function world(
	kinds: IRecord["Kind"][] = [
		"step"
	],
	landing = true
) {
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
	runtime.on(
		"record",
		(record) => {
			if (record.Kind === "step") {
				steps.push(record);
			}
		},
		{
			kinds,
			landing
		}
	);
	return {
		runtime,
		parks,
		steps
	};
}

function* park(): IActionGenerator {
	yield {
		Type: "park"
	};
}

const at = (EntityId: string, ...Path: string[]): IRecordLanding => ({
	EntityId,
	Path
});

const landings = (
	changes: readonly IRecordChange[]
): [
	string,
	IRecordLanding | undefined
][] =>
	changes.map((change) => [
		change.Path.join("."),
		change.Landing
	]);

const item = (board: IBoard, id: string): IItem | undefined => board.Lists.flatMap((list) => list.Items).find((i) => i.$Id === id);

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});

const draftWarns = (): string[] =>
	warn.mock.calls
		.map((call: unknown[]) => /draft\/[a-z-]+/.exec(String(call[0]))?.[0])
		.filter((code: string | undefined): code is string => code !== undefined);

describe("the landing entity of a step's changes", () => {
	it("names the acting entity for its own fields, a nested object and an array element", async () => {
		const { runtime, steps } = world();
		function* own(d: IBoard): IActionGenerator {
			d.Title = "renamed";
			d.Meta!.Tags[0] = "b";
			d.Meta!.Tags.push("c");
		}
		await runtime.dispatch(own, "B");
		expect(landings(steps[0]!.Changes)).toEqual([
			[
				"Title",
				at("B", "Title")
			],
			[
				"Meta.Tags.0",
				at("B", "Meta", "Tags", "0")
			],
			[
				"Meta.Tags.1",
				at("B", "Meta", "Tags", "1")
			],
			[
				"Meta.Tags.length",
				at("B", "Meta", "Tags", "length")
			]
		]);
		runtime.dispose();
	});

	it("names the child for a parent's write into a child, a grandchild and a plain node inside the child", async () => {
		const { runtime, steps } = world();
		function* intoChildren(d: IBoard): IActionGenerator {
			d.Lists[0]!.Items[0]!.Score = 5;
			d.Lists[0]!.Items[0]!.Sub!.Hue = 2;
			d.Lists[0]!.Items[0]!.Note!.Text = "noted";
		}
		await runtime.dispatch(intoChildren, "B");
		expect(landings(steps[0]!.Changes)).toEqual([
			[
				"Lists.0.Items.0.Score",
				at("I1", "Score")
			],
			[
				"Lists.0.Items.0.Sub.Hue",
				at("S1", "Hue")
			],
			[
				"Lists.0.Items.0.Note.Text",
				at("I1", "Note", "Text")
			]
		]);
		runtime.dispose();
	});

	it("names the list's owner for an added entity's slot, and the new entity for writes into it later in the step", async () => {
		const { runtime, steps } = world();
		function* add(d: IList): IActionGenerator {
			d.Items.push(
				minted("new", {
					Score: 0,
					Tags: [] as string[]
				})
			);
			d.Items[2]!.Score = 9;
			const fresh = d.Items[2]!;
			fresh.Tags.push("t");
		}
		await runtime.dispatch(add, "L1");
		expect(landings(steps[0]!.Changes)).toEqual([
			[
				"Items.2",
				at("L1", "Items", "2")
			],
			[
				"Items.length",
				at("L1", "Items", "length")
			],
			[
				"Items.2.Score",
				at("~new", "Score")
			],
			[
				"Items.2.Tags.0",
				at("~new", "Tags", "0")
			],
			[
				"Items.2.Tags.length",
				at("~new", "Tags", "length")
			]
		]);
		runtime.dispose();
	});

	it("names the entity a held reference's node sits in after another action reordered the list, and keeps the stale Path", async () => {
		const { runtime, parks, steps } = world();
		const search = vi.spyOn((runtime as IRuntimeInternal<IBoard>).get("runtime/writeGateway"), "landingOf");
		function* holdThenWrite(d: IBoard): IOpenGenerator {
			const first = d.Lists[0]!.Items[0]!;
			const note = first.Note!;
			yield* open(park());
			first.Score = 0;
			note.Text = "held";
		}
		function* reverse(d: IList): IActionGenerator {
			d.Items.reverse();
		}
		const held = runtime.dispatch(holdThenWrite, "B");
		await settled();
		await runtime.dispatch(reverse, "L1");
		parks.shift()!();
		await held;
		expect(item(runtime.state, "I1")!.Score).toBe(0);
		expect(runtime.state.Lists[0]!.Items[0]!.$Id).toBe("I2");
		expect(landings(steps.at(-1)!.Changes)).toEqual([
			[
				"Lists.0.Items.0.Score",
				at("I1", "Score")
			],
			[
				"Lists.0.Items.0.Note.Text",
				at("I1", "Note", "Text")
			]
		]);
		expect(draftWarns()).toEqual([
			"draft/stale-path-write",
			"draft/stale-path-write"
		]);
		expect(search).toHaveBeenCalledTimes(1);
		runtime.dispose();
	});

	it("follows an entity and a plain node moved to another entity earlier in the same step", async () => {
		const { runtime, steps } = world();
		function* moveThenWrite(d: IBoard): IActionGenerator {
			const moved = d.Lists[0]!.Items[0]!;
			const note = moved.Note!;
			d.Lists[0]!.Items.splice(0, 1);
			d.Lists[1]!.Items.push(moved);
			moved.Score = 10;
			note.Text = "moved";
			const other = d.Lists[0]!.Items[0]!.Note!;
			d.Lists[1]!.Items[0]!.Note = other;
			delete d.Lists[0]!.Items[0]!.Note;
			other.Text = "moved over";
		}
		await runtime.dispatch(moveThenWrite, "B");
		expect(item(runtime.state, "I1")!.Note!.Text).toBe("moved");
		expect(item(runtime.state, "I3")!.Note!.Text).toBe("moved over");
		expect(landings(steps[0]!.Changes)).toEqual([
			[
				"Lists.0.Items.0",
				at("L1", "Items", "0")
			],
			[
				"Lists.0.Items.1",
				at("L1", "Items", "1")
			],
			[
				"Lists.0.Items.length",
				at("L1", "Items", "length")
			],
			[
				"Lists.1.Items.1",
				at("L2", "Items", "1")
			],
			[
				"Lists.1.Items.length",
				at("L2", "Items", "length")
			],
			[
				"Lists.0.Items.0.Score",
				at("I1", "Score")
			],
			[
				"Lists.0.Items.0.Note.Text",
				at("I1", "Note", "Text")
			],
			[
				"Lists.1.Items.0.Note",
				at("I3", "Note")
			],
			[
				"Lists.0.Items.0.Note",
				at("I2", "Note")
			],
			[
				"Lists.0.Items.0.Note.Text",
				at("I3", "Note", "Text")
			]
		]);
		runtime.dispose();
	});

	it("prefers the holder still in the tree when a node held twice mid-step has lost the other one", async () => {
		const { runtime, steps } = world();
		function* twice(d: IBoard): IActionGenerator {
			const tags = d.Lists[0]!.Items[0]!.Tags;
			d.Lists[0]!.Items.reverse();
			d.Lists[1]!.Items[0]!.Tags = tags;
			d.Lists[1]!.Items.splice(0, 1);
			tags.push("kept");
		}
		await runtime.dispatch(twice, "B");
		expect(item(runtime.state, "I1")!.Tags).toEqual([
			"kept"
		]);
		expect(landings(steps[0]!.Changes).slice(-2)).toEqual([
			[
				"Lists.0.Items.0.Tags.0",
				at("I1", "Tags", "0")
			],
			[
				"Lists.0.Items.0.Tags.length",
				at("I1", "Tags", "length")
			]
		]);
		runtime.dispose();
	});

	it("does not name a place this step put a plain node in once that place is overwritten", async () => {
		const { runtime, steps } = world();
		function* placeThenOverwrite(d: IBoard): IActionGenerator {
			const note = d.Lists[0]!.Items[0]!.Note!;
			d.Lists[0]!.Items.reverse();
			d.Lists[1]!.Items[0]!.Note = note;
			note.Text = "held twice";
			d.Lists[1]!.Items[0]!.Note = {
				Text: "other"
			};
			note.Text = "held once";
		}
		await runtime.dispatch(placeThenOverwrite, "B");
		expect(item(runtime.state, "I1")!.Note!.Text).toBe("held once");
		expect(
			steps[0]!.Changes.filter((change) => change.Path.at(-1) === "Text").map((change) => [
				change.Path.join("."),
				change.Landing
			])
		).toEqual([
			[
				"Lists.0.Items.0.Note.Text",
				at("I3", "Note", "Text")
			],
			[
				"Lists.0.Items.0.Note.Text",
				at("I1", "Note", "Text")
			]
		]);
		runtime.dispose();
	});

	it("names a place this step put a plain node in after a newer place lets go of it", async () => {
		const { runtime, steps } = world();
		function* placeTwiceThenLetGo(d: IBoard): IActionGenerator {
			const note = d.Lists[0]!.Items[0]!.Note!;
			d.Lists[0]!.Items.reverse();
			d.Lists[1]!.Items[0]!.Note = note;
			note.Text = "one";
			const second = d.Lists[1] as unknown as {
				Note?: unknown;
			};
			second.Note = note;
			note.Text = "two";
			delete d.Lists[0]!.Items[1]!.Note;
			delete second.Note;
			note.Text = "three";
		}
		await runtime.dispatch(placeTwiceThenLetGo, "B");
		expect(item(runtime.state, "I3")!.Note!.Text).toBe("three");
		expect(steps[0]!.Changes.filter((change) => change.Path.at(-1) === "Text").map((change) => change.Landing)).toEqual([
			at("I3", "Note", "Text"),
			at("L2", "Note", "Text"),
			at("I3", "Note", "Text")
		]);
		runtime.dispose();
	});

	it("follows an entity and a plain node another action moved before this step", async () => {
		const { runtime, parks, steps } = world();
		function* holdThenWrite(d: IBoard): IOpenGenerator {
			const first = d.Lists[0]!.Items[0]!;
			const note = d.Lists[0]!.Items[1]!.Note!;
			yield* open(park());
			first.Score = 11;
			note.Text = "after the move";
		}
		function* moveAcross(d: IBoard): IActionGenerator {
			const [moved] = d.Lists[0]!.Items.splice(0, 1);
			d.Lists[1]!.Items.push(moved!);
			const note = d.Lists[0]!.Items[0]!.Note!;
			d.Lists[1]!.Items[0]!.Note = note;
			delete d.Lists[0]!.Items[0]!.Note;
		}
		const held = runtime.dispatch(holdThenWrite, "B");
		await settled();
		await runtime.dispatch(moveAcross, "B");
		parks.shift()!();
		await held;
		expect(item(runtime.state, "I1")!.Score).toBe(11);
		expect(item(runtime.state, "I3")!.Note!.Text).toBe("after the move");
		expect(landings(steps.at(-1)!.Changes)).toEqual([
			[
				"Lists.0.Items.0.Score",
				at("I1", "Score")
			],
			[
				"Lists.0.Items.1.Note.Text",
				at("I3", "Note", "Text")
			]
		]);
		runtime.dispose();
	});

	it("names the holder of a removed node's slot, and the node's own entity for a write before its subtree is removed", async () => {
		const { runtime, steps } = world();
		function* remove(d: IBoard): IActionGenerator {
			d.Lists[1]!.Items[0]!.Score = 4;
			d.Lists.splice(1, 1);
			delete d.Meta;
		}
		await runtime.dispatch(remove, "B");
		expect(landings(steps[0]!.Changes)).toEqual([
			[
				"Lists.1.Items.0.Score",
				at("I3", "Score")
			],
			[
				"Lists.1",
				at("B", "Lists", "1")
			],
			[
				"Lists.length",
				at("B", "Lists", "length")
			],
			[
				"Meta",
				at("B", "Meta")
			]
		]);
		runtime.dispose();
	});

	it("names a removed entity for a write into it later in the step, and has none for a removed plain node", async () => {
		const { runtime, steps } = world();
		function* writeAfterRemoval(d: IBoard): IActionGenerator {
			const gone = d.Lists[0]!.Items[1]!;
			const goneNote = gone.Note!;
			const note = d.Lists[0]!.Items[0]!.Note!;
			d.Lists[0]!.Items.pop();
			delete d.Lists[0]!.Items[0]!.Note;
			gone.Score = 0;
			goneNote.Text = "gone";
			note.Text = "orphaned";
		}
		await runtime.dispatch(writeAfterRemoval, "B");
		expect(landings(steps[0]!.Changes)).toEqual([
			[
				"Lists.0.Items.1",
				at("L1", "Items", "1")
			],
			[
				"Lists.0.Items.length",
				at("L1", "Items", "length")
			],
			[
				"Lists.0.Items.0.Note",
				at("I1", "Note")
			],
			[
				"Lists.0.Items.1.Score",
				at("I2", "Score")
			],
			[
				"Lists.0.Items.1.Note.Text",
				at("I2", "Note", "Text")
			],
			[
				"Lists.0.Items.0.Note.Text",
				undefined
			]
		]);
		expect(draftWarns()).toEqual([
			"draft/orphaned-write",
			"draft/orphaned-write",
			"draft/orphaned-write"
		]);
		runtime.dispose();
	});

	it("names the holder for a replaced subtree, a replaced entity, a grown array and a deletion", async () => {
		const { runtime, steps } = world();
		function* reshape(d: IBoard): IActionGenerator {
			d.Lists[0]!.Items[0]!.Note = {
				Text: "replaced"
			};
			d.Lists[1]!.Items[0] = minted("I4", {
				Score: 0,
				Tags: [] as string[]
			});
			d.Lists[0]!.Items[0]!.Tags[0] = "grown";
			delete d.Lists[0]!.Items[1]!.Note;
		}
		await runtime.dispatch(reshape, "B");
		const changes = steps[0]!.Changes;
		expect(landings(changes)).toEqual([
			[
				"Lists.0.Items.0.Note",
				at("I1", "Note")
			],
			[
				"Lists.1.Items.0",
				at("L2", "Items", "0")
			],
			[
				"Lists.0.Items.0.Tags.0",
				at("I1", "Tags", "0")
			],
			[
				"Lists.0.Items.1.Note",
				at("I2", "Note")
			]
		]);
		expect(changes[2]!.GrewFrom).toBe(0);
		expect(changes[3]!.Deleted).toBe(true);
		runtime.dispose();
	});

	it("has none for a transient's own fields, and names an entity inside the transient", async () => {
		const { runtime, steps } = world();
		function* progress(d: IBoard): IActionGenerator {
			const p = yield* transient(d, "Landing/Progress", {
				Count: 0,
				Rows: [] as IRow[]
			});
			p.Count = 1;
			p.Rows.push(
				minted("R1", {
					V: 0
				})
			);
			p.Rows[0]!.V = 1;
		}
		await runtime.dispatch(progress, "B");
		expect(steps[0]!.Root).toBe("AppState");
		expect(landings(steps[0]!.Changes)).toEqual([
			[
				"TransientState.B.Landing/Progress.Count",
				undefined
			],
			[
				"TransientState.B.Landing/Progress.Rows.0",
				undefined
			],
			[
				"TransientState.B.Landing/Progress.Rows.length",
				undefined
			],
			[
				"TransientState.B.Landing/Progress.Rows.0.V",
				at("~R1", "V")
			]
		]);
		expect(steps[0]!.Changes.slice(0, 3).every((change) => !("Landing" in change))).toBe(true);
		runtime.dispose();
	});

	it("keeps the stale Path and has none for a transient's field written through a reference held across a reorder", async () => {
		const { runtime, steps } = world();
		function* reorderUnderAHold(d: IBoard): IActionGenerator {
			const p = yield* transient(d, "Landing/Rows", {
				Rows: [
					{
						A: {
							X: 0
						}
					},
					{
						A: {
							X: 1
						}
					}
				]
			});
			const a = p.Rows[0]!.A;
			p.Rows.reverse();
			a.X = 99;
		}
		await runtime.dispatch(reorderUnderAHold, "B");
		const write = steps[0]!.Changes.at(-1)!;
		expect(write.Path.join(".")).toBe("TransientState.B.Landing/Rows.Rows.0.A.X");
		expect(write.Prev).toBe(0);
		expect(write.Value).toBe(99);
		expect("Landing" in write).toBe(false);
		runtime.dispose();
	});

	it("names the component's entity for a write to component state", async () => {
		const { runtime, steps } = world();
		const id = mountComponent(runtime, "B", {
			Open: false,
			Panel: {
				W: 1
			}
		});
		function* toggle(d: any): IActionGenerator {
			d.Open = true;
			d.Panel.W = 2;
		}
		await runtime.dispatch(toggle, id);
		expect(steps[0]!.Root).toBe("ComponentState");
		expect(landings(steps[0]!.Changes)).toEqual([
			[
				"Open",
				at(id, "Open")
			],
			[
				"Panel.W",
				at(id, "Panel", "W")
			]
		]);
		runtime.dispose();
	});

	it("records nothing for a step the tree rule refuses", async () => {
		const { runtime, steps } = world();
		function* alias(d: IBoard): IActionGenerator {
			d.Title = "aliased";
			(
				d as unknown as {
					Meta: unknown;
				}
			).Meta = d.Lists[0]!.Items[0]!.Note;
		}
		await expect(runtime.dispatch(alias, "B")).rejects.toThrow(StateAliasError);
		expect(steps).toEqual([]);
		expect(runtime.state.Title).toBe("board");
		runtime.dispose();
	});

	it("names the entity a close writes, after the entity has left the tree", async () => {
		const { runtime, steps } = world();
		function* closes(d: IItem): IActionGenerator {
			try {
				yield* park();
			} finally {
				d.Score = -1;
				d.Note!.Text = "closed";
			}
		}
		function* drop(d: IList): IActionGenerator {
			d.Items.splice(0, 1);
		}
		const run = runtime.dispatch(closes, "I1");
		await settled();
		await runtime.dispatch(drop, "L1");
		await run;
		const close = steps.find((step) => step.Cancelling)!;
		expect(landings(close.Changes)).toEqual([
			[
				"Score",
				at("I1", "Score")
			],
			[
				"Note.Text",
				at("I1", "Note", "Text")
			]
		]);
		runtime.dispose();
	});

	it("is carried on a trace's step entries", async () => {
		const { runtime } = world();
		const traces: IActionTrace[] = [];
		createTraceAggregator(runtime, (trace) => traces.push(trace));
		function* write(d: IBoard): IActionGenerator {
			d.Lists[0]!.Items[1]!.Score = 7;
		}
		await runtime.dispatch(write, "B");
		const entry = traces[0]!.entries.find((e) => e.type === "step")!;
		expect(entry.type === "step" && entry.changes[0]!.Landing).toEqual(at("I2", "Score"));
		runtime.dispose();
	});

	it("is worked out only while a tap takes step", async () => {
		const { runtime, parks } = world([
			"action:end"
		]);
		const gateway = (runtime as IRuntimeInternal<IBoard>).get("runtime/writeGateway");
		const search = vi.spyOn(gateway, "landingOf");
		function* holdThenWrite(d: IBoard): IOpenGenerator {
			const note = d.Lists[0]!.Items[0]!.Note!;
			yield* open(park());
			note.Text = "held";
		}
		function* reverse(d: IList): IActionGenerator {
			d.Items.reverse();
		}
		const held = runtime.dispatch(holdThenWrite, "B");
		await settled();
		await runtime.dispatch(reverse, "L1");
		parks.shift()!();
		await held;
		expect(item(runtime.state, "I1")!.Note!.Text).toBe("held");
		expect(draftWarns()).toEqual([
			"draft/stale-path-write"
		]);
		expect(search).not.toHaveBeenCalled();
		runtime.dispose();
	});

	it("names the newest place of a node that two places reaching the root hold mid-step", async () => {
		const { runtime, steps } = world();
		const search = vi.spyOn((runtime as IRuntimeInternal<IBoard>).get("runtime/writeGateway"), "landingOf");
		function* threePlaces(d: IBoard): IActionGenerator {
			const note = d.Lists[0]!.Items[0]!.Note!;
			d.Lists[0]!.Items.reverse();
			d.Lists[1]!.Items[0]!.Note = note;
			(
				d.Lists[1] as unknown as {
					Note?: unknown;
				}
			).Note = note;
			note.Text = "newest";
			delete d.Lists[0]!.Items[1]!.Note;
			delete d.Lists[1]!.Items[0]!.Note;
		}
		await runtime.dispatch(threePlaces, "B");
		expect(steps[0]!.Changes.find((change) => change.Path.at(-1) === "Text")!.Landing).toEqual(at("L2", "Note", "Text"));
		expect(search).toHaveBeenCalledTimes(1);
		runtime.dispose();
	});

	it("follows an entity added and then moved in the same step, written through a reference held across both", async () => {
		const { runtime, steps } = world();
		function* addThenMove(d: IBoard): IActionGenerator {
			d.Lists[0]!.Items.push(
				minted("n", {
					Score: 0,
					Note: {
						Text: ""
					},
					Tags: [] as string[]
				})
			);
			const fresh = d.Lists[0]!.Items[2]!;
			const note = fresh.Note!;
			d.Lists[0]!.Items.splice(2, 1);
			d.Lists[1]!.Items.unshift(fresh);
			note.Text = "after";
		}
		await runtime.dispatch(addThenMove, "B");
		expect(runtime.state.Lists[1]!.Items[0]!.Note!.Text).toBe("after");
		expect(steps[0]!.Changes.at(-1)!.Landing).toEqual(at("~n", "Note", "Text"));
		runtime.dispose();
	});

	it("names the component's entity for component state written through a reference held across another action's reorder", async () => {
		const { runtime, parks, steps } = world();
		const id = mountComponent(runtime, "B", {
			Rows: [
				{
					A: {
						X: 0
					}
				},
				{
					A: {
						X: 1
					}
				}
			]
		});
		function* hold(d: any): IOpenGenerator {
			const a = d.Rows[0].A;
			yield* open(park());
			a.X = 99;
		}
		function* reverse(d: any): IActionGenerator {
			d.Rows.reverse();
		}
		const held = runtime.dispatch(hold, id);
		await settled();
		await runtime.dispatch(reverse, id);
		parks.shift()!();
		await held;
		expect(landings(steps.at(-1)!.Changes)).toEqual([
			[
				"Rows.0.A.X",
				at(id, "Rows", "1", "A", "X")
			]
		]);
		runtime.dispose();
	});
});

describe("the search for a landing across a step", () => {
	it("reads each write of the frame once, however many searches the step makes", () => {
		const gateway = createWriteGateway({
			journal: createJournal(),
			emitDiag: () => {},
			verifyIndex: "off"
		});
		const { raw, setState } = createTreeState(
			{
				$Id: "R",
				Rows: [
					{
						Box: {
							N: 0
						}
					}
				]
			},
			gateway
		);
		gateway.connect(raw, setState);
		const box = raw.Rows[0]!.Box;
		let reads = 0;
		const written = new Proxy(
			{},
			{
				getOwnPropertyDescriptor(target, key) {
					reads++;
					return Reflect.getOwnPropertyDescriptor(target, key);
				}
			}
		);
		const writes = 2000;
		const found = gateway.exemptFrame(() => {
			let last: unknown;
			for (let i = 0; i < writes; i++) {
				gateway.logWrite(written, `N${i}`, false, undefined, -1);
				last = gateway.landingOf(box);
			}
			return last;
		});
		expect(found).toEqual({
			entityId: "R",
			path: [
				"Rows",
				"0",
				"Box"
			]
		});
		expect(reads).toBe(writes);
	});

	it("checks work in proportion to the moves when a node moves to a new place before each search", () => {
		const searchWork = (moves: number): number => {
			const gateway = createWriteGateway({
				journal: createJournal(),
				emitDiag: () => {},
				verifyIndex: "off"
			});
			const { raw, setState } = createTreeState<Record<string, any>>(
				{
					$Id: "R",
					Bag: {
						k0: {
							N: 0
						}
					}
				},
				gateway
			);
			gateway.connect(raw, setState);
			const bag = raw.Bag;
			const box = bag.k0;
			const hasOwn = Object.hasOwn;
			let counting = false;
			let checks = 0;
			const spy = vi.spyOn(Object, "hasOwn").mockImplementation((o: object, k: PropertyKey) => {
				if (counting) {
					checks++;
				}
				return hasOwn(o, k);
			});
			gateway.exemptFrame(() => {
				for (let i = 1; i <= moves; i++) {
					bag[`k${i}`] = box;
					gateway.logWrite(bag, `k${i}`, false, undefined, -1);
					delete bag[`k${i - 1}`];
					gateway.logWrite(bag, `k${i - 1}`, true, box, -1);
					counting = true;
					const found = gateway.landingOf(box);
					counting = false;
					expect(found?.path).toEqual([
						"Bag",
						`k${i}`
					]);
				}
			});
			spy.mockRestore();
			return checks;
		};
		const few = searchWork(500);
		const many = searchWork(2000);
		expect(many / few).toBeLessThan(5);
	});

	it("forgets what unwound writes placed", () => {
		const gateway = createWriteGateway({
			journal: createJournal(),
			emitDiag: () => {},
			verifyIndex: "off"
		});
		const { raw, setState } = createTreeState<Record<string, Record<string, unknown>>>(
			{
				A: {
					$Id: "A"
				},
				B: {
					$Id: "B"
				},
				Plain: {
					X: 0
				}
			},
			gateway
		);
		gateway.connect(raw, setState);
		const plain = raw.Plain!;
		const found = gateway.exemptFrame(() => {
			const mark = gateway.logMark();
			raw.A!.Held = plain;
			gateway.logWrite(raw.A!, "Held", false, undefined, -1);
			delete raw.Plain;
			gateway.logWrite(raw, "Plain", true, plain, -1);
			const before = gateway.landingOf(plain);
			gateway.unwindTo(mark);
			gateway.releaseMark();
			raw.B!.Held = plain;
			gateway.logWrite(raw.B!, "Held", false, undefined, -1);
			delete raw.Plain;
			gateway.logWrite(raw, "Plain", true, plain, -1);
			return [
				before,
				gateway.landingOf(plain)
			];
		});
		expect(found).toEqual([
			{
				entityId: "A",
				path: [
					"Held"
				]
			},
			{
				entityId: "B",
				path: [
					"Held"
				]
			}
		]);
	});

	it("starts the step after a refused one with nothing from the refused step's writes", async () => {
		const { runtime, steps } = world();
		function* refused(d: IBoard): IActionGenerator {
			for (const title of [
				"a",
				"b",
				"c",
				"d",
				"e",
				"f"
			]) {
				d.Title = title;
			}
			const note = d.Lists[0]!.Items[0]!.Note!;
			d.Lists[0]!.Items.reverse();
			note.Text = "refused";
			(
				d as unknown as {
					Meta: unknown;
				}
			).Meta = d.Lists[0]!.Items[0]!.Tags;
		}
		await expect(runtime.dispatch(refused, "B")).rejects.toThrow(StateAliasError);
		function* accepted(d: IBoard): IActionGenerator {
			const note = d.Lists[0]!.Items[0]!.Note!;
			d.Lists[1]!.Items[0]!.Note = note;
			delete d.Lists[0]!.Items[0]!.Note;
			note.Text = "accepted";
		}
		await runtime.dispatch(accepted, "B");
		expect(item(runtime.state, "I3")!.Note!.Text).toBe("accepted");
		expect(landings(steps[0]!.Changes)).toEqual([
			[
				"Lists.1.Items.0.Note",
				at("I3", "Note")
			],
			[
				"Lists.0.Items.0.Note",
				at("I1", "Note")
			],
			[
				"Lists.0.Items.0.Note.Text",
				at("I3", "Note", "Text")
			]
		]);
		runtime.dispose();
	});

	it("starts each of two steps in a row afresh, each moving a node and writing it through a held reference", async () => {
		const { runtime, steps } = world();
		function* first(d: IBoard): IActionGenerator {
			d.Title = "a";
			d.Title = "b";
			d.Title = "c";
			const note = d.Lists[0]!.Items[0]!.Note!;
			d.Lists[1]!.Items[0]!.Note = note;
			delete d.Lists[0]!.Items[0]!.Note;
			note.Text = "first";
		}
		function* second(d: IBoard): IActionGenerator {
			const note = d.Lists[1]!.Items[0]!.Note!;
			d.Lists[0]!.Items[1]!.Note = note;
			delete d.Lists[1]!.Items[0]!.Note;
			note.Text = "second";
		}
		await runtime.dispatch(first, "B");
		await runtime.dispatch(second, "B");
		expect(item(runtime.state, "I2")!.Note!.Text).toBe("second");
		expect(steps.map((step) => step.Changes.at(-1)!.Landing)).toEqual([
			at("I3", "Note", "Text"),
			at("I2", "Note", "Text")
		]);
		runtime.dispose();
	});
});

describe("a tap that files a step's writes by the entity they landed in", () => {
	it("files a parent's writes into its children, a reorder, and a write through a reference held across it", async () => {
		const { runtime, parks } = world();
		const filed = new Map<string, string[]>();
		const unfiled: string[] = [];
		runtime.on(
			"record",
			(record) => {
				if (record.Kind !== "step") {
					return;
				}
				for (const change of record.Changes) {
					if (!change.Landing) {
						unfiled.push(change.Path.join("."));
						continue;
					}
					const writes = filed.get(change.Landing.EntityId) ?? [];
					writes.push(`${change.Landing.Path.join(".")}=${JSON.stringify(change.Value)}`);
					filed.set(change.Landing.EntityId, writes);
				}
			},
			{
				kinds: [
					"step"
				],
				landing: true
			}
		);
		function* parentWrites(d: IList): IActionGenerator {
			d.Items[0]!.Score = 10;
			d.Items[1]!.Note!.Text = "parent";
		}
		function* hold(d: IBoard): IOpenGenerator {
			const first = d.Lists[0]!.Items[0]!;
			yield* open(park());
			first.Note!.Text = "held";
		}
		function* reverse(d: IList): IActionGenerator {
			d.Items.reverse();
		}
		await runtime.dispatch(parentWrites, "L1");
		const held = runtime.dispatch(hold, "B");
		await settled();
		await runtime.dispatch(reverse, "L1");
		parks.shift()!();
		await held;
		expect([
			...filed.keys()
		]).toEqual([
			"I1",
			"I2",
			"L1"
		]);
		expect(filed.get("I1")).toEqual([
			"Score=10",
			'Note.Text="held"'
		]);
		expect(filed.get("I2")).toEqual([
			'Note.Text="parent"'
		]);
		expect(filed.get("L1")!.map((write) => write.split("=")[0])).toEqual([
			"Items.0",
			"Items.1"
		]);
		expect(unfiled).toEqual([]);
		runtime.dispose();
	});
});

const carriesLanding = (changes: readonly IRecordChange[]): boolean[] => changes.map((change) => "Landing" in change);

const traceChanges = (traces: readonly IActionTrace[]): IRecordChange[] =>
	traces.flatMap((trace) => trace.entries.flatMap((entry) => (entry.type === "step" ? entry.changes : [])));

const askOn = (runtime: IRuntime<object>): (() => void) =>
	runtime.on("record", () => {}, {
		kinds: [
			"step"
		],
		landing: true
	});

function* writeIntoChild(d: IBoard): IActionGenerator {
	d.Lists[0]!.Items[1]!.Score = 7;
}

describe("asking for the landing entity", () => {
	it("gives no change a Landing key and makes no search for a step tap that does not ask", async () => {
		const { runtime, parks, steps } = world(
			[
				"step"
			],
			false
		);
		const search = vi.spyOn((runtime as IRuntimeInternal<IBoard>).get("runtime/writeGateway"), "landingOf");
		function* intoChild(d: IBoard): IActionGenerator {
			d.Lists[0]!.Items[0]!.Score = 5;
			d.Lists[0]!.Items[0]!.Sub!.Hue = 2;
		}
		function* add(d: IList): IActionGenerator {
			d.Items.push(
				minted("new", {
					Score: 0,
					Tags: [] as string[]
				})
			);
			d.Items[2]!.Score = 9;
		}
		function* progress(d: IBoard): IActionGenerator {
			const p = yield* transient(d, "Landing/Progress", {
				Count: 0
			});
			p.Count = 1;
		}
		function* deleteAndResize(d: IBoard): IActionGenerator {
			delete d.Lists[0]!.Items[1]!.Note;
			d.Lists[0]!.Items[0]!.Tags.push("x", "y");
			d.Lists[0]!.Items[0]!.Tags.length = 1;
		}
		function* holdThenWrite(d: IBoard): IOpenGenerator {
			const first = d.Lists[0]!.Items[0]!;
			const note = first.Note!;
			yield* open(park());
			first.Score = 0;
			note.Text = "held";
		}
		function* reverse(d: IList): IActionGenerator {
			d.Items.reverse();
		}
		await runtime.dispatch(intoChild, "B");
		await runtime.dispatch(add, "L1");
		await runtime.dispatch(progress, "B");
		await runtime.dispatch(deleteAndResize, "B");
		const held = runtime.dispatch(holdThenWrite, "B");
		await settled();
		await runtime.dispatch(reverse, "L1");
		parks.shift()!();
		await held;
		expect(item(runtime.state, "I1")!.Note!.Text).toBe("held");
		const changes = steps.flatMap((step) => step.Changes);
		expect(changes.map((change) => change.Path.join("."))).toEqual(
			expect.arrayContaining([
				"Lists.0.Items.0.Sub.Hue",
				"Items.2",
				"Items.2.Score",
				"TransientState.B.Landing/Progress.Count",
				"Lists.0.Items.1.Note",
				"Lists.0.Items.0.Tags.1",
				"Lists.0.Items.0.Tags.length",
				"Lists.0.Items.0.Note.Text"
			])
		);
		expect(item(runtime.state, "I1")!.Tags).toEqual([
			"x"
		]);
		expect(carriesLanding(changes).some(Boolean)).toBe(false);
		expect(search).not.toHaveBeenCalled();
		runtime.dispose();
	});

	it("gives a trace's step entries no Landing key while no tap asks", async () => {
		const { runtime } = world(
			[
				"step"
			],
			false
		);
		const traces: IActionTrace[] = [];
		createTraceAggregator(runtime, (trace) => traces.push(trace));
		await runtime.dispatch(writeIntoChild, "B");
		expect(carriesLanding(traceChanges(traces))).toEqual([
			false
		]);
		runtime.dispose();
	});

	it("gives every tap and trace the Landing while one tap asks, and none from the first step that begins after it detaches", async () => {
		const { runtime, steps } = world(
			[
				"step"
			],
			false
		);
		const traces: IActionTrace[] = [];
		createTraceAggregator(runtime, (trace) => traces.push(trace));
		const asked: IStep[] = [];
		const off = runtime.on(
			"record",
			(record) => {
				asked.push(record);
			},
			{
				kinds: [
					"step"
				],
				landing: true
			}
		);
		await runtime.dispatch(writeIntoChild, "B");
		expect(steps[0]!.Changes[0]!.Landing).toEqual(at("I2", "Score"));
		expect(asked[0]!.Changes[0]!.Landing).toEqual(at("I2", "Score"));
		expect(traceChanges(traces)[0]!.Landing).toEqual(at("I2", "Score"));
		off();
		traces.length = 0;
		await runtime.dispatch(writeIntoChild, "B");
		expect(carriesLanding(steps[1]!.Changes)).toEqual([
			false
		]);
		expect(carriesLanding(traceChanges(traces))).toEqual([
			false
		]);
		runtime.dispose();
	});

	it("turns nothing on for landing on a tap that does not take step", async () => {
		const { runtime, steps } = world(
			[
				"step"
			],
			false
		);
		const search = vi.spyOn((runtime as IRuntimeInternal<IBoard>).get("runtime/writeGateway"), "landingOf");
		runtime.on("record", () => {}, {
			kinds: [
				"action:end"
			],
			landing: true
		});
		await runtime.dispatch(writeIntoChild, "B");
		expect(carriesLanding(steps[0]!.Changes)).toEqual([
			false
		]);
		expect(search).not.toHaveBeenCalled();
		runtime.dispose();
	});

	it("gives an action in flight when a tap starts asking the Landing from its next step", async () => {
		const { runtime, parks, steps } = world(
			[
				"step"
			],
			false
		);
		function* twoSteps(d: IBoard): IActionGenerator {
			d.Title = "before";
			yield* park();
			d.Lists[0]!.Items[0]!.Score = 2;
		}
		const run = runtime.dispatch(twoSteps, "B");
		await settled();
		askOn(runtime);
		parks.shift()!();
		await run;
		expect(steps.map((step) => landings(step.Changes))).toEqual([
			[
				[
					"Title",
					undefined
				]
			],
			[
				[
					"Lists.0.Items.0.Score",
					at("I1", "Score")
				]
			]
		]);
		expect(carriesLanding(steps[0]!.Changes)).toEqual([
			false
		]);
		runtime.dispose();
	});

	it("keeps the Landing while one of two asking taps stays, and gives none from the step after the last one detaches", async () => {
		const { runtime, parks, steps } = world(
			[
				"step"
			],
			false
		);
		const offFirst = askOn(runtime);
		const offSecond = askOn(runtime);
		function* threeSteps(d: IBoard): IActionGenerator {
			d.Title = "one";
			yield* park();
			d.Title = "two";
			yield* park();
			d.Title = "three";
		}
		const run = runtime.dispatch(threeSteps, "B");
		await settled();
		offFirst();
		parks.shift()!();
		await settled();
		offSecond();
		parks.shift()!();
		await run;
		expect(steps.map((step) => carriesLanding(step.Changes))).toEqual([
			[
				true
			],
			[
				true
			],
			[
				false
			]
		]);
		runtime.dispose();
	});

	it("gives the Landing to an action queued behind a hold before the ask, which begins after it", async () => {
		const { runtime, parks, steps } = world(
			[
				"step"
			],
			false
		);
		function* holder(d: IItem): IActionGenerator {
			d.Score = 1;
			yield* park();
		}
		function* queued(d: IItem): IActionGenerator {
			d.Note!.Text = "queued";
		}
		const first = runtime.dispatch(holder, "I1");
		await settled();
		const second = runtime.dispatch(queued, "I1");
		await settled();
		expect(steps).toHaveLength(1);
		askOn(runtime);
		parks.shift()!();
		await Promise.all([
			first,
			second
		]);
		expect(steps.map((step) => landings(step.Changes))).toEqual([
			[
				[
					"Score",
					undefined
				]
			],
			[
				[
					"Note.Text",
					at("I1", "Note", "Text")
				]
			]
		]);
		runtime.dispose();
	});

	it("leaves a step as it began when its own code attaches or detaches the asking tap", async () => {
		const { runtime, parks, steps } = world(
			[
				"step"
			],
			false
		);
		let off = (): void => {};
		function* attachThenDetach(d: IBoard): IActionGenerator {
			d.Title = "before";
			off = askOn(runtime);
			d.Lists[0]!.Items[0]!.Score = 2;
			yield* park();
			d.Title = "after";
			off();
			d.Lists[0]!.Items[0]!.Score = 3;
		}
		const run = runtime.dispatch(attachThenDetach, "B");
		await settled();
		parks.shift()!();
		await run;
		expect(steps.map((step) => carriesLanding(step.Changes))).toEqual([
			[
				false,
				false
			],
			[
				true,
				true
			]
		]);
		runtime.dispose();
	});

	it("reads the ask for a close when the close begins, not when its action was dispatched", async () => {
		const closeLandings = async (askAtDispatch: boolean): Promise<boolean[][]> => {
			const { runtime, steps } = world(
				[
					"step"
				],
				false
			);
			const off = askAtDispatch ? askOn(runtime) : (): void => {};
			const run = runtime.dispatch(function* closes(d: IItem): IActionGenerator {
				d.Score = 1;
				try {
					yield* park();
				} finally {
					d.Note!.Text = "closed";
				}
			}, "I1");
			await settled();
			if (askAtDispatch) {
				off();
			} else {
				askOn(runtime);
			}
			await runtime.dispatch(function* drop(d: IList): IActionGenerator {
				d.Items.splice(0, 1);
			}, "L1");
			await run;
			runtime.dispose();
			const own = steps.filter((step) => step.Cancelling || step.Changes.some((change) => change.Path.join(".") === "Score"));
			return own.map((step) => carriesLanding(step.Changes));
		};
		expect(await closeLandings(false)).toEqual([
			[
				false
			],
			[
				true
			]
		]);
		expect(await closeLandings(true)).toEqual([
			[
				true
			],
			[
				false
			]
		]);
	});

	it("reads whether a tap asks once for each step that records changes, and never with no step tap", async () => {
		const reads = async (kinds: IRecord["Kind"][]): Promise<number> => {
			const { runtime } = world(kinds, false);
			const read = vi.spyOn((runtime as IRuntimeInternal<IBoard>).get("runtime/journal"), "asking", "get");
			function* closesOnRemoval(d: IItem): IActionGenerator {
				d.Score = 1;
				try {
					yield* park();
				} finally {
					d.Score = -1;
				}
			}
			function* drop(d: IList): IActionGenerator {
				d.Items.splice(0, 1);
			}
			const run = runtime.dispatch(closesOnRemoval, "I1");
			await settled();
			await runtime.dispatch(drop, "L1");
			await run;
			runtime.dispose();
			return read.mock.calls.length;
		};
		expect(
			await reads([
				"action:end"
			])
		).toBe(0);
		expect(
			await reads([
				"step"
			])
		).toBe(3);
	});

	it("does no landing work for a step tap that does not ask, at depth six and through a held reference", async () => {
		const writes = 50;
		const landingWork = async (
			kinds: IRecord["Kind"][],
			landing: boolean
		): Promise<{
			reads: number;
			searches: number;
		}> => {
			const parks: (() => void)[] = [];
			const runtime = createRuntime<any>(
				{
					$Id: "Deep",
					A: {
						B: {
							C: {
								D: {
									E: {
										F: {
											X: 0,
											Gone: 0,
											L: []
										}
									}
								}
							}
						}
					},
					Rows: [
						{
							A: {
								X: 0
							}
						},
						{
							A: {
								X: 1
							}
						}
					]
				},
				{
					onError: () => {}
				}
			);
			runtime.registerImplementation(
				"park",
				() =>
					new Promise<void>((resolve) => {
						parks.push(resolve);
					})
			);
			runtime.on("record", () => {}, {
				kinds,
				landing
			});
			const search = vi.spyOn((runtime as IRuntimeInternal<any>).get("runtime/writeGateway"), "landingOf");
			function* deep(d: any): IActionGenerator {
				for (let i = 1; i <= writes; i++) {
					d.A.B.C.D.E.F.X = i;
				}
				d.A.B.C.D.E.F.L.push(1, 2);
				d.A.B.C.D.E.F.L.length = 1;
				delete d.A.B.C.D.E.F.Gone;
			}
			function* hold(d: any): IOpenGenerator {
				const a = d.Rows[0].A;
				yield* open(park());
				for (let i = 1; i <= writes; i++) {
					a.X = i;
				}
			}
			function* reverse(d: any): IActionGenerator {
				d.Rows.reverse();
			}
			const before = idReads.count;
			await runtime.dispatch(deep, "Deep");
			const held = runtime.dispatch(hold, "Deep");
			await settled();
			await runtime.dispatch(reverse, "Deep");
			parks.shift()!();
			await held;
			const reads = idReads.count - before;
			runtime.dispose();
			return {
				reads,
				searches: search.mock.calls.length
			};
		};
		const noStep = await landingWork(
			[
				"action:end"
			],
			false
		);
		const notAsking = await landingWork(
			[
				"step"
			],
			false
		);
		const asking = await landingWork(
			[
				"step"
			],
			true
		);
		expect(notAsking).toEqual(noStep);
		expect(noStep.searches).toBe(0);
		expect(asking.reads).toBeGreaterThan(noStep.reads + 7 * writes);
		expect(asking.searches).toBe(writes);
	});

	it("takes landing beside kinds, and keeps a change's Landing optional", () => {
		expectTypeOf<IRecordTapOptions<"step">["landing"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<IRecordChange["Landing"]>().toEqualTypeOf<IRecordLanding | undefined>();
		expectTypeOf({
			Path: [
				"X"
			],
			Prev: 0,
			Value: 1
		}).toExtend<IRecordChange>();
		const runtime = createRuntime<IBoard>(seed());
		const off = runtime.on(
			"record",
			(record) => {
				expectTypeOf(record.Changes[0]!.Landing).toEqualTypeOf<IRecordLanding | undefined>();
			},
			{
				kinds: [
					"step"
				],
				landing: true
			}
		);
		expectTypeOf<{
			landing: true;
		}>().not.toExtend<IRecordTapOptions<"step">>();
		off();
		runtime.dispose();
	});
});

describe("the count of asking taps", () => {
	const noop = (): void => {};

	it("keeps asking while one of two asking taps stays, and stops when both have gone", () => {
		const journal = createJournal();
		const first = journal.tap(
			noop,
			[
				"step"
			],
			true
		);
		const second = journal.tap(
			noop,
			[
				"step"
			],
			true
		);
		first();
		expect(journal.asking).toBe(true);
		second();
		expect(journal.asking).toBe(false);
	});

	it("doesn't count a tap unsubscribed twice below zero", () => {
		const journal = createJournal();
		const first = journal.tap(
			noop,
			[
				"step"
			],
			true
		);
		const second = journal.tap(
			noop,
			[
				"step"
			],
			true
		);
		first();
		first();
		expect(journal.asking).toBe(true);
		second();
		expect(journal.asking).toBe(false);
		journal.tap(
			noop,
			[
				"step"
			],
			true
		);
		expect(journal.asking).toBe(true);
	});

	it("ends the ask when the asking one of a listener attached twice is removed", () => {
		const journal = createJournal();
		const asking = journal.tap(
			noop,
			[
				"step"
			],
			true
		);
		journal.tap(noop, [
			"step"
		]);
		asking();
		expect(journal.asking).toBe(false);
		expect(journal.sample().step).toBe(true);
	});

	it("asks nothing for an empty kinds with landing", () => {
		const journal = createJournal();
		journal.tap(noop, [], true);
		expect(journal.asking).toBe(false);
	});
});

const Reached = receiver<IItem>("LandingReached")({
	*"Landing/Ping"(d, e) {
		d.Score = 20;
		d.Note!.Text = e.Text;
	},
	*"Landing/Tick"(d) {
		d.Score += 1;
	},
	*"Landing/Feed"(d, e) {
		if (!isEnded(e)) {
			d.Note!.Text = e.Text;
		}
	}
});

const reaches: [
	string,
	(landing: boolean) => Promise<IStep[]>
][] = [
	[
		"a receiver's delivery",
		async (landing) => {
			const { runtime, steps } = world(
				[
					"step"
				],
				landing
			);
			runtime.registerReceiver(Reached);
			await runtime.dispatch(function* listen(d: IItem): IActionGenerator {
				bind(d, Reached);
			}, "I1");
			steps.length = 0;
			await runtime.dispatch(function* ping(_d: IBoard): IActionGenerator {
				yield* publish("Landing/Ping", {
					Text: "pinged"
				});
			}, "B");
			await settled();
			runtime.dispose();
			return steps;
		}
	],
	[
		"a timer's tick",
		async (landing) => {
			vi.useFakeTimers();
			try {
				const { runtime, steps } = world(
					[
						"step"
					],
					landing
				);
				runtime.registerReceiver(Reached);
				await runtime.dispatch(function* arm(d: IItem): IActionGenerator {
					yield* startTimer(d, "Landing/Tick", Reached, 10);
				}, "I1");
				steps.length = 0;
				await vi.advanceTimersByTimeAsync(15);
				runtime.dispose();
				return steps;
			} finally {
				vi.useRealTimers();
			}
		}
	],
	[
		"a resource's delivery",
		async (landing) => {
			const { runtime, steps } = world(
				[
					"step"
				],
				landing
			);
			runtime.registerReceiver(Reached);
			let feed!: IResourceContext<"landing/feed">;
			runtime.registerResourceType("landing/feed", (_params, context) => {
				feed = context;
			});
			await runtime.dispatch(function* openFeed(d: IItem): IActionGenerator {
				yield* openResource(d, "Landing/Feed", Reached, {
					Type: "landing/feed"
				});
			}, "I1");
			await settled();
			steps.length = 0;
			await feed.emit({
				Text: "fed"
			});
			await settled();
			runtime.dispose();
			return steps;
		}
	],
	[
		"parallel branches",
		async (landing) => {
			const { runtime, steps } = world(
				[
					"step"
				],
				landing
			);
			function* left(d: IBoard): IActionGenerator {
				d.Lists[0]!.Items[0]!.Score = 31;
			}
			function* right(d: IBoard): IActionGenerator {
				d.Lists[1]!.Items[0]!.Score = 32;
			}
			await runtime.dispatch(function* both(d: IBoard): IActionGenerator {
				yield* parallel(left(d), right(d));
			}, "B");
			runtime.dispose();
			return steps;
		}
	],
	[
		"a started action",
		async (landing) => {
			const { runtime, steps } = world(
				[
					"step"
				],
				landing
			);
			function* child(d: IItem): IActionGenerator {
				d.Note!.Text = "started";
			}
			await runtime.dispatch(function* starts(_d: IBoard): IActionGenerator {
				yield* start(child, "I1");
			}, "B");
			await settled();
			runtime.dispose();
			return steps;
		}
	],
	[
		"a cancellation's close",
		async (landing) => {
			const { runtime, steps } = world(
				[
					"step"
				],
				landing
			);
			const run = runtime.dispatch(function* closes(d: IItem): IActionGenerator {
				try {
					yield* park();
				} finally {
					d.Note!.Text = "closed";
				}
			}, "I1");
			await settled();
			await runtime.dispatch(function* drop(d: IList): IActionGenerator {
				d.Items.splice(0, 1);
			}, "L1");
			await run;
			runtime.dispose();
			return steps.filter((step) => step.Cancelling);
		}
	],
	[
		"a latest replacement's close",
		async (landing) => {
			const { runtime, parks, steps } = world(
				[
					"step"
				],
				landing
			);
			const replaced = latest(function* replaced(d: IItem, text: string): IActionGenerator {
				try {
					yield* park();
				} finally {
					d.Note!.Text = text;
				}
			});
			const first = runtime.dispatch(replaced, "I1", "first");
			await settled();
			const second = runtime.dispatch(replaced, "I1", "second");
			await settled();
			parks.at(-1)!();
			await Promise.all([
				first,
				second
			]);
			runtime.dispose();
			return steps.filter((step) => step.Cancelling);
		}
	],
	[
		"an action on a restored runtime, the tap attached in setup",
		async (landing) => {
			const source = createRuntime<IBoard>(seed());
			const json = createSnapshot(source);
			source.dispose();
			const steps: IStep[] = [];
			const { runtime } = await restoreRuntime<IBoard>(json, {
				rootId: "B",
				options: {},
				setup: (restored) => {
					restored.on(
						"record",
						(record) => {
							steps.push(record);
						},
						{
							kinds: [
								"step"
							],
							landing
						}
					);
				}
			});
			await runtime.dispatch(writeIntoChild, "B");
			runtime.dispose();
			return steps;
		}
	]
];

describe("the ask's reach", () => {
	it.each([
		true,
		false
	])("reaches every kind of work that records changes, asking: %s", async (landing) => {
		for (const [work, reach] of reaches) {
			const changes = (await reach(landing)).flatMap((step) => step.Changes);
			expect(changes.length, work).toBeGreaterThan(0);
			expect(carriesLanding(changes), work).toEqual(changes.map(() => landing));
		}
	});
});
