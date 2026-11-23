import type { IActionGenerator, IEntity, IOpenGenerator } from "../../src/index";
import type { IHistory, IHistoryEntry } from "../../src/Resume/history";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IRecordChange } from "../../src/Types/IRecord";
import { describe, expect, it } from "vitest";
import { ask } from "../../src/Effects/ask";
import { entity } from "../../src/Effects/entity";
import { startTimer } from "../../src/Effects/startTimer";
import { resumable } from "../../src/Resume/resumable";
import { entityRewind, RewindRefusedError } from "../../src/Resume/rewind";
import { bind } from "../../src/Runtime/bind";
import { seat } from "../../src/Runtime/draftNode";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { StateAliasError } from "../../src/Runtime/stateAlias";
import { transient } from "../../src/Runtime/transient";
import { rawOf, view } from "../../src/Runtime/viewProxy";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreTestRuntime } from "../../src/Snapshot/index";
import { frameWrite, minted, pendingAsksOf } from "../testHelpers";
import { harness, until, wait } from "./resumeHarness";

declare module "../../src/Registries/ITimerRegistry" {
	interface ITimerRegistry {
		"Scope/Tick": {};
	}
}

interface IKid extends IEntity {
	V: number;
}
interface IHome extends IEntity {
	Note: string;
	Items: IKid[];
	Box: Record<string, IKid>;
}
interface IWorld extends IEntity {
	Homes: Record<string, IHome>;
}

const world = (): IWorld => ({
	$Id: "world",
	Homes: {
		h1: {
			$Id: "h1",
			Note: "",
			Items: [
				{
					$Id: "e",
					V: 0
				},
				{
					$Id: "f",
					V: 0
				}
			],
			Box: {}
		},
		h2: {
			$Id: "h2",
			Note: "",
			Items: [],
			Box: {}
		}
	}
});

const Ticks = receiver<IKid>("Scope/Ticks")({
	*"Scope/Tick"(draft) {
		draft.V++;
	}
});

function* arm(draft: IKid): IActionGenerator {
	yield* startTimer(draft, "Scope/Tick", Ticks, 60_000);
	const scratch = yield* transient(draft, "Scope/Scratch", {
		N: 0
	});
	scratch.N = 7;
}
function* asks(draft: IKid): IOpenGenerator {
	yield* open(
		ask<string>(draft, {
			Path: "Scope/Question"
		})
	);
}
function* holds(draft: IKid): IActionGenerator {
	yield* wait("hold");
	draft.V += 100;
}
function* queued(draft: IKid): IActionGenerator {
	draft.V += 1000;
}
function* scratchOf(draft: IKid): IActionGenerator<number> {
	return (yield* transient(draft, "Scope/Scratch", {
		N: 0
	})).N;
}

function* flow(draft: IHome): IOpenGenerator {
	draft.Note = "began";
	yield* open(wait("flow"));
	draft.Note = "went on";
	yield* open(wait("again"));
}
named(flow, "Scope/Flow");
resumable(flow);

function* mints(draft: IHome): IOpenGenerator {
	draft.Note = "began";
	draft.Items.push(
		yield* entity<IKid>({
			V: 5
		})
	);
	yield* open(wait("flow"));
}
named(mints, "Scope/Mints");
resumable(mints);

function* moveOut(draft: IWorld): IActionGenerator {
	const [kid] = draft.Homes.h1!.Items.splice(0, 1);
	draft.Homes.h2!.Items.push(kid!);
}
function* addKid(draft: IHome): IActionGenerator {
	draft.Items.push(
		yield* entity<IKid>({
			V: 9
		})
	);
}
function* setNote(draft: IHome, note: string): IActionGenerator {
	draft.Note = note;
}
function* inner(draft: IKid): IOpenGenerator {
	draft.V = 1;
	yield* open(wait("inner"));
	draft.V = 2;
	yield* open(wait("inner again"));
}
named(inner, "Scope/Inner");
resumable(inner);

