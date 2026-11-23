import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { ISnapshot } from "../../src/Snapshot/ISnapshot";
import type { IActionGenerator, IOpenGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import type { IResourceContext } from "../../src/Types/IResource";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openResource } from "../../src/Effects/openResource";
import { parallel } from "../../src/Effects/parallel";
import { publish } from "../../src/Effects/publish";
import { start } from "../../src/Effects/start";
import { startTimer } from "../../src/Effects/startTimer";
import { stopTimer } from "../../src/Effects/stopTimer";
import { latest, leading } from "../../src/Runtime/arrivalPolicy";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { wrapSetState } from "../../src/Runtime/sliceSetState";
import { transient } from "../../src/Runtime/transient";
import { rawOf } from "../../src/Runtime/viewProxy";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { SNAPSHOT_FORMAT_VERSION } from "../../src/Snapshot/ISnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";
import { settled } from "../../src/Testing/createTestRuntime";
import { isEnded } from "../../src/Types/IResource";
import { mountComponent, rawReceiver, rootSetState } from "../testHelpers";

type IRow = {
	$Id: string;
	Log: string[];
};

type IRoot = {
	$Id: string;
	Log: string[];
	Rows: IRow[];
	Form: {
		Name: string;
	};
};

const seed = (): IRoot => ({
	$Id: "root",
	Log: [],
	Rows: [
		{
			$Id: "row-1",
			Log: []
		}
	],
	Form: {
		Name: ""
	}
});

const publishAny = publish as unknown as (topic: string, data?: unknown) => Generator<any, void, any>;

function* wait(name: string): Generator<any, unknown, any> {
	return yield {
		Type: "test/wait",
		Name: name
	};
}

function* slow(_draft: IRoot): IActionGenerator {
	yield* wait("slow");
}

function* mark(draft: IRoot, text: string): IActionGenerator {
	draft.Log.push(text);
}

function* opener(draft: IRoot, name: string): IOpenGenerator {
	yield* open(wait(name) as IActionGenerator);
	draft.Log.push(name);
}

function* slowRow(_draft: IRow): IActionGenerator {
	yield* wait("row");
}

function* markRow(draft: IRow, text: string): IActionGenerator {
	draft.Log.push(text);
}

function* openRow(draft: IRow, name: string): IOpenGenerator {
	yield* open(wait(name) as IActionGenerator);
	draft.Log.push(name);
}

const latestRowAction = latest(function* latestRow(draft: IRow, name: string): IActionGenerator {
	yield* wait(name);
	draft.Log.push(name);
});

const latestRootAction = latest(function* latestRoot(draft: IRoot, name: string): IActionGenerator {
	yield* wait(name);
	draft.Log.push(name);
});

const latestOpenerAction = latest(function* latestOpener(draft: IRoot, name: string): IOpenGenerator {
	yield* open(wait(name) as IActionGenerator);
	draft.Log.push(name);
});

const latestMarkAction = latest(function* latestMark(draft: IRoot, text: string): IActionGenerator {
	draft.Log.push(text);
});

const leadingMarkAction = leading(function* leadingMark(draft: IRoot, text: string): IActionGenerator {
	draft.Log.push(text);
});

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"State/Go": {
			Mode: string;
		};
	}
}

declare module "../../src/Registries/IResourceRegistry" {
	interface IResourceTypeRegistry {
		"state/feed": {
			Message: {
				N: number;
			};
		};
	}
	interface IResourceRegistry {
		"State/Feed": {
			Type: "state/feed";
		};
	}
}

const RowReceiver = receiver<IRow>("State/RowReceiver")({
	*"State/Go"(draft, data) {
		if (data.Mode === "open") {
			yield* open(wait("delivery") as IActionGenerator);
		} else if (data.Mode === "hold") {
			yield* wait("delivery");
		}
		draft.Log.push(`delivery:${data.Mode}`);
	}
});

const FeedReceiver = receiver<IRow>("State/FeedReceiver")({
	*"State/Feed"(draft, e) {
		if (!isEnded(e)) {
			draft.Log.push(`feed:${e.N}`);
		}
	}
});

function* openFeed(draft: IRow): IActionGenerator {
	yield* openResource(draft, "State/Feed", FeedReceiver, {
		Type: "state/feed"
	});
}

function* typeFormLate(draft: { Name: string }): IActionGenerator {
	yield* wait("form");
	draft.Name = "late";
}

function* binds(draft: IRow): IActionGenerator {
	bind(draft, RowReceiver);
}

function* announce(_draft: IRoot, mode: string): IActionGenerator {
	yield* publishAny("State/Go", {
		Mode: mode
	});
}

function* announceThenWait(_draft: IRoot, mode: string): IActionGenerator {
	yield* publishAny("State/Go", {
		Mode: mode
	});
	yield* wait("publisher");
}

function* startsOpenRow(_draft: IRoot, name: string): IActionGenerator {
	yield* start(openRow, "row-1", name);
}

function* startsLatestRow(_draft: IRoot, name: string): IActionGenerator {
	yield* start(latestRowAction, "row-1", name);
}

