import type { IVersion } from "../../src/Reactive/IReactiveHost";
import { describe, expect, it } from "vitest";
import * as engine from "../../src/Reactive/engine";
import { host } from "../../src/Reactive/host";

function observe<T>(read: () => T) {
	let runs = 0;
	const memo = host.createOwnedMemo(() => {
		runs++;
		return read();
	});
	return {
		runs: () => runs,
		read: memo.read,
		dispose: memo.dispose
	};
}

describe("the host", () => {
	describe("versions", () => {
		it("notify on every bump, the value never compared", () => {
			const version = host.createVersion();
			const seen = observe(() => version.track());
			version.bump();
			version.bump();
			expect(seen.runs()).toBe(3);
			seen.dispose();
		});
	});

	describe("isTracking", () => {
		it("is true only while a computation runs, and false inside untrack and runUnowned", () => {
			const during: boolean[] = [];
			expect(host.isTracking()).toBe(false);
			const seen = observe(() => {
				during.push(host.isTracking());
				during.push(host.untrack(() => host.isTracking()));
				during.push(host.runUnowned(() => host.isTracking()));
			});
			expect(during).toEqual([
				true,
				false,
				false
			]);
			expect(host.isTracking()).toBe(false);
			seen.dispose();
		});
	});

	describe("trackedReads", () => {
		it("counts each source a run reads once, from zero each run", () => {
			const a = host.createVersion();
			const b = host.createVersion();
			const counts: number[][] = [];
			let second = false;
			const seen = observe(() => {
				const run: number[] = [
					host.trackedReads()
				];
				a.track();
				a.track();
				run.push(host.trackedReads());
				if (!second) {
					b.track();
					a.track();
					run.push(host.trackedReads());
				}
				counts.push(run);
			});
			second = true;
			a.bump();
			expect(counts).toEqual([
				[
					0,
					1,
					2
				],
				[
					0,
					1
				]
			]);
			expect(host.trackedReads()).toBe(0);
			seen.dispose();
		});

		it("does not count what a run reads untracked", () => {
			const a = host.createVersion();
			let count = -1;
			const seen = observe(() => {
				host.untrack(() => a.track());
				count = host.trackedReads();
			});
			expect(count).toBe(0);
			seen.dispose();
		});
	});

	describe("createOwnedMemo", () => {
		it("is not owned by the computation that built it, and subscribes it to nothing until it reads", () => {
			const outerSource = host.createVersion();
			const innerSource = host.createVersion();
			let inner!: ReturnType<typeof observe<number>>;
			let value = 1;
			const outer = observe(() => {
				outerSource.track();
				inner ??= observe(() => {
					innerSource.track();
					return value;
				});
			});
			outerSource.bump();
			expect(outer.runs()).toBe(2);
			innerSource.bump();
			expect(inner.runs()).toBe(2);
			expect(outer.runs()).toBe(2);
			const reader = observe(() => inner.read());
			value = 2;
			innerSource.bump();
			expect(reader.runs()).toBe(2);
			expect(reader.read()).toBe(2);
			reader.dispose();
			inner.dispose();
			outer.dispose();
		});

		it("is eager: it re-runs in the flush of a write it read, unread", () => {
			const version = host.createVersion();
			const seen = observe(() => version.track());
			version.bump();
			expect(seen.runs()).toBe(2);
			seen.dispose();
			version.bump();
			expect(seen.runs()).toBe(2);
		});

		it("answers a read inside a batch with the batch's writes", () => {
			const version = host.createVersion();
			let n = 0;
			const seen = observe(() => {
				version.track();
				return n;
			});
			host.batch(() => {
				n = 1;
				version.bump();
				expect(seen.read()).toBe(1);
			});
			expect(seen.runs()).toBe(2);
			seen.dispose();
		});

		it("answers a read at the end of a chain inside a batch with the batch's writes", () => {
			const version = host.createVersion();
			let n = 0;
			const m1 = observe(() => {
				version.track();
				return n;
			});
			const m2 = observe(() => m1.read() + 1);
			const m3 = observe(() => m2.read() * 10);
			host.batch(() => {
				n = 1;
				version.bump();
				expect(m3.read()).toBe(20);
			});
			expect(m3.runs()).toBe(2);
			for (const memo of [
				m3,
				m2,
				m1
			]) {
				memo.dispose();
			}
		});

		it("answers a read of a diamond's join inside a batch with the batch's writes", () => {
			const version = host.createVersion();
			let n = 0;
			const top = observe(() => {
				version.track();
				return n;
			});
			const left = observe(() => top.read() + 1);
			const right = observe(() => top.read() * 2);
			const join = observe(() => left.read() + right.read());
			host.batch(() => {
				n = 1;
				version.bump();
				expect(join.read()).toBe(4);
			});
			expect(join.runs()).toBe(2);
			for (const memo of [
				join,
				right,
				left,
				top
			]) {
				memo.dispose();
			}
		});

		it("notifies readers only when its value changes, and every time it fails", () => {
			const version = host.createVersion();
			let mode: "same" | "fail" = "same";
			const inner = observe(() => {
				version.track();
				if (mode === "fail") {
					throw new Error("inner failed");
				}
				return 7;
			});
			const outer = observe(() => {
				try {
					return inner.read();
				} catch {
					return -1;
				}
			});
			version.bump();
			expect(inner.runs()).toBe(2);
			expect(outer.runs()).toBe(1);
			mode = "fail";
			version.bump();
			version.bump();
			expect(outer.runs()).toBe(3);
			expect(() => inner.read()).toThrow("inner failed");
			outer.dispose();
			inner.dispose();
		});

		it("holds a compute's error for its readers: the write that made it fail does not throw", () => {
			const version = host.createVersion();
			let fail = false;
			const failing = observe(() => {
				version.track();
				if (fail) {
					throw new Error("compute failed");
				}
				return 1;
			});
			const sibling = observe(() => version.track());
			fail = true;
			expect(() => version.bump()).not.toThrow();
			expect(sibling.runs()).toBe(2);
			expect(() => failing.read()).toThrow("compute failed");
			expect(() => failing.read()).toThrow("compute failed");
			failing.dispose();
			sibling.dispose();
		});

		it("runs a diamond's join once per flush", () => {
			const version = host.createVersion();
			let n = 0;
			const top = observe(() => {
				version.track();
				return n;
			});
			const left = observe(() => top.read() + 1);
			const right = observe(() => top.read() * 2);
			const join = observe(() => left.read() + right.read());
			n = 1;
			version.bump();
			expect(join.runs()).toBe(2);
			expect(join.read()).toBe(4);
			for (const memo of [
				join,
				right,
				left,
				top
			]) {
				memo.dispose();
			}
		});
	});

	describe("batch", () => {
		it("nests, flushing once at the outermost exit; a write outside any batch flushes at once", () => {
			const version = host.createVersion();
			const seen = observe(() => version.track());
			host.batch(() => {
				host.batch(() => {
					version.bump();
					version.bump();
				});
				expect(seen.runs()).toBe(1);
				version.bump();
			});
			expect(seen.runs()).toBe(2);
			version.bump();
			expect(seen.runs()).toBe(3);
			seen.dispose();
		});

		it("returns the callback's value", () => {
			expect(host.batch(() => 7)).toBe(7);
		});

		it("flushes the writes before a throw from its callback, then rethrows it", () => {
			const version = host.createVersion();
			const seen = observe(() => version.track());
			expect(() =>
				host.batch(() => {
					version.bump();
					throw new Error("refused");
				})
			).toThrow("refused");
			expect(seen.runs()).toBe(2);
			version.bump();
			expect(seen.runs()).toBe(3);
			seen.dispose();
		});
	});

	describe("untrack and runUnowned", () => {
		it("untrack clears the listener and keeps the owner", () => {
			const read = host.createVersion();
			const quiet = host.createVersion();
			const cleaned: string[] = [];
			const seen = observe(() => {
				read.track();
				host.untrack(() => {
					quiet.track();
					host.onCleanup(() => cleaned.push("untracked"));
				});
			});
			quiet.bump();
			expect(seen.runs()).toBe(1);
			read.bump();
			expect(seen.runs()).toBe(2);
			expect(cleaned).toEqual([
				"untracked"
			]);
			seen.dispose();
		});

		it("runUnowned clears the listener and the owner", () => {
			const read = host.createVersion();
			const quiet = host.createVersion();
			const cleaned: string[] = [];
			const seen = observe(() => {
				read.track();
				host.runUnowned(() => {
					quiet.track();
					host.onCleanup(() => cleaned.push("unowned"));
				});
			});
			quiet.bump();
			read.bump();
			seen.dispose();
			expect(seen.runs()).toBe(2);
			expect(cleaned).toEqual([]);
		});
	});

	describe("onCleanup", () => {
		it("runs a computation's cleanups before its next run and at its dispose, newest first", () => {
			const version = host.createVersion();
			const order: string[] = [];
			let run = 0;
			const seen = observe(() => {
				version.track();
				run++;
				const at = run;
				host.onCleanup(() => order.push(`first ${at}`));
				host.onCleanup(() => order.push(`second ${at}`));
				order.push(`run ${at}`);
			});
			version.bump();
			seen.dispose();
			version.bump();
			expect(order).toEqual([
				"run 1",
				"second 1",
				"first 1",
				"run 2",
				"second 2",
				"first 2"
			]);
		});

		it("does nothing outside any owner", () => {
			let ran = false;
			host.onCleanup(() => {
				ran = true;
			});
			expect(ran).toBe(false);
		});
	});

	describe("a write during a computation's run", () => {
		function harness() {
			const a = host.createVersion();
			const b = host.createVersion();
			const go = host.createVersion();
			let n = 0;
			return {
				a,
				b,
				go,
				n: () => n,
				set: (next: number, version: IVersion) => {
					n = next;
					version.bump();
				}
			};
		}

		it("to a source it read in this run re-runs it after the run, in the same flush", () => {
			const h = harness();
			const seen: number[] = [];
			let armed = false;
			const memo = observe(() => {
				h.go.track();
				h.a.track();
				seen.push(h.n());
				if (armed && h.n() === 0) {
					h.set(1, h.a);
				}
			});
			armed = true;
			h.go.bump();
			expect(seen).toEqual([
				0,
				0,
				1
			]);
			memo.dispose();
		});

		it("to a source it reads later in the run does not re-run it", () => {
			const h = harness();
			const seen: number[] = [];
			let armed = false;
			const memo = observe(() => {
				h.go.track();
				if (armed && h.n() === 0) {
					h.set(1, h.a);
				}
				h.a.track();
				seen.push(h.n());
			});
			armed = true;
			h.go.bump();
			expect(seen).toEqual([
				0,
				1
			]);
			memo.dispose();
		});

		it("to a source it does not read does not re-run it, and runs that source's readers", () => {
			const h = harness();
			let armed = false;
			const writer = observe(() => {
				h.go.track();
				if (armed) {
					h.set(1, h.b);
				}
			});
			const reader = observe(() => {
				h.b.track();
				return h.n();
			});
			armed = true;
			h.go.bump();
			expect(writer.runs()).toBe(2);
			expect(reader.runs()).toBe(2);
			expect(reader.read()).toBe(1);
			reader.dispose();
			writer.dispose();
		});

		it("inside untrack counts as a write all the same", () => {
			const h = harness();
			const seen: number[] = [];
			let armed = false;
			const memo = observe(() => {
				h.go.track();
				h.a.track();
				seen.push(h.n());
				if (armed && h.n() === 0) {
					host.untrack(() => h.set(1, h.a));
				}
			});
			armed = true;
			h.go.bump();
			expect(seen).toEqual([
				0,
				0,
				1
			]);
			memo.dispose();
		});

		it("in the first run re-runs it once that run is over", () => {
			const h = harness();
			const seen: number[] = [];
			const memo = observe(() => {
				h.a.track();
				seen.push(h.n());
				if (h.n() === 0) {
					h.set(1, h.a);
				}
				return h.n();
			});
			expect(seen).toEqual([
				0,
				1
			]);
			expect(memo.read()).toBe(1);
			memo.dispose();
		});

		it("re-runs another memo of the same flush, one that already ran included", () => {
			const h = harness();
			const runs: string[] = [];
			const before = observe(() => {
				h.a.track();
				h.b.track();
				runs.push("before");
			});
			const writer = observe(() => {
				h.a.track();
				if (h.n() === 1) {
					h.set(2, h.b);
				}
			});
			const after = observe(() => {
				h.b.track();
				runs.push("after");
			});
			runs.length = 0;
			h.set(1, h.a);
			expect(runs.sort()).toEqual([
				"after",
				"before",
				"before"
			]);
			for (const memo of [
				after,
				writer,
				before
			]) {
				memo.dispose();
			}
		});

		it("disposing a memo queued in the same flush keeps it from running", () => {
			const version = host.createVersion();
			let victim!: ReturnType<typeof observe<void>>;
			const killer = observe(() => {
				version.track();
				if (victim !== undefined) {
					victim.dispose();
				}
			});
			victim = observe(() => version.track());
			version.bump();
			expect(victim.runs()).toBe(1);
			killer.dispose();
		});

		it("settles a cycle of writes that a value bounds", () => {
			const h = harness();
			let left = 0;
			let right = 0;
			const ping = observe(() => {
				h.a.track();
				if (left < 5) {
					right = left + 1;
					h.b.bump();
				}
			});
			const pong = observe(() => {
				h.b.track();
				if (right < 5) {
					left = right + 1;
					h.a.bump();
				}
			});
			expect([
				left,
				right
			]).toEqual([
				4,
				5
			]);
			pong.dispose();
			ping.dispose();
		});
	});

	it("TRACK is a symbol of the engine's own", () => {
		expect(typeof host.TRACK).toBe("symbol");
		expect(Symbol.keyFor(host.TRACK)).toBeUndefined();
	});

	it("batch is the engine's, which flushes the writes before a raw batch's throw", () => {
		expect(host.batch).toBe(engine.batch);
	});

	describe("a computation throwing in a flush", () => {
		it("runs the rest of the flush and then throws the first error", () => {
			const signal = new engine.Signal(0);
			const seen: number[] = [];
			const dispose = engine.createRoot((d) => {
				engine.createComputation(
					() => {
						if (signal.read() === 1) {
							throw new Error("boom");
						}
					},
					false,
					false
				);
				engine.createComputation(() => seen.push(signal.read()), false, false);
				return d;
			});
			expect(() => signal.write(1)).toThrow("boom");
			signal.write(2);
			expect(seen).toEqual([
				0,
				1,
				2
			]);
			dispose();
		});
	});

	describe("a write in a memo's first run, outside any batch", () => {
		it("runs the write's readers once the run is over", () => {
			const version = host.createVersion();
			let n = 0;
			const log: string[] = [];
			const reader = observe(() => {
				version.track();
				log.push(`reader sees ${n}`);
			});
			log.length = 0;
			const writer = observe(() => {
				n++;
				version.bump();
				log.push("writer's run ends");
			});
			writer.dispose();
			reader.dispose();
			expect(log).toEqual([
				"writer's run ends",
				"reader sees 1"
			]);
		});
	});

	describe("a write made by a nested pull to a source the puller already read", () => {
		it("re-runs the puller after its run, so its last run sees the write", () => {
			const values = [
				0,
				0,
				0
			];
			const versions = values.map(() => host.createVersion());
			const read = (k: number) => {
				versions[k]!.track();
				return values[k]!;
			};
			const bump = (k: number) => {
				values[k]!++;
				versions[k]!.bump();
			};
			let armed = false;
			const finished: string[] = [];
			const m0 = host.createOwnedMemo(() => {
				if (armed) {
					armed = false;
					host.untrack(() => bump(1));
				}
				return read(1);
			});
			const m1 = host.createOwnedMemo(() => m0.read());
			const m2 = host.createOwnedMemo(() => {
				const first = read(1);
				const fromM1 = m1.read();
				const last = read(1) % 2 === 1 ? read(2) : read(0);
				finished.push(`saw v1=${first}`);
				return first + fromM1 + last;
			});
			finished.length = 0;
			armed = true;
			host.batch(() => {
				bump(0);
				bump(1);
			});
			const value = m2.read();
			for (const memo of [
				m2,
				m1,
				m0
			]) {
				memo.dispose();
			}
			expect({
				finished,
				value
			}).toEqual({
				finished: [
					"saw v1=1",
					"saw v1=2"
				],
				value: 5
			});
		});
	});

	describe("a computation that keeps writing what it reads", () => {
		it("is stopped by the flush after a million runs, which throws from the write and leaves the memo live", () => {
			const version = host.createVersion();
			let armed = false;
			let runs = 0;
			const memo = host.createOwnedMemo(() => {
				version.track();
				runs++;
				if (armed) {
					version.bump();
				}
			});
			armed = true;
			let thrown: unknown;
			try {
				version.bump();
			} catch (error) {
				thrown = error;
			}
			expect((thrown as Error).message).toMatch(/Potential infinite loop/);
			expect(runs).toBe(1_000_001);
			armed = false;
			const before = runs;
			version.bump();
			expect(runs).toBe(before + 1);
			expect(() => memo.read()).not.toThrow();
			memo.dispose();
		});
	});
});