function* dropFirst(draft: IHome): IActionGenerator {
	draft.Items.splice(0, 1);
}
function* shelve(draft: IHome): IActionGenerator {
	const shelf = yield* transient(draft, "Scope/Shelf", {
		Items: [] as IKid[]
	});
	shelf.Items.push(
		yield* entity<IKid>({
			V: 1
		})
	);
}
function* unshelve(draft: IHome): IActionGenerator {
	const shelf = yield* transient(draft, "Scope/Shelf", {
		Items: [] as IKid[]
	});
	shelf.Items.splice(0, 1);
}
function* binds(draft: IKid): IActionGenerator {
	bind(draft, Ticks);
}

function setUp() {
	const h = harness(world(), {
		verifyIndex: "always"
	});
	const internal = h.runtime as IRuntimeInternal<IWorld>;
	const gateway = internal.get("runtime/writeGateway");
	const root = rawOf(h.runtime.state) as IWorld;
	return {
		...h,
		internal,
		gateway,
		root
	};
}

async function restoredAt(json: string, name: string) {
	const envelope = JSON.parse(json);
	const row = envelope.InFlight.find((entry: { Name: string }) => entry.Name === name);
	const history = envelope.Histories.find((entry: { ActionId: string }) => entry.ActionId === row.ActionId) as IHistory;
	const { runtime } = await restoreTestRuntime<IWorld>(json, {
		rootId: "world",
		setup: (restored) => restored.registerReceiver(Ticks)
	});
	const internal = runtime as IRuntimeInternal<IWorld>;
	return {
		runtime,
		history,
		gateway: internal.get("runtime/writeGateway"),
		root: rawOf(runtime.state) as IWorld
	};
}

