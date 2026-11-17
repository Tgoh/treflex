import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IAskId } from "../../src/Types/IAskId";
import type { IRecord } from "../../src/Types/IRecord";
import type { IResourceContext } from "../../src/Types/IResource";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answer } from "../../src/Effects/answer";
import { ask } from "../../src/Effects/ask";
import { entity } from "../../src/Effects/entity";
import { openResource } from "../../src/Effects/openResource";
import { parallel } from "../../src/Effects/parallel";
import { parallelSettled } from "../../src/Effects/parallelSettled";
import { start } from "../../src/Effects/start";
import { latest } from "../../src/Runtime/arrivalPolicy";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import { pendingAsks } from "../../src/Runtime/pendingAsks";
import { HOLD_WARN_MS } from "../../src/Runtime/processAction";
import { wrapSetState } from "../../src/Runtime/sliceSetState";
import { transient } from "../../src/Runtime/transient";
import { rawOf } from "../../src/Runtime/viewProxy";
import { settled } from "../../src/Testing/createTestRuntime";
import { minted, pendingAsksOf, rootSetState } from "../testHelpers";

declare module "../../src/Registries/IResourceRegistry" {
	interface IResourceTypeRegistry {
		"gate/quiet": {
			Params: {
				Label: string;
			};
			Methods: {
				ping(): string;
			};
		};
	}
	interface IResourceRegistry {
		"Gate/Quiet": {
			Type: "gate/quiet";
		};
	}
}

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

function build(options?: { onError?: (error: unknown) => void }) {
	const runtime = createRuntime<IRoot>(seed(), {
		onError: options?.onError ?? (() => {})
	});
	const internal = runtime as IRuntimeInternal<IRoot>;
	const releases = new Map<string, (value?: unknown) => void>();
	runtime.registerImplementation(
		"test/wait",
		(effect: { Type: string; Name: string }) =>
			new Promise((resolve) => {
				releases.set(effect.Name, resolve);
			})
	);
	const release = (name: string, value?: unknown): void => {
		const resolve = releases.get(name);
		if (!resolve) {
			throw new Error(`nothing waits on "${name}"`);
		}
		releases.delete(name);
		resolve(value);
	};
	const records: IRecord[] = [];
	runtime.on("record", (record) => records.push(record));
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	const starts = (name: string) => records.filter((r) => r.Kind === "action:start" && r.Name === name);
	const endOf = (actionId: string) => records.find((r) => r.Kind === "action:end" && r.ActionId === actionId);
	return {
		runtime,
		internal,
		release,
		releases,
		records,
		diags,
		codes: () => diags.map((d) => d.code),
		starts,
		endOf,
		inFlight: () =>
			internal
				.get("runtime/inFlightActions")()
				.map((a) => a.Name)
	};
}

function* wait(name: string): Generator<any, unknown, any> {
	return yield {
		Type: "test/wait",
		Name: name
	};
}

function* mark(draft: IRoot, text: string): IActionGenerator<string> {
	draft.Log.push(text);
	return text;
}

function* slow(draft: IRoot): IActionGenerator {
	draft.Log.push("slow:start");
	yield* wait("slow");
	draft.Log.push("slow:end");
}

function* markRow(draft: IRow, text: string): IActionGenerator<string> {
	draft.Log.push(text);
	return text;
}

