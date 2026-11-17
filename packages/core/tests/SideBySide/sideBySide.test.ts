import { describe, expect, it } from "vitest";
import { baselineMissing, baselineRef, type IRun, type IScenario, loadEngines, runOn, wait } from "./engines";

type IGen = Generator<any, any, any>;

const engines = await loadEngines();

function withChild() {
	return {
		$Id: "e1",
		items: [] as string[],
		child: {
			$Id: "c1",
			items: [] as string[]
		}
	};
}

function outcome(promise: Promise<unknown>): Promise<string> {
	return promise.then(
		(value) => String(value),
		(error: Error) => `rejected ${error.message}`
	);
}

function* fails(message: string): IGen {
	throw new Error(message);
}

interface ICase {
	run: IScenario;
	/** Record order within a tick is known to move: the records still match as a set, and must not match in order. */
	recordOrderMoves?: true;
	/** Where the engines are known to differ: asserts each engine's own outcome. */
	differs?: (tree: IRun, baseline: IRun) => void;
}

const cases: Record<string, ICase> = {
	"latest replaces an action with waiting branches": {
		recordOrderMoves: true,
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			let run = 0;
			function* br(draft: any, key: string): IGen {
				try {
					yield* wait(key);
				} finally {
					log(`body ${key} finally`);
					draft.items.push(`fin-${key}`);
				}
			}
			const act = lib.latest(function* act(draft: any): IGen {
				const n = ++run;
				log(`body parent ${n} start sees ${JSON.stringify(draft.items)}`);
				if (n > 1) {
					yield* wait(`r${n}`);
					return;
				}
				try {
					yield* lib.parallel(br(draft, `a${n}`), br(draft, `b${n}`));
				} finally {
					log(`body parent ${n} finally`);
					draft.items.push(`pfin-${n}`);
				}
			});
			const first = h.runtime.dispatch(act, "e1");
			await flush();
			log("second dispatch");
			void h.runtime.dispatch(act, "e1");
			await first;
			log("first resolved");
		}
	},

	"latest replaces an action with no branches": {
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			let run = 0;
			const act = lib.latest(function* act(draft: any): IGen {
				const n = ++run;
				log(`body parent ${n} start sees ${JSON.stringify(draft.items)}`);
				if (n > 1) {
					yield* wait(`r${n}`);
					return;
				}
				try {
					yield* wait("a1");
				} finally {
					log(`body parent ${n} finally`);
					draft.items.push(`pfin-${n}`);
				}
			});
			const first = h.runtime.dispatch(act, "e1");
			await flush();
			log("second dispatch");
			void h.runtime.dispatch(act, "e1");
			await first;
			log("first resolved");
		}
	},

	"a branch stops its own action, then throws, with a waiting sibling": {
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			let run = 0;
			const act = lib.latest(function* act(_draft: any): IGen {
				const n = ++run;
				if (n > 1) {
					log("replacement runs");
					return;
				}
				function* killer(): IGen {
					yield* wait("x");
					log("killer dispatches replacement");
					void h.runtime.dispatch(act, "e1");
					throw new Error("kept");
				}
				function* other(): IGen {
					try {
						yield* wait("never");
					} finally {
						log("other finally");
					}
				}
				try {
					yield* lib.parallel(killer(), other());
				} catch (e) {
					log(`parent caught ${(e as Error).message}`);
				}
			});
			const first = outcome(h.runtime.dispatch(act, "e1"));
			await flush();
			h.get("x").resolve(1);
			log(`first ${await first}`);
		}
	},

	"a stopped action's branches and root all throw from finally": {
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			let run = 0;
			const act = lib.latest(function* act(_draft: any): IGen {
				const n = ++run;
				if (n > 1) {
					return;
				}
				function* br(): IGen {
					try {
						yield* wait("never");
					} finally {
						// biome-ignore lint/correctness/noUnsafeFinally: the throw from finally is the case under test
						throw new Error("branch-finally");
					}
				}
				function* br2(): IGen {
					try {
						yield* wait("never2");
					} finally {
						// biome-ignore lint/correctness/noUnsafeFinally: the throw from finally is the case under test
						throw new Error("branch2-finally");
					}
				}
				try {
					yield* lib.parallel(br(), br2());
				} finally {
					// biome-ignore lint/correctness/noUnsafeFinally: the throw from finally is the case under test
					throw new Error("root-finally");
				}
			});
			const first = outcome(h.runtime.dispatch(act, "e1"));
			await flush();
			void h.runtime.dispatch(act, "e1");
			log(`first ${await first}`);
		}
	},

	"the entity is removed mid fan-out": {
		recordOrderMoves: true,
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			function* br(draft: any, k: string): IGen {
				try {
					yield* wait(k);
				} finally {
					log(`br ${k} finally`);
					draft.items.push(k);
				}
			}
			function* act(draft: any): IGen {
				try {
					yield* lib.parallel(br(draft, "a"), br(draft, "b"));
				} finally {
					log("parent finally");
				}
			}
			function* remove(draft: any): IGen {
				draft.child = undefined;
			}
			const p = outcome(h.runtime.dispatch(act, "c1"));
			await flush();
			await h.runtime.dispatch(remove, "e1");
			log("removed");
			log(`act ${await p}`);
		}
	},

	"latest stops nested fan-outs": {
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			let run = 0;
			const act = lib.latest(function* act(_draft: any): IGen {
				const n = ++run;
				if (n > 1) {
					return;
				}
				function* inner(k: string): IGen {
					try {
						yield* wait(k);
					} finally {
						log(`inner ${k} finally`);
					}
				}
				function* mid(k: string): IGen {
					try {
						yield* lib.parallel(inner(`${k}1`), inner(`${k}2`));
					} finally {
						log(`mid ${k} finally`);
					}
				}
				try {
					yield* lib.parallel(mid("a"), mid("b"));
				} finally {
					log("root finally");
				}
			});
			const first = h.runtime.dispatch(act, "e1");
			await flush();
			void h.runtime.dispatch(act, "e1");
			await first;
		}
	},

	"two branches fail a microtask apart": {
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			function* f(k: string, msg: string): IGen {
				try {
					yield* wait(k);
					throw new Error(msg);
				} finally {
					log(`${msg} finally`);
				}
			}
			function* act(): IGen {
				try {
					yield* lib.parallel(f("x", "one"), f("y", "two"));
				} catch (e) {
					log(`caught ${(e as Error).message}`);
				}
			}
			const p = h.runtime.dispatch(act, "e1");
			await flush();
			h.get("y").resolve(1);
			await Promise.resolve();
			h.get("x").resolve(1);
			await p;
		}
	},

	"a group-stopped sibling throws from finally": {
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			function* f(): IGen {
				yield* wait("x");
				throw new Error("first");
			}
			function* g(): IGen {
				try {
					yield* wait("never");
				} finally {
					// biome-ignore lint/correctness/noUnsafeFinally: the throw from finally is the case under test
					throw new Error("sibling-finally");
				}
			}
			function* act(): IGen {
				try {
					yield* lib.parallel(f(), g());
				} catch (e) {
					log(`caught ${(e as Error).message}`);
				}
			}
			const p = h.runtime.dispatch(act, "e1");
			await flush();
			h.get("x").resolve(1);
			await p;
		}
	},

	"open(parallel(sync)) after a wait, with another action queued": {
		recordOrderMoves: true,
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			function* sync(k: string): IGen {
				log(`branch ${k}`);
				return k;
			}
			function* act(draft: any): IGen {
				yield* wait("start");
				yield* lib.open(
					(function* (): IGen {
						yield* lib.parallel(sync("a"), sync("b"));
					})()
				);
				draft.items.push("A-after-open");
				log(`A after open sees ${JSON.stringify(draft.items)}`);
			}
			function* other(draft: any): IGen {
				draft.items.push("B");
				log("B runs");
			}
			const p = h.runtime.dispatch(act, "e1");
			await flush();
			const q = h.runtime.dispatch(other, "e1");
			h.get("start").resolve(1);
			await p;
			await q;
			await flush();
			log(`final ${JSON.stringify(h.runtime.state.items)}`);
		}
	},

	"empty and sync fan-outs in a loop": {
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			function* s(i: number): IGen {
				return i;
			}
			function* act(draft: any): IGen {
				for (let i = 0; i < 3; i++) {
					const r = yield* lib.parallel();
					const q = yield* lib.parallel(s(i));
					draft.items.push(`${r.length}-${q[0]}`);
				}
			}
			await h.runtime.dispatch(act, "e1");
			await flush();
			log(`final ${JSON.stringify(h.runtime.state.items)}`);
		}
	},

	"the last branch stops its own action and completes": {
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			let run = 0;
			const act = lib.latest(function* act(draft: any): IGen {
				const n = ++run;
				if (n > 1) {
					log(`replacement sees ${JSON.stringify(draft.items)}`);
					return;
				}
				function* killer(): IGen {
					yield* wait("x");
					void h.runtime.dispatch(act, "e1");
					draft.items.push("killer-wrote");
					return "k";
				}
				try {
					const r = yield* lib.parallel(killer());
					log(`parent past fan-out ${JSON.stringify(r)}`);
					draft.items.push("after");
				} finally {
					log("parent finally");
				}
			});
			const first = outcome(h.runtime.dispatch(act, "e1"));
			await flush();
			h.get("x").resolve(1);
			log(`first ${await first}`);
			await flush();
			log(`final ${JSON.stringify(h.runtime.state.items)}`);
		}
	},

	"a branch's first slice stops its own action": {
		recordOrderMoves: true,
		run: async ({ lib, log, open }) => {
			const h = open(withChild());
			let run = 0;
			const act = lib.latest(function* act(draft: any): IGen {
				const n = ++run;
				if (n > 1) {
					log(`replacement sees ${JSON.stringify(draft.items)}`);
					return;
				}
				function* killer(): IGen {
					void h.runtime.dispatch(act, "e1");
					log("killer first slice");
					yield* wait("x");
				}
				function* later(k: string): IGen {
					try {
						log(`later ${k} started`);
						yield* wait(k);
					} finally {
						log(`later ${k} finally`);
					}
				}
				try {
					yield* lib.parallel(later("a"), killer(), later("b"));
					log("parent past fan-out");
				} finally {
					log("parent finally");
				}
			});
			log(`first ${await outcome(h.runtime.dispatch(act, "e1"))}`);
		}
	},

	"parallelSettled under a stop, with a failing branch": {
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			let run = 0;
			const act = lib.latest(function* act(_draft: any): IGen {
				const n = ++run;
				if (n > 1) {
					return;
				}
				function* killer(): IGen {
					yield* wait("x");
					void h.runtime.dispatch(act, "e1");
					throw new Error("settled-kept");
				}
				const out = yield* lib.parallelSettled(killer(), wait("never"));
				log(`parent past ${JSON.stringify(out)}`);
			});
			const first = outcome(h.runtime.dispatch(act, "e1"));
			await flush();
			h.get("x").resolve(1);
			log(`first ${await first}`);
		}
	},

	"branches queue work on their own entity": {
		recordOrderMoves: true,
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			function* other(draft: any): IGen {
				draft.items.push("other");
				log(`other sees ${JSON.stringify(draft.items)}`);
			}
			function* br(draft: any): IGen {
				yield* wait("x");
				void h.runtime.dispatch(other, "e1");
				draft.items.push("br");
			}
			function* act(draft: any): IGen {
				yield* lib.parallel(br(draft), br(draft));
				draft.items.push("parent");
				yield* wait("y");
				draft.items.push("parent2");
			}
			const p = h.runtime.dispatch(act, "e1");
			await flush();
			h.get("x").resolve(1);
			await flush();
			h.get("y").resolve(1);
			await p;
			await flush();
			log(`final ${JSON.stringify(h.runtime.state.items)}`);
		}
	},

	"dispose from a branch's step": {
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			function* killer(): IGen {
				yield* wait("x");
				h.runtime.dispose();
				log("killer after dispose");
			}
			function* br(k: string): IGen {
				try {
					yield* wait(k);
				} finally {
					log(`br ${k} finally`);
				}
			}
			function* act(): IGen {
				try {
					yield* lib.parallel(killer(), br("a"));
					log("parent past");
				} finally {
					log("parent finally");
				}
			}
			const p = outcome(h.runtime.dispatch(act, "e1")).then((v) => log(`act ${v}`));
			await flush();
			h.get("x").resolve(1);
			await Promise.race([
				p,
				new Promise((r) => setTimeout(r, 50))
			]);
		}
	},

	"dispose mid fan-out": {
		run: async ({ lib, log, open, flush }) => {
			const h = open(withChild());
			function* br(k: string): IGen {
				try {
					yield* wait(k);
				} finally {
					log(`br ${k} finally`);
				}
			}
			function* act(): IGen {
				try {
					yield* lib.parallel(br("a"), br("b"));
				} finally {
					log("parent finally");
				}
			}
			const p = outcome(h.runtime.dispatch(act, "e1")).then((v) => log(`act ${v}`));
			await flush();
			h.runtime.dispose();
			log("disposed");
			await Promise.race([
				p,
				new Promise((r) => setTimeout(r, 50))
			]);
			await flush();
			h.get("a").resolve(1);
		}
	},

	"parallel whose branches never wait gives up a turn": {
		run: async ({ lib, log, open }) => {
			const h = open();
			function* sync(): IGen {
				return 1;
			}
			function* act(): IGen {
				yield* lib.parallel(sync());
				log("action past the fan-out");
			}
			const done = h.runtime.dispatch(act, "e1");
			log("dispatch returned");
			await done;
		}
	},

	"parallelSettled whose branches never wait gives up a turn": {
		run: async ({ lib, log, open }) => {
			const h = open();
			function* sync(): IGen {
				return 1;
			}
			function* act(): IGen {
				yield* lib.parallelSettled(sync());
				log("action past the fan-out");
			}
			const done = h.runtime.dispatch(act, "e1");
			log("dispatch returned");
			await done;
		}
	},

	"a loop of fan-outs whose branches never wait is stopped from a microtask: the tree runs one more iteration first": {
		run: async ({ lib, log, open }) => {
			const h = open(
				{
					$Id: "e1",
					other: {
						$Id: "e2"
					}
				},
				{
					ping: () => Promise.resolve(1)
				}
			);
			let iterations = 0;
			function* sync(): IGen {
				return 1;
			}
			let run = 0;
			const act = lib.latest(function* act(_draft: any): IGen {
				if (++run > 1) {
					return;
				}
				for (let i = 0; i < 2000; i++) {
					iterations++;
					yield* lib.parallel(sync());
				}
			});
			function* stopper(): IGen {
				yield {
					Type: "ping"
				};
				void h.runtime.dispatch(act, "e1");
			}
			const first = h.runtime.dispatch(act, "e1");
			void h.runtime.dispatch(stopper, "e2");
			await first;
			log(`iterations ${iterations}`);
		},
		differs: (tree, baseline) => {
			expect(tree.code).toEqual([
				"iterations 2"
			]);
			expect(baseline.code).toEqual([
				"iterations 1"
			]);
			expect(tree.reports).toEqual(baseline.reports);
			expect(tree.unhandled).toEqual(baseline.unhandled);
		}
	},

	"a nested fan-out's failure and a sibling's failure answered in the same tick: the other one wins": {
		run: async ({ lib, log, open }) => {
			const h = open({
				$Id: "e1"
			});
			function* thrower(k: string): IGen {
				yield* wait(k);
				log(`resumed ${k}`);
				throw new Error(`boom ${k}`);
			}
			function* nested(): IGen {
				yield* lib.parallel(thrower("x"));
			}
			function* act(): IGen {
				try {
					yield* lib.parallel(nested(), thrower("y"));
				} catch (e) {
					log(`caught ${(e as Error).message}`);
				}
			}
			const a = h.runtime.dispatch(act, "e1");
			await new Promise((r) => setTimeout(r, 0));
			h.get("x").resolve(1);
			h.get("y").resolve(1);
			await a;
		},
		differs: (tree, baseline) => {
			expect(tree.code).toEqual([
				"resumed x",
				"caught boom x"
			]);
			expect(tree.reports).toEqual([]);
			expect(baseline.code).toEqual([
				"resumed x",
				"resumed y",
				"caught boom y"
			]);
			expect(baseline.reports).toEqual([
				"diag action/unrouted-throw",
				"failure boom x status=completed close=false taken=false"
			]);
			expect(tree.unhandled).toEqual([]);
			expect(baseline.unhandled).toEqual([]);
		}
	},

	"a branch's nested sync failure, then the branch group-stopped by a sync-failing sibling": {
		run: async ({ lib, log, open }) => {
			const h = open({
				$Id: "e1"
			});
			function* b1(): IGen {
				try {
					yield* lib.parallel(fails("boom inner"));
					log("b1 past");
				} finally {
					log("b1 finally");
				}
			}
			function* act(): IGen {
				try {
					yield* lib.parallel(b1(), fails("boom sibling"));
				} catch (e) {
					log(`caught ${(e as Error).message}`);
				}
			}
			await h.runtime.dispatch(act, "e1");
		}
	},

	"two siblings answered in the same tick, the first to resume fails": {
		recordOrderMoves: true,
		run: async ({ lib, log, open, flush }) => {
			const h = open();
			function* thrower(): IGen {
				yield* wait("x");
				throw new Error("boom x");
			}
			function* writer(draft: any): IGen {
				yield* wait("y");
				draft.items.push("y");
				log("y wrote");
			}
			function* act(draft: any): IGen {
				try {
					yield* lib.parallel(thrower(), writer(draft));
				} catch (e) {
					log(`caught ${(e as Error).message}`);
				}
			}
			const a = h.runtime.dispatch(act, "e1");
			await flush();
			h.get("x").resolve(1);
			h.get("y").resolve(1);
			await a;
			await flush();
			log(`items=${JSON.stringify(h.runtime.state.items)}`);
		}
	},

	"a sync-failing parallel, then a latest replacement before its end reaches the parent": {
		recordOrderMoves: true,
		run: async ({ lib, log, open, flush }) => {
			const h = open();
			let runs = 0;
			function* ok(draft: any): IGen {
				draft.items.push("ok");
			}
			const act = lib.latest(function* act(draft: any): IGen {
				if (++runs > 1) {
					log("second run");
					return;
				}
				try {
					yield* lib.parallel(ok(draft), fails("boom"));
					log("after parallel");
				} catch (e) {
					log(`caught ${(e as Error).message}`);
				} finally {
					log("finally");
				}
			});
			const a = h.runtime.dispatch(act, "e1");
			log("dispatched 1");
			const b = h.runtime.dispatch(act, "e1");
			log("dispatched 2");
			log(`a=${await outcome(a)}`);
			await b;
			await flush();
			log(`items=${JSON.stringify(h.runtime.state.items)}`);
		}
	},

	"a sync-failing parallel, then the entity removed before its end reaches the parent": {
		run: async ({ lib, log, open }) => {
			const h = open({
				$Id: "root",
				child: {
					$Id: "c",
					items: []
				}
			});
			function* act(): IGen {
				try {
					yield* lib.parallel(fails("boom"));
					log("after parallel");
				} catch (e) {
					log(`caught ${(e as Error).message}`);
				} finally {
					log("finally");
				}
			}
			function* remove(draft: any): IGen {
				draft.child = null;
			}
			const a = h.runtime.dispatch(act, "c");
			log("dispatched");
			await h.runtime.dispatch(remove, "root");
			log("removed");
			log(`a=${await outcome(a)}`);
		}
	},

	"a parallelSettled with a sync failure, stopped by removal": {
		run: async ({ lib, log, open }) => {
			const h = open({
				$Id: "root",
				child: {
					$Id: "c"
				}
			});
			function* act(): IGen {
				const r = yield* lib.parallelSettled(fails("boom"));
				log(`after ${JSON.stringify(r.map((x: any) => x.ok))}`);
			}
			function* remove(draft: any): IGen {
				draft.child = null;
			}
			const a = h.runtime.dispatch(act, "c");
			await h.runtime.dispatch(remove, "root");
			log(`a=${await outcome(a)}`);
		}
	},

	"open(parallel(sync)) dispatched together with another action": {
		recordOrderMoves: true,
		run: async ({ lib, log, open, flush }) => {
			const h = open();
			function* sync(draft: any, k: string): IGen {
				draft.items.push(k);
			}
			function* act(draft: any): IGen {
				yield* lib.open(lib.parallel(sync(draft, "a")) as any);
				log("after open");
				draft.items.push("p");
			}
			function* other(draft: any): IGen {
				log("other runs");
				draft.items.push("o");
			}
			const a = h.runtime.dispatch(act, "e1");
			log("dispatched a");
			const b = h.runtime.dispatch(other, "e1");
			log("dispatched b");
			await a;
			await b;
			await flush();
			log(`items=${JSON.stringify(h.runtime.state.items)}`);
		}
	},

	"open(parallel(sync)) with the other action dispatched after both": {
		recordOrderMoves: true,
		run: async ({ lib, log, open, flush }) => {
			const h = open();
			function* sync(draft: any, k: string): IGen {
				draft.items.push(k);
			}
			function* act(draft: any): IGen {
				yield* lib.open(lib.parallel(sync(draft, "a")) as any);
				log("after open");
				draft.items.push("p");
			}
			function* other(draft: any): IGen {
				log("other runs");
				draft.items.push("o");
			}
			const a = h.runtime.dispatch(act, "e1");
			const b = h.runtime.dispatch(other, "e1");
			log("dispatched");
			await a;
			await b;
			await flush();
			log(`items=${JSON.stringify(h.runtime.state.items)}`);
		}
	},

	"nested fan-outs whose leaves never wait, all ending at once": {
		recordOrderMoves: true,
		run: async ({ lib, log, open }) => {
			const h = open({
				$Id: "e1"
			});
			function* leaf(): IGen {
				return 1;
			}
			function* mid(k: string): IGen {
				yield* lib.parallel(leaf(), leaf());
				log(`mid ${k}`);
				yield* lib.parallel(leaf());
				log(`mid2 ${k}`);
			}
			function* act(): IGen {
				yield* lib.parallel(mid("a"), mid("b"));
				log("parent");
			}
			const a = h.runtime.dispatch(act, "e1");
			log("dispatched");
			await a;
		}
	},

	"a sync-failing branch and a waiting sibling, the entity removed before the end reaches the parent": {
		recordOrderMoves: true,
		run: async ({ lib, log, open }) => {
			const h = open({
				$Id: "root",
				child: {
					$Id: "c"
				}
			});
			function* waiter(): IGen {
				try {
					yield* wait("x");
				} finally {
					log("waiter finally");
				}
			}
			function* act(): IGen {
				try {
					yield* lib.parallel(waiter(), fails("boom"));
				} catch (e) {
					log(`caught ${(e as Error).message}`);
				}
			}
			function* remove(draft: any): IGen {
				draft.child = null;
			}
			const a = h.runtime.dispatch(act, "c");
			await h.runtime.dispatch(remove, "root");
			log(`a=${await outcome(a)}`);
		}
	},

	"dispose while a fan-out's end is deferred": {
		recordOrderMoves: true,
		run: async ({ lib, log, open, flush }) => {
			const h = open();
			function* sync(draft: any): IGen {
				draft.items.push("a");
			}
			function* act(draft: any): IGen {
				try {
					yield* lib.parallel(sync(draft));
					log("after parallel");
					draft.items.push("p");
				} finally {
					log("finally");
				}
			}
			const a = h.runtime.dispatch(act, "e1");
			h.runtime.dispose();
			log("disposed");
			log(`a=${await outcome(a)}`);
			await flush();
			log(`items=${JSON.stringify(h.runtime.state.items)}`);
		}
	},

	"dispose in the tick a branch is answered": {
		run: async ({ lib, log, open, flush }) => {
			const h = open();
			function* br(k: string): IGen {
				try {
					yield* wait(k);
					log(`after ${k}`);
				} finally {
					log(`finally ${k}`);
				}
			}
			function* act(): IGen {
				try {
					yield* lib.parallel(br("x"), br("y"));
					log("after parallel");
				} finally {
					log("finally root");
				}
			}
			const a = h.runtime.dispatch(act, "e1");
			await flush();
			h.get("x").resolve(1);
			h.runtime.dispose();
			log("disposed");
			log(`a=${await outcome(a)}`);
		}
	},

	"an uncaught sync parallel failure reaches onError once": {
		run: async ({ lib, log, open }) => {
			const h = open({
				$Id: "e1"
			});
			function* act(): IGen {
				yield* lib.parallel(fails("boom 1"), fails("boom 2"));
			}
			log(`a=${await outcome(h.runtime.dispatch(act, "e1"))}`);
		}
	},

	"a leading action dispatched during a deferred fan-out end is dropped": {
		recordOrderMoves: true,
		run: async ({ lib, log, open }) => {
			const h = open();
			let n = 0;
			function* sync(): IGen {
				return 1;
			}
			const act = lib.leading(function* act(draft: any): IGen {
				const me = ++n;
				yield* lib.parallel(sync());
				draft.items.push(me);
			});
			const a = h.runtime.dispatch(act, "e1");
			const b = h.runtime.dispatch(act, "e1");
			await a;
			await b;
			log(`items=${JSON.stringify(h.runtime.state.items)}`);
		}
	},

	"a publish from a branch's first slice: the receiver starts after the publisher resumes": {
		recordOrderMoves: true,
		run: async ({ log, open, lib }) => {
			const h = open({
				$Id: "e1",
				r: {
					$Id: "r1"
				}
			});
			const Pinged = lib.receiver<any>("SideBySidePinged")({
				["Ping" as any]: function* (): IGen {
					log("receiver runs");
				}
			});
			h.runtime.registerReceiver(Pinged);
			function* setup(draft: any): IGen {
				lib.bind(draft.r, Pinged);
			}
			await h.runtime.dispatch(setup, "e1");
			function* br(): IGen {
				yield* (lib.publish as any)("Ping");
				log("branch after publish");
			}
			function* act(): IGen {
				yield* lib.parallel(br());
				log("parent");
			}
			const a = h.runtime.dispatch(act, "e1");
			log("dispatched");
			await a;
		}
	},

	"a start from a branch on a free entity": {
		recordOrderMoves: true,
		run: async ({ lib, log, open, flush }) => {
			const h = open({
				$Id: "e1",
				r: {
					$Id: "e2"
				}
			});
			function* other(): IGen {
				log("other first step");
				yield* wait("o");
				log("other resumed");
			}
			function* br(): IGen {
				yield* lib.start(other as any, "e2");
				log("branch after start");
			}
			function* act(): IGen {
				yield* lib.parallel(br(), br());
				log("parent");
			}
			const a = h.runtime.dispatch(act, "e1");
			log("dispatched");
			await a;
			h.get("o").resolve(1);
			await flush();
		}
	},

	"open(parallel(waiting branches)) with another action queued": {
		recordOrderMoves: true,
		run: async ({ lib, log, open, flush }) => {
			const h = open();
			function* br(k: string): IGen {
				yield* wait(k);
				log(`branch ${k}`);
			}
			function* act(draft: any): IGen {
				yield* lib.open(lib.parallel(br("x"), br("y")) as any);
				log("after open");
				draft.items.push("p");
			}
			function* other(draft: any): IGen {
				log("other runs");
				draft.items.push("o");
				yield* wait("z");
				log("other resumed");
				draft.items.push("o2");
			}
			const a = h.runtime.dispatch(act, "e1");
			const b = h.runtime.dispatch(other, "e1");
			await flush();
			h.get("x").resolve(1);
			h.get("y").resolve(1);
			await flush();
			log("z");
			h.get("z").resolve(1);
			await a;
			await b;
			await flush();
			log(`items=${JSON.stringify(h.runtime.state.items)}`);
		}
	},

	"a latest replacement dispatched from inside a lone branch's step": {
		run: async ({ lib, log, open, flush }) => {
			const h = open();
			let n = 0;
			const act: any = lib.latest(function* act(_draft: any): IGen {
				if (++n > 1) {
					log("replacement runs");
					return;
				}
				function* br(): IGen {
					yield* wait("x");
					void h.runtime.dispatch(act, "e1");
					log("branch past dispatch");
					throw new Error("after stop");
				}
				try {
					yield* lib.parallel(br());
					log("after parallel");
				} catch (e) {
					log(`caught ${(e as Error).message}`);
				} finally {
					log("finally");
				}
			});
			const a = h.runtime.dispatch(act, "e1");
			await flush();
			h.get("x").resolve(1);
			await a;
		}
	},

	"a parent resumes in the same tick as its last branch's answer on the tree, after a microtask on the baseline": {
		run: async ({ lib, log, open, flush, tick }) => {
			const h = open();
			function* br(draft: any, key: string): IGen {
				yield* wait(key);
				draft.items.push(key);
				log(`body ${key}`);
			}
			function* act(draft: any): IGen {
				yield* lib.parallel(br(draft, "x"), br(draft, "x"));
				log("body parent");
			}
			const done = h.runtime.dispatch(act, "e1");
			await flush();
			h.get("x").resolve(1);
			tick();
			await done;
		},
		differs: (tree, baseline) => {
			expect(tree.code).toEqual([
				"body x",
				"body x",
				"body parent",
				"tick"
			]);
			expect(baseline.code).toEqual([
				"body x",
				"body x",
				"tick",
				"body parent"
			]);
			expect(tree.reports).toEqual(baseline.reports);
			expect(
				[
					...tree.records
				].sort()
			).toEqual(
				[
					...baseline.records
				].sort()
			);
		}
	},

	"record order within a tick: two branches whose answers settle together, each branch:end right after its own response on the tree": {
		run: async ({ lib, log, open }) => {
			const h = open(undefined, {
				echo: (effect: any) => effect.Payload
			});
			function* leg(payload: string): IGen {
				yield {
					Type: "echo",
					Payload: payload
				};
				return payload;
			}
			function* act(draft: any): IGen {
				const results: string[] = yield* lib.parallel(leg("a"), leg("b"));
				draft.items.push(results.join("+"));
				log(results.join("+"));
			}
			await h.runtime.dispatch(act, "e1");
		},
		differs: (tree, baseline) => {
			const start = [
				"action:start #1 act",
				"effect parallel br=#1",
				"branch:start br=#2 parent=#1",
				"effect echo br=#2",
				"branch:start br=#3 parent=#1",
				"effect echo br=#3"
			];
			const end = [
				"branch:end br=#3 completed",
				"response parallel",
				"step br=#1 n=2",
				"action:end #1 completed"
			];
			expect(tree.records).toEqual([
				...start,
				"response echo",
				"branch:end br=#2 completed",
				"response echo",
				...end
			]);
			expect(baseline.records).toEqual([
				...start,
				"response echo",
				"response echo",
				"branch:end br=#2 completed",
				...end
			]);
			expect(tree.code).toEqual(baseline.code);
			expect(tree.reports).toEqual(baseline.reports);
		}
	},

	"a failing branch stops its sibling, which closes a microtask after the stop": {
		run: async ({ lib, log, open, flush, tick }) => {
			const h = open();
			function* thrower(): IGen {
				yield* wait("x");
				log("thrower throws");
				throw new Error("boom");
			}
			function* waiter(): IGen {
				try {
					yield* wait("never");
				} finally {
					log("waiter finally");
				}
			}
			function* act(): IGen {
				try {
					yield* lib.parallel(thrower(), waiter());
				} catch (e) {
					log(`parent caught ${(e as Error).message}`);
				}
			}
			const done = h.runtime.dispatch(act, "e1");
			await flush();
			h.get("x").resolve(1);
			tick();
			await done;
		}
	},

	"a stopped action with branches lets go of its hold a microtask sooner on the tree": {
		run: async ({ lib, log, open, flush, tick }) => {
			const h = open();
			let run = 0;
			function* br(key: string): IGen {
				try {
					yield* wait(key);
				} finally {
					log(`body ${key} finally`);
				}
			}
			const act = lib.latest(function* act(_draft: any): IGen {
				const n = ++run;
				if (n > 1) {
					log("replacement first step");
					yield* wait(`r${n}`);
					return;
				}
				try {
					yield* lib.parallel(br("a1"), br("b1"));
				} finally {
					log("body parent finally");
				}
			});
			void h.runtime.dispatch(act, "e1");
			await flush();
			void h.runtime.dispatch(act, "e1");
			tick();
			void Promise.resolve()
				.then(() => {})
				.then(() => log("second tick"));
			await flush();
		},
		differs: (tree, baseline) => {
			expect(tree.code).toEqual([
				"body a1 finally",
				"body b1 finally",
				"body parent finally",
				"tick",
				"replacement first step",
				"second tick"
			]);
			expect(baseline.code).toEqual([
				"body a1 finally",
				"body b1 finally",
				"body parent finally",
				"tick",
				"second tick",
				"replacement first step"
			]);
			expect(tree.reports).toEqual(baseline.reports);
			expect(
				[
					...tree.records
				].sort()
			).toEqual(
				[
					...baseline.records
				].sort()
			);
		}
	},

	"a stopped action without branches lets go of its hold": {
		run: async ({ lib, log, open, flush, tick }) => {
			const h = open();
			let run = 0;
			const act = lib.latest(function* act(_draft: any): IGen {
				const n = ++run;
				if (n > 1) {
					log("replacement first step");
					yield* wait(`r${n}`);
					return;
				}
				try {
					yield* wait("a1");
				} finally {
					log("body parent finally");
				}
			});
			void h.runtime.dispatch(act, "e1");
			await flush();
			void h.runtime.dispatch(act, "e1");
			tick();
			void Promise.resolve()
				.then(() => {})
				.then(() => log("second tick"));
			await flush();
		}
	},

	"a stop dispatched 0 to 7 microtasks after a failing parallel's last answer: the baseline stops the parent first at the first five delays and routes the failure to onError":
		{
			run: stopAfterFailingParallel({}),
			differs: (tree, baseline) => {
				expect(tree.code).toEqual(stopWindowRows(0));
				expect(tree.reports).toEqual([]);
				expect(tree.unhandled).toEqual([]);
				expect(baseline.code).toEqual(stopWindowRows(5));
				expect(baseline.reports).toEqual(
					new Array(5)
						.fill([
							"onError f",
							"failure f status=cancelled close=false taken=true"
						])
						.flat()
				);
				expect(baseline.unhandled).toEqual([]);
			}
		},

	"the same with no onError: the baseline leaves an unhandled rejection at each of the first five delays": {
		run: stopAfterFailingParallel({
			noOnError: true
		}),
		differs: (tree, baseline) => {
			expect(tree.code).toEqual(stopWindowRows(0));
			expect(tree.reports).toEqual([]);
			expect(tree.unhandled).toEqual([]);
			expect(baseline.code).toEqual(stopWindowRows(5));
			expect(baseline.reports).toEqual(new Array(5).fill("failure f status=cancelled close=false taken=false"));
			expect(baseline.unhandled).toEqual(new Array(5).fill("f"));
		}
	}
};