describe("a write scope", () => {
	async function attachedKid() {
		const w = setUp();
		w.runtime.registerReceiver(Ticks);
		await w.runtime.dispatch(arm, "e");
		w.runtime.dispatch(asks, "e");
		const holding = w.runtime.dispatch(holds, "e");
		const waiting = w.runtime.dispatch(queued, "e");
		await until(
			() => w.waiting.some((entry) => entry.name === "hold") && pendingAsksOf(w.runtime, w.runtime.state.Homes.h1!.Items[0]!).length === 1
		);
		const kid = w.root.Homes.h1!.Items[0]!;
		const disposed: string[] = [];
		w.gateway.onDispose((id) => disposed.push(id), "cancel");
		const attached = () => ({
			timers: w.internal.get("runtime/timers").ownerCount("e"),
			asks: w.internal.get("runtime/asks").under("e").length,
			actions: w.internal
				.get("runtime/inFlightActions")()
				.filter((action) => action.EntityId === "e")
				.map((action) => action.State)
		});
		const before = attached();
		expect(before.timers).toBe(1);
		expect(before.actions).toEqual([
			"open",
			"holding",
			"queued"
		]);
		return {
			...w,
			kid,
			disposed,
			attached,
			before,
			holding,
			waiting
		};
	}

	it("holds a removed entity's disposal, so one put back by a later frame keeps its timer, ask, transient and actions", async () => {
		const w = await attachedKid();
		const scope = w.gateway.openScope();
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Items.splice(0, 1);
		});
		expect(w.gateway.lookup().e).toBeUndefined();
		expect(w.gateway.isDetached(w.kid)).toBe(true);
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Box.e = view(w.kid);
		});
		scope.end();
		expect(w.root.Homes.h1!.Box.e).toBe(w.kid);
		expect(w.gateway.isDetached(w.kid)).toBe(false);
		expect(w.disposed).toEqual([]);
		expect(w.attached()).toEqual(w.before);
		expect(pendingAsksOf(w.runtime, w.runtime.state.Homes.h1!.Box.e!)).toHaveLength(1);
		w.release("hold");
		await w.holding;
		await w.waiting;
		expect(w.kid.V).toBe(1100);
		expect(await w.runtime.dispatch(scratchOf, "e")).toBe(7);
		w.runtime.dispose();
	});

	it("disposes an entity removed and not put back when the scope ends", async () => {
		const w = await attachedKid();
		const scope = w.gateway.openScope();
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Items.splice(0, 1);
		});
		expect(w.disposed).toEqual([]);
		scope.end();
		expect(w.disposed).toEqual([
			"e"
		]);
		expect(w.attached().timers).toBe(0);
		expect(w.gateway.addressLive("e")).toBe(false);
		w.runtime.dispose();
	});

	it("disposes an entity whose $Id is out of the tree at the end, whichever node carried it last", async () => {
		const w = setUp();
		w.runtime.registerReceiver(Ticks);
		await w.runtime.dispatch(arm, "e");
		const disposed: string[] = [];
		w.gateway.onDispose((id) => disposed.push(id), "cancel");
		const scope = w.gateway.openScope();
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Items.splice(0, 1);
		});
		frameWrite(w.runtime, (state) => {
			seat(
				state.Homes.h1!.Items,
				1,
				{
					$Id: "e",
					V: 3
				},
				true
			);
		});
		expect(w.gateway.cellOf("e")).toEqual({
			$Id: "e",
			V: 3
		});
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Items.splice(1, 1);
		});
		scope.end();
		expect(disposed).toEqual([
			"e"
		]);
		expect(w.internal.get("runtime/timers").ownerCount("e")).toBe(0);
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Note = "after";
		});
		w.runtime.dispose();
	});

	it("disposes an entity born in the scope and removed in it when the scope ends", async () => {
		const w = setUp();
		w.runtime.registerReceiver(Ticks);
		const disposed: string[] = [];
		w.gateway.onDispose((id) => disposed.push(id), "cancel");
		const scope = w.gateway.openScope();
		await w.runtime.dispatch(addKid, "h1");
		const born = w.root.Homes.h1!.Items[2]!.$Id;
		await w.runtime.dispatch(arm, born);
		w.runtime.dispatch(asks, born);
		await until(() => w.internal.get("runtime/asks").under(born).length === 1);
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Items.splice(2, 1);
		});
		expect(disposed).toEqual([]);
		scope.end();
		expect(disposed).toEqual([
			born
		]);
		expect(w.internal.get("runtime/timers").ownerCount(born)).toBe(0);
		expect(w.internal.get("runtime/asks").under(born)).toHaveLength(0);
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Note = "after";
		});
		w.runtime.dispose();
	});

	it("is ended by disposing the runtime, which disposes what it held and the tree", async () => {
		const w = await attachedKid();
		const scope = w.gateway.openScope();
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Items.splice(0, 1);
		});
		w.runtime.dispose();
		expect(w.disposed).toContain("e");
		expect(w.disposed).toContain("f");
		expect(w.disposed).toContain("world");
		expect(w.attached().timers).toBe(0);
		expect(() => scope.end()).toThrow(/once/);
		expect(() => scope.unwind()).toThrow(/once/);
	});

	it("disposes nothing when it is unwound, and puts the removed entity back with everything attached", async () => {
		const w = await attachedKid();
		const before = JSON.stringify(w.root);
		const scope = w.gateway.openScope();
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Items.splice(0, 1);
			state.Homes.h1!.Note = "changed";
		});
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Items[0]!.V = 42;
		});
		scope.unwind();
		expect(JSON.stringify(w.root)).toBe(before);
		expect(w.root.Homes.h1!.Items[0]).toBe(w.kid);
		expect(w.gateway.cellOf("e")).toBe(w.kid);
		expect(w.gateway.isDetached(w.kid)).toBe(false);
		expect(w.disposed).toEqual([]);
		expect(w.attached()).toEqual(w.before);
		w.release("hold");
		await w.holding;
		await w.waiting;
		expect(w.kid.V).toBe(1100);
		expect(await w.runtime.dispatch(scratchOf, "e")).toBe(7);
		w.runtime.dispose();
	});

	it("refuses a frame the tree rule refuses as it does today, and stays whole for its unwind", () => {
		const w = setUp();
		const before = JSON.stringify(w.root);
		const kid = w.root.Homes.h1!.Items[0]!;
		const scope = w.gateway.openScope();
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Note = "kept";
		});
		const afterFirst = JSON.stringify(w.root);
		expect(() =>
			frameWrite(w.runtime, (state) => {
				state.Homes.h2!.Items.push(state.Homes.h1!.Items[0]!);
			})
		).toThrow(StateAliasError);
		expect(JSON.stringify(w.root)).toBe(afterFirst);
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Items.splice(0, 1);
		});
		scope.unwind();
		expect(JSON.stringify(w.root)).toBe(before);
		expect(w.root.Homes.h1!.Items[0]).toBe(kid);
		expect(w.gateway.isDetached(kid)).toBe(false);
		w.runtime.dispose();
	});

	it("unwinds deletes from two records across its frames to the key order it opened on", () => {
		const w = setUp();
		const kid = (id: string): IKid =>
			minted(id, {
				V: 0
			});
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Box = {
				p: kid("p"),
				q: kid("q"),
				r: kid("r"),
				s: kid("s")
			};
			state.Homes.h2!.Box = {
				t: kid("t"),
				u: kid("u"),
				v: kid("v")
			};
		});
		const before = JSON.stringify(w.root);
		const scope = w.gateway.openScope();
		frameWrite(w.runtime, (state) => {
			delete state.Homes.h1!.Box.q;
			delete state.Homes.h2!.Box.t;
		});
		const afterFirst = JSON.stringify(w.root);
		expect(() =>
			frameWrite(w.runtime, (state) => {
				delete state.Homes.h1!.Box.s;
				delete state.Homes.h1!.Box.p;
				state.Homes.h2!.Items.push(state.Homes.h1!.Items[0]!);
			})
		).toThrow(StateAliasError);
		expect(JSON.stringify(w.root)).toBe(afterFirst);
		expect(Object.keys(w.root.Homes.h1!.Box)).toEqual([
			"p",
			"r",
			"s"
		]);
		frameWrite(w.runtime, (state) => {
			delete state.Homes.h2!.Box.u;
			delete state.Homes.h1!.Box.s;
			delete state.Homes.h1!.Box.p;
		});
		expect(Object.keys(w.root.Homes.h1!.Box)).toEqual([
			"r"
		]);
		scope.unwind();
		expect(JSON.stringify(w.root)).toBe(before);
		expect(Object.keys(w.root.Homes.h1!.Box)).toEqual([
			"p",
			"q",
			"r",
			"s"
		]);
		expect(Object.keys(w.root.Homes.h2!.Box)).toEqual([
			"t",
			"u",
			"v"
		]);
		w.runtime.dispose();
	});

	it("around nothing, ends or unwinds with the tree and index as they were", () => {
		const w = setUp();
		const before = JSON.stringify(w.root);
		const ids = w.gateway.cellIds().sort();
		const drains: (readonly object[] | null)[] = [];
		w.gateway.onDrained((touched) => drains.push(touched));
		w.gateway.openScope().end();
		w.gateway.openScope().unwind();
		expect(JSON.stringify(w.root)).toBe(before);
		expect(w.gateway.cellIds().sort()).toEqual(ids);
		expect(drains).toEqual([
			null
		]);
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Note = "after";
		});
		expect(w.gateway.logMark()).toBe(0);
		w.gateway.releaseMark();
		w.runtime.dispose();
	});

	it("opens only outside every frame and scope, and closes once, outside every frame", () => {
		const w = setUp();
		expect(() => w.gateway.frame(() => w.gateway.openScope())).toThrow(/outside every frame and scope/);
		expect(() => w.gateway.rewindFrame(() => {})).toThrow(/inside a write scope/);
		const scope = w.gateway.openScope();
		expect(() => w.gateway.openScope()).toThrow(/outside every frame and scope/);
		expect(() => w.gateway.frame(() => w.gateway.rewindFrame(() => {}))).toThrow(/outside every frame/);
		expect(() => w.gateway.frame(() => scope.end())).toThrow(/once, outside every frame/);
		scope.end();
		expect(() => scope.end()).toThrow(/once/);
		expect(() => scope.unwind()).toThrow(/once/);
		w.gateway.openScope().unwind();
		w.runtime.dispose();
	});
});

