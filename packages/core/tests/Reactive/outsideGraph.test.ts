import type { IMirror, IOutsideGraph } from "../../src/Reactive/IReactiveHost";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = Symbol.for("treflex.host.v1");

const slot = globalThis as unknown as Record<symbol, unknown>;

interface IRoot {
	$Id: string;
	Title: string;
	Other: number;
	Items: {
		N: number;
	}[];
}

async function copyOfCore() {
	vi.resetModules();
	const hostModule = await import("../../src/Reactive/host");
	const engine = await import("../../src/Reactive/engine");
	const core = await import("../../src/index");
	const internal = await import("../../src/internal");
	return {
		host: hostModule.host,
		engine,
		internal,
		runtime: () =>
			core.createRuntime<IRoot>({
				$Id: "root",
				Title: "ab",
				Other: 0,
				Items: []
			}) as IRuntimeInternal<IRoot>
	};
}

async function freshCore() {
	delete slot[KEY];
	return copyOfCore();
}

interface IReader {
	runs: number;
	deps: Set<Set<IReader>>;
	disposed: boolean;
	run(): void;
}

function fakeGraph(TRACK: symbol = Symbol("fake-track")) {
	let listener: IReader | null = null;
	const dirty = new Set<IReader>();
	const mirrors: {
		writes: number;
		readers: Set<IReader>;
	}[] = [];
	const graph: IOutsideGraph = {
		TRACK,
		isReading: () => listener !== null,
		untrack<T>(fn: () => T): T {
			const previous = listener;
			listener = null;
			try {
				return fn();
			} finally {
				listener = previous;
			}
		},
		createMirror(): IMirror {
			const made = {
				writes: 0,
				readers: new Set<IReader>()
			};
			mirrors.push(made);
			return {
				track() {
					if (listener !== null) {
						made.readers.add(listener);
						listener.deps.add(made.readers);
					}
				},
				write() {
					made.writes++;
					for (const reader of made.readers) {
						dirty.add(reader);
					}
				}
			};
		}
	};
	function reader(fn: () => void) {
		const node: IReader = {
			runs: 0,
			deps: new Set(),
			disposed: false,
			run() {
				for (const dep of node.deps) {
					dep.delete(node);
				}
				node.deps.clear();
				const previous = listener;
				listener = node;
				node.runs++;
				try {
					fn();
				} finally {
					listener = previous;
				}
			}
		};
		node.run();
		return {
			runs: () => node.runs,
			dispose() {
				node.disposed = true;
				for (const dep of node.deps) {
					dep.delete(node);
				}
			}
		};
	}
	function flush(): void {
		while (dirty.size > 0) {
			const pending = [
				...dirty
			];
			dirty.clear();
			for (const node of pending) {
				if (!node.disposed) {
					node.run();
				}
			}
		}
	}
	return {
		graph,
		reader,
		flush,
		mirrors
	};
}

function* titleLength(draft: IRoot): ISelectorGenerator<number> {
	return draft.Title.length;
}

function* retitle(draft: IRoot, title: string): IActionGenerator {
	draft.Title = title;
}

function* setOther(draft: IRoot, n: number): IActionGenerator {
	draft.Other = n;
}

afterEach(() => {
	delete slot[KEY];
	vi.restoreAllMocks();
});