function* slowRow(draft: IRow): IActionGenerator {
	yield* wait("row");
	draft.Log.push("row:late");
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("the gate: one queue per entity", () => {
	it("starts work on a free entity before the dispatch returns, and a finished action holds for no microtask", async () => {
		const w = build();
		const a = w.runtime.dispatch(mark, "root", "a");
		const b = w.runtime.dispatch(mark, "root", "b");
		expect(w.runtime.state.Log).toEqual([
			"a",
			"b"
		]);
		await Promise.all([
			a,
			b
		]);
	});

	it("queues work on a held entity in arrival order, through every wait of the holder", async () => {
		const w = build();
		const a = w.runtime.dispatch(slow, "root");
		const b = w.runtime.dispatch(mark, "root", "b");
		const c = w.runtime.dispatch(mark, "root", "c");
		await settled();
		expect(w.runtime.state.Log).toEqual([
			"slow:start"
		]);
		w.release("slow");
		expect(await b).toBe("b");
		expect(await c).toBe("c");
		await a;
		expect(w.runtime.state.Log).toEqual([
			"slow:start",
			"slow:end",
			"b",
			"c"
		]);
	});

	it("leaves another entity free, a child of the held one included", async () => {
		const w = build();
		const a = w.runtime.dispatch(slow, "root");
		const b = w.runtime.dispatch(markRow, "row-1", "row");
		expect(w.runtime.state.Rows[0]!.Log).toEqual([
			"row"
		]);
		await b;
		w.release("slow");
		await a;
	});

	it("records queued work at arrival: its id, its arguments as they were, and an InFlight row", async () => {
		const w = build();
		function* note(
			draft: IRoot,
			arg: {
				Text: string;
			}
		): IActionGenerator {
			draft.Log.push(arg.Text);
		}
		const a = w.runtime.dispatch(slow, "root");
		const arg = {
			Text: "first"
		};
		const b = w.runtime.dispatch(note, "root", arg);
		arg.Text = "changed";
		const [start] = w.starts("note");
		expect(start).toMatchObject({
			Args: [
				{
					Text: "first"
				}
			]
		});
		expect(w.inFlight()).toEqual([
			"slow",
			"note"
		]);
		w.release("slow");
		await Promise.all([
			a,
			b
		]);
		expect(w.runtime.state.Log).toEqual([
			"slow:start",
			"slow:end",
			"first"
		]);
		expect(w.inFlight()).toEqual([]);
	});

	it("runs a start on the starter's own entity after the starter, and keeps its StartedBy", async () => {
		const w = build();
		function* starter(draft: IRoot): IActionGenerator {
			yield* start(mark, "root", "started");
			draft.Log.push("starter:end");
		}
		await w.runtime.dispatch(starter, "root");
		await settled();
		expect(w.runtime.state.Log).toEqual([
			"starter:end",
			"started"
		]);
		const [starterStart] = w.starts("starter");
		const [startedStart] = w.starts("mark");
		expect(startedStart).toMatchObject({
			StartedBy: (
				starterStart as {
					ActionId: string;
				}
			).ActionId
		});
	});

	it("starts a queued action after the holder's last step has drained, so its start finds a row that step pushed", async () => {
		const w = build();
		const row = minted("added", {
			Log: [] as string[]
		});
		function* addRow(draft: IRoot): IActionGenerator {
			yield* wait("add");
			draft.Rows.push(row);
		}
		function* startOnRow(_draft: IRoot): IActionGenerator {
			yield* start(markRow, row.$Id, "hello");
		}
		const a = w.runtime.dispatch(addRow, "root");
		const b = w.runtime.dispatch(startOnRow, "root");
		w.release("add");
		await Promise.all([
			a,
			b
		]);
		await settled();
		expect(w.codes()).not.toContain("dispatch/unresolved-entity");
		expect(w.runtime.state.Rows[1]!.Log).toEqual([
			"hello"
		]);
	});

	it("runs parallel and parallelSettled branches under the root's hold", async () => {
		const w = build();
		function* branchy(draft: IRoot): IActionGenerator {
			yield* parallel(
				(function* () {
					yield* wait("p1");
					draft.Log.push("p1");
				})(),
				(function* () {
					yield* wait("p2");
					draft.Log.push("p2");
				})()
			);
			yield* parallelSettled(
				(function* () {
					yield* wait("s");
					draft.Log.push("s");
				})()
			);
			draft.Log.push("root:end");
		}
		const a = w.runtime.dispatch(branchy, "root");
		const b = w.runtime.dispatch(mark, "root", "after");
		await settled();
		w.release("p1");
		w.release("p2");
		await settled();
		w.release("s");
		await Promise.all([
			a,
			b
		]);
		expect(w.runtime.state.Log).toEqual([
			"p1",
			"p2",
			"s",
			"root:end",
			"after"
		]);
	});

	it("holds past a stopped root until its branch has closed, so the branch's finally writes under it", async () => {
		const w = build();
		const branchy = latest(function* branchy(draft: IRoot, name: string): IActionGenerator {
			if (name === "first") {
				yield* parallel(
					(function* () {
						try {
							yield* wait("never");
						} finally {
							draft.Log.push("left:finally");
						}
					})()
				);
			}
			draft.Log.push(name);
		});
		const a = w.runtime.dispatch(branchy, "root", "first");
		await settled();
		const b = w.runtime.dispatch(mark, "root", "after");
		const c = w.runtime.dispatch(branchy, "root", "second");
		await Promise.all([
			a,
			b,
			c
		]);
		expect(w.runtime.state.Log).toEqual([
			"left:finally",
			"after",
			"second"
		]);
	});
});

describe("the gate: ending work", () => {
	it("releases a holder that fails", async () => {
		const w = build();
		function* failing(_draft: IRoot): IActionGenerator {
			yield* wait("fail");
			throw new Error("boom");
		}
		const a = w.runtime.dispatch(failing, "root");
		const b = w.runtime.dispatch(mark, "root", "after");
		w.release("fail");
		await expect(a).rejects.toThrow("boom");
		expect(await b).toBe("after");
	});

	it("clears the queue when the entity leaves the tree: queued callers resolve undefined and their work never runs", async () => {
		const w = build();
		let ran = false;
		function* queued(_draft: IRow): IActionGenerator<string> {
			ran = true;
			return "ran";
		}
		function* dropRows(draft: IRoot): IActionGenerator {
			draft.Rows = [];
		}
		const a = w.runtime.dispatch(slowRow, "row-1");
		const b = w.runtime.dispatch(queued, "row-1");
		await w.runtime.dispatch(dropRows, "root");
		expect(await b).toBeUndefined();
		expect(await a).toBeUndefined();
		expect(ran).toBe(false);
		const [start] = w.starts("queued");
		expect(
			w.endOf(
				(
					start as {
						ActionId: string;
					}
				).ActionId
			)
		).toMatchObject({
			Status: "cancelled"
		});
		expect(w.inFlight()).toEqual([]);
	});
});

describe("the gate: what it keys on", () => {
	it("queues work whose id accessor gives no id behind the nearest entity above its node", async () => {
		const w = build();
		function* typeName(
			draft: {
				Name: string;
			},
			name: string
		): IActionGenerator {
			draft.Name = name;
		}
		const formSetState = wrapSetState(rawOf(w.runtime.state).Form, w.internal.get("runtime/writeGateway"));
		const a = w.runtime.dispatch(slow, "root");
		const b = w.runtime.processAction(
			typeName,
			() => w.runtime.state.Form,
			formSetState,
			() => undefined as unknown as string,
			"typed"
		);
		await settled();
		expect(w.runtime.state.Form.Name).toBe("");
		w.release("slow");
		await Promise.all([
			a,
			b
		]);
		expect(w.runtime.state.Form.Name).toBe("typed");
	});

	it("stops work whose id accessor gives no id when the entity above its node is removed", async () => {
		type IForm = {
			Name: string;
		};
		type IFormRow = {
			$Id: string;
			Form: IForm;
		};
		const errors: unknown[] = [];
		const runtime = createRuntime<{
			$Id: string;
			Rows: IFormRow[];
		}>(
			{
				$Id: "root",
				Rows: [
					minted("row-1", {
						Form: {
							Name: ""
						}
					})
				]
			},
			{
				onError: (error) => errors.push(error)
			}
		);
		const internal = runtime as IRuntimeInternal<{
			$Id: string;
			Rows: IFormRow[];
		}>;
		const releases: ((value?: unknown) => void)[] = [];
		runtime.registerImplementation(
			"test/wait",
			() =>
				new Promise((resolve) => {
					releases.push(resolve);
				})
		);
		const log: string[] = [];
		function* typeLate(draft: IForm): IActionGenerator {
			try {
				yield* wait("form");
				draft.Name = "late";
			} finally {
				log.push("finally");
			}
		}
		const typing = runtime.processAction(
			typeLate,
			() => runtime.state.Rows[0].Form,
			wrapSetState(rawOf(runtime.state).Rows[0].Form, internal.get("runtime/writeGateway")),
			() => undefined as unknown as string
		);
		await settled();
		const inFlight = () =>
			internal
				.get("runtime/inFlightActions")()
				.map((a) => a.Name);
		expect(inFlight()).toEqual([
			"typeLate"
		]);
		await runtime.dispatch(function* removesRows(draft: { $Id: string; Rows: IFormRow[] }): IActionGenerator {
			draft.Rows = [];
		}, "root");
		await settled();
		expect(log).toEqual([
			"finally"
		]);
		expect(inFlight()).toEqual([]);
		releases[0]?.();
		expect(await typing).toBeUndefined();
		await settled();
		expect(errors).toEqual([]);
	});

	it("addresses an ask's refusals by the entity the gate holds, for an action on a form with no id", async () => {
		type IForm = {
			Name: string;
		};
		type IFormRow = {
			$Id: string;
			Form: IForm;
		};
		type IFormRoot = {
			$Id: string;
			Rows: IFormRow[];
			Answer: string | null;
		};
		const runtime = createRuntime<IFormRoot>(
			{
				$Id: "root",
				Rows: [
					minted("row-1", {
						Form: {
							Name: ""
						}
					})
				],
				Answer: null
			},
			{
				onError: () => {}
			}
		);
		const internal = runtime as IRuntimeInternal<IFormRoot>;
		const onForm = <A extends any[]>(action: (draft: IForm, ...args: A) => IActionGenerator, ...args: A) =>
			runtime.processAction(
				action,
				() => runtime.state.Rows[0].Form,
				wrapSetState(rawOf(runtime.state).Rows[0].Form, internal.get("runtime/writeGateway")),
				() => undefined as unknown as string,
				...args
			);
		function* asksOnItsRow(_draft: IForm): IActionGenerator {
			yield* ask<string>("~row-1", {
				Path: "Row"
			});
		}
		await expect(onForm(asksOnItsRow)).rejects.toMatchObject({
			name: "AskRefusedError",
			reason: "outside-open",
			ownerId: "~row-1",
			entityId: "~row-1"
		});
		function* asker(draft: IFormRoot) {
			draft.Answer =
				(yield* open(
					ask<string>("~row-1", {
						Path: "Row"
					})
				)) ?? null;
		}
		const asking = runtime.dispatch(asker, "root");
		await settled();
		function* answersFromForm(_draft: IForm, id: IAskId<string>): IActionGenerator {
			yield* answer(id, "from the form");
		}
		await onForm(answersFromForm, pendingAsksOf(runtime, runtime.state)[0]!.Id as IAskId<string>);
		await asking;
		expect(runtime.state.Answer).toBe("from the form");
		runtime.dispose();
	});

	it("lets r.run through on its owner while the owner is held", async () => {
		const w = build();
		let ctx!: IResourceContext<"gate/quiet">;
		w.runtime.registerResourceType("gate/quiet", (_params, r) => {
			ctx = r;
		});
		w.runtime.registerImplementation("test/echo", (effect: { Type: string; Text: string }) => effect.Text);
		function* open(draft: IRoot): IActionGenerator {
			yield* openResource(draft, "Gate/Quiet", {
				Type: "gate/quiet",
				Label: "a"
			});
		}
		await w.runtime.dispatch(open, "root");
		await settled();
		const a = w.runtime.dispatch(slow, "root");
		function* echo(): Generator<any, string, any> {
			return yield {
				Type: "test/echo",
				Text: "through"
			};
		}
		expect(await ctx.run(echo())).toBe("through");
		w.release("slow");
		await a;
	});
});

describe("the gate: a wait on work queued behind its own hold", () => {
	it("leaves an effect waiting on a dispatch queued behind the hold stuck, and the long-hold warning names it", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout"
			]
		});
		const w = build();
		w.runtime.registerImplementation("test/callSelf", (_effect, action) =>
			action!.processAction(
				mark,
				() => w.runtime.state,
				rootSetState(w.runtime),
				() => "root",
				"inner"
			)
		);
		function* caller(_draft: IRoot): IActionGenerator {
			yield {
				Type: "test/callSelf"
			};
		}
		const calling = w.runtime.dispatch(caller, "root");
		await settled();
		vi.advanceTimersByTime(HOLD_WARN_MS);
		expect(w.runtime.state.Log).toEqual([]);
		expect(w.diags.filter((d) => d.code === "action/long-hold")).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({
					holder: "caller",
					waitingOn: [
						"test/callSelf"
					],
					queued: [
						"mark"
					]
				})
			})
		]);
		w.runtime.dispose();
		await calling;
	});

	it("takes the answer from an answerer on the ask's owner while the asker waits inside open(...)", async () => {
		const w = build();
		function* answerer(draft: IRow): IActionGenerator {
			yield* answer((yield* pendingAsks(draft))[0]!.Id as IAskId<string>, "hi");
		}
		function* toChild(draft: IRoot) {
			const value = yield* open(
				ask<string>(draft.Rows[0]!, {
					Path: "Child"
				})
			);
			draft.Log.push(`child:${value}`);
		}
		const asking = w.runtime.dispatch(toChild, "root");
		await settled();
		await w.runtime.dispatch(answerer, "row-1");
		await asking;
		await settled();
		expect(w.runtime.state.Log).toEqual([
			"child:hi"
		]);
		expect(w.codes()).toEqual([]);
	});

	it("refuses an ask that would wait holding the entity, whatever its owner, so no answer can queue behind its hold", async () => {
		const w = build();
		function* asker(draft: IRoot, onRow: boolean) {
			draft.Log.push(
				`answer:${yield* ask<string>(onRow ? draft.Rows[0]! : draft, {
					Path: "Held"
				})}`
			);
		}
		for (const onRow of [
			false,
			true
		]) {
			await expect(w.runtime.dispatch(asker, "root", onRow)).rejects.toMatchObject({
				name: "AskRefusedError",
				entityId: "root"
			});
		}
		expect(w.runtime.state.Log).toEqual([]);
		expect(w.records.filter((r) => r.Kind === "table" && r.Table === "asks")).toHaveLength(0);
	});
});