describe("the rewind", () => {
	it("refuses an entity another writer moved out of the marked one, and the unwind leaves the tree as it was", async () => {
		const w = setUp();
		w.runtime.dispatch(flow, "h1");
		await until(() => w.waiting.some((entry) => entry.name === "flow"));
		await w.runtime.dispatch(moveOut, "world");
		const r = await restoredAt(createSnapshot(w.runtime), "Scope/Flow");
		const before = JSON.stringify(r.root);
		const kid = r.root.Homes.h2!.Items[0]!;
		const scope = r.gateway.openScope();
		expect(() => entityRewind(r.gateway, "h1").rewind(r.history.Entries)).toThrow(RewindRefusedError);
		expect(JSON.stringify(r.root)).toBe(before);
		scope.unwind();
		expect(JSON.stringify(r.root)).toBe(before);
		expect(r.root.Homes.h2!.Items[0]).toBe(kid);
		expect(r.gateway.cellOf("e")).toBe(kid);
		r.runtime.dispose();
		w.runtime.dispose();
	});

	it("leaves a node it takes out unborn: a read finds it not there, not detached, and the forward puts the same node back", async () => {
		const w = setUp();
		w.runtime.dispatch(flow, "h1");
		await until(() => w.waiting.some((entry) => entry.name === "flow"));
		await w.runtime.dispatch(addKid, "h1");
		const r = await restoredAt(createSnapshot(w.runtime), "Scope/Flow");
		const added = r.root.Homes.h1!.Items[2]!;
		const scope = r.gateway.openScope();
		const session = entityRewind(r.gateway, "h1");
		session.rewind(r.history.Entries);
		expect(r.root.Homes.h1!.Items).toHaveLength(2);
		expect(r.gateway.lookup()[added.$Id]).toBeUndefined();
		expect(r.runtime.state.Homes.h1!.Items.some((item) => item.$Id === added.$Id)).toBe(false);
		expect(r.gateway.isDetached(added)).toBe(false);
		expect(r.gateway.detachedPath(added)).toBeUndefined();
		session.forward(
			r.history.Entries.flatMap((entry) =>
				entry.Kind === "other"
					? [
							entry.Change
						]
					: entry.Kind === "step"
						? entry.Changes
						: []
			)
		);
		expect(r.root.Homes.h1!.Items[2]).toBe(added);
		expect(r.gateway.cellOf(added.$Id)).toBe(added);
		scope.end();
		expect(r.gateway.isDetached(added)).toBe(false);
		r.runtime.dispose();
		w.runtime.dispose();
	});

	it("takes out a child the action made with entity(), and the forward puts that node back", async () => {
		const w = setUp();
		w.runtime.dispatch(mints, "h1");
		await until(() => w.waiting.some((entry) => entry.name === "flow"));
		const r = await restoredAt(createSnapshot(w.runtime), "Scope/Mints");
		const before = JSON.stringify(r.root);
		const made = r.root.Homes.h1!.Items[2]!;
		const scope = r.gateway.openScope();
		const session = entityRewind(r.gateway, "h1");
		session.rewind(r.history.Entries);
		expect(JSON.parse(JSON.stringify(r.root.Homes.h1))).toEqual(world().Homes.h1);
		expect(r.gateway.isDetached(made)).toBe(false);
		session.forward(r.history.Entries.flatMap((entry) => (entry.Kind === "step" ? entry.Changes : [])));
		expect(JSON.stringify(r.root)).toBe(before);
		expect(r.root.Homes.h1!.Items[2]).toBe(made);
		scope.end();
		r.runtime.dispose();
		w.runtime.dispose();
	});

	it("refuses a change whose place doesn't hold what the history says, having undone its own writes", async () => {
		const w = setUp();
		w.runtime.dispatch(flow, "h1");
		await until(() => w.waiting.some((entry) => entry.name === "flow"));
		await w.runtime.dispatch(setNote, "h1", "from another");
		await w.runtime.dispatch(addKid, "h1");
		const r = await restoredAt(createSnapshot(w.runtime), "Scope/Flow");
		frameWrite(r.runtime, (state) => {
			state.Homes.h1!.Note = "not in the history";
		});
		const before = JSON.stringify(r.root);
		const scope = r.gateway.openScope();
		expect(() => entityRewind(r.gateway, "h1").rewind(r.history.Entries)).toThrow(/doesn't find what the history says/);
		expect(JSON.stringify(r.root)).toBe(before);
		scope.unwind();
		expect(JSON.stringify(r.root)).toBe(before);
		r.runtime.dispose();
		w.runtime.dispose();
	});

	it("refuses a binding change, which it can't make again exactly", async () => {
		const w = setUp();
		w.runtime.registerReceiver(Ticks);
		w.runtime.dispatch(flow, "h1");
		await until(() => w.waiting.some((entry) => entry.name === "flow"));
		await w.runtime.dispatch(binds, "e");
		const r = await restoredAt(createSnapshot(w.runtime), "Scope/Flow");
		const before = JSON.stringify(r.root);
		const scope = r.gateway.openScope();
		expect(() => entityRewind(r.gateway, "h1").rewind(r.history.Entries)).toThrow(/"\$Receiver" can't be made again/);
		scope.unwind();
		expect(JSON.stringify(r.root)).toBe(before);
		r.runtime.dispose();
		w.runtime.dispose();
	});

	it("marks a node it left unborn detached when the scope ends with the node still out", async () => {
		const w = setUp();
		w.runtime.dispatch(flow, "h1");
		await until(() => w.waiting.some((entry) => entry.name === "flow"));
		await w.runtime.dispatch(addKid, "h1");
		const r = await restoredAt(createSnapshot(w.runtime), "Scope/Flow");
		const added = r.root.Homes.h1!.Items[2]!;
		const disposed: string[] = [];
		r.gateway.onDispose((id) => disposed.push(id), "cancel");
		const scope = r.gateway.openScope();
		entityRewind(r.gateway, "h1").rewind(r.history.Entries);
		expect(r.gateway.isDetached(added)).toBe(false);
		scope.end();
		expect(disposed).toEqual([
			added.$Id
		]);
		expect(r.gateway.isDetached(added)).toBe(true);
		expect(r.gateway.addressLive(added.$Id)).toBe(false);
		r.runtime.dispose();
		w.runtime.dispose();
	});

	it("runs what its frame held as ordinary frames, whose removals are detached", async () => {
		const w = setUp();
		w.runtime.dispatch(flow, "h1");
		await until(() => w.waiting.some((entry) => entry.name === "flow"));
		await w.runtime.dispatch(addKid, "h1");
		const r = await restoredAt(createSnapshot(w.runtime), "Scope/Flow");
		const first = r.root.Homes.h1!.Items[0]!;
		let armed = false;
		let dropping: Promise<unknown> | undefined;
		r.gateway.onDrained(() => {
			if (armed) {
				armed = false;
				dropping = r.runtime.dispatch(dropFirst, "h1");
			}
		});
		const scope = r.gateway.openScope();
		armed = true;
		entityRewind(r.gateway, "h1").rewind(r.history.Entries);
		await dropping;
		expect(r.root.Homes.h1!.Items).not.toContain(first);
		expect(r.gateway.isDetached(first)).toBe(true);
		scope.unwind();
		expect(r.root.Homes.h1!.Items[0]).toBe(first);
		expect(r.gateway.isDetached(first)).toBe(false);
		r.runtime.dispose();
		w.runtime.dispose();
	});

	function brokenHistory(...changes: IRecordChange[]): IHistoryEntry[] {
		return changes.map((change) => ({
			Kind: "other",
			Change: change
		}));
	}

	it("refuses a node that differs from the history's copy of it", () => {
		const w = setUp();
		const before = JSON.stringify(w.root);
		const scope = w.gateway.openScope();
		const history = brokenHistory(
			{
				Path: [
					"Note"
				],
				Prev: "",
				Value: "x",
				Landing: {
					EntityId: "h1",
					Path: [
						"Note"
					]
				}
			},
			{
				Path: [
					"Items",
					"1"
				],
				Prev: {
					$Id: "f",
					V: 99
				},
				Value: {
					$Id: "f",
					V: 0
				},
				Landing: {
					EntityId: "h1",
					Path: [
						"Items",
						"1"
					]
				}
			}
		);
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Note = "x";
		});
		const written = JSON.stringify(w.root);
		expect(() => entityRewind(w.gateway, "h1").rewind(history)).toThrow(/"f" is not as the history's copy of it/);
		expect(JSON.stringify(w.root)).toBe(written);
		scope.unwind();
		expect(JSON.stringify(w.root)).toBe(before);
		w.runtime.dispose();
	});

	it("refuses a change landing in an entity the tree holds outside the marked one", () => {
		const w = setUp();
		const before = JSON.stringify(w.root);
		const scope = w.gateway.openScope();
		const history = brokenHistory({
			Path: [
				"Note"
			],
			Prev: "",
			Value: "x",
			Landing: {
				EntityId: "h2",
				Path: [
					"Note"
				]
			}
		});
		expect(() => entityRewind(w.gateway, "h1").rewind(history)).toThrow(/lands in "h2", which the tree holds outside "h1"/);
		scope.unwind();
		expect(JSON.stringify(w.root)).toBe(before);
		w.runtime.dispose();
	});

	it("refuses two nodes with one $Id below the entity, undoing its own writes", () => {
		const w = setUp();
		frameWrite(w.runtime, (state) => {
			seat(
				state.Homes.h1!.Items,
				2,
				{
					$Id: "g",
					V: 1
				},
				true
			);
		});
		const before = JSON.stringify(w.root);
		const added: IRecordChange = {
			Path: [
				"Items",
				"2"
			],
			Prev: undefined,
			Value: {
				$Id: "g",
				V: 1
			},
			Created: true,
			GrewFrom: 2,
			Landing: {
				EntityId: "h1",
				Path: [
					"Items",
					"2"
				]
			}
		};
		const scope = w.gateway.openScope();
		const session = entityRewind(w.gateway, "h1");
		session.rewind(brokenHistory(added));
		frameWrite(w.runtime, (state) => {
			seat(
				state.Homes.h1!.Box,
				"g",
				{
					$Id: "g",
					V: 1
				},
				true
			);
		});
		const twice = JSON.stringify(w.root);
		expect(() =>
			session.forward([
				added,
				{
					Path: [
						"V"
					],
					Prev: 1,
					Value: 2,
					Landing: {
						EntityId: "g",
						Path: [
							"V"
						]
					}
				}
			])
		).toThrow(/two nodes below "h1" carry the \$Id "g"/);
		expect(JSON.stringify(w.root)).toBe(twice);
		scope.unwind();
		expect(JSON.stringify(w.root)).toBe(before);
		w.runtime.dispose();
	});

	async function nested() {
		const w = setUp();
		const homeAtStart = JSON.parse(JSON.stringify(w.root.Homes.h1));
		w.runtime.dispatch(flow, "h1");
		await until(() => w.waiting.some((entry) => entry.name === "flow"));
		const kidAtStart = JSON.parse(JSON.stringify(w.root.Homes.h1!.Items[0]));
		w.runtime.dispatch(inner, "e");
		await until(() => w.waiting.some((entry) => entry.name === "inner"));
		w.release("inner");
		await until(() => w.waiting.some((entry) => entry.name === "inner again"));
		const json = createSnapshot(w.runtime);
		w.runtime.dispose();
		const outer = await restoredAt(json, "Scope/Flow");
		const { history: kid } = await restoredAt(json, "Scope/Inner");
		return {
			...outer,
			kid,
			homeAtStart,
			kidAtStart
		};
	}

	it("can't rewind two marked actions on nested entities in one scope: the outer first is exact, and the inner is refused", async () => {
		const r = await nested();
		const before = JSON.stringify(r.root);
		const scope = r.gateway.openScope();
		entityRewind(r.gateway, "h1").rewind(r.history.Entries);
		expect(JSON.parse(JSON.stringify(r.root.Homes.h1))).toEqual(r.homeAtStart);
		const rewound = JSON.stringify(r.root);
		expect(() => entityRewind(r.gateway, "e").rewind(r.kid.Entries)).toThrow(RewindRefusedError);
		expect(JSON.stringify(r.root)).toBe(rewound);
		scope.unwind();
		expect(JSON.stringify(r.root)).toBe(before);
		r.runtime.dispose();
	});

	it("can't rewind two marked actions on nested entities in one scope: the inner first is exact, and the outer is refused", async () => {
		const r = await nested();
		const before = JSON.stringify(r.root);
		const scope = r.gateway.openScope();
		entityRewind(r.gateway, "e").rewind(r.kid.Entries);
		expect(JSON.parse(JSON.stringify(r.root.Homes.h1!.Items[0]))).toEqual(r.kidAtStart);
		const rewound = JSON.stringify(r.root);
		expect(() => entityRewind(r.gateway, "h1").rewind(r.history.Entries)).toThrow(RewindRefusedError);
		expect(JSON.stringify(r.root)).toBe(rewound);
		scope.unwind();
		expect(JSON.stringify(r.root)).toBe(before);
		r.runtime.dispose();
	});
});

describe("a write scope's end", () => {
	function aliasOnDispose(w: ReturnType<typeof setUp>): void {
		w.gateway.onDispose((id) => {
			if (id !== "e") {
				return;
			}
			w.runtime.dispatch(setNote, "h2", "held");
			frameWrite(w.runtime, (state) => {
				state.Homes.h2!.Items.push(state.Homes.h1!.Items[0]!);
			});
		}, "cancel");
	}

	it("throws a refusal in the dispose cascade as a frame does without a scope, and runs nothing the cascade held", async () => {
		const plain = setUp();
		aliasOnDispose(plain);
		expect(() =>
			frameWrite(plain.runtime, (state) => {
				state.Homes.h1!.Items.splice(0, 1);
			})
		).toThrow(/a write made in the dispose cascade/);
		await until(() => true);
		expect(plain.root.Homes.h2!.Note).toBe("");
		plain.runtime.dispose();

		const w = setUp();
		aliasOnDispose(w);
		const scope = w.gateway.openScope();
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Items.splice(0, 1);
		});
		expect(() => scope.end()).toThrow(/a write made in the dispose cascade/);
		expect(w.root.Homes.h2!.Items).toEqual([]);
		frameWrite(w.runtime, (state) => {
			state.Homes.h1!.Note = "after";
		});
		await until(() => true);
		expect(w.root.Homes.h2!.Note).toBe("");
		w.runtime.dispose();
	});

	it("records an entity in a transient as disposed from TransientState", async () => {
		const roots = async (scoped: boolean) => {
			const w = setUp();
			await w.runtime.dispatch(shelve, "h1");
			const found: string[] = [];
			w.runtime.on("record", (record) => {
				if (record.Kind === "entity:dispose") {
					found.push(record.Root);
				}
			});
			const scope = scoped ? w.gateway.openScope() : null;
			await w.runtime.dispatch(unshelve, "h1");
			scope?.end();
			const roots = [
				...found
			];
			w.runtime.dispose();
			return roots;
		};
		expect(await roots(false)).toEqual([
			"TransientState"
		]);
		expect(await roots(true)).toEqual([
			"TransientState"
		]);
	});
});