async function build() {
	const runtime = createRuntime<IRoot>(seed(), {
		onError: () => {}
	});
	const releases = new Map<string, (value?: unknown) => void>();
	const waiting = new Map<string, Promise<unknown>>();
	runtime.registerImplementation("test/wait", (effect: { Type: string; Name: string }) => {
		const promise = new Promise((resolve) => {
			releases.set(effect.Name, resolve);
		});
		waiting.set(effect.Name, promise);
		return promise;
	});
	runtime.registerReceiver(RowReceiver);
	const firstArgs = new Map<string, unknown>();
	runtime.on("record", (record) => {
		if (record.Kind === "action:start") {
			firstArgs.set(record.ActionId, record.Args[0]);
		}
	});
	await runtime.dispatch(binds, "row-1");
	const release = (name: string): void => {
		const resolve = releases.get(name);
		if (!resolve) {
			throw new Error(`nothing waits on "${name}"`);
		}
		releases.delete(name);
		resolve();
	};
	return {
		runtime,
		release,
		waiting,
		firstArg: (actionId: string): unknown => firstArgs.get(actionId),
		line: (json: string, entityId: string): unknown[] =>
			(JSON.parse(json) as ISnapshot).InFlight.filter((entry) => entry.EntityId === entityId && entry.Place !== undefined)
				.sort((a, b) => a.Place! - b.Place!)
				.map((entry) => firstArgs.get(entry.ActionId)),
		log: () => runtime.state.Log,
		rowLog: () => runtime.state.Rows[0]!.Log
	};
}

interface IListed {
	label: string | null;
	receiver?: string;
	entityId: string;
	state?: string;
	place?: number;
}

function listed(json: string): IListed[] {
	return (JSON.parse(json) as ISnapshot).InFlight.map((entry) => ({
		label: entry.Label,
		...(entry.Receiver !== undefined
			? {
					receiver: entry.Receiver
				}
			: {}),
		entityId: entry.EntityId,
		state: entry.State,
		...(entry.Place !== undefined
			? {
					place: entry.Place
				}
			: {})
	}));
}

async function restored(json: string): Promise<{
	dropped: IListed[];
	diags: string[];
}> {
	const diags: string[] = [];
	const { runtime, result } = await restoreRuntime<IRoot>(json, {
		rootId: "root",
		options: {
			onError: () => {}
		},
		setup: (runtime) => {
			runtime.on("diag", (event) => diags.push(event.code));
			runtime.registerReceiver(RowReceiver);
		}
	});
	const snapshot = JSON.parse(json) as ISnapshot;
	expect(result.dropped.map((d) => d.actionId)).toEqual(snapshot.InFlight.map((entry) => entry.ActionId));
	runtime.dispose();
	return {
		dropped: result.dropped.map((d) => ({
			label: d.label,
			...(d.receiver !== undefined
				? {
						receiver: d.receiver
					}
				: {}),
			entityId: d.entityId,
			state: d.state,
			...(d.place !== undefined
				? {
						place: d.place
					}
				: {})
		})),
		diags
	};
}