function stopWindowRows(stoppedFirst: number): string[] {
	return Array.from(
		{
			length: 8
		},
		(_, delay) => `delay ${delay}: ${delay < stoppedFirst ? "[]" : '["caught","after"]'}`
	);
}

function stopAfterFailingParallel(options: { noOnError?: true }): IScenario {
	return async ({ lib, log, open }) => {
		for (let delay = 0; delay <= 7; delay++) {
			let release!: (value: unknown) => void;
			const gate = new Promise((r) => {
				release = r;
			});
			const h = open(
				undefined,
				{
					wait: (effect: any) => (effect.Key === "x" ? gate : new Promise(() => {}))
				},
				options
			);
			let run = 0;
			function* br(): IGen {
				yield* wait("x");
				throw new Error("f");
			}
			const act = lib.latest(function* act(draft: any): IGen {
				if (++run > 1) {
					return;
				}
				try {
					yield* lib.parallel(br());
				} catch {
					draft.items.push("caught");
				}
				draft.items.push("after");
				yield* wait("never");
			});
			const first = h.runtime.dispatch(act, "e1").catch(() => {});
			for (let i = 0; i < 20; i++) {
				await Promise.resolve();
			}
			release(1);
			let p: Promise<unknown> = Promise.resolve();
			for (let i = 0; i < delay; i++) {
				p = p.then(() => {});
			}
			await p.then(() => h.runtime.dispatch(act, "e1"));
			await first;
			log(`delay ${delay}: ${JSON.stringify(h.runtime.state.items)}`);
		}
	};
}