describe("the gate: a long hold", () => {
	it("warns once a hold has had work queued behind it past the threshold, naming the holder, its wait and the queue", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout"
			]
		});
		const w = build();
		const a = w.runtime.dispatch(slow, "root");
		vi.advanceTimersByTime(HOLD_WARN_MS * 2);
		expect(w.codes()).not.toContain("action/long-hold");
		const b = w.runtime.dispatch(mark, "root", "queued");
		vi.advanceTimersByTime(HOLD_WARN_MS - 1);
		expect(w.codes()).not.toContain("action/long-hold");
		vi.advanceTimersByTime(1);
		expect(w.diags.filter((d) => d.code === "action/long-hold")).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({
					entityId: "root",
					holder: "slow",
					waitingOn: [
						"test/wait"
					],
					queued: [
						"mark"
					]
				})
			})
		]);
		w.release("slow");
		await Promise.all([
			a,
			b
		]);
	});

	it("warns when a run takes its hold back with work queued behind it", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout"
			]
		});
		const w = build();
		function* sendAndConfirm(draft: IRoot) {
			yield* open(wait("send"));
			yield* wait("confirm");
			draft.Log.push("confirmed");
		}
		const a = w.runtime.dispatch(sendAndConfirm, "root");
		await settled();
		const b = w.runtime.dispatch(slow, "root");
		await settled();
		w.release("send");
		await settled();
		const c = w.runtime.dispatch(mark, "root", "queued");
		w.release("slow");
		await settled();
		vi.advanceTimersByTime(HOLD_WARN_MS);
		expect(w.diags.filter((d) => d.code === "action/long-hold")).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({
					holder: "sendAndConfirm",
					waitingOn: [
						"test/wait"
					],
					queued: [
						"mark"
					]
				})
			})
		]);
		w.release("confirm");
		await Promise.all([
			a,
			b,
			c
		]);
	});

	it("lets a feed through while an ask waits inside open, and warns once for the slow held wait after it", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout"
			]
		});
		const w = build();
		function* asksThenLoads(draft: IRoot) {
			const value = yield* open(
				ask<string>(draft.Rows[0]!, {
					Path: "Feed"
				})
			);
			draft.Log.push(`answer:${value}`);
			yield* wait("load");
		}
		function* answers(_draft: IRow, id: IAskId<string>): IActionGenerator {
			yield* answer(id, "yes");
		}
		const a = w.runtime.dispatch(asksThenLoads, "root");
		await settled();
		for (let n = 0; n < 2; n++) {
			await w.runtime.dispatch(mark, "root", `fed:${n}`);
			vi.advanceTimersByTime(HOLD_WARN_MS);
		}
		expect(w.codes()).not.toContain("action/long-hold");
		await w.runtime.dispatch(answers, "row-1", pendingAsksOf(w.runtime, w.runtime.state)[0]!.Id as IAskId<string>);
		await settled();
		expect(w.runtime.state.Log).toEqual([
			"fed:0",
			"fed:1",
			"answer:yes"
		]);
		const fed = w.runtime.dispatch(mark, "root", "fed:2");
		vi.advanceTimersByTime(HOLD_WARN_MS * 3);
		expect(w.diags.filter((d) => d.code === "action/long-hold").map((d) => d.data)).toEqual([
			{
				entityId: "root",
				holder: "asksThenLoads",
				holderId: expect.any(String),
				waitingOn: [
					"test/wait"
				],
				queued: [
					"mark"
				]
			}
		]);
		w.release("load");
		await Promise.all([
			a,
			fed
		]);
	});

	describe("warns once for each wait the hold sits in", () => {
		function timed(w: ReturnType<typeof build>) {
			w.runtime.registerImplementation(
				"test/tick",
				(effect: { Type: string; Ms: number }) =>
					new Promise<void>((resolve) => {
						setTimeout(resolve, effect.Ms);
					})
			);
		}
		function* tick(ms: number): Generator<any, void, any> {
			yield {
				Type: "test/tick",
				Ms: ms
			};
		}
		const longHolds = (w: ReturnType<typeof build>) => w.diags.filter((d) => d.code === "action/long-hold").map((d) => d.data);

		beforeEach(() => {
			vi.useFakeTimers({
				toFake: [
					"setTimeout",
					"clearTimeout"
				]
			});
		});

		it("once for a held loop of short waits", async () => {
			const w = build();
			timed(w);
			function* loops(): IActionGenerator {
				for (let n = 0; n < 12; n++) {
					yield* tick(500);
				}
			}
			const a = w.runtime.dispatch(loops, "root");
			const b = w.runtime.dispatch(mark, "root", "queued");
			await vi.advanceTimersByTimeAsync(6000);
			await Promise.all([
				a,
				b
			]);
			expect(longHolds(w)).toEqual([
				expect.objectContaining({
					waitingOn: [
						"test/tick"
					]
				})
			]);
		});

		it("once for a held loop of waits each longer than the threshold", async () => {
			const w = build();
			timed(w);
			function* loops(): IActionGenerator {
				for (let n = 0; n < 8; n++) {
					yield* tick(1500);
				}
			}
			const a = w.runtime.dispatch(loops, "root");
			const b = w.runtime.dispatch(mark, "root", "queued");
			await vi.advanceTimersByTimeAsync(12_000);
			await Promise.all([
				a,
				b
			]);
			expect(longHolds(w)).toHaveLength(1);
		});

		it("once for a stuck branch beside a ticking one", async () => {
			const w = build();
			timed(w);
			function* ticker(): Generator<any, void, any> {
				for (;;) {
					yield* tick(300);
				}
			}
			function* both(_draft: IRoot): IActionGenerator {
				yield* parallel(wait("stuck"), ticker());
			}
			const a = w.runtime.dispatch(both, "root");
			const b = w.runtime.dispatch(mark, "root", "queued");
			await vi.advanceTimersByTimeAsync(6000);
			expect(longHolds(w)).toEqual([
				expect.objectContaining({
					waitingOn: [
						"parallel",
						"test/wait",
						"test/tick"
					]
				})
			]);
			w.runtime.dispose();
			await Promise.all([
				a,
				b
			]);
		});

		it("once for a stuck branch beside two loops that re-create their fibers at different rates", async () => {
			const w = build();
			timed(w);
			w.runtime.registerImplementation(
				"test/beat",
				(effect: { Type: string; Ms: number }) =>
					new Promise<void>((resolve) => {
						setTimeout(resolve, effect.Ms);
					})
			);
			function* beat(ms: number): Generator<any, void, any> {
				yield {
					Type: "test/beat",
					Ms: ms
				};
			}
			function* loopA(): Generator<any, void, any> {
				for (;;) {
					yield* parallel(tick(300));
				}
			}
			function* loopB(): Generator<any, void, any> {
				for (;;) {
					yield* parallel(beat(700));
				}
			}
			function* stalls(_draft: IRoot): IActionGenerator {
				yield* parallel(wait("stuck"), loopA(), loopB());
			}
			const a = w.runtime.dispatch(stalls, "root");
			const b = w.runtime.dispatch(mark, "root", "queued");
			await vi.advanceTimersByTimeAsync(8000);
			expect(longHolds(w)).toHaveLength(1);
			w.runtime.dispose();
			await Promise.all([
				a,
				b
			]);
		});

		it("again when the hold moves from a slow wait to a stuck one, naming each", async () => {
			const w = build();
			timed(w);
			function* slowThenStuck(): IActionGenerator {
				yield* tick(1500);
				yield* wait("stuck");
			}
			const a = w.runtime.dispatch(slowThenStuck, "root");
			const b = w.runtime.dispatch(mark, "root", "queued");
			await vi.advanceTimersByTimeAsync(4000);
			expect(longHolds(w)).toEqual([
				expect.objectContaining({
					waitingOn: [
						"test/tick"
					]
				}),
				expect.objectContaining({
					waitingOn: [
						"test/wait"
					]
				})
			]);
			w.release("stuck");
			await Promise.all([
				a,
				b
			]);
		});
	});
});