async function expectListed(json: string, expected: IListed[]): Promise<void> {
	expect(listed(json)).toEqual(expected);
	const { dropped, diags } = await restored(json);
	expect(dropped).toEqual(expected);
	expect(diags).not.toContain("restore/malformed-rows");
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("an in-flight entry's state: a dispatched action", () => {
	it("is holding while parked on a plain effect", async () => {
		const w = await build();
		const a = w.runtime.dispatch(slow, "root");
		await settled();
		await expectListed(createSnapshot(w.runtime), [
			{
				label: "slow",
				entityId: "root",
				state: "holding"
			}
		]);
		w.release("slow");
		await a;
		w.runtime.dispose();
	});

	it("is holding while its parallel branches are parked", async () => {
		const w = await build();
		function* branchy(_draft: IRoot): IActionGenerator {
			yield* parallel(wait("p1"), wait("p2"));
		}
		const a = w.runtime.dispatch(branchy, "root");
		await settled();
		await expectListed(createSnapshot(w.runtime), [
			{
				label: "branchy",
				entityId: "root",
				state: "holding"
			}
		]);
		w.release("p1");
		w.release("p2");
		await a;
		w.runtime.dispose();
	});

	it("is open while parked inside open(...)", async () => {
		const w = await build();
		const a = w.runtime.dispatch(opener, "root", "o");
		await settled();
		await expectListed(createSnapshot(w.runtime), [
			{
				label: "opener",
				entityId: "root",
				state: "open"
			}
		]);
		w.release("o");
		await a;
		w.runtime.dispose();
	});

	it("is regaining once its open wait is answered while another action holds, and the holder is holding", async () => {
		const w = await build();
		const a = w.runtime.dispatch(opener, "root", "o");
		await settled();
		const b = w.runtime.dispatch(slow, "root");
		w.release("o");
		await settled();
		await expectListed(createSnapshot(w.runtime), [
			{
				label: "opener",
				entityId: "root",
				state: "regaining",
				place: 0
			},
			{
				label: "slow",
				entityId: "root",
				state: "holding"
			}
		]);
		w.release("slow");
		await Promise.all([
			a,
			b
		]);
		expect(w.log()).toEqual([
			"o"
		]);
		w.runtime.dispose();
	});

	it("is queued behind a holder", async () => {
		const w = await build();
		const a = w.runtime.dispatch(slow, "root");
		const b = w.runtime.dispatch(mark, "root", "b");
		await settled();
		await expectListed(createSnapshot(w.runtime), [
			{
				label: "slow",
				entityId: "root",
				state: "holding"
			},
			{
				label: "mark",
				entityId: "root",
				state: "queued",
				place: 0
			}
		]);
		w.release("slow");
		await Promise.all([
			a,
			b
		]);
		w.runtime.dispose();
	});
});

describe("an in-flight entry's state: a started action", () => {
	it("is holding, open, regaining or queued as a dispatched one is", async () => {
		const w = await build();
		await w.runtime.dispatch(startsOpenRow, "root", "o");
		await settled();
		await expectListed(createSnapshot(w.runtime), [
			{
				label: "openRow",
				entityId: "row-1",
				state: "open"
			}
		]);
		await w.runtime.dispatch(startsLatestRow, "root", "held");
		await settled();
		await w.runtime.dispatch(startsOpenRow, "root", "queuedOpen");
		await settled();
		w.release("o");
		await settled();
		await expectListed(createSnapshot(w.runtime), [
			{
				label: "openRow",
				entityId: "row-1",
				state: "regaining",
				place: 1
			},
			{
				label: "latestRow",
				entityId: "row-1",
				state: "holding"
			},
			{
				label: "openRow",
				entityId: "row-1",
				state: "queued",
				place: 0
			}
		]);
		w.release("held");
		await settled();
		w.release("queuedOpen");
		await settled();
		expect(w.rowLog()).toEqual([
			"held",
			"o",
			"queuedOpen"
		]);
		w.runtime.dispose();
	});

	it("is stopping once a latest replacement stops it, until its close has run", async () => {
		const w = await build();
		await w.runtime.dispatch(startsLatestRow, "root", "first");
		await settled();
		const replacing = w.runtime.dispatch(latestRowAction, "row-1", "second");
		const json = createSnapshot(w.runtime);
		await settled();
		const after = createSnapshot(w.runtime);
		await expectListed(json, [
			{
				label: "latestRow",
				entityId: "row-1",
				state: "stopping"
			},
			{
				label: "latestRow",
				entityId: "row-1",
				state: "queued",
				place: 0
			}
		]);
		expect(listed(after)).toEqual([
			{
				label: "latestRow",
				entityId: "row-1",
				state: "holding"
			}
		]);
		w.release("second");
		await replacing;
		w.runtime.dispose();
	});
});

describe("an in-flight entry's state: a delivery", () => {
	it("is holding while its case waits", async () => {
		const w = await build();
		await w.runtime.dispatch(announce, "root", "hold");
		await settled();
		await expectListed(createSnapshot(w.runtime), [
			{
				label: "State/RowReceiver",
				receiver: "State/RowReceiver",
				entityId: "row-1",
				state: "holding"
			}
		]);
		w.release("delivery");
		await settled();
		w.runtime.dispose();
	});

	it("is open inside open(...), and regaining once answered while another action holds", async () => {
		const w = await build();
		await w.runtime.dispatch(announce, "root", "open");
		await settled();
		await expectListed(createSnapshot(w.runtime), [
			{
				label: "State/RowReceiver",
				receiver: "State/RowReceiver",
				entityId: "row-1",
				state: "open"
			}
		]);
		const held = w.runtime.dispatch(slowRow, "row-1");
		w.release("delivery");
		await settled();
		await expectListed(createSnapshot(w.runtime), [
			{
				label: "State/RowReceiver",
				receiver: "State/RowReceiver",
				entityId: "row-1",
				state: "regaining",
				place: 0
			},
			{
				label: "slowRow",
				entityId: "row-1",
				state: "holding"
			}
		]);
		w.release("row");
		await held;
		await settled();
		expect(w.rowLog()).toEqual([
			"delivery:open"
		]);
		w.runtime.dispose();
	});

	it("is queued behind a holder", async () => {
		const w = await build();
		const held = w.runtime.dispatch(slowRow, "row-1");
		await w.runtime.dispatch(announce, "root", "now");
		await settled();
		await expectListed(createSnapshot(w.runtime), [
			{
				label: "slowRow",
				entityId: "row-1",
				state: "holding"
			},
			{
				label: "State/RowReceiver",
				receiver: "State/RowReceiver",
				entityId: "row-1",
				state: "queued",
				place: 0
			}
		]);
		w.release("row");
		await held;
		await settled();
		expect(w.rowLog()).toEqual([
			"delivery:now"
		]);
		w.runtime.dispose();
	});

	it("is queued on a free entity while held back until its publisher resumes", async () => {
		const w = await build();
		const publisher = w.runtime.dispatch(announceThenWait, "root", "now");
		const cuts: {
			json: string;
			rowLog: string[];
		}[] = [];
		for (let turn = 0; turn < 10; turn++) {
			cuts.push({
				json: createSnapshot(w.runtime),
				rowLog: [
					...w.rowLog()
				]
			});
			await Promise.resolve();
		}
		const heldBack = cuts.find((cut) => listed(cut.json).some((entry) => entry.receiver !== undefined));
		expect(heldBack?.rowLog).toEqual([]);
		await expectListed(heldBack!.json, [
			{
				label: "State/RowReceiver",
				receiver: "State/RowReceiver",
				entityId: "row-1",
				state: "queued",
				place: 0
			},
			{
				label: "announceThenWait",
				entityId: "root",
				state: "holding"
			}
		]);
		await settled();
		w.release("publisher");
		await publisher;
		expect(w.rowLog()).toEqual([
			"delivery:now"
		]);
		w.runtime.dispose();
	});
});

describe("an in-flight entry's state: stopping", () => {
	it("a holder stopped by a latest replacement, before its close has run, and gone once the runtime has settled", async () => {
		const w = await build();
		const first = w.runtime.dispatch(latestRootAction, "root", "first");
		await settled();
		const second = w.runtime.dispatch(latestRootAction, "root", "second");
		const json = createSnapshot(w.runtime);
		await settled();
		const after = createSnapshot(w.runtime);
		await expectListed(json, [
			{
				label: "latestRoot",
				entityId: "root",
				state: "stopping"
			},
			{
				label: "latestRoot",
				entityId: "root",
				state: "queued",
				place: 0
			}
		]);
		expect(listed(after)).toEqual([
			{
				label: "latestRoot",
				entityId: "root",
				state: "holding"
			}
		]);
		w.release("second");
		await Promise.all([
			first,
			second
		]);
		expect(w.log()).toEqual([
			"second"
		]);
		w.runtime.dispose();
	});

	it("a queued action stopped by a latest replacement, leaving no gap in the line's places", async () => {
		const w = await build();
		const held = w.runtime.dispatch(slow, "root");
		const first = w.runtime.dispatch(latestMarkAction, "root", "first");
		const between = w.runtime.dispatch(mark, "root", "between");
		const second = w.runtime.dispatch(latestMarkAction, "root", "second");
		const json = createSnapshot(w.runtime);
		await settled();
		const after = createSnapshot(w.runtime);
		await expectListed(json, [
			{
				label: "slow",
				entityId: "root",
				state: "holding"
			},
			{
				label: "latestMark",
				entityId: "root",
				state: "stopping"
			},
			{
				label: "mark",
				entityId: "root",
				state: "queued",
				place: 0
			},
			{
				label: "latestMark",
				entityId: "root",
				state: "queued",
				place: 1
			}
		]);
		expect(listed(after).map((entry) => entry.state)).toEqual([
			"holding",
			"queued",
			"queued"
		]);
		w.release("slow");
		await Promise.all([
			held,
			first,
			between,
			second
		]);
		expect(w.log()).toEqual([
			"between",
			"second"
		]);
		w.runtime.dispose();
	});

	it("a regaining action stopped by a latest replacement, its close run with the entity let go", async () => {
		const w = await build();
		const first = w.runtime.dispatch(latestOpenerAction, "root", "first");
		await settled();
		const held = w.runtime.dispatch(slow, "root");
		w.release("first");
		await settled();
		expect(listed(createSnapshot(w.runtime)).map((entry) => entry.state)).toEqual([
			"regaining",
			"holding"
		]);
		const second = w.runtime.dispatch(latestOpenerAction, "root", "second");
		const json = createSnapshot(w.runtime);
		await settled();
		const after = createSnapshot(w.runtime);
		await expectListed(json, [
			{
				label: "latestOpener",
				entityId: "root",
				state: "stopping"
			},
			{
				label: "slow",
				entityId: "root",
				state: "holding"
			},
			{
				label: "latestOpener",
				entityId: "root",
				state: "queued",
				place: 0
			}
		]);
		expect(listed(after).map((entry) => entry.state)).toEqual([
			"holding",
			"queued"
		]);
		w.release("slow");
		await settled();
		w.release("second");
		await Promise.all([
			first,
			held,
			second
		]);
		expect(w.log()).toEqual([
			"second"
		]);
		w.runtime.dispose();
	});
});

describe("what an in-flight list leaves out", () => {
	it("an action whose code has finished, snapshotted from a then on the promise it awaited", async () => {
		const w = await build();
		let settledDispatch = false;
		const a = w.runtime.dispatch(slow, "root");
		void a.then(() => {
			settledDispatch = true;
		});
		await settled();
		const json = await new Promise<string>((resolve) => {
			void w.waiting.get("slow")!.then(() => resolve(createSnapshot(w.runtime)));
			w.release("slow");
		});
		expect(settledDispatch).toBe(false);
		await expectListed(json, []);
		await a;
		w.runtime.dispose();
	});

	it("a stopped holder whose close has ended, so its line's waiting entries come with no holding entry", async () => {
		const w = await build();
		const replacing = latest(function* branchy(draft: IRoot, name: string): IActionGenerator {
			if (name === "first") {
				yield* parallel(
					(function* () {
						try {
							yield* wait("never");
						} finally {
							draft.Log.push("finally");
						}
					})()
				);
			}
			draft.Log.push(name);
		});
		const first = w.runtime.dispatch(replacing, "root", "first");
		await settled();
		const after = w.runtime.dispatch(mark, "root", "after");
		const second = w.runtime.dispatch(replacing, "root", "second");
		const cuts: {
			entries: IListed[];
			log: string[];
		}[] = [];
		for (let turn = 0; turn < 10; turn++) {
			cuts.push({
				entries: listed(createSnapshot(w.runtime)),
				log: [
					...w.log()
				]
			});
			await Promise.resolve();
		}
		expect(cuts[0]!.entries.map((entry) => entry.state)).toEqual([
			"stopping",
			"queued",
			"queued"
		]);
		expect(cuts.find((cut) => cut.entries.length > 0 && cut.entries.every((entry) => entry.place !== undefined))).toEqual({
			entries: [
				{
					label: "mark",
					entityId: "root",
					state: "queued",
					place: 0
				},
				{
					label: "branchy",
					entityId: "root",
					state: "queued",
					place: 1
				}
			],
			log: [
				"finally"
			]
		});
		await Promise.all([
			first,
			after,
			second
		]);
		expect(w.log()).toEqual([
			"finally",
			"after",
			"second"
		]);
		w.runtime.dispose();
	});

	it("work on a node under no entity", async () => {
		const w = await build();
		const loose = {
			Name: ""
		};
		function* looseWait(_draft: { Name: string }): IActionGenerator {
			yield* wait("loose");
		}
		const running = w.runtime.processAction(
			looseWait,
			() => loose,
			((write: (node: { Name: string }) => void) => write(loose)) as never,
			() => undefined as unknown as string
		);
		await settled();
		expect(w.waiting.has("loose")).toBe(true);
		expect(listed(createSnapshot(w.runtime))).toEqual([]);
		expect((w.runtime as IRuntimeInternal<IRoot>).get("runtime/inFlightActions")()).toEqual([]);
		w.release("loose");
		await running;
		w.runtime.dispose();
	});
});

describe("a form over part of an entity", () => {
	it("is listed under the entity above it, and the restore drops it with no malformed rows", async () => {
		const w = await build();
		function* typeName(
			draft: {
				Name: string;
			},
			name: string
		): IActionGenerator {
			draft.Name = name;
		}
		function* typeLate(draft: { Name: string }): IActionGenerator {
			yield* wait("form");
			draft.Name = "late";
		}
		const formSetState = wrapSetState(rawOf(w.runtime.state).Form, (w.runtime as IRuntimeInternal<IRoot>).get("runtime/writeGateway"));
		const typing = w.runtime.processAction(
			typeLate,
			() => w.runtime.state.Form,
			formSetState,
			() => undefined as unknown as string
		);
		const queued = w.runtime.processAction(
			typeName,
			() => w.runtime.state.Form,
			formSetState,
			() => undefined as unknown as string,
			"typed"
		);
		await settled();
		await expectListed(createSnapshot(w.runtime), [
			{
				label: "typeLate",
				entityId: "root",
				state: "holding"
			},
			{
				label: "typeName",
				entityId: "root",
				state: "queued",
				place: 0
			}
		]);
		w.release("form");
		await Promise.all([
			typing,
			queued
		]);
		w.runtime.dispose();
	});

	it("over a field of a transient, is listed under the transient's owner", async () => {
		const w = await build();
		function* makeSlot(draft: IRow): IActionGenerator {
			const slot = yield* transient(draft, "State/Slot", {
				Form: {
					Name: ""
				}
			});
			slot.Form.Name = "seeded";
		}
		await w.runtime.dispatch(makeSlot, "row-1");
		const gateway = (w.runtime as IRuntimeInternal<IRoot>).get("runtime/writeGateway");
		const form = (
			gateway.rootNode() as {
				TransientState: Record<
					string,
					Record<
						string,
						{
							Form: {
								Name: string;
							};
						}
					>
				>;
			}
		).TransientState["row-1"]!["State/Slot"]!.Form;
		const typing = w.runtime.processAction(
			typeFormLate,
			() => form,
			wrapSetState(form, gateway),
			() => undefined as unknown as string
		);
		await settled();
		await expectListed(createSnapshot(w.runtime), [
			{
				label: "typeFormLate",
				entityId: "row-1",
				state: "holding"
			}
		]);
		w.release("form");
		await typing;
		w.runtime.dispose();
	});

	it("over a field of component state, isn't listed", async () => {
		const w = await build();
		const internal = w.runtime as IRuntimeInternal<IRoot>;
		const id = mountComponent(w.runtime, "row-1", {
			Form: {
				Name: ""
			}
		});
		const gateway = internal.get("runtime/writeGateway");
		const cell = internal.get("runtime/stateIdLookup")()[id]!;
		const form = rawOf(
			(
				cell.state as {
					Form: {
						Name: string;
					};
				}
			).Form
		);
		const typing = w.runtime.processAction(
			typeFormLate,
			() => form,
			wrapSetState(form, gateway),
			() => undefined as unknown as string
		);
		await settled();
		expect(
			internal
				.get("runtime/inFlightActions")()
				.map((entry) => [
					entry.EntityId,
					entry.State
				])
		).toEqual([
			[
				id,
				"holding"
			]
		]);
		await expectListed(createSnapshot(w.runtime), []);
		w.release("form");
		await typing;
		w.runtime.dispose();
	});
});

describe("a timer tick queued behind a holder that then stops the timer", () => {
	it("is listed queued with a place, and the runtime, left to run, drops it", async () => {
		vi.useFakeTimers();
		try {
			type ITicking = {
				$Id: string;
				Ticks: number;
			};
			const startTimerAny = startTimer as unknown as (
				entity: {
					$Id: string;
				},
				key: string,
				receiver: {
					Id: string;
				},
				intervalMs: number
			) => Generator<any, void, any>;
			const stopTimerAny = stopTimer as unknown as (
				entity: {
					$Id: string;
				},
				key: string
			) => Generator<any, void, any>;
			const runtime = createRuntime<ITicking>({
				$Id: "Root",
				Ticks: 0
			});
			runtime.registerReceiver(
				rawReceiver("TickReceiver", [], function* (draft: ITicking): IActionGenerator {
					draft.Ticks++;
				})
			);
			const records: IRecord[] = [];
			runtime.on("record", (record) => records.push(record));
			const releases: (() => void)[] = [];
			runtime.registerImplementation(
				"slow",
				() =>
					new Promise<void>((resolve) => {
						releases.push(resolve);
					})
			);
			const dispatch = (action: (draft: ITicking) => IActionGenerator) =>
				runtime.processAction(
					action as any,
					() => runtime.state,
					rootSetState(runtime),
					() => "Root"
				);
			function* arm(draft: ITicking): IActionGenerator {
				yield* startTimerAny(
					draft,
					"Tick",
					{
						Id: "TickReceiver"
					},
					100
				);
			}
			function* holdsThenStops(draft: ITicking): IActionGenerator {
				yield {
					Type: "slow"
				};
				yield* stopTimerAny(draft, "Tick");
				yield {
					Type: "slow"
				};
			}
			await dispatch(arm);
			const holding = dispatch(holdsThenStops);
			await vi.advanceTimersByTimeAsync(100);
			releases.shift()!();
			await vi.advanceTimersByTimeAsync(0);
			const snapshot = JSON.parse(createSnapshot(runtime)) as ISnapshot;
			expect(snapshot.Timers).toEqual([]);
			expect(
				snapshot.InFlight.map(({ Label, EntityId, State, Place }) => ({
					Label,
					EntityId,
					State,
					Place
				}))
			).toEqual([
				{
					Label: "holdsThenStops",
					EntityId: "Root",
					State: "holding",
					Place: undefined
				},
				{
					Label: null,
					EntityId: "Root",
					State: "queued",
					Place: 0
				}
			]);
			releases.shift()!();
			await holding;
			await vi.advanceTimersByTimeAsync(1000);
			expect(runtime.state.Ticks).toBe(0);
			expect(
				records.flatMap((record) =>
					record.Kind === "action:end" && record.Status === "dropped"
						? [
								record.ActionId
							]
						: []
				)
			).toEqual([
				snapshot.InFlight[1]!.ActionId
			]);
			runtime.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the order is the truth: entries sorted by place are admitted in that order", () => {
	it("queued work", async () => {
		const w = await build();
		const held = w.runtime.dispatch(slow, "root");
		const runs = [
			"c",
			"a",
			"b"
		].map((text) => w.runtime.dispatch(mark, "root", text));
		await settled();
		const line = w.line(createSnapshot(w.runtime), "root");
		w.release("slow");
		await Promise.all([
			held,
			...runs
		]);
		expect(w.log()).toEqual(line);
		expect(line).toEqual([
			"c",
			"a",
			"b"
		]);
	});

	it("work regaining its hold", async () => {
		const w = await build();
		const openers = [
			"o1",
			"o2",
			"o3"
		].map((name) => w.runtime.dispatch(opener, "root", name));
		await settled();
		const held = w.runtime.dispatch(slow, "root");
		for (const name of [
			"o2",
			"o3",
			"o1"
		]) {
			w.release(name);
			await settled();
		}
		const json = createSnapshot(w.runtime);
		expect(listed(json).map((entry) => entry.state)).toEqual([
			"regaining",
			"regaining",
			"regaining",
			"holding"
		]);
		const line = w.line(json, "root");
		w.release("slow");
		await Promise.all([
			held,
			...openers
		]);
		expect(w.log()).toEqual(line);
		expect(line).toEqual([
			"o2",
			"o3",
			"o1"
		]);
	});

	it("queued and regaining work in one line", async () => {
		const w = await build();
		const opening = w.runtime.dispatch(opener, "root", "opened");
		await settled();
		const held = w.runtime.dispatch(slow, "root");
		const first = w.runtime.dispatch(mark, "root", "queued-first");
		await settled();
		w.release("opened");
		await settled();
		const last = w.runtime.dispatch(mark, "root", "queued-last");
		await settled();
		const json = createSnapshot(w.runtime);
		expect(listed(json).map((entry) => entry.state)).toEqual([
			"regaining",
			"holding",
			"queued",
			"queued"
		]);
		const line = w.line(json, "root");
		w.release("slow");
		await Promise.all([
			opening,
			held,
			first,
			last
		]);
		expect(w.log()).toEqual(line);
		expect(line).toEqual([
			"queued-first",
			"opened",
			"queued-last"
		]);
	});

	it("a line with a leading and a latest action in it", async () => {
		const w = await build();
		const held = w.runtime.dispatch(slow, "root");
		const runs = [
			w.runtime.dispatch(leadingMarkAction, "root", "leading-1"),
			w.runtime.dispatch(latestMarkAction, "root", "latest-1"),
			w.runtime.dispatch(mark, "root", "plain"),
			w.runtime.dispatch(leadingMarkAction, "root", "leading-2"),
			w.runtime.dispatch(latestMarkAction, "root", "latest-2")
		];
		await settled();
		const json = createSnapshot(w.runtime);
		expect(listed(json)).toEqual([
			{
				label: "slow",
				entityId: "root",
				state: "holding"
			},
			{
				label: "leadingMark",
				entityId: "root",
				state: "queued",
				place: 0
			},
			{
				label: "mark",
				entityId: "root",
				state: "queued",
				place: 1
			},
			{
				label: "latestMark",
				entityId: "root",
				state: "queued",
				place: 2
			}
		]);
		const line = w.line(json, "root");
		w.release("slow");
		await Promise.all([
			held,
			...runs
		]);
		expect(w.log()).toEqual(line);
		expect(line).toEqual([
			"leading-1",
			"plain",
			"latest-2"
		]);
	});

	it("work queued on a child while its parent is held", async () => {
		const w = await build();
		const parent = w.runtime.dispatch(slow, "root");
		const child = w.runtime.dispatch(slowRow, "row-1");
		const runs = [
			"r2",
			"r1",
			"r3"
		].map((text) => w.runtime.dispatch(markRow, "row-1", text));
		const onParent = w.runtime.dispatch(mark, "root", "parent-queued");
		await settled();
		const json = createSnapshot(w.runtime);
		const entries = listed(json);
		expect(
			entries
				.filter((entry) => entry.entityId === "row-1")
				.map((entry) => [
					entry.state,
					entry.place
				])
		).toEqual([
			[
				"holding",
				undefined
			],
			[
				"queued",
				0
			],
			[
				"queued",
				1
			],
			[
				"queued",
				2
			]
		]);
		expect(
			entries
				.filter((entry) => entry.entityId === "root")
				.map((entry) => [
					entry.state,
					entry.place
				])
		).toEqual([
			[
				"holding",
				undefined
			],
			[
				"queued",
				0
			]
		]);
		const line = w.line(json, "row-1");
		w.release("row");
		await Promise.all([
			child,
			...runs
		]);
		expect(w.rowLog()).toEqual(line);
		expect(line).toEqual([
			"r2",
			"r1",
			"r3"
		]);
		expect(w.log()).toEqual([]);
		w.release("slow");
		await Promise.all([
			parent,
			onParent
		]);
		expect(w.log()).toEqual([
			"parent-queued"
		]);
	});

	it("a resource's delivery waiting ahead of listed work leaves no gap in the places", async () => {
		const w = await build();
		const contexts: IResourceContext<"state/feed">[] = [];
		w.runtime.registerResourceType("state/feed", (_params, r) => {
			contexts.push(r);
		});
		w.runtime.registerReceiver(FeedReceiver);
		await w.runtime.dispatch(openFeed, "row-1");
		const held = w.runtime.dispatch(slowRow, "row-1");
		await settled();
		void contexts[0]!.emit({
			N: 1
		});
		await settled();
		const after = w.runtime.dispatch(markRow, "row-1", "after");
		await settled();
		expect(listed(createSnapshot(w.runtime))).toEqual([
			{
				label: "slowRow",
				entityId: "row-1",
				state: "holding"
			},
			{
				label: "markRow",
				entityId: "row-1",
				state: "queued",
				place: 0
			}
		]);
		w.release("row");
		await Promise.all([
			held,
			after
		]);
		await settled();
		expect(w.rowLog()).toEqual([
			"feed:1",
			"after"
		]);
		w.runtime.dispose();
	});

	it("at every microtask across a hand-over: at most one holder, places dense from 0, and the line in the order the run admits it", async () => {
		const w = await build();
		function* regainsThenHolds(draft: IRoot, name: string): IOpenGenerator {
			yield* open(wait(name) as IActionGenerator);
			draft.Log.push(name);
			yield* wait(`${name}-held`);
		}
		const cuts: {
			json: string;
			log: string[];
		}[] = [];
		const sweep = async (): Promise<void> => {
			for (let turn = 0; turn < 40; turn++) {
				cuts.push({
					json: createSnapshot(w.runtime),
					log: [
						...w.log()
					]
				});
				await Promise.resolve();
			}
			await settled();
		};
		const opening = w.runtime.dispatch(regainsThenHolds, "root", "o");
		await sweep();
		const held = w.runtime.dispatch(slow, "root");
		const queued = [
			"q1",
			"q2"
		].map((text) => w.runtime.dispatch(mark, "root", text));
		await sweep();
		w.release("o");
		await sweep();
		w.release("slow");
		await sweep();
		w.release("o-held");
		await sweep();
		await Promise.all([
			opening,
			held,
			...queued
		]);
		const admitted = w.log();
		expect(admitted).toEqual([
			"q1",
			"q2",
			"o"
		]);
		const opener: (string | undefined)[] = [];
		for (const cut of cuts) {
			const onRoot = (JSON.parse(cut.json) as ISnapshot).InFlight.filter((entry) => entry.EntityId === "root");
			expect(onRoot.filter((entry) => entry.State === "holding").length).toBeLessThanOrEqual(1);
			const places = onRoot
				.flatMap((entry) =>
					entry.Place === undefined
						? []
						: [
								entry.Place
							]
				)
				.sort((a, b) => a - b);
			expect(places).toEqual(places.map((_, index) => index));
			const line = w.line(cut.json, "root");
			expect(line.filter((name) => cut.log.includes(name as string))).toEqual([]);
			expect(admitted.filter((name) => line.includes(name))).toEqual(line);
			const state = onRoot.find((entry) => w.firstArg(entry.ActionId) === "o")?.State;
			if (state !== opener.at(-1)) {
				opener.push(state);
			}
		}
		expect(opener).toEqual([
			"open",
			"regaining",
			"holding",
			undefined
		]);
		expect(cuts.some((cut) => w.line(cut.json, "root").join() === "q1,q2,o")).toBe(true);
		w.runtime.dispose();
	});
});

describe("a snapshot with nothing listed", () => {
	it("of a runtime with nothing in flight, and of a restored runtime", async () => {
		const w = await build();
		const quiet = createSnapshot(w.runtime);
		expect(listed(quiet)).toEqual([]);
		const held = w.runtime.dispatch(slow, "root");
		await settled();
		const busy = createSnapshot(w.runtime);
		const { runtime } = await restoreRuntime<IRoot>(busy, {
			rootId: "root",
			options: {
				onError: () => {}
			},
			setup: (r) => r.registerReceiver(RowReceiver)
		});
		expect(listed(createSnapshot(runtime))).toEqual([]);
		runtime.dispose();
		w.release("slow");
		await held;
		w.runtime.dispose();
	});
});

const TREFLEX_0_2_0_ENVELOPE =
	'{"Version":8,"Build":"upgrade-build","AppState":{"$Id":"root","Title":"kept","Log":["boot","slow-start"],"Rows":[{"$Id":"row-1","Log":[],"N":1},{"$Id":"row-2","Log":[],"N":2,"$Receiver":"Upgrade/RowReceiver"}]},"DataSources":[],"Timers":[{"Key":"Upgrade/Tick","OwnerId":"row-2","ReceiverId":"Upgrade/RowReceiver","IntervalMs":60000,"Payload":null,"NextDue":1794951785902}],"Resources":[],"InFlight":[{"ActionId":"branch-8","Name":null,"Label":"Upgrade/RowReceiver","Receiver":"Upgrade/RowReceiver","EntityId":"row-2"},{"ActionId":"branch-2","Name":null,"Label":"slow","EntityId":"root"},{"ActionId":"branch-3","Name":null,"Label":"mark","EntityId":"root"},{"ActionId":"branch-4","Name":null,"Label":"mark","EntityId":"root"},{"ActionId":"branch-5","Name":null,"Label":"opener","EntityId":"row-1"},{"ActionId":"branch-6","Name":"Row/NamedSlow","Label":"namedSlow","EntityId":"row-1"}]}';

const TREFLEX_0_1_1_ENVELOPE =
	'{"Version":7,"AppState":{"$Id":"root","Title":"kept","Log":["boot","slow-start"],"Rows":[{"$Id":"row-1","Log":[],"N":1},{"$Id":"row-2","Log":[],"N":2,"$Receiver":"Upgrade/RowReceiver"}]},"DataSources":[],"Timers":[{"Key":"Upgrade/Tick","OwnerId":"row-2","ReceiverId":"Upgrade/RowReceiver","IntervalMs":60000,"Payload":null,"NextDue":1794951786096}],"Resources":[],"InFlight":[{"ActionId":"branch-8","Name":"Upgrade/RowReceiver","EntityId":"row-2"},{"ActionId":"branch-2","Name":"slow","EntityId":"root"},{"ActionId":"branch-3","Name":"mark","EntityId":"root"},{"ActionId":"branch-4","Name":"mark","EntityId":"root"},{"ActionId":"branch-5","Name":"opener","EntityId":"row-1"},{"ActionId":"branch-6","Name":"namedSlow","EntityId":"row-1"}]}';

async function restoredPublished(json: string) {
	const diags: string[] = [];
	const { runtime, result } = await restoreRuntime<IRoot>(json, {
		rootId: "root",
		options: {
			build: "upgrade-build"
		},
		setup: (r) => {
			r.on("diag", (event) => {
				diags.push(event.code);
			});
			r.registerReceiver(rawReceiver("Upgrade/RowReceiver", [], function* () {}));
		}
	});
	const state = JSON.parse(JSON.stringify(runtime.state));
	runtime.dispose();
	return {
		result,
		diags,
		state
	};
}

describe("a version 8 envelope", () => {
	it("as this treflex writes it, carries State on its in-flight entries", async () => {
		const w = await build();
		const held = w.runtime.dispatch(slow, "root");
		await settled();
		const envelope = JSON.parse(createSnapshot(w.runtime)) as ISnapshot;
		expect(SNAPSHOT_FORMAT_VERSION).toBe(8);
		expect(envelope.Version).toBe(8);
		expect(envelope.InFlight.map((entry) => entry.State)).toEqual([
			"holding"
		]);
		w.release("slow");
		await held;
		w.runtime.dispose();
	});

	it("as treflex 0.2.0 wrote it, drops every in-flight entry with neither state nor place, calls none malformed, and keeps the data", async () => {
		const { result, diags, state } = await restoredPublished(TREFLEX_0_2_0_ENVELOPE);
		expect(diags).not.toContain("restore/malformed-rows");
		expect(result.savedBuild).toBe("upgrade-build");
		expect(result.dropped).toStrictEqual(
			[
				{
					actionId: "branch-8",
					name: null,
					label: "Upgrade/RowReceiver",
					receiver: "Upgrade/RowReceiver",
					entityId: "row-2"
				},
				{
					actionId: "branch-2",
					name: null,
					label: "slow",
					entityId: "root"
				},
				{
					actionId: "branch-3",
					name: null,
					label: "mark",
					entityId: "root"
				},
				{
					actionId: "branch-4",
					name: null,
					label: "mark",
					entityId: "root"
				},
				{
					actionId: "branch-5",
					name: null,
					label: "opener",
					entityId: "row-1"
				},
				{
					actionId: "branch-6",
					name: "Row/NamedSlow",
					label: "namedSlow",
					entityId: "row-1"
				}
			].map((entry) => ({
				...entry,
				reason: "resume-off"
			}))
		);
		expect(state).toEqual(JSON.parse(TREFLEX_0_2_0_ENVELOPE).AppState);
	});
});

describe("a version 7 envelope", () => {
	it("as treflex 0.1.1 wrote it, drops every in-flight entry labelled by its old Name, and keeps the data", async () => {
		const { result, diags, state } = await restoredPublished(TREFLEX_0_1_1_ENVELOPE);
		expect(diags).not.toContain("restore/malformed-rows");
		expect(result.savedBuild).toBeNull();
		expect(result.dropped).toStrictEqual(
			[
				[
					"branch-8",
					"Upgrade/RowReceiver",
					"row-2"
				],
				[
					"branch-2",
					"slow",
					"root"
				],
				[
					"branch-3",
					"mark",
					"root"
				],
				[
					"branch-4",
					"mark",
					"root"
				],
				[
					"branch-5",
					"opener",
					"row-1"
				],
				[
					"branch-6",
					"namedSlow",
					"row-1"
				]
			].map(([actionId, label, entityId]) => ({
				actionId,
				name: null,
				label,
				entityId,
				reason: "resume-off"
			}))
		);
		expect(state).toEqual(JSON.parse(TREFLEX_0_1_1_ENVELOPE).AppState);
	});

	it("ignores a State and Place on its entries", async () => {
		const v7 = {
			Version: 7,
			AppState: seed(),
			DataSources: [],
			Timers: [],
			Resources: [],
			InFlight: [
				{
					ActionId: "branch-1",
					Name: "slow",
					EntityId: "root",
					State: "queued",
					Place: 0
				}
			]
		};
		const { runtime, result } = await restoreRuntime<IRoot>(JSON.stringify(v7), {
			rootId: "root",
			options: {}
		});
		expect(result.dropped).toStrictEqual([
			{
				actionId: "branch-1",
				name: null,
				label: "slow",
				entityId: "root",
				reason: "resume-off"
			}
		]);
		runtime.dispose();
	});
});