function assertSame(name: string, run: ICase, tree: IRun, baseline: IRun): void {
	expect(tree.code, `${name}: what the code logged`).toEqual(baseline.code);
	expect(tree.reports, `${name}: onError, failure and diag`).toEqual(baseline.reports);
	expect(tree.unhandled, `${name}: unhandled rejections`).toEqual(baseline.unhandled);
	expect(
		[
			...tree.records
		].sort(),
		`${name}: records as a set`
	).toEqual(
		[
			...baseline.records
		].sort()
	);
	if (run.recordOrderMoves) {
		expect(tree.records, `${name}: records in order`).not.toEqual(baseline.records);
	} else {
		expect(tree.records, `${name}: records in order`).toEqual(baseline.records);
	}
}

describe.skipIf(engines === null)(
	engines === null
		? `side by side with the baseline engine: skipped, ${baselineMissing}`
		: `side by side with the baseline engine at ${baselineRef}`,
	() => {
		it("the baseline is a separate copy of the engine", () => {
			expect(engines!.baseline).not.toBe(engines!.tree);
			expect(engines!.baseline.createTestRuntime).not.toBe(engines!.tree.createTestRuntime);
		});

		const node = (globalThis as any).process;
		const show = node?.env?.SIDE_BY_SIDE_SHOW !== undefined;
		for (const [name, entry] of Object.entries(cases)) {
			it(entry.recordOrderMoves ? `${name}: the same, with records reordered within a tick` : name, async () => {
				const tree = await runOn(engines!.tree, entry.run);
				const baseline = await runOn(engines!.baseline, entry.run);
				if (show) {
					node.stderr.write(
						`=== ${name}\n--- tree\n${JSON.stringify(tree, null, 1)}\n--- baseline\n${JSON.stringify(baseline, null, 1)}\n`
					);
				}
				expect(tree.records.length, "the tree engine ran").toBeGreaterThan(0);
				expect(baseline.records.length, "the baseline engine ran").toBeGreaterThan(0);
				if (entry.differs) {
					entry.differs(tree, baseline);
				} else {
					assertSame(name, entry, tree, baseline);
				}
			});
		}
	}
);
