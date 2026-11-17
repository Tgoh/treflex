import type { IActionGenerator, IOpenGenerator } from "../../src/Types/IAction";
import type { IEffect } from "../../src/Types/IEffect";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entity } from "../../src/Effects/entity";
import { parallel } from "../../src/Effects/parallel";
import { parallelSettled } from "../../src/Effects/parallelSettled";
import { start } from "../../src/Effects/start";
import { latest } from "../../src/Runtime/arrivalPolicy";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { DraftInsideOpenError } from "../../src/Runtime/draftNode";
import { FINALLY_YIELD_LIMIT } from "../../src/Runtime/fiberMachine";
import { open } from "../../src/Runtime/open";
import { OutsideActionError } from "../../src/Runtime/runningStep";
import { transient } from "../../src/Runtime/transient";
import { settled } from "../../src/Testing/createTestRuntime";

type IRoot = {
	$Id: string;
	Log: string[];
	Rows: string[];
	Loading: number;
};

function build() {
	const errors: unknown[] = [];
	const runtime = createRuntime<IRoot>(
		{
			$Id: "root",
			Log: [],
			Rows: [],
			Loading: 0
		},
		{
			onError: (error) => errors.push(error)
		}
	);
	const releases = new Map<string, (value?: unknown) => void>();
	runtime.registerImplementation(
		"test/wait",
		(effect: { Type: string; Name: string }) =>
			new Promise((resolve) => {
				releases.set(effect.Name, resolve);
			})
	);
	const release = async (name: string, value: unknown = name): Promise<void> => {
		const resolve = releases.get(name);
		if (!resolve) {
			throw new Error(`nothing waits on "${name}"`);
		}
		releases.delete(name);
		resolve(value);
		await settled();
	};
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	const failures: IRuntimeEventOf<"failure">[] = [];
	runtime.on("failure", (event) => failures.push(event));
	return {
		runtime,
		release,
		releases,
		errors,
		diags,
		failures,
		log: () => runtime.state.Log
	};
}

function* wait(name: string): Generator<IEffect, unknown, any> {
	return yield {
		Type: "test/wait",
		Name: name
	} as IEffect;
}

function* mark(draft: IRoot, text: string): IActionGenerator {
	draft.Log.push(text);
}

function* slowMark(draft: IRoot, text: string): IActionGenerator {
	draft.Log.push(`${text}:start`);
	yield* wait(text);
	draft.Log.push(`${text}:end`);
}

function* loadPreview(draft: IRoot, name = "load") {
	draft.Log.push(`${name}:start`);
	const value = yield* open(wait(name));
	draft.Log.push(`${name}:${String(value)}`);
}

function* readsAfterWait(draft: IRoot) {
	draft.Log.push("helper:start");
	yield* wait("helper");
	draft.Log.push("helper:end");
}

