import type { IJournal, IJournalAppend } from "../../src/Runtime/createJournal";
import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IRuntimeStoreReader } from "../../src/Runtime/processAction";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineEffect } from "../../src/Effects/defineEffect";
import { parallel } from "../../src/Effects/parallel";
import { parallelSettled } from "../../src/Effects/parallelSettled";
import { publish } from "../../src/Effects/publish";
import { registerDataSource } from "../../src/Effects/registerDataSource";
import { start } from "../../src/Effects/start";
import { unregisterDataSource } from "../../src/Effects/unregisterDataSource";
import { bind } from "../../src/Runtime/bind";
import { createJournal } from "../../src/Runtime/createJournal";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import { createProcessAction } from "../../src/Runtime/processAction";
import { receiver } from "../../src/Runtime/receiver";
import { sliceSetState } from "../../src/Runtime/sliceSetState";
import { createTreeState, minted, rootSetState } from "../testHelpers";

function createBarrier() {
	let resolve!: (v: any) => void;
	let reject!: (e: any) => void;
	let signalStarted!: () => void;
	const started = new Promise<void>((r) => {
		signalStarted = r;
	});
	const promise = new Promise<any>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {
		started,
		resolve,
		reject,
		run: () => {
			signalStarted();
			return promise;
		}
	};
}

type ChildState = {
	$Id: string;
	Data: string;
};
type TestState = {
	$Id: string;
	Data: string;
	Count: number;
	Children: ChildState[];
};

const initialState = (): TestState => ({
	$Id: "parent",
	Data: "before",
	Count: 0,
	Children: [
		{
			$Id: "child-1",
			Data: ""
		}
	]
});

type ITestJournal = IJournal & {
	records(): IRecord[];
};

async function grabJournal(
	runtime: IRuntime<TestState>,
	options?: {
		raw?: boolean;
	}
): Promise<ITestJournal> {
	let captured: IJournal | undefined;
	runtime.registerImplementation("journal_probe", (_e, action) => {
		captured = action!.get("runtime/journal");
	});
	function* probe(_draft: TestState): IActionGenerator {
		yield {
			Type: "journal_probe"
		};
	}
	await runtime.processAction(
		probe,
		() => runtime.state,
		rootSetState(runtime),
		() => "parent"
	);
	// The tap starts after the probe so the stream opens clean. `raw` skips it
	// for tests of the enabled gate, which a tap subscriber would flip.
	const real = captured!;
	const stream: IRecord[] = [];
	if (!options?.raw) {
		real.tap((record) => {
			stream.push(record as IRecord);
		});
	}
	return {
		get enabled() {
			return real.enabled;
		},
		wants: real.wants,
		sample: real.sample,
		append: real.append,
		tap: real.tap,
		records: () => [
			...stream
		]
	};
}

function* hang(): IActionGenerator {
	yield {
		Type: "hang"
	};
}

function dispatch<A extends any[], R>(
	runtime: IRuntime<TestState>,
	action: (draft: TestState, ...args: A) => Generator<any, R, any>,
	...args: A
): Promise<R | undefined> {
	return runtime.processAction(
		action as any,
		() => runtime.state,
		rootSetState(runtime),
		() => "parent",
		...args
	);
}

// The message and data-source registries are empty until a consumer augments them.
const publishAny = publish as unknown as (topic: string) => Generator<any, void, any>;
const registerDataSourceAny = registerDataSource as unknown as (
	owner: {
		$Id: string;
	},
	key: string
) => Generator<any, void, any>;
const unregisterDataSourceAny = unregisterDataSource as unknown as (
	owner: {
		$Id: string;
	},
	key: string
) => Generator<any, void, any>;

const startRecord = (actionId: string): IJournalAppend => ({
	T: 0,
	Kind: "action:start",
	Root: "AppState",
	ActionId: actionId,
	Name: null,
	EntityId: "e",
	Path: [
		"e"
	],
	Args: []
});
const endRecord = (actionId: string): IJournalAppend => ({
	T: 0,
	Kind: "action:end",
	Root: "AppState",
	ActionId: actionId,
	Status: "completed"
});
const effectRecord = (actionId: string): IJournalAppend => ({
	T: 0,
	Kind: "effect",
	Root: "AppState",
	ActionId: actionId,
	BranchId: actionId,
	Type: "echo",
	Descriptor: {
		Type: "echo"
	}
});
const stepRecord = (actionId: string): IJournalAppend => ({
	T: 0,
	Kind: "step",
	Root: "AppState",
	ActionId: actionId,
	BranchId: actionId,
	Changes: [
		{
			Path: [
				"Data"
			],
			Prev: "before",
			Value: "after"
		}
	]
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createJournal (unit)", () => {
	it("append stamps Seq in place, in increasing order", () => {
		const journal = createJournal();
		const seen: number[] = [];
		journal.tap((record) => seen.push(record.Seq));
		const a = startRecord("a");
		const b = effectRecord("a");
		journal.append(a);
		journal.append(b);
		expect((a as IRecord).Seq).toBe(1);
		expect((b as IRecord).Seq).toBe(2);
		expect(seen).toEqual([
			1,
			2
		]);
	});

	it("an unsettled effect is an effect record with no response — pending is the absence of a settlement", () => {
		const journal = createJournal();
		const stream: IRecord[] = [];
		journal.tap((record) => stream.push(record as IRecord));
		journal.append(startRecord("a"));
		const effect = effectRecord("a");
		journal.append(effect);
		const effectSeq = (effect as IRecord).Seq;

		expect(stream.some((r) => r.Kind === "effect" && r.Seq === effectSeq)).toBe(true);
		expect(stream.filter((r) => r.Kind === "response")).toEqual([]);

		journal.append({
			T: 0,
			Kind: "response",
			Root: "AppState",
			ForSeq: effectSeq,
			Value: "ok"
		});
		expect(stream.filter((r) => r.Kind === "response" && r.ForSeq === effectSeq).length).toBe(1);
		expect(stream[stream.length - 1]).toMatchObject({
			Kind: "response",
			Value: "ok"
		});
	});
});