describe("the gate: an answer on a child entity", () => {
	const asked = async (w: ReturnType<typeof build>): Promise<IAskId<string>> => {
		await settled();
		const [entry] = pendingAsksOf(w.runtime, w.runtime.state);
		expect(entry).toBeDefined();
		return entry!.Id as IAskId<string>;
	};

	function* writesAndAsks(draft: IRoot) {
		const row = yield* entity<IRow>({
			Log: []
		});
		draft.Rows.push(row);
		try {
			return yield* open(
				ask<string>(row.$Id, {
					Path: "Row"
				})
			);
		} finally {
			const index = draft.Rows.findIndex((x) => x.$Id === row.$Id);
			if (index >= 0) {
				draft.Log.push(`row:${draft.Rows[index]!.Log.join(",")}`);
				draft.Rows.splice(index, 1);
			}
		}
	}

	const endIndex = (w: ReturnType<typeof build>, name: string): number => {
		const [start] = w.starts(name);
		return w.records.findIndex(
			(r) =>
				r.Kind === "action:end" &&
				r.ActionId ===
					(
						start as {
							ActionId: string;
						}
					).ActionId
		);
	};

	it("runs the answerer's code after the answer before the asker resumes, so the asker's finally sees its write", async () => {
		const errors: unknown[] = [];
		const w = build({
			onError: (error) => errors.push(error)
		});
		function* answersThenWrites(draft: IRow, id: IAskId<string>, value: string): IActionGenerator<string> {
			yield* answer(id, value);
			draft.Log.push("answered");
			return "done";
		}
		const asking = w.runtime.dispatch(writesAndAsks, "root");
		const id = await asked(w);
		const answering = w.runtime.dispatch(answersThenWrites, w.runtime.state.Rows[1]!.$Id, id, "hi");
		expect(await asking).toBe("hi");
		await expect(answering).resolves.toBe("done");
		expect(w.runtime.state.Log).toEqual([
			"row:answered"
		]);
		expect(w.runtime.state.Rows.map((x) => x.$Id)).toEqual([
			"row-1"
		]);
		expect(w.records[endIndex(w, "answersThenWrites")]).toMatchObject({
			Status: "completed"
		});
		expect(w.records.filter((r) => r.Kind === "ask:answer" && r.AskId === id)).toHaveLength(1);
		expect(w.records.filter((r) => r.Kind === "ask:abandon")).toHaveLength(0);
		expect(w.codes()).toEqual([]);
		expect(errors).toEqual([]);
	});

	it("stops an answerer that waits after the answer once the asker removes the row, quietly", async () => {
		const errors: unknown[] = [];
		const w = build({
			onError: (error) => errors.push(error)
		});
		function* answersThenWaits(draft: IRow, id: IAskId<string>, value: string): IActionGenerator<string> {
			yield* answer(id, value);
			yield {
				Type: "test/wait",
				Name: "after the answer"
			};
			draft.Log.push("after the wait");
			return "done";
		}
		const asking = w.runtime.dispatch(writesAndAsks, "root");
		const id = await asked(w);
		const answering = w.runtime.dispatch(answersThenWaits, w.runtime.state.Rows[1]!.$Id, id, "hi");
		expect(await asking).toBe("hi");
		await expect(answering).resolves.toBeUndefined();
		expect(w.runtime.state.Log).toEqual([
			"row:"
		]);
		expect(w.records[endIndex(w, "answersThenWaits")]).toMatchObject({
			Status: "cancelled"
		});
		expect(w.codes()).toEqual([]);
		expect(errors).toEqual([]);
	});

	it("leaves an answer dispatched on the held parent queued behind the parent's wait on the child that asked, and the long-hold warning names it", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout"
			]
		});
		const w = build();
		function* asksOnRow(draft: IRow) {
			const dialogs = yield* transient(draft, "Gate/Dialogs", {
				Rows: [] as IRow[]
			});
			const dialog = yield* entity<IRow>({
				Log: []
			});
			dialogs.Rows.push(dialog);
			const value = yield* open(
				ask<string>(dialog.$Id, {
					Path: "Dialog"
				})
			);
			draft.Log.push(`answer:${value}`);
			return value;
		}
		w.runtime.registerImplementation("test/callRow", () => w.runtime.dispatch(asksOnRow, "row-1"));
		function* waitsOnRow(draft: IRoot): IActionGenerator {
			const value = yield {
				Type: "test/callRow"
			};
			draft.Log.push(`parent:${String(value)}`);
		}
		function* answersOnParent(_draft: IRoot, id: IAskId<string>, value: string): IActionGenerator {
			yield* answer(id, value);
		}
		const parent = w.runtime.dispatch(waitsOnRow, "root");
		const id = await asked(w);
		let answered = false;
		const answering = w.runtime.dispatch(answersOnParent, "root", id, "hi").then(() => {
			answered = true;
		});
		await settled();
		expect(answered).toBe(false);
		expect(w.records.filter((r) => r.Kind === "ask:answer")).toHaveLength(0);
		expect(w.codes()).toEqual([]);
		vi.advanceTimersByTime(HOLD_WARN_MS);
		expect(w.diags.filter((d) => d.code === "action/long-hold")).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({
					entityId: "root",
					holder: "waitsOnRow",
					waitingOn: [
						"test/callRow"
					],
					queued: [
						"answersOnParent"
					]
				})
			})
		]);
		vi.advanceTimersByTime(HOLD_WARN_MS * 10);
		await settled();
		expect(answered).toBe(false);
		expect(w.codes().filter((code) => code !== "action/long-hold")).toEqual([]);
		expect(w.inFlight().sort()).toEqual([
			"answersOnParent",
			"asksOnRow",
			"waitsOnRow"
		]);
		w.runtime.dispose();
		await Promise.all([
			parent,
			answering
		]);
	});

	it("answers undefined to an asker whose ask's owner is removed, by a dismissal on the written row, and the row goes after it", async () => {
		const w = build();
		type IOwned = IRow & {
			Owner: IRow[];
		};
		function* writesAndAsksBelow(draft: IRoot) {
			const owner = yield* entity<IRow>({
				Log: []
			});
			const row = yield* entity<IOwned>({
				Log: [],
				Owner: [
					owner
				]
			});
			draft.Rows.push(row);
			try {
				return yield* open(
					ask<string>(owner.$Id, {
						Path: "Owned"
					})
				);
			} finally {
				const index = draft.Rows.findIndex((x) => x.$Id === row.$Id);
				if (index >= 0) draft.Rows.splice(index, 1);
			}
		}
		function* dismisses(draft: IOwned): IActionGenerator {
			draft.Owner = [];
		}
		const asking = w.runtime.dispatch(writesAndAsksBelow, "root");
		const id = await asked(w);
		await w.runtime.dispatch(dismisses, w.runtime.state.Rows[1]!.$Id);
		expect(await asking).toBeUndefined();
		expect(w.runtime.state.Rows).toHaveLength(1);
		expect(w.records.filter((r) => r.Kind === "ask:abandon" && r.AskId === id)).toMatchObject([
			{
				Reason: "disposed"
			}
		]);
		expect(w.codes()).toEqual([]);
	});

	it("answers undefined to an asker that opened its wait, when a dismissal on its own entity removes the row", async () => {
		const w = build();
		function* opensItsWait(draft: IRoot) {
			const row = yield* entity<IRow>({
				Log: []
			});
			draft.Rows.push(row);
			try {
				return yield* open(
					ask<string>(row.$Id, {
						Path: "Row"
					})
				);
			} finally {
				const index = draft.Rows.findIndex((x) => x.$Id === row.$Id);
				if (index >= 0) draft.Rows.splice(index, 1);
			}
		}
		function* dismisses(draft: IRoot): IActionGenerator {
			draft.Rows = draft.Rows.filter((x) => x.$Id === "row-1");
		}
		const asking = w.runtime.dispatch(opensItsWait, "root");
		const id = await asked(w);
		await w.runtime.dispatch(dismisses, "root");
		expect(await asking).toBeUndefined();
		expect(w.runtime.state.Rows).toHaveLength(1);
		expect(w.records.filter((r) => r.Kind === "ask:abandon" && r.AskId === id)).toMatchObject([
			{
				Reason: "disposed"
			}
		]);
		expect(w.codes()).toEqual([]);
	});
});