function* trips(): IActionGenerator {
	yield* wait("trip");
	throw new Error("tripped");
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("open(...): a region that lets other work in", () => {
	it("lets queued work run during its wait, and holds outside it", async () => {
		const w = build();
		const a = w.runtime.dispatch(loadPreview, "root");
		const b = w.runtime.dispatch(mark, "root", "b");
		await settled();
		expect(w.log()).toEqual([
			"load:start",
			"b"
		]);
		await w.release("load", "done");
		await Promise.all([
			a,
			b
		]);
		expect(w.log()).toEqual([
			"load:start",
			"b",
			"load:done"
		]);
	});

	it("queues to take the hold back, behind work that got in during the wait", async () => {
		const w = build();
		const a = w.runtime.dispatch(loadPreview, "root");
		const b = w.runtime.dispatch(slowMark, "root", "b");
		await settled();
		expect(w.log()).toEqual([
			"load:start",
			"b:start"
		]);
		await w.release("load", "done");
		expect(w.log()).toEqual([
			"load:start",
			"b:start"
		]);
		const c = w.runtime.dispatch(mark, "root", "c");
		await w.release("b");
		await Promise.all([
			a,
			b,
			c
		]);
		expect(w.log()).toEqual([
			"load:start",
			"b:start",
			"b:end",
			"load:done",
			"c"
		]);
	});

	it("takes the hold back at once when nothing got in", async () => {
		const w = build();
		const a = w.runtime.dispatch(loadPreview, "root");
		await w.release("load", "done");
		await a;
		expect(w.log()).toEqual([
			"load:start",
			"load:done"
		]);
	});

	it("refuses the draft after a wait inside it, through any proxy of it, until it ends", async () => {
		const w = build();
		function* wrapsHelper(draft: IRoot) {
			yield* open(readsAfterWait(draft));
		}
		const a = w.runtime.dispatch(wrapsHelper, "root");
		await w.release("helper");
		await expect(a).rejects.toBeInstanceOf(DraftInsideOpenError);
		expect(w.log()).toEqual([
			"helper:start"
		]);

		function* holdsAReference(draft: IRoot) {
			const rows = draft.Rows;
			yield* open(
				(function* () {
					yield* wait("held-ref");
					rows.push("late");
				})()
			);
		}
		const b = w.runtime.dispatch(holdsAReference, "root");
		await w.release("held-ref");
		await expect(b).rejects.toBeInstanceOf(DraftInsideOpenError);
		expect(w.runtime.state.Rows).toEqual([]);

		const counter = (draft: IRoot) =>
			transient(draft, "Regions/Counter", {
				Count: 0
			});
		function* writesItsSlot(draft: IRoot) {
			const slot = yield* counter(draft);
			yield* open(
				(function* () {
					yield* wait("slot");
					slot.Count++;
				})()
			);
		}
		const c = w.runtime.dispatch(writesItsSlot, "root");
		await w.release("slot");
		await expect(c).rejects.toBeInstanceOf(DraftInsideOpenError);
		expect(
			w.runtime.processSelector(
				function* (draft: IRoot) {
					return (yield* counter(draft)).Count;
				},
				() => w.runtime.state
			)
		).toBe(0);
	});

	it("gives the draft back once the hold is taken back", async () => {
		const w = build();
		function* readsAfter(draft: IRoot) {
			yield* open(wait("x"));
			draft.Log.push(`after:${draft.Log.length}`);
		}
		const a = w.runtime.dispatch(readsAfter, "root");
		await w.release("x");
		await a;
		expect(w.log()).toEqual([
			"after:0"
		]);
	});

	it("lets an open function call another with a plain yield*, the callee's open letting others in", async () => {
		const w = build();
		function* loadViewsOpen(draft: IRoot) {
			yield* loadPreview(draft);
		}
		const a = w.runtime.dispatch(loadViewsOpen, "root");
		const b = w.runtime.dispatch(mark, "root", "b");
		await settled();
		expect(w.log()).toEqual([
			"load:start",
			"b"
		]);
		await w.release("load", "done");
		await Promise.all([
			a,
			b
		]);
		expect(w.log()).toEqual([
			"load:start",
			"b",
			"load:done"
		]);
	});

	it("refuses an open(...) inside another, typed any, before the inner one's body runs", async () => {
		const w = build();
		const untyped = open as (gen: any) => any;
		function* nested(draft: IRoot) {
			yield* open(
				(function* () {
					yield* untyped(
						(function* () {
							draft.Log.push("inner ran");
							yield* wait("inner");
						})()
					);
				})()
			);
		}
		await expect(w.runtime.dispatch(nested, "root")).rejects.toThrow(/called open\(\.\.\.\) inside open\(\.\.\.\)/);
		expect(w.log()).toEqual([]);
		expect(w.releases.size).toBe(0);
	});

	it("leaves the action open-free after the refused inner open, so a later open lets others in", async () => {
		const w = build();
		const untyped = open as (gen: any) => any;
		function* recovers(draft: IRoot) {
			try {
				yield* open(
					(function* () {
						yield* untyped(wait("inner"));
					})()
				);
			} catch {
				draft.Log.push("refused");
			}
			yield* loadPreview(draft);
		}
		const a = w.runtime.dispatch(recovers, "root");
		const b = w.runtime.dispatch(mark, "root", "b");
		await settled();
		expect(w.log()).toEqual([
			"refused",
			"load:start",
			"b"
		]);
		await w.release("load", "done");
		await Promise.all([
			a,
			b
		]);
	});
});

describe("a region outside an action", () => {
	it("throws OutsideActionError from open(...) stepped by hand", () => {
		expect(() => open(wait("w")).next()).toThrow(OutsideActionError);
	});

	it("throws OutsideActionError from an open(...) in a selector run inside an action's step, leaving the action's own open alone", async () => {
		const w = build();
		function* abandoned(): ISelectorGenerator<unknown> {
			return yield* open(
				(function* (): IActionGenerator {
					yield {
						Type: "regions/noSuchRead"
					} as IEffect;
				})()
			) as unknown as ISelectorGenerator<unknown>;
		}
		let caught: unknown;
		function* loads(draft: IRoot): IOpenGenerator {
			try {
				w.runtime.processSelector(abandoned, () => w.runtime.state);
			} catch (error) {
				caught = error;
			}
			yield* loadPreview(draft);
		}
		const a = w.runtime.dispatch(loads, "root");
		const b = w.runtime.dispatch(mark, "root", "b");
		await settled();
		expect(caught).toBeInstanceOf(OutsideActionError);
		expect(w.log()).toEqual([
			"load:start",
			"b"
		]);
		await w.release("load", "done");
		await Promise.all([
			a,
			b
		]);
	});

	it("refuses a selector's read of a draft let go inside open(...), as the draft itself refuses it", async () => {
		const w = build();
		const seen: string[] = [];
		function* count(state: IRoot): ISelectorGenerator<number> {
			return state.Log.length;
		}
		function* root(draft: IRoot): IOpenGenerator {
			yield* open(
				(function* (): IActionGenerator {
					yield* wait("r1");
					for (const read of [
						() => draft.Log.length,
						() => w.runtime.processSelector(count, () => draft)
					]) {
						try {
							read();
							seen.push("read");
						} catch (error) {
							seen.push((error as Error).name);
						}
					}
					yield* wait("r2");
				})()
			);
		}
		const a = w.runtime.dispatch(root, "root");
		await settled();
		await w.runtime.dispatch(mark, "root", "c");
		await w.release("r1");
		expect(seen).toEqual([
			"DraftInsideOpenError",
			"DraftInsideOpenError"
		]);
		await w.release("r2");
		await a;
	});
});

describe("what counts as a wait inside open(...)", () => {
	it("counts a start, so the draft throws after it", async () => {
		const w = build();
		function* starts(draft: IRoot) {
			yield* open(
				(function* () {
					yield* start(mark, "root", "started");
					draft.Log.push("after-start");
				})()
			);
		}
		await expect(w.runtime.dispatch(starts, "root")).rejects.toBeInstanceOf(DraftInsideOpenError);
	});

	it("counts neither a settles: sync effect nor a read", async () => {
		const w = build();
		function* syncOnly(draft: IRoot) {
			yield* open(
				(function* () {
					yield* entity({
						Log: []
					});
					yield* transient(draft, "Regions/Probe", {
						N: 0
					});
					draft.Log.push("a");
				})()
			);
		}
		const a = w.runtime.dispatch(syncOnly, "root");
		const b = w.runtime.dispatch(mark, "root", "b");
		await Promise.all([
			a,
			b
		]);
		expect(w.errors).toEqual([]);
		expect(w.log()).toEqual([
			"a",
			"b"
		]);
	});
});

describe("a row that removes itself later", () => {
	it("is put up by the action, which starts its removal on its own entity to wait in open(...)", async () => {
		const w = build();
		function* dismissLater(draft: IRoot, text: string) {
			yield* open(wait("toast"));
			draft.Rows = draft.Rows.filter((row) => row !== text);
		}
		function* raise(draft: IRoot): IActionGenerator {
			draft.Rows.push("saved");
			yield* start(dismissLater, "root", "saved");
		}
		await w.runtime.dispatch(raise, "root");
		await settled();
		expect(w.runtime.state.Rows).toEqual([
			"saved"
		]);
		await w.runtime.dispatch(mark, "root", "b");
		expect(w.log()).toEqual([
			"b"
		]);
		await w.release("toast");
		expect(w.runtime.state.Rows).toEqual([]);
		expect(w.errors).toEqual([]);
	});
});

describe("regions and branches", () => {
	it("holds through a fan-out outside open(...), whatever its branches wait on", async () => {
		const w = build();
		function* both(draft: IRoot): IActionGenerator {
			yield* parallel(slowMark(draft, "p"), slowMark(draft, "q"));
		}
		const a = w.runtime.dispatch(both, "root");
		const b = w.runtime.dispatch(mark, "root", "b");
		await settled();
		await w.release("p");
		expect(w.log()).toEqual([
			"p:start",
			"q:start",
			"p:end"
		]);
		await w.release("q");
		await Promise.all([
			a,
			b
		]);
		expect(w.log()).toEqual([
			"p:start",
			"q:start",
			"p:end",
			"q:end",
			"b"
		]);
	});

	it("lets others in at an open fan-out's wait, after each branch's first step reads under the hold", async () => {
		const w = build();
		function* reads(draft: IRoot, name: string): IActionGenerator<string> {
			const before = draft.Log.length;
			draft.Log.push(`${name}:start`);
			return `${name}:${String(yield* wait(name))}@${before}`;
		}
		function* both(draft: IRoot) {
			const results = yield* open(parallel(reads(draft, "p"), reads(draft, "q")));
			draft.Log.push(...results);
		}
		const a = w.runtime.dispatch(both, "root");
		const b = w.runtime.dispatch(mark, "root", "b");
		await settled();
		expect(w.log()).toEqual([
			"p:start",
			"q:start",
			"b"
		]);
		await w.release("p", "P");
		await w.release("q", "Q");
		await Promise.all([
			a,
			b
		]);
		expect(w.log()).toEqual([
			"p:start",
			"q:start",
			"b",
			"p:P@0",
			"q:Q@1"
		]);
	});

	it("refuses a branch's draft after its wait inside open(parallel(...)), as the action's own", async () => {
		const w = build();
		function* writesAfter(draft: IRoot): IActionGenerator {
			yield* wait("w");
			draft.Log.push("late");
		}
		const a = w.runtime.dispatch(function* (draft: IRoot) {
			yield* open(parallel(writesAfter(draft)));
		}, "root");
		await settled();
		await w.release("w");
		await expect(a).rejects.toBeInstanceOf(DraftInsideOpenError);
		expect(w.log()).toEqual([]);
	});

	it("refuses the draft to a branch a nested fan-out starts after a wait inside open(...)", async () => {
		const w = build();
		const outcomes: string[] = [];
		function* k(draft: IRoot): IActionGenerator {
			try {
				draft.Log.push("k");
				outcomes.push("k:wrote");
			} catch (error) {
				outcomes.push(error instanceof DraftInsideOpenError ? "k:refused" : "k:failed");
			}
		}
		function* b(draft: IRoot): IActionGenerator {
			yield* wait("b");
			yield* parallel(k(draft));
		}
		const action = w.runtime.dispatch(function* (draft: IRoot) {
			yield* open(parallel(b(draft)));
		}, "root");
		await settled();
		await w.release("b");
		await action;
		expect(outcomes).toEqual([
			"k:refused"
		]);
	});

	it("refuses open(...) in a branch, typed any, before its body runs", async () => {
		const w = build();
		const untyped = open as (gen: any) => any;
		function* opens(draft: IRoot): IActionGenerator {
			yield* untyped(
				(function* () {
					draft.Log.push("body ran");
					yield* wait("inner");
				})()
			);
		}
		const outcomes = await w.runtime.dispatch(function* (draft: IRoot): IActionGenerator<unknown> {
			return yield* parallelSettled(opens(draft));
		}, "root");
		expect(outcomes).toEqual([
			{
				ok: false,
				error: expect.objectContaining({
					message: expect.stringMatching(/called open\(\.\.\.\) in a branch of parallel or parallelSettled/)
				})
			}
		]);
		expect(w.log()).toEqual([]);
		expect(w.releases.size).toBe(0);
	});

	it("refuses open(...) in a branch of a branch", async () => {
		const w = build();
		const untyped = open as (gen: any) => any;
		function* inner(): IActionGenerator {
			yield* untyped(wait("inner"));
		}
		function* outer(): IActionGenerator {
			yield* parallel(inner());
		}
		await expect(
			w.runtime.dispatch(function* (): IActionGenerator {
				yield* parallel(outer());
			}, "root")
		).rejects.toThrow(/in a branch of parallel or parallelSettled/);
		expect(w.releases.size).toBe(0);
	});

	it("resumes the action only once every branch has ended, a failed fan-out included", async () => {
		const w = build();
		const order: string[] = [];
		function* slow(): IActionGenerator {
			try {
				yield* wait("slow");
			} finally {
				order.push("slow closed");
			}
		}
		function* fails(): IActionGenerator {
			yield* wait("fail");
			throw new Error("failed");
		}
		const a = w.runtime.dispatch(function* (): IActionGenerator {
			try {
				yield* parallel(slow(), fails());
			} catch {
				order.push("action resumed");
			}
		}, "root");
		await settled();
		await w.release("fail");
		await a;
		expect(order).toEqual([
			"slow closed",
			"action resumed"
		]);
	});
});

describe("stopping during a region", () => {
	it("ends the action without taking the hold back, and its finally can't touch the draft", async () => {
		const w = build();
		const replaced = latest(function* replaced(draft: IRoot, name: string) {
			try {
				yield* open(wait(name));
				draft.Log.push(`${name}:end`);
			} finally {
				draft.Log.push(`${name}:finally`);
			}
		});
		const a = w.runtime.dispatch(replaced, "root", "first");
		await settled();
		const b = w.runtime.dispatch(replaced, "root", "second");
		await settled();
		expect(await a).toBeUndefined();
		expect(
			w.failures.map((failure) => [
				(failure.Error as Error).name,
				failure.Close
			])
		).toEqual([
			[
				"DraftInsideOpenError",
				true
			]
		]);
		expect([
			...w.releases.keys()
		]).toEqual([
			"first",
			"second"
		]);
		await w.release("second");
		await b;
		expect(w.log()).toEqual([
			"second:end",
			"second:finally"
		]);
	});

	it("leaves the hold free when an action stopped inside open(...) keeps yielding in its close, past the drain limit", async () => {
		const w = build();
		function* runaway(name: string): IActionGenerator {
			for (;;) {
				try {
					yield* wait(name);
				} finally {
					// biome-ignore lint/correctness/noUnsafeFinally lint/complexity/noUselessContinue: the continue overrides the close's return(), which is the subject.
					continue;
				}
			}
		}
		const replaced = latest(function* replaced(draft: IRoot, name: string) {
			if (name === "first") {
				yield* open(runaway(name));
			}
			draft.Log.push(`${name} wrote`);
		});
		const run = w.runtime.dispatch(replaced, "root", "first");
		await settled();
		const queued = w.runtime.dispatch(mark, "root", "queued");
		await settled();
		await w.runtime.dispatch(replaced, "root", "second");
		await Promise.all([
			run,
			queued
		]);
		expect(w.log()).toEqual([
			"queued",
			"second wrote"
		]);
		expect(w.diags.filter((d) => d.code === "cancel/finally-yield")).toHaveLength(FINALLY_YIELD_LIMIT);
		expect(w.diags.filter((d) => d.code === "cancel/finally-yield-limit")).toHaveLength(1);
		expect(w.errors).toEqual([]);
	});

	it("leaves the hold free when an action replaced during an open yields in the open's finally, refusing the outer finally's write", async () => {
		const w = build();
		const replaced = latest(function* replaced(draft: IRoot, name: string) {
			try {
				yield* open(
					(function* (): IActionGenerator {
						try {
							yield* wait(name);
						} finally {
							yield* wait(`${name} cleanup`);
						}
					})()
				);
				draft.Log.push(`${name}:end`);
			} finally {
				draft.Log.push(`${name}:finally`);
			}
		});
		const a = w.runtime.dispatch(replaced, "root", "first");
		await settled();
		const b = w.runtime.dispatch(replaced, "root", "second");
		await settled();
		expect(await a).toBeUndefined();
		await w.release("second");
		await w.release("second cleanup");
		await b;
		await w.runtime.dispatch(mark, "root", "after");
		expect(w.log()).toEqual([
			"second:end",
			"second:finally",
			"after"
		]);
		expect(w.diags.map((d) => d.code)).toEqual([
			"cancel/finally-yield"
		]);
		expect(
			w.failures.map((failure) => [
				(failure.Error as Error).name,
				failure.Close
			])
		).toEqual([
			[
				"DraftInsideOpenError",
				true
			]
		]);
	});

	describe("a loading count taken down in a finally, around a body whose own finally yields", () => {
		function* withLoading(draft: IRoot, body: () => IActionGenerator): IActionGenerator {
			draft.Loading++;
			try {
				yield* body();
			} finally {
				draft.Loading--;
			}
		}
		function* revokesInFinally(name: string): IActionGenerator {
			try {
				yield* wait(name);
			} finally {
				yield* wait(`${name} revoke`);
			}
		}
		const bodies: [
			string,
			(name: string) => IActionGenerator
		][] = [
			[
				"plain",
				(name) => revokesInFinally(name)
			],
			[
				"inside a nested generator",
				(name) =>
					(function* (): IActionGenerator {
						yield* revokesInFinally(name);
					})()
			]
		];

		for (const [bodyName, body] of bodies) {
			it(`comes back to zero when its sibling's failure stops its branch, with the body ${bodyName}`, async () => {
				const w = build();
				function* root(draft: IRoot): IActionGenerator {
					try {
						yield* parallel(
							withLoading(draft, () => body("body")),
							trips()
						);
					} catch {}
					draft.Log.push("joined");
				}
				const run = w.runtime.dispatch(root, "root");
				await settled();
				expect(w.runtime.state.Loading).toBe(1);
				await w.release("trip");
				await run;
				await w.runtime.dispatch(mark, "root", "after");
				expect(w.runtime.state.Loading).toBe(0);
				expect(w.log()).toEqual([
					"joined",
					"after"
				]);
				expect([
					...w.releases.keys()
				]).toEqual([
					"body"
				]);
				expect(w.diags.map((d) => d.code)).toEqual([
					"cancel/finally-yield"
				]);
				expect(w.errors).toEqual([]);
			});

			it(`comes back to zero when a latest replacement stops it, with the body ${bodyName}`, async () => {
				const w = build();
				const load = latest(function* load(draft: IRoot, name: string) {
					yield* withLoading(draft, () => body(name));
					draft.Log.push(`${name}:end`);
				});
				const a = w.runtime.dispatch(load, "root", "first");
				await settled();
				const b = w.runtime.dispatch(load, "root", "second");
				await settled();
				expect(await a).toBeUndefined();
				expect(w.runtime.state.Loading).toBe(1);
				await w.release("second");
				await w.release("second revoke");
				await b;
				await w.runtime.dispatch(mark, "root", "after");
				expect(w.runtime.state.Loading).toBe(0);
				expect(w.log()).toEqual([
					"second:end",
					"after"
				]);
				expect([
					...w.releases.keys()
				]).toEqual([
					"first"
				]);
				expect(w.diags.map((d) => d.code)).toEqual([
					"cancel/finally-yield"
				]);
				expect(w.errors).toEqual([]);
			});
		}

		it("comes back to zero past two nested finally blocks that each yield, reporting each one", async () => {
			const w = build();
			function* twoRevokes(draft: IRoot): IActionGenerator {
				try {
					yield* revokesInFinally("body");
				} finally {
					yield* wait("outer revoke");
					draft.Log.push("after the outer revoke");
				}
			}
			function* root(draft: IRoot): IActionGenerator {
				try {
					yield* parallel(
						withLoading(draft, () => twoRevokes(draft)),
						trips()
					);
				} catch {}
				draft.Log.push("joined");
			}
			const run = w.runtime.dispatch(root, "root");
			await settled();
			expect(w.runtime.state.Loading).toBe(1);
			await w.release("trip");
			await run;
			expect(w.runtime.state.Loading).toBe(0);
			expect(w.log()).toEqual([
				"joined"
			]);
			expect([
				...w.releases.keys()
			]).toEqual([
				"body"
			]);
			expect(
				w.diags.map((d) => [
					d.code,
					d.data?.yieldedType
				])
			).toEqual([
				[
					"cancel/finally-yield",
					"test/wait"
				],
				[
					"cancel/finally-yield",
					"test/wait"
				]
			]);
			expect(w.errors).toEqual([]);
		});
	});

	it("routes a stopped open's close failure to onError when its body finally throws after others got in, and refuses the outer finally's write", async () => {
		const w = build();
		const replaced = latest(function* replaced(draft: IRoot, name: string) {
			try {
				yield* open(
					(function* (): IActionGenerator {
						try {
							yield* wait(name);
						} finally {
							// biome-ignore lint/correctness/noUnsafeFinally: the throw from a finally is the subject.
							throw new Error(`${name} finally threw`);
						}
					})()
				);
			} finally {
				draft.Log.push(`${name}: outer finally`);
			}
		});
		const a = w.runtime.dispatch(replaced, "root", "first");
		await settled();
		const blocker = w.runtime.dispatch(slowMark, "root", "blocker");
		await settled();
		const b = w.runtime.dispatch(replaced, "root", "second");
		expect(await a).toBeUndefined();
		expect(w.diags.filter((d) => d.code.startsWith("cancel/"))).toEqual([]);
		expect(w.failures.filter((failure) => failure.Close).map((failure) => (failure.Error as Error).name)).toEqual([
			"DraftInsideOpenError"
		]);
		expect(w.errors.map((error) => (error as Error).name)).toEqual([
			"DraftInsideOpenError"
		]);
		await w.release("blocker");
		await w.release("second");
		await expect(b).rejects.toThrow("second finally threw");
		await blocker;
		expect(w.log()).toEqual([
			"blocker:start",
			"blocker:end",
			"second: outer finally"
		]);
	});

	it("ends silently when stopped while taking the hold back after the region's throw", async () => {
		const w = build();
		const replaced = latest(function* replaced(_draft: IRoot, name: string) {
			yield* open(
				(function* (): IActionGenerator {
					yield* wait(name);
					throw new Error(`${name} failed`);
				})()
			);
		});
		const a = w.runtime.dispatch(replaced, "root", "first");
		const blocker = w.runtime.dispatch(slowMark, "root", "blocker");
		await w.release("first");
		const b = w.runtime.dispatch(replaced, "root", "second");
		await w.release("blocker");
		expect(await a).toBeUndefined();
		expect(w.diags.filter((d) => d.code.startsWith("cancel/"))).toEqual([]);
		expect(w.errors).toEqual([]);
		await w.release("second");
		await expect(b).rejects.toThrow("second failed");
		await blocker;
	});

	it("drops its place in the queue when stopped while taking the hold back", async () => {
		const w = build();
		const replaced = latest(function* replaced(draft: IRoot, name: string) {
			yield* open(wait(name));
			draft.Log.push(`${name}:end`);
		});
		const a = w.runtime.dispatch(replaced, "root", "first");
		const blocker = w.runtime.dispatch(slowMark, "root", "blocker");
		await w.release("first");
		const b = w.runtime.dispatch(replaced, "root", "second");
		await w.release("blocker");
		expect(await a).toBeUndefined();
		await w.release("second");
		await Promise.all([
			b,
			blocker
		]);
		expect(w.log()).toEqual([
			"blocker:start",
			"blocker:end",
			"second:end"
		]);
	});
});