describe("journal (runtime integration)", () => {
	it("records a totally ordered interleaved scenario and round-trips through JSON", async () => {
		await createRoot(async (dispose) => {
			try {
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {
					onError: () => {}
				});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => barrier.run());
				runtime.registerImplementation("echo", () => "fetched");

				function* actionA(_draft: TestState) {
					yield* open(hang());
				}
				function* actionB(draft: TestState): IActionGenerator {
					draft.Data = "x";
					const v: string = yield {
						Type: "echo"
					};
					draft.Count = v.length;
				}

				const aPromise = dispatch(runtime, actionA);
				await barrier.started;
				await dispatch(runtime, actionB);

				const records = journal.records();
				expect(records.map((r) => r.Kind)).toEqual([
					"action:start",
					"effect",
					"action:start",
					"step",
					"effect",
					"response",
					"step",
					"action:end"
				]);

				const seqs = records.map((r) => r.Seq);
				expect([
					...seqs
				]).toEqual(
					[
						...seqs
					].sort((x, y) => x - y)
				);
				expect(new Set(seqs).size).toBe(seqs.length);
				const effectSeqs = new Set(records.filter((r) => r.Kind === "effect").map((r) => r.Seq));
				for (const response of records.filter((r) => r.Kind === "response")) {
					expect(
						effectSeqs.has(
							(
								response as {
									ForSeq: number;
								}
							).ForSeq
						)
					).toBe(true);
					expect(
						(
							response as {
								ForSeq: number;
							}
						).ForSeq
					).toBeLessThan(response.Seq);
				}
				const bStart = records[2];
				const bEnd = records[records.length - 1];
				for (const step of records.filter((r) => r.Kind === "step")) {
					expect(step.Seq).toBeGreaterThan(bStart.Seq);
					expect(step.Seq).toBeLessThan(bEnd.Seq);
				}

				expect(records[0]).toMatchObject({
					Name: "actionA",
					EntityId: "parent"
				});
				expect(records[2]).toMatchObject({
					Name: "actionB"
				});

				expect(records[1]).toMatchObject({
					Kind: "effect",
					Type: "hang"
				});
				expect(records.some((r) => r.Kind === "response" && r.ForSeq === records[1].Seq)).toBe(false);

				barrier.resolve("released");
				await aPromise;
				expect((runtime as IRuntimeInternal<TestState>).get("runtime/inFlightActions")()).toEqual([]);
			} finally {
				dispose();
			}
		});
	});

	it("step changes carry Path, Prev, and the cloned written Value — no hash", async () => {
		await createRoot(async (dispose) => {
			try {
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => barrier.run());

				function* writeAndHang(draft: TestState): IActionGenerator {
					draft.Data = "after";
					yield {
						Type: "hang"
					};
				}
				const promise = dispatch(runtime, writeAndHang);
				await barrier.started;

				const step = journal.records().find((r) => r.Kind === "step")!;
				const change = (
					step as {
						Changes: any[];
					}
				).Changes[0];
				expect(change.Path).toEqual([
					"Data"
				]);
				expect(change.Prev).toBe("before");
				expect(change.Value).toBe("after");
				expect(change).not.toHaveProperty("Hash");

				barrier.resolve(undefined);
				await promise;
			} finally {
				dispose();
			}
		});
	});

	it("pop journals the delete trap's record and a bare length write — no synthesized duplicate", async () => {
		await createRoot(async (dispose) => {
			try {
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => barrier.run());

				function* popsAndHangs(draft: TestState): IActionGenerator {
					draft.Children.pop();
					yield {
						Type: "hang"
					};
				}
				const promise = dispatch(runtime, popsAndHangs);
				await barrier.started;

				const step = journal.records().find((r) => r.Kind === "step")!;
				const changes = (
					step as {
						Changes: any[];
					}
				).Changes;
				expect(changes.map((c) => c.Path)).toEqual([
					[
						"Children",
						"0"
					],
					[
						"Children",
						"length"
					]
				]);
				expect(changes[0].Prev).toEqual({
					$Id: "child-1",
					Data: ""
				});
				expect(changes[0]).not.toHaveProperty("Value");
				expect(changes[1].Prev).toBe(1);
				expect(changes[1].Value).toBe(0);

				barrier.resolve(undefined);
				await promise;
			} finally {
				dispose();
			}
		});
	});

	it("a length-assignment shrink synthesizes the tail deletes before the length record", async () => {
		await createRoot(async (dispose) => {
			try {
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => barrier.run());

				function* truncatesAndHangs(draft: TestState): IActionGenerator {
					draft.Children.length = 0;
					yield {
						Type: "hang"
					};
				}
				const promise = dispatch(runtime, truncatesAndHangs);
				await barrier.started;

				const step = journal.records().find((r) => r.Kind === "step")!;
				const changes = (
					step as {
						Changes: any[];
					}
				).Changes;
				expect(changes.map((c) => c.Path)).toEqual([
					[
						"Children",
						"0"
					],
					[
						"Children",
						"length"
					]
				]);
				expect(changes[0].Prev).toEqual({
					$Id: "child-1",
					Data: ""
				});
				expect(changes[0]).not.toHaveProperty("Value");
				expect(changes[1].Prev).toBe(1);
				expect(changes[1].Value).toBe(0);

				barrier.resolve(undefined);
				await promise;
			} finally {
				dispose();
			}
		});
	});

	it("a write through a re-derived reference to a moved element journals the element's CURRENT path", async () => {
		await createRoot(async (dispose) => {
			try {
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => barrier.run());

				// Reading Children[0] before the unshift mints the child's proxy at
				// that path (the proxy cache is keyed by target).
				function* moveThenWrite(draft: TestState): IActionGenerator {
					const first = draft.Children[0];
					draft.Children.unshift(
						minted("child-0", {
							Data: first.Data
						})
					);
					const moved = draft.Children[1];
					moved.Data = "x";
					yield {
						Type: "hang"
					};
				}
				const promise = dispatch(runtime, moveThenWrite);
				await barrier.started;

				const steps = journal.records().filter((r) => r.Kind === "step") as Extract<
					IRecord,
					{
						Kind: "step";
					}
				>[];
				const write = steps.flatMap((s) => s.Changes).find((c) => !c.Deleted && c.Value === "x");
				expect(write).toBeDefined();
				expect(write!.Path).toEqual([
					"Children",
					"1",
					"Data"
				]);

				barrier.resolve(undefined);
				await promise;
			} finally {
				dispose();
			}
		});
	});

	it("journals the table-write built-ins' dispatches and their table mutations at the store boundary", async () => {
		await createRoot(async (dispose) => {
			try {
				vi.spyOn(console, "warn").mockImplementation(() => {});
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => barrier.run());

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* tableWrites(draft: TestState): IActionGenerator {
					yield* registerDataSourceAny(draft, "TestKey");
					yield* registerDataSourceAny(draft, "TestKey");
					yield* unregisterDataSourceAny(draft, "TestKey");
				}

				const pinPromise = dispatch(runtime, pin);
				await barrier.started;
				await dispatch(runtime, tableWrites);

				const effects = journal.records().filter((r) => r.Kind === "effect" && r.Type !== "hang") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>[];
				expect(effects.map((e) => e.Type)).toEqual([
					"registerDataSource",
					"registerDataSource",
					"unregisterDataSource"
				]);
				for (const effect of effects) {
					expect("Inverse" in effect).toBe(false);
				}

				const tables = journal.records().filter((r) => r.Kind === "table") as Extract<
					IRecord,
					{
						Kind: "table";
					}
				>[];
				expect(tables).toEqual([
					expect.objectContaining({
						Table: "dataSources",
						Key: "TestKey",
						OwnerId: "parent",
						Prev: null,
						Value: "parent"
					}),
					expect.objectContaining({
						Table: "dataSources",
						Key: "TestKey",
						OwnerId: "parent",
						Prev: "parent",
						Value: null
					})
				]);

				barrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it("records branch:start edges for parallel children", async () => {
		await createRoot(async (dispose) => {
			try {
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => barrier.run());
				runtime.registerImplementation("echo", () => "ok");

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* leg(_draft: TestState): IActionGenerator {
					yield {
						Type: "echo"
					};
				}
				function* split(draft: TestState): IActionGenerator {
					yield* parallel(leg(draft), leg(draft));
				}

				const pinPromise = dispatch(runtime, pin);
				await barrier.started;
				await dispatch(runtime, split);

				const records = journal.records();
				const parallelEffect = records.find((r) => r.Kind === "effect" && r.Type === "parallel") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>;

				const branchStarts = records.filter((r) => r.Kind === "branch:start") as Extract<
					IRecord,
					{
						Kind: "branch:start";
					}
				>[];
				expect(branchStarts.length).toBe(2);
				for (const branchStart of branchStarts) {
					expect(branchStart.ActionId).toBe(parallelEffect.ActionId);
					expect(branchStart.ParentBranchId).toBe(parallelEffect.BranchId);
				}
				expect(branchStarts[0].BranchId).not.toBe(branchStarts[1].BranchId);

				const childBranchIds = new Set(branchStarts.map((s) => s.BranchId));
				const legEffects = records.filter((r) => r.Kind === "effect" && r.Type === "echo") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>[];
				expect(legEffects.length).toBe(2);
				for (const legEffect of legEffects) {
					expect(childBranchIds.has(legEffect.BranchId)).toBe(true);
				}

				barrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it("records action:end with status 'cancelled' when the entity is removed mid-flight", async () => {
		await createRoot(async (dispose) => {
			try {
				const pinBarrier = createBarrier();
				const childBarrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {
					onError: () => {}
				});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => pinBarrier.run());
				runtime.registerImplementation("hang_child", () => childBarrier.run());

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* childAction(_draft: ChildState): IActionGenerator {
					yield {
						Type: "hang_child"
					};
				}
				function* clearChildren(draft: TestState): IActionGenerator {
					draft.Children = [];
				}

				const pinPromise = dispatch(runtime, pin);
				await pinBarrier.started;

				const childSetState = sliceSetState(rootSetState(runtime), (x: TestState) => x.Children[0]);
				const childPromise = runtime.processAction(
					childAction,
					(() => runtime.state) as any,
					childSetState,
					() => runtime.state.Children[0]?.$Id ?? ""
				);
				await childBarrier.started;

				await dispatch(runtime, clearChildren);
				childBarrier.resolve("late");
				await childPromise;

				const records = journal.records();
				const childStart = records.find((r) => r.Kind === "action:start" && r.EntityId === "child-1") as Extract<
					IRecord,
					{
						Kind: "action:start";
					}
				>;
				expect(childStart).toBeDefined();
				expect(records).toContainEqual(
					expect.objectContaining({
						Kind: "action:end",
						ActionId: childStart.ActionId,
						Status: "cancelled"
					})
				);

				pinBarrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it("journals receiver-dispatched work with the receiver id as its Name", async () => {
		await createRoot(async (dispose) => {
			try {
				vi.spyOn(console, "warn").mockImplementation(() => {});
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => barrier.run());

				const PingReceiver = receiver<TestState>("PingReceiver")({
					["Ping" as any]: function* (draft: any) {
						draft.Data = "pinged";
					}
				});
				runtime.registerReceiver(PingReceiver);

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* setupAndPublish(draft: TestState): IActionGenerator {
					bind(draft, PingReceiver);
					yield* publishAny("Ping");
				}

				const pinPromise = dispatch(runtime, pin);
				await barrier.started;
				await dispatch(runtime, setupAndPublish);
				await new Promise((r) => setTimeout(r, 0));

				const starts = journal.records().filter((r) => r.Kind === "action:start") as Extract<
					IRecord,
					{
						Kind: "action:start";
					}
				>[];
				const receiverStart = starts.find((r) => r.Name === "PingReceiver");
				expect(receiverStart).toBeDefined();
				expect((runtime.state as TestState).Data).toBe("pinged");

				barrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it("undefined-valued keys in descriptors and responses are absence, not loss", async () => {
		await createRoot(async (dispose) => {
			try {
				const pinBarrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => pinBarrier.run());
				runtime.registerImplementation("wire", () => ({
					Status: 204,
					Body: undefined
				}));

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* call(draft: TestState): IActionGenerator {
					const response: {
						Status: number;
					} = yield {
						Type: "wire",
						Url: "/api/thing",
						Body: undefined
					};
					draft.Count = response.Status;
				}

				const pinPromise = dispatch(runtime, pin);
				await pinBarrier.started;
				await dispatch(runtime, call);
				expect(runtime.state.Count).toBe(204);

				const records = journal.records();
				const effect = records.find((r) => r.Kind === "effect" && r.Type === "wire") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>;
				expect(effect.Descriptor).toEqual({
					Type: "wire",
					Url: "/api/thing"
				});
				const settlement = records.find((r) => r.Kind === "response" && r.ForSeq === effect.Seq);
				expect(
					(
						settlement as {
							Value?: unknown;
						}
					).Value
				).toEqual({
					Status: 204
				});

				pinBarrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it("journals a caught effect throw as an Error settlement and the action continues", async () => {
		await createRoot(async (dispose) => {
			try {
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => barrier.run());
				runtime.registerImplementation("explode", () => {
					throw new TypeError("boom");
				});

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* recovers(draft: TestState): IActionGenerator {
					try {
						yield {
							Type: "explode"
						};
					} catch (e) {
						draft.Data = (e as Error).message;
					}
					draft.Count = 1;
				}

				const pinPromise = dispatch(runtime, pin);
				await barrier.started;
				await dispatch(runtime, recovers);

				const records = journal.records();
				const explodeEffect = records.find((r) => r.Kind === "effect" && r.Type === "explode") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>;
				const settlement = records.find((r) => r.Kind === "response" && r.ForSeq === explodeEffect.Seq);
				expect(settlement).toMatchObject({
					Error: {
						Thrown: "error",
						Name: "TypeError",
						Message: "boom"
					}
				});
				expect(settlement).not.toHaveProperty("Value");
				const laterSteps = records.filter((r) => r.Kind === "step" && r.Seq > settlement!.Seq);
				expect(laterSteps.length).toBeGreaterThan(0);
				expect(records).toContainEqual(
					expect.objectContaining({
						Kind: "action:end",
						ActionId: explodeEffect.ActionId,
						Status: "completed"
					})
				);
				expect(runtime.state.Data).toBe("boom");
				expect(runtime.state.Count).toBe(1);

				barrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it("journals an uncaught effect throw as an Error settlement plus action:end errored", async () => {
		await createRoot(async (dispose) => {
			try {
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {
					onError: () => {}
				});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => barrier.run());
				runtime.registerImplementation("explode", () => {
					throw new Error("unhandled");
				});

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* fails(_draft: TestState): IActionGenerator {
					yield {
						Type: "explode"
					};
				}

				const pinPromise = dispatch(runtime, pin);
				await barrier.started;
				await expect(dispatch(runtime, fails)).rejects.toThrow("unhandled");

				const records = journal.records();
				const explodeEffect = records.find((r) => r.Kind === "effect" && r.Type === "explode") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>;
				expect(records).toContainEqual(
					expect.objectContaining({
						Kind: "response",
						ForSeq: explodeEffect.Seq,
						Error: expect.objectContaining({
							Thrown: "error",
							Message: "unhandled"
						})
					})
				);
				expect(records).toContainEqual(
					expect.objectContaining({
						Kind: "action:end",
						ActionId: explodeEffect.ActionId,
						Status: "errored"
					})
				);
				expect(records.some((r) => r.Kind === "response" && r.ForSeq === explodeEffect.Seq)).toBe(true);

				barrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it("an aborted effect settles nothing — the cancelled action ends with no response record", async () => {
		await createRoot(async (dispose) => {
			try {
				const pinBarrier = createBarrier();
				const childBarrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {
					onError: () => {}
				});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => pinBarrier.run());
				runtime.registerImplementation("hang_child", () => childBarrier.run());

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* childAction(_draft: ChildState): IActionGenerator {
					yield {
						Type: "hang_child"
					};
				}
				function* clearChildren(draft: TestState): IActionGenerator {
					draft.Children = [];
				}

				const pinPromise = dispatch(runtime, pin);
				await pinBarrier.started;

				const childSetState = sliceSetState(rootSetState(runtime), (x: TestState) => x.Children[0]);
				const childPromise = runtime.processAction(
					childAction,
					(() => runtime.state) as any,
					childSetState,
					() => runtime.state.Children[0]?.$Id ?? ""
				);
				await childBarrier.started;

				await dispatch(runtime, clearChildren);
				// Rejecting, not resolving, drives the silent-cancel path.
				childBarrier.reject(new Error("aborted by disposal"));
				await childPromise;

				const records = journal.records();
				const childEffect = records.find((r) => r.Kind === "effect" && r.Type === "hang_child") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>;
				expect(records.filter((r) => r.Kind === "response" && r.ForSeq === childEffect.Seq)).toEqual([]);
				expect(records).toContainEqual(
					expect.objectContaining({
						Kind: "action:end",
						ActionId: childEffect.ActionId,
						Status: "cancelled"
					})
				);
				const inFlight = (type: string) =>
					records.some(
						(r) =>
							r.Kind === "effect" &&
							r.Type === type &&
							!records.some((s) => s.Kind === "response" && s.ForSeq === r.Seq) &&
							!records.some((e) => e.Kind === "action:end" && e.ActionId === r.ActionId)
					);
				expect(inFlight("hang_child")).toBe(false);
				expect(inFlight("hang")).toBe(true);

				pinBarrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it("with no tap the journal reports disabled, and actions still run", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<TestState>(initialState());
				const journal = await grabJournal(runtime, {
					raw: true
				});
				expect(journal.enabled).toBe(false);

				function* writes(draft: TestState): IActionGenerator {
					draft.Data = "after";
					yield {
						Type: "journal_probe"
					};
					draft.Count = 1;
				}
				await dispatch(runtime, writes);
				expect(runtime.state.Data).toBe("after");
			} finally {
				dispose();
			}
		});
	});

	it("journal disabled: the recording path never engages on a state write with no mutation subscriber", async () => {
		// Any runtime-store lookup on the recording path would reject the action.
		const throwingReader: IRuntimeStoreReader = ((key: string) => {
			throw new Error(`[test] No runtime value registered for key "${String(key)}".`);
		}) as IRuntimeStoreReader;

		const state = {
			name: "before"
		};
		const { raw, state: view, setState } = createTreeState(state);
		const { processAction } = createProcessAction({
			effectProcessor: async () => "ok",
			runtimeStoreReader: throwingReader,
			journal: createJournal()
		});

		function* writes(draft: { name: string }): IActionGenerator {
			draft.name = "after";
			yield {
				Type: "echo"
			};
		}
		await processAction(
			writes,
			() => view,
			setState,
			() => "test"
		);
		expect(raw.name).toBe("after");
	});
});

describe("journal owns Args and Descriptors", () => {
	it("clones Args and Descriptors at append — mutating them after dispatch cannot rewrite history", async () => {
		await createRoot(async (dispose) => {
			try {
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => barrier.run());

				function* holds(
					_draft: TestState,
					payload: {
						Mode: string;
					}
				): IActionGenerator {
					yield {
						Type: "hang",
						Payload: payload
					};
				}

				const payload = {
					Mode: "at-dispatch"
				};
				const promise = dispatch(runtime, holds, payload);
				await barrier.started;
				payload.Mode = "rewritten";

				const records = journal.records();
				const start = records.find((r) => r.Kind === "action:start") as Extract<
					IRecord,
					{
						Kind: "action:start";
					}
				>;
				expect(start.Name).toBe("holds");
				expect(start.Args).toEqual([
					{
						Mode: "at-dispatch"
					}
				]);
				const effect = records.find((r) => r.Kind === "effect" && r.Type === "hang") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>;
				expect(effect.Descriptor).toEqual({
					Type: "hang",
					Payload: {
						Mode: "at-dispatch"
					}
				});

				barrier.resolve(undefined);
				await promise;
			} finally {
				dispose();
			}
		});
	});

	it("trailing undefined args trim loss-free; a mid-list undefined arg reaches the record", async () => {
		await createRoot(async (dispose) => {
			try {
				const pinBarrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => pinBarrier.run());

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* initLike(_draft: TestState, _options?: unknown): IActionGenerator {}
				function* opener(draft: TestState, options?: unknown): IActionGenerator {
					yield* start(initLike as any, draft.$Id, options);
				}
				function* midArray(_draft: TestState, _a?: unknown, _b?: number): IActionGenerator {}

				const pinPromise = dispatch(runtime, pin);
				await pinBarrier.started;

				await dispatch(runtime, opener, undefined);
				await new Promise((r) => setTimeout(r, 0));

				const records = journal.records();
				const openerStart = records.find((r) => r.Kind === "action:start" && r.Name === "opener") as Extract<
					IRecord,
					{
						Kind: "action:start";
					}
				>;
				expect(openerStart.Args).toEqual([]);
				const startEffect = records.find((r) => r.Kind === "effect" && r.Type === "start") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>;
				expect(
					(
						startEffect.Descriptor as {
							Args: unknown[];
						}
					).Args
				).toEqual([]);

				await dispatch(runtime, midArray, undefined, 2);
				const midStart = journal.records().find((r) => r.Kind === "action:start" && r.Name === "midArray") as Extract<
					IRecord,
					{
						Kind: "action:start";
					}
				>;
				expect(midStart.Args).toEqual([
					undefined,
					2
				]);

				pinBarrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it("a start effect journals its target's ActionName in the normalized descriptor", async () => {
		await createRoot(async (dispose) => {
			try {
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => barrier.run());

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* childWrite(draft: ChildState, tag: string): IActionGenerator {
					draft.Data = tag;
				}
				function* parentStarts(_draft: TestState): IActionGenerator {
					yield* start(childWrite, "child-1", "tagged");
				}

				const pinPromise = dispatch(runtime, pin);
				await barrier.started;
				await dispatch(runtime, parentStarts);
				await new Promise((r) => setTimeout(r, 0));

				const startEffects = journal.records().filter((r) => r.Kind === "effect" && r.Type === "start") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>[];
				expect(startEffects.length).toBe(1);
				// toEqual, not toMatchObject: a leaked live Action reference must fail this.
				expect(startEffects[0].Descriptor).toEqual({
					Type: "start",
					EntityId: "child-1",
					ActionName: "childWrite",
					Args: [
						"tagged"
					]
				});

				expect(runtime.state.Children[0].Data).toBe("tagged");

				barrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it("a function in a publish payload is refused at the sender, naming the effect", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<TestState>(initialState(), {
					onError: () => {}
				});

				const publishData = publish as unknown as (topic: string, data: object) => Generator<any, void, any>;
				function* leaksAFunction(_draft: TestState): IActionGenerator {
					yield* publishData("Evil/Event", {
						Callback: () => {}
					});
				}

				await expect(dispatch(runtime, leaksAFunction)).rejects.toThrow(/publish: the input is not plain: function/);
			} finally {
				dispose();
			}
		});
	});

	it("journals normalized descriptors for start, parallel and parallelSettled", async () => {
		await createRoot(async (dispose) => {
			try {
				const barrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				const tailBarrier = createBarrier();
				runtime.registerImplementation("hang", () => barrier.run());
				runtime.registerImplementation("hang_tail", () => tailBarrier.run());
				runtime.registerImplementation("echo", () => "ok");

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* leg(_draft: TestState): Generator<any, string, any> {
					const v: string = yield {
						Type: "echo"
					};
					return v;
				}
				function* childWrite(draft: ChildState): IActionGenerator {
					draft.Data = "started";
				}
				function* usesEveryFiberEffect(draft: TestState): IActionGenerator {
					yield* parallel(leg(draft), leg(draft));
					yield* parallelSettled(leg(draft));
					yield* start(childWrite, "child-1");
					draft.Data = "fibers-done";
					yield {
						Type: "hang_tail"
					};
				}

				const pinPromise = dispatch(runtime, pin);
				await barrier.started;
				const fiberPromise = dispatch(runtime, usesEveryFiberEffect);
				await expect.poll(() => runtime.state.Data).toBe("fibers-done");
				await new Promise((r) => setTimeout(r, 0));

				const records = journal.records();
				const descriptorOf = (type: string) =>
					(
						records.find((r) => r.Kind === "effect" && r.Type === type) as Extract<
							IRecord,
							{
								Kind: "effect";
							}
						>
					).Descriptor;
				expect(descriptorOf("parallel")).toEqual({
					Type: "parallel",
					Branches: 2
				});
				expect(descriptorOf("parallelSettled")).toEqual({
					Type: "parallelSettled",
					Branches: 1
				});
				expect(descriptorOf("start")).toEqual({
					Type: "start",
					EntityId: "child-1",
					ActionName: "childWrite",
					Args: []
				});

				tailBarrier.resolve(undefined);
				barrier.resolve(undefined);
				await pinPromise;
				await fiberPromise;
			} finally {
				dispose();
			}
		});
	});

	it("fan-out settlements are owned clones, with parallelSettled's errors serialized to data", async () => {
		await createRoot(async (dispose) => {
			try {
				const pinBarrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => pinBarrier.run());

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* payloadWorker(): Generator<
					any,
					{
						Tag: string;
						Nested: {
							N: number;
						};
					},
					any
				> {
					return {
						Tag: "deep",
						Nested: {
							N: 1
						}
					};
				}
				function* voidWorker(): Generator<any, void, any> {}
				function* boomWorker(): Generator<any, never, any> {
					throw new Error("fiber exploded");
				}

				let joined:
					| {
							Tag: string;
							Nested: {
								N: number;
							};
					  }
					| undefined;
				function* act(draft: TestState): IActionGenerator {
					const [payload] = yield* parallelSettled(payloadWorker(), voidWorker(), boomWorker());
					joined = payload.ok ? payload.value : undefined;

					yield* parallel(payloadWorker(), payloadWorker());
					yield* parallel(voidWorker(), voidWorker());
					draft.Data = "done";
					yield {
						Type: "hang"
					};
				}

				const pinPromise = dispatch(runtime, pin);
				await pinBarrier.started;
				const actPromise = dispatch(runtime, act);
				await expect.poll(() => runtime.state.Data).toBe("done");

				joined!.Nested.N = 99;

				const records = journal.records();
				const settlementsOf = (type: string) =>
					records
						.filter((r) => r.Kind === "effect" && r.Type === type)
						.map(
							(e) =>
								records.find((r) => r.Kind === "response" && r.ForSeq === e.Seq) as {
									Value?: unknown;
									Error?: unknown;
								}
						);

				const [settledSettlement] = settlementsOf("parallelSettled");
				expect(settledSettlement.Value).toEqual([
					{
						Ok: true,
						Value: {
							Tag: "deep",
							Nested: {
								N: 1
							}
						}
					},
					{
						Ok: true
					},
					{
						Ok: false,
						Error: {
							Thrown: "error",
							Name: "Error",
							Message: "fiber exploded",
							Stack: expect.any(String)
						}
					}
				]);
				expect("Value" in (settledSettlement.Value as object[])[1]!).toBe(false);
				expect("Error" in settledSettlement).toBe(false);

				const [parallelSettlement, voidParallelSettlement] = settlementsOf("parallel");
				expect(parallelSettlement.Value).toEqual([
					{
						Tag: "deep",
						Nested: {
							N: 1
						}
					},
					{
						Tag: "deep",
						Nested: {
							N: 1
						}
					}
				]);
				expect(voidParallelSettlement.Value).toEqual([
					null,
					null
				]);

				pinBarrier.resolve(undefined);
				await pinPromise;
				await actPromise;
			} finally {
				dispose();
			}
		});
	});

	it("a generator-body throw after a settled effect journals one settlement and the step's writes", async () => {
		await createRoot(async (dispose) => {
			try {
				const pinBarrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {
					onError: () => {}
				});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => pinBarrier.run());
				runtime.registerImplementation("echo", () => "ok");

				const streamOrder: string[] = [];
				let echoSeq = 0;
				let actId = "";
				runtime.on("record", (record) => {
					if (
						record.Kind === "effect" &&
						(
							record.Descriptor as {
								Type?: string;
							}
						).Type === "echo"
					) {
						echoSeq = record.Seq;
						actId = record.ActionId;
						streamOrder.push("effect");
					} else if (record.Kind === "response" && record.ForSeq === echoSeq && echoSeq !== 0) {
						streamOrder.push("Error" in record ? "response(error)" : "response");
					} else if (record.Kind === "action:end" && record.ActionId === actId && actId !== "") {
						streamOrder.push(`action:end(${record.Status})`);
					}
				});

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* act(draft: TestState): IActionGenerator {
					const r: string = yield {
						Type: "echo"
					};
					draft.Data = `wrote-${r}`;
					throw new Error("body boom");
				}

				const pinPromise = dispatch(runtime, pin);
				await pinBarrier.started;
				await expect(dispatch(runtime, act)).rejects.toThrow("body boom");

				const records = journal.records();
				const echoEffect = records.find((r) => r.Kind === "effect" && r.Type === "echo") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>;
				const settlements = records.filter((r) => r.Kind === "response" && r.ForSeq === echoEffect.Seq);
				expect(settlements.length).toBe(1);
				expect((settlements[0] as Record<string, unknown>).Value).toBe("ok");
				const steps = records.filter((r) => r.Kind === "step" && r.ActionId === echoEffect.ActionId) as Extract<
					IRecord,
					{
						Kind: "step";
					}
				>[];
				expect(steps.some((s) => s.Changes.some((c) => c.Path.join(".") === "Data"))).toBe(true);
				expect(runtime.state.Data).toBe("wrote-ok");
				const end = records.find((r) => r.Kind === "action:end" && r.ActionId === echoEffect.ActionId) as Extract<
					IRecord,
					{
						Kind: "action:end";
					}
				>;
				expect(end.Status).toBe("errored");
				expect(streamOrder).toEqual([
					"effect",
					"response",
					"action:end(errored)"
				]);

				pinBarrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it("a throwing first step still journals its writes", async () => {
		await createRoot(async (dispose) => {
			try {
				const pinBarrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {
					onError: () => {}
				});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => pinBarrier.run());

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* act(draft: TestState): IActionGenerator {
					draft.Count = 7;
					throw new Error("init boom");
				}

				const pinPromise = dispatch(runtime, pin);
				await pinBarrier.started;
				await expect(dispatch(runtime, act)).rejects.toThrow("init boom");

				expect(runtime.state.Count).toBe(7);
				const records = journal.records();
				const start = records.find((r) => r.Kind === "action:start" && r.Name === "act") as Extract<
					IRecord,
					{
						Kind: "action:start";
					}
				>;
				const steps = records.filter((r) => r.Kind === "step" && r.ActionId === start.ActionId) as Extract<
					IRecord,
					{
						Kind: "step";
					}
				>[];
				expect(steps.some((s) => s.Changes.some((c) => c.Path.join(".") === "Count"))).toBe(true);
				const end = records.find((r) => r.Kind === "action:end" && r.ActionId === start.ActionId) as Extract<
					IRecord,
					{
						Kind: "action:end";
					}
				>;
				expect(end.Status).toBe("errored");

				pinBarrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it('non-fiber responses are owned clones, and a returns: "module" settlement records what survives', async () => {
		await createRoot(async (dispose) => {
			try {
				const pinBarrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => pinBarrier.run());
				runtime.registerImplementation("echoObj", () => ({
					Count: 1
				}));
				defineEffect<
					{
						Type: "journal/liveThing";
					},
					unknown
				>("journal/liveThing", {
					returns: "module"
				});
				runtime.registerImplementation("journal/liveThing", () => () => {});

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* act(draft: TestState): IActionGenerator {
					const r: {
						Count: number;
					} = yield {
						Type: "echoObj"
					};
					// Mutates the received response in place to probe the recorded clone.
					r.Count++;
					draft.Count = r.Count;
					yield {
						Type: "journal/liveThing"
					};
				}

				const pinPromise = dispatch(runtime, pin);
				await pinBarrier.started;
				await dispatch(runtime, act);

				expect(runtime.state.Count).toBe(2);
				const records = journal.records();
				const echoEffect = records.find((r) => r.Kind === "effect" && r.Type === "echoObj") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>;
				const echoSettlement = records.find((r) => r.Kind === "response" && r.ForSeq === echoEffect.Seq) as Record<string, unknown>;
				expect(echoSettlement.Value).toEqual({
					Count: 1
				});
				const liveEffect = records.find((r) => r.Kind === "effect" && r.Type === "journal/liveThing") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>;
				const liveSettlement = records.find((r) => r.Kind === "response" && r.ForSeq === liveEffect.Seq) as Record<string, unknown>;
				expect(liveSettlement).toBeDefined();
				expect(liveSettlement.Value).toBeUndefined();

				pinBarrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it("a long-lived action's body narrates like every other action's — and is never stored", async () => {
		await createRoot(async (dispose) => {
			try {
				const pinBarrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => pinBarrier.run());
				runtime.registerImplementation("echo", () => "ok");

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* daemon(draft: TestState): IActionGenerator {
					const r: string = yield {
						Type: "echo"
					};
					draft.Data = r;
					yield* (function* (): IActionGenerator {
						draft.Count = 41;
						const inner: string = yield {
							Type: "echo"
						};
						draft.Count = inner.length + 40;
					})();
				}

				const pinPromise = dispatch(runtime, pin);
				await pinBarrier.started;
				await dispatch(runtime, daemon);

				const records = journal.records();
				const start = records.find((r) => r.Kind === "action:start" && r.Name === "daemon") as Extract<
					IRecord,
					{
						Kind: "action:start";
					}
				>;
				const bodySteps = records.filter((r) => r.Kind === "step" && r.ActionId === start.ActionId) as Extract<
					IRecord,
					{
						Kind: "step";
					}
				>[];
				const writtenPaths = bodySteps.flatMap((s) => s.Changes.map((c) => c.Path.join(".")));
				expect(writtenPaths).toContain("Data");
				expect(writtenPaths.filter((p) => p === "Count").length).toBe(2);
				const bodyEffects = records.filter((r) => r.Kind === "effect" && r.ActionId === start.ActionId);
				expect(bodyEffects.length).toBe(2);
				const effectSeqs = new Set(bodyEffects.map((r) => r.Seq));
				const bodyResponses = records.filter(
					(r) =>
						r.Kind === "response" &&
						effectSeqs.has(
							(
								r as {
									ForSeq: number;
								}
							).ForSeq
						)
				);
				expect(bodyResponses.length).toBe(2);
				expect(runtime.state.Data).toBe("ok");
				expect(runtime.state.Count).toBe(42);

				const inFlight = (runtime as IRuntimeInternal<TestState>).get("runtime/inFlightActions");
				expect(inFlight().filter((r) => r.ActionId === start.ActionId)).toEqual([]);
				expect(inFlight().length).toBe(1);

				pinBarrier.resolve(undefined);
				await pinPromise;
				expect(inFlight()).toEqual([]);
			} finally {
				dispose();
			}
		});
	});

	it("redacted effects journal Type only — no descriptor payload, no settlement payload", async () => {
		await createRoot(async (dispose) => {
			try {
				const pinBarrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => pinBarrier.run());
				defineEffect("readSession" as never, {
					redact: true
				});
				runtime.registerImplementation("readSession", () => ({
					Token: "SECRET-RESPONSE-TOKEN",
					Expires: "2026-10-26T00:00:00.000Z"
				}));

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* login(draft: TestState): IActionGenerator {
					const session: {
						Token: string;
					} = yield {
						Type: "readSession",
						Token: "SECRET-DESCRIPTOR-TOKEN"
					};
					draft.Data = session.Token === "SECRET-RESPONSE-TOKEN" ? "authed" : "broken";
				}

				const pinPromise = dispatch(runtime, pin);
				await pinBarrier.started;
				await dispatch(runtime, login);

				const records = journal.records();
				const effect = records.find((r) => r.Kind === "effect" && r.Type === "readSession") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>;
				expect(effect.Descriptor).toEqual({
					Type: "readSession"
				});
				const settlement = records.find((r) => r.Kind === "response" && r.ForSeq === effect.Seq);
				expect(settlement).toBeDefined();
				expect(settlement).not.toHaveProperty("Value");
				expect(settlement).not.toHaveProperty("Error");
				const serialized = JSON.stringify(records);
				expect(serialized).not.toContain("SECRET-DESCRIPTOR-TOKEN");
				expect(serialized).not.toContain("SECRET-RESPONSE-TOKEN");
				expect(runtime.state.Data).toBe("authed");

				pinBarrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});

	it("an effect that resolves after its action was cancelled settles nothing", async () => {
		await createRoot(async (dispose) => {
			try {
				const pinBarrier = createBarrier();
				const childBarrier = createBarrier();
				const runtime = createRuntime<TestState>(initialState(), {
					onError: () => {}
				});
				const journal = await grabJournal(runtime);
				runtime.registerImplementation("hang", () => pinBarrier.run());
				runtime.registerImplementation("hang_child", () => childBarrier.run());

				function* pin(_draft: TestState) {
					yield* open(hang());
				}
				function* childAction(_draft: ChildState): IActionGenerator {
					yield {
						Type: "hang_child"
					};
				}
				function* clearChildren(draft: TestState): IActionGenerator {
					draft.Children = [];
				}

				const pinPromise = dispatch(runtime, pin);
				await pinBarrier.started;

				const childSetState = sliceSetState(rootSetState(runtime), (x: TestState) => x.Children[0]);
				const childPromise = runtime.processAction(
					childAction,
					(() => runtime.state) as any,
					childSetState,
					() => runtime.state.Children[0]?.$Id ?? ""
				);
				await childBarrier.started;

				await dispatch(runtime, clearChildren);
				childBarrier.resolve("late");
				await childPromise;

				const records = journal.records();
				const childEffect = records.find((r) => r.Kind === "effect" && r.Type === "hang_child") as Extract<
					IRecord,
					{
						Kind: "effect";
					}
				>;
				expect(records.filter((r) => r.Kind === "response" && r.ForSeq === childEffect.Seq)).toEqual([]);
				expect(records).toContainEqual(
					expect.objectContaining({
						Kind: "action:end",
						ActionId: childEffect.ActionId,
						Status: "cancelled"
					})
				);

				pinBarrier.resolve(undefined);
				await pinPromise;
			} finally {
				dispose();
			}
		});
	});
});

describe("createJournal: the record tap", () => {
	it("notifies tap subscribers on every append, with Seq already stamped", () => {
		const journal = createJournal();
		const seen: {
			kind: string;
			seq: number;
		}[] = [];
		journal.tap((record) =>
			seen.push({
				kind: record.Kind,
				seq: record.Seq
			})
		);
		journal.append(startRecord("a"));
		journal.append(endRecord("a"));
		expect(seen).toEqual([
			{
				kind: "action:start",
				seq: 1
			},
			{
				kind: "action:end",
				seq: 2
			}
		]);
	});

	it("is enabled exactly while a tap is subscribed", () => {
		const journal = createJournal();
		expect(journal.enabled).toBe(false);
		const kinds: string[] = [];
		const off = journal.tap((record) => kinds.push(record.Kind));
		expect(journal.enabled).toBe(true);

		journal.append(startRecord("a"));
		journal.append(stepRecord("a"));
		journal.append(endRecord("a"));

		expect(kinds).toEqual([
			"action:start",
			"step",
			"action:end"
		]);

		off();
		expect(journal.enabled).toBe(false);
	});

	it("passes the live extras through, unstored", () => {
		const journal = createJournal();
		const seen: unknown[] = [];
		const appended: IRecord[] = [];
		journal.tap((record, live) => {
			appended.push(record as IRecord);
			seen.push(live);
		});
		const boom = new Error("boom");
		journal.append(startRecord("a"));
		journal.append(endRecord("a"), {
			error: boom,
			duration: 5
		});
		expect(seen).toEqual([
			undefined,
			{
				error: boom,
				duration: 5
			}
		]);
		for (const record of appended) {
			expect("error" in record).toBe(false);
			expect("duration" in record).toBe(false);
		}
	});

	it("a throwing subscriber is isolated — siblings and the producer are unharmed", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const journal = createJournal();
			const survivor: string[] = [];
			journal.tap(() => {
				throw new Error("subscriber failure");
			});
			journal.tap((record) => survivor.push(record.Kind));

			expect(() => journal.append(startRecord("a"))).not.toThrow();
			expect(survivor).toEqual([
				"action:start"
			]);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("unsubscribing during a notification does not skip siblings", () => {
		const journal = createJournal();
		const calls: string[] = [];
		const offA = journal.tap(() => {
			calls.push("a");
			offA();
		});
		journal.tap(() => calls.push("b"));
		journal.append(startRecord("a"));
		expect(calls).toEqual([
			"a",
			"b"
		]);
		journal.append(endRecord("a"));
		expect(calls).toEqual([
			"a",
			"b",
			"b"
		]);
	});
});

describe("action names", () => {
	it("journals a named function's own name, and null for an anonymous one", async () => {
		await createRoot(async (dispose) => {
			try {
				const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
				const runtime = createRuntime<TestState>(initialState(), {});
				const journal = await grabJournal(runtime);

				function* named(draft: TestState): IActionGenerator {
					draft.Data = "ran";
				}
				await dispatch(runtime, named);
				expect(runtime.state.Data).toBe("ran");
				// Inline on purpose: binding it to a const would give it a name.
				await dispatch(runtime, function* (draft: TestState): IActionGenerator {
					draft.Data = "ran too";
				});
				expect(runtime.state.Data).toBe("ran too");

				const starts = journal.records().filter((r) => r.Kind === "action:start") as Extract<
					IRecord,
					{
						Kind: "action:start";
					}
				>[];
				expect(starts.map((r) => r.Name)).toEqual([
					"named",
					null
				]);
				expect(warn).not.toHaveBeenCalled();
			} finally {
				dispose();
			}
		});
	});
});