describe("the outside-graph seam", () => {
	describe("with nothing registered", () => {
		it("leaves the engine's own functions and symbol on the host", async () => {
			const { host, engine } = await freshCore();
			expect(host.isTracking).toBe(engine.isTracking);
			expect(host.untrack).toBe(engine.untrack);
			expect(host.trackedReads).toBe(engine.trackedReads);
			expect(host.batch).toBe(engine.batch);
			expect(typeof host.TRACK).toBe("symbol");
		});
	});

	describe("registration", () => {
		it("swaps isTracking, untrack and TRACK as plain properties", async () => {
			const { host, engine, internal } = await freshCore();
			const { graph } = fakeGraph();
			expect(internal.registerOutsideGraph(graph)).toBe(true);
			expect(host.TRACK).toBe(graph.TRACK);
			expect(host.isTracking).not.toBe(engine.isTracking);
			expect(host.untrack).not.toBe(engine.untrack);
			for (const name of [
				"isTracking",
				"untrack",
				"TRACK"
			]) {
				const descriptor = Object.getOwnPropertyDescriptor(host, name)!;
				expect(descriptor.get).toBeUndefined();
				expect("value" in descriptor).toBe(true);
			}
		});

		it("answers true for a graph with the same TRACK, changing nothing, and false for one with another", async () => {
			const { host, internal } = await freshCore();
			const first = fakeGraph();
			internal.registerOutsideGraph(first.graph);
			const isTracking = host.isTracking;
			const same = fakeGraph(first.graph.TRACK);
			expect(internal.registerOutsideGraph(same.graph)).toBe(true);
			expect(internal.registerOutsideGraph(fakeGraph().graph)).toBe(false);
			expect(host.TRACK).toBe(first.graph.TRACK);
			expect(host.isTracking).toBe(isTracking);
			const version = host.createVersion();
			same.reader(() => version.track());
			expect(same.mirrors).toHaveLength(0);
			first.reader(() => version.track());
			expect(first.mirrors).toHaveLength(1);
		});
	});

	describe("isTracking", () => {
		it("answers true for an outside read, and false outside any reader and under the graph's untrack", async () => {
			const { host, internal } = await freshCore();
			const g = fakeGraph();
			internal.registerOutsideGraph(g.graph);
			const seen: boolean[] = [];
			g.reader(() => {
				seen.push(host.isTracking());
				seen.push(g.graph.untrack(() => host.isTracking()));
				seen.push(host.untrack(() => host.isTracking()));
			});
			expect(seen).toEqual([
				true,
				false,
				false
			]);
			expect(host.isTracking()).toBe(false);
		});
	});

	describe("versions", () => {
		it("make a mirror on the first outside read, one per version, and write it on each bump", async () => {
			const { host, internal } = await freshCore();
			const g = fakeGraph();
			internal.registerOutsideGraph(g.graph);
			const version = host.createVersion();
			const a = g.reader(() => version.track());
			const b = g.reader(() => version.track());
			expect(g.mirrors).toHaveLength(1);
			version.bump();
			version.bump();
			expect(g.mirrors[0]!.writes).toBe(2);
			g.flush();
			expect(a.runs()).toBe(2);
			expect(b.runs()).toBe(2);
		});

		it("make no mirror for an untracked read or an engine computation's read", async () => {
			const { host, internal } = await freshCore();
			const g = fakeGraph();
			internal.registerOutsideGraph(g.graph);
			const version = host.createVersion();
			version.track();
			const memo = host.createOwnedMemo(() => version.track());
			memo.read();
			g.reader(() => {
				host.untrack(() => version.track());
				g.graph.untrack(() => version.track());
			});
			expect(g.mirrors).toHaveLength(0);
			version.bump();
			memo.dispose();
		});

		it("bridge a runtime's tree: a view read in a reader re-runs it after a dispatch writes the key", async () => {
			const { internal, runtime: make } = await freshCore();
			const g = fakeGraph();
			internal.registerOutsideGraph(g.graph);
			const runtime = make();
			const titles: string[] = [];
			const reader = g.reader(() => titles.push(runtime.state.Title));
			expect(g.mirrors).toHaveLength(1);
			await runtime.dispatch(setOther, "root", 1);
			g.flush();
			expect(reader.runs()).toBe(1);
			await runtime.dispatch(retitle, "root", "cd");
			g.flush();
			expect(titles).toEqual([
				"ab",
				"cd"
			]);
			runtime.dispose();
		});
	});

	describe("owned memos", () => {
		it("write their mirror only after a re-run whose value changed", async () => {
			const { host, internal } = await freshCore();
			const g = fakeGraph();
			internal.registerOutsideGraph(g.graph);
			const version = host.createVersion();
			let n = 1;
			const memo = host.createOwnedMemo(() => {
				version.track();
				return n;
			});
			const reader = g.reader(() => memo.read());
			const second = g.reader(() => memo.read());
			expect(g.mirrors).toHaveLength(1);
			version.bump();
			expect(g.mirrors[0]!.writes).toBe(0);
			n = 2;
			version.bump();
			expect(g.mirrors[0]!.writes).toBe(1);
			g.flush();
			expect(reader.runs()).toBe(2);
			expect(second.runs()).toBe(2);
			expect(g.mirrors).toHaveLength(1);
			memo.dispose();
		});

		it("decide at each run to compute under the graph's untrack, so a memo built before registration subscribes no outside reader", async () => {
			const { host, internal } = await freshCore();
			const version = host.createVersion();
			const memo = host.createOwnedMemo(() => version.track());
			const g = fakeGraph();
			internal.registerOutsideGraph(g.graph);
			g.reader(() => {
				host.batch(() => version.bump());
			});
			expect(g.mirrors).toHaveLength(0);
			memo.dispose();
		});

		it("write nothing once disposed", async () => {
			const { host, internal } = await freshCore();
			const g = fakeGraph();
			internal.registerOutsideGraph(g.graph);
			const version = host.createVersion();
			let n = 1;
			const memo = host.createOwnedMemo(() => {
				version.track();
				return n;
			});
			g.reader(() => memo.read());
			memo.dispose();
			n = 2;
			version.bump();
			expect(g.mirrors[0]!.writes).toBe(0);
		});

		it("run their compute under the graph's untrack, so a selector's reads subscribe no outside reader", async () => {
			const { internal, runtime: make } = await freshCore();
			const g = fakeGraph();
			internal.registerOutsideGraph(g.graph);
			const runtime = make();
			const signal = g.graph.createMirror();
			function* readsOutside(draft: IRoot): ISelectorGenerator<number> {
				signal.track();
				return draft.Title.length;
			}
			const lengths: number[] = [];
			const reader = g.reader(() => lengths.push(runtime.runSelector(readsOutside, () => runtime.state)));
			expect(g.mirrors[0]!.readers.size).toBe(0);
			signal.write();
			g.flush();
			await runtime.dispatch(retitle, "root", "cd");
			g.flush();
			expect(reader.runs()).toBe(1);
			await runtime.dispatch(retitle, "root", "abc");
			g.flush();
			expect(lengths).toEqual([
				2,
				3
			]);
			runtime.dispose();
		});
	});

	describe("untrack", () => {
		it("clears both graphs", async () => {
			const { host, engine, internal } = await freshCore();
			const g = fakeGraph();
			internal.registerOutsideGraph(g.graph);
			const version = host.createVersion();
			const reader = g.reader(() => host.untrack(() => version.track()));
			let runs = 0;
			const memo = host.createOwnedMemo(() => {
				runs++;
				host.untrack(() => version.track());
				expect(engine.isTracking()).toBe(true);
			});
			version.bump();
			g.flush();
			expect(g.mirrors).toHaveLength(0);
			expect(reader.runs()).toBe(1);
			expect(runs).toBe(1);
			memo.dispose();
		});

		it("keeps a dispatch from an outside reader from subscribing it to what the action reads", async () => {
			const { internal, runtime: make } = await freshCore();
			const g = fakeGraph();
			internal.registerOutsideGraph(g.graph);
			const runtime = make();
			let read: number | undefined;
			function* readsOther(draft: IRoot): IActionGenerator {
				read = runtime.state.Other;
				draft.Title = "read";
			}
			const reader = g.reader(() => {
				void runtime.dispatch(readsOther, "root");
			});
			expect(read).toBe(0);
			expect(g.mirrors).toHaveLength(0);
			await runtime.dispatch(setOther, "root", 1);
			g.flush();
			expect(reader.runs()).toBe(1);
			runtime.dispose();
		});
	});

	describe("TRACK", () => {
		it("is the graph's, so a reader of a list's shape hears a push and an element replaced in place", async () => {
			const { internal, runtime: make } = await freshCore();
			const g = fakeGraph();
			internal.registerOutsideGraph(g.graph);
			const runtime = make();
			const reader = g.reader(() => {
				void (runtime.state.Items as unknown as Record<symbol, unknown>)[g.graph.TRACK];
			});
			function* push(draft: IRoot): IActionGenerator {
				draft.Items.push({
					N: 1
				});
			}
			function* replace(draft: IRoot): IActionGenerator {
				draft.Items[0] = {
					N: 2
				};
			}
			await runtime.dispatch(push, "root");
			g.flush();
			expect(reader.runs()).toBe(2);
			await runtime.dispatch(replace, "root");
			g.flush();
			expect(reader.runs()).toBe(3);
			runtime.dispose();
		});
	});

	describe("registration after the runtime", () => {
		it("bridges a runtime, and a selector memo a watch built, made before it", async () => {
			const { internal, runtime: make } = await freshCore();
			const runtime = make();
			let watched = 0;
			const stop = internal.watch(
				() => runtime.runSelector(titleLength, () => runtime.state),
				() => {
					watched++;
				}
			);
			const g = fakeGraph();
			expect(internal.registerOutsideGraph(g.graph)).toBe(true);
			const lengths: number[] = [];
			const titles: string[] = [];
			const selectorReader = g.reader(() => lengths.push(runtime.runSelector(titleLength, () => runtime.state)));
			g.reader(() => titles.push(runtime.state.Title));
			await runtime.dispatch(retitle, "root", "cd");
			g.flush();
			expect(selectorReader.runs()).toBe(1);
			await runtime.dispatch(retitle, "root", "abc");
			g.flush();
			expect(lengths).toEqual([
				2,
				3
			]);
			expect(titles).toEqual([
				"ab",
				"cd",
				"abc"
			]);
			expect(watched).toBe(1);
			stop();
			runtime.dispose();
		});
	});

	describe("two copies of core", () => {
		it("share one host, engine and seam included", async () => {
			const first = await freshCore();
			const second = await copyOfCore();
			expect(second.internal).not.toBe(first.internal);
			expect(second.engine).not.toBe(first.engine);
			expect(second.host).toBe(first.host);
			const runtime = first.runtime();
			let heard = 0;
			const stop = second.internal.watch(
				() => runtime.state.Title,
				() => {
					heard++;
				}
			);
			await runtime.dispatch(retitle, "root", "cd");
			expect(heard).toBe(1);
			const g = fakeGraph();
			expect(second.internal.registerOutsideGraph(g.graph)).toBe(true);
			const reader = g.reader(() => runtime.state.Other);
			await runtime.dispatch(setOther, "root", 1);
			g.flush();
			expect(reader.runs()).toBe(2);
			expect(first.internal.registerOutsideGraph(g.graph)).toBe(true);
			stop();
			runtime.dispose();
		});

		it("keeps an engine of its own, with a warning in development, for a copy on another contract version", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const other = {
				contract: 999
			};
			slot[KEY] = other;
			const copy = await copyOfCore();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]![0])).toMatch(/reactive contract 999 where this copy is on 1/);
			expect(slot[KEY]).toBe(other);
			expect(copy.host).not.toBe(other);
			expect(copy.host.contract).toBe(1);
			const runtime = copy.runtime();
			let heard = 0;
			const stop = copy.internal.watch(
				() => runtime.state.Title,
				() => {
					heard++;
				}
			);
			await runtime.dispatch(retitle, "root", "cd");
			expect(heard).toBe(1);
			stop();
			runtime.dispose();
		});
	});
});
