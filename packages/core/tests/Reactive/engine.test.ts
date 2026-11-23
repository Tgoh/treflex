import { afterEach, describe, expect, it, vi } from "vitest";
import {
	batch,
	type Computation,
	createComputation,
	createRoot,
	onCleanup,
	runUnowned,
	Signal,
	trackedReads,
	untrack
} from "../../src/Reactive/engine";

function effect(fn: () => void): Computation<void> {
	return createComputation(fn, false, false);
}

function memo<T>(fn: () => T): Computation<T> {
	return createComputation(fn, (a, b) => a === b, false);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the engine", () => {
	describe("dispose", () => {
		it("keeps a computation queued in the running flush from running", () => {
			const source = new Signal(0);
			let victim!: Computation<void>;
			let victimRuns = 0;
			effect(() => {
				if (source.read() === 1) {
					victim.dispose();
				}
			});
			victim = effect(() => {
				source.read();
				victimRuns++;
			});
			source.write(1);
			expect(victimRuns).toBe(1);
			expect(source.observers).toHaveLength(1);
		});

		it("during the computation's own run leaves it subscribed to nothing and notifies no one", () => {
			const source = new Signal(0);
			const later = new Signal(0);
			let self!: Computation<number>;
			let readerRuns = 0;
			self = memo(() => {
				const n = source.read();
				if (n === 1) {
					self.dispose();
					later.read();
				}
				return n;
			});
			effect(() => {
				self.read();
				readerRuns++;
			});
			source.write(1);
			expect(source.observers).toEqual([]);
			expect(later.observers ?? []).toEqual([]);
			expect(readerRuns).toBe(1);
			expect(self.read()).toBe(0);
		});

		it("is a no-op the second time", () => {
			let cleaned = 0;
			const node = effect(() => {
				onCleanup(() => cleaned++);
			});
			node.dispose();
			node.dispose();
			expect(cleaned).toBe(1);
		});
	});

	describe("a write during a run", () => {
		it("to a source read last run but not yet in this one does not re-run it", () => {
			const a = new Signal(0);
			const b = new Signal(0);
			const seen: string[] = [];
			effect(() => {
				const first = a.read();
				if (first === 1 && b.value === 0) {
					b.write(1);
				}
				seen.push(`${first},${b.read()}`);
			});
			a.write(1);
			expect(seen).toEqual([
				"0,0",
				"1,1"
			]);
		});

		it("in a pull inside a batch waits for the batch's flush", () => {
			const source = new Signal(0);
			const target = new Signal(0);
			const order: string[] = [];
			const writer = memo(() => {
				const n = source.read();
				if (n === 1) {
					target.write(1);
				}
				return n;
			});
			effect(() => {
				order.push(`reader ${target.read()}`);
			});
			batch(() => {
				source.write(1);
				writer.read();
				order.push("batch body ends");
			});
			expect(order).toEqual([
				"reader 0",
				"batch body ends",
				"reader 1"
			]);
		});

		it("made by a nested pull to a source the puller already read re-runs the puller, so its last run sees it", () => {
			const v0 = new Signal(0);
			const v1 = new Signal(0);
			const v2 = new Signal(0);
			let armed = false;
			const finished: string[] = [];
			const m0 = memo(() => {
				if (armed) {
					armed = false;
					untrack(() => v1.write(v1.value + 1));
				}
				return v1.read();
			});
			const m1 = memo(() => m0.read());
			const m2 = memo(() => {
				const first = v1.read();
				const fromM1 = m1.read();
				const last = v1.read() % 2 === 1 ? v2.read() : v0.read();
				finished.push(`saw v1=${first}`);
				return first + fromM1 + last;
			});
			finished.length = 0;
			armed = true;
			batch(() => {
				v0.write(1);
				v1.write(1);
			});
			expect(finished).toEqual([
				"saw v1=1",
				"saw v1=2"
			]);
			expect(m2.read()).toBe(5);
		});
	});

	describe("a throwing computation", () => {
		it("keeps its value and the sources it read before the throw", () => {
			const before = new Signal(0);
			const after = new Signal(0);
			let runs = 0;
			const node = memo(() => {
				runs++;
				const n = before.read();
				if (n === 1) {
					throw new Error("boom");
				}
				after.read();
				return n;
			});
			expect(() => before.write(1)).toThrow("boom");
			expect(node.read()).toBe(0);
			after.write(1);
			expect(runs).toBe(2);
			before.write(2);
			expect(runs).toBe(3);
			expect(node.read()).toBe(2);
		});

		it("lets the rest of the flush run, throws the first error and surfaces the others in microtasks", () => {
			const queued: (() => void)[] = [];
			vi.stubGlobal("queueMicrotask", (task: () => void) => {
				queued.push(task);
			});
			const source = new Signal(0);
			const seen: number[] = [];
			effect(() => {
				if (source.read() === 1) {
					throw new Error("first");
				}
			});
			effect(() => {
				if (source.read() === 1) {
					throw new Error("second");
				}
			});
			effect(() => seen.push(source.read()));
			expect(() => source.write(1)).toThrow("first");
			expect(seen).toEqual([
				0,
				1
			]);
			expect(queued).toHaveLength(1);
			expect(() => queued[0]!()).toThrow("second");
		});

		it("in a batch whose callback throws too: the callback's error wins and the flush's surfaces once", () => {
			const queued: (() => void)[] = [];
			vi.stubGlobal("queueMicrotask", (task: () => void) => {
				queued.push(task);
			});
			const source = new Signal(0);
			effect(() => {
				if (source.read() === 1) {
					throw new Error("flush");
				}
			});
			expect(() =>
				batch(() => {
					source.write(1);
					throw new Error("callback");
				})
			).toThrow("callback");
			expect(queued).toHaveLength(1);
			expect(() => queued[0]!()).toThrow("flush");
		});
	});

	describe("nested batches", () => {
		it("flush once, at the outermost exit, even when an inner one throws", () => {
			const source = new Signal(0);
			const seen: number[] = [];
			effect(() => seen.push(source.read()));
			batch(() => {
				expect(() =>
					batch(() => {
						source.write(1);
						throw new Error("inner");
					})
				).toThrow("inner");
				expect(seen).toEqual([
					0
				]);
				source.write(2);
			});
			expect(seen).toEqual([
				0,
				2
			]);
		});
	});

	describe("cycles", () => {
		it("a computation reading itself gets its previous value instead of re-entering", () => {
			let self!: Computation<number>;
			let runs = 0;
			const source = new Signal(1);
			self = memo((): number => {
				runs++;
				const previous = runs === 1 ? 0 : self.read();
				return Math.min(previous + source.read(), 3);
			});
			expect(self.read()).toBe(1);
			source.write(2);
			expect(self.read()).toBe(3);
			expect(runs).toBeLessThan(10);
		});

		it("two computations reading each other settle once their values do", () => {
			const source = new Signal(1);
			let right: Computation<number> | undefined;
			const left = memo(() => Math.min(source.read() + (right === undefined ? 0 : right.read()), 5));
			right = memo(() => left.read());
			source.write(2);
			expect(left.read()).toBe(5);
			expect(right.read()).toBe(5);
		});

		it("abandons a runaway flush and leaves the computations it dropped live", () => {
			const loop = new Signal(0);
			let armed = true;
			let loopRuns = 0;
			let watcherRuns = 0;
			effect(() => {
				loopRuns++;
				const n = loop.read();
				if (armed && n > 0) {
					loop.write(n + 1);
				}
			});
			effect(() => {
				watcherRuns++;
				loop.read();
			});
			expect(() => loop.write(1)).toThrow(/Potential infinite loop/);
			armed = false;
			const before = [
				loopRuns,
				watcherRuns
			];
			loop.write(-1);
			expect([
				loopRuns - before[0]!,
				watcherRuns - before[1]!
			]).toEqual([
				1,
				1
			]);
		});
	});

	describe("trackedReads", () => {
		it("counts a repeat once, unless a computation built in between read the same source, as Solid does", () => {
			const source = new Signal(0);
			const counts: number[] = [];
			effect(() => {
				source.read();
				source.read();
				counts.push(trackedReads());
				memo(() => source.read());
				source.read();
				counts.push(trackedReads());
			});
			expect(counts).toEqual([
				1,
				2
			]);
		});

		it("is zero outside a computation", () => {
			expect(trackedReads()).toBe(0);
		});
	});

	describe("edges", () => {
		it("keeps one edge per source when a run reads its sources in a new order", () => {
			const a = new Signal(0);
			const b = new Signal(0);
			const flip = new Signal(false);
			let runs = 0;
			effect(() => {
				runs++;
				if (flip.read()) {
					b.read();
					a.read();
				} else {
					a.read();
					b.read();
				}
			});
			flip.write(true);
			expect(a.observers).toHaveLength(1);
			expect(b.observers).toHaveLength(1);
			a.write(1);
			b.write(1);
			expect(runs).toBe(4);
		});

		it("follows the reads once their order diverges from the last run's", () => {
			const phase = new Signal(0);
			const a = new Signal(0);
			const b = new Signal(0);
			const c = new Signal(0);
			const d = new Signal(0);
			let runs = 0;
			effect(() => {
				runs++;
				const p = phase.read();
				if (p === 0) {
					a.read();
					b.read();
					c.read();
				} else if (p === 1) {
					c.read();
				} else {
					a.read();
					d.read();
					c.read();
				}
			});
			phase.write(1);
			const afterNarrow = runs;
			a.write(1);
			b.write(1);
			expect(runs).toBe(afterNarrow);
			c.write(1);
			expect(runs).toBe(afterNarrow + 1);
			phase.write(2);
			const afterWiden = runs;
			b.write(2);
			expect(runs).toBe(afterWiden);
			for (const source of [
				a,
				d,
				c
			]) {
				source.write(source.value + 10);
			}
			expect(runs).toBe(afterWiden + 3);
			expect(b.observers).toEqual([]);
		});

		it("drops the sources a run no longer reads", () => {
			const gate = new Signal(true);
			const extra = new Signal(0);
			let runs = 0;
			effect(() => {
				runs++;
				if (gate.read()) {
					extra.read();
				}
			});
			gate.write(false);
			expect(extra.observers).toEqual([]);
			extra.write(1);
			expect(runs).toBe(2);
		});
	});

	describe("owners and cleanups", () => {
		it("disposes the computations a run created before the next run, newest first, with their cleanups", () => {
			const outer = new Signal(0);
			const order: string[] = [];
			effect(() => {
				const n = outer.read();
				effect(() => {
					onCleanup(() => order.push(`first child of ${n}`));
				});
				effect(() => {
					onCleanup(() => order.push(`second child of ${n}`));
				});
				onCleanup(() => order.push(`parent ${n}`));
			});
			outer.write(1);
			expect(order).toEqual([
				"second child of 0",
				"first child of 0",
				"parent 0"
			]);
		});

		it("keeps a detached computation alive through its creator's next run", () => {
			const outer = new Signal(0);
			const inner = new Signal(0);
			let innerRuns = 0;
			effect(() => {
				if (outer.read() === 0) {
					createComputation(
						() => {
							inner.read();
							innerRuns++;
						},
						false,
						true
					);
				}
			});
			outer.write(1);
			inner.write(1);
			expect(innerRuns).toBe(2);
		});

		it("a root's dispose disposes what it owns and runs its own cleanups", () => {
			const source = new Signal(0);
			const order: string[] = [];
			let runs = 0;
			const dispose = createRoot((d) => {
				effect(() => {
					source.read();
					runs++;
					onCleanup(() => order.push("effect"));
				});
				onCleanup(() => order.push("root"));
				return d;
			});
			dispose();
			source.write(1);
			expect(runs).toBe(1);
			expect(order).toEqual([
				"effect",
				"root"
			]);
		});

		it("runUnowned creates computations no root disposes", () => {
			const source = new Signal(0);
			let runs = 0;
			const dispose = createRoot((d) => {
				runUnowned(() =>
					effect(() => {
						source.read();
						runs++;
					})
				);
				return d;
			});
			dispose();
			source.write(1);
			expect(runs).toBe(2);
		});

		it("a cleanup that throws stops that dispose there and reaches the caller", () => {
			const order: string[] = [];
			const dispose = createRoot((d) => {
				onCleanup(() => order.push("never"));
				onCleanup(() => {
					throw new Error("cleanup");
				});
				return d;
			});
			expect(dispose).toThrow("cleanup");
			expect(order).toEqual([]);
		});
	});

	describe("memo equality", () => {
		it("is not asked about the first value", () => {
			const equals = vi.fn((a: number, b: number) => a === b);
			const source = new Signal(1);
			createComputation(() => source.read(), equals, false);
			expect(equals).not.toHaveBeenCalled();
			source.write(2);
			expect(equals).toHaveBeenCalledWith(1, 2);
		});
	});
});
