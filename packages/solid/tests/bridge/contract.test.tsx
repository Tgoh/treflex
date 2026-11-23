import type { IMirror, IRuntimeInternal } from "treflex/internal";
import {
	configureClientErrors,
	createMemo,
	createRenderEffect,
	createRoot,
	createSignal,
	DEV,
	Errored,
	flush,
	getOwner,
	isPending,
	Loading,
	latest,
	mapArray,
	untrack
} from "solid-js";
import {
	createRuntime as createCoreRuntime,
	external,
	type IActionGenerator,
	type IEntity,
	type ISelectorGenerator,
	select
} from "treflex";
import { watch } from "treflex/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntityFeature } from "../../src/Context/createEntityFeature";
import { solidGraph, TreflexProvider } from "../../src/Context/TreflexContext";
import { useComponentState } from "../../src/Hooks/useComponentState";
import { mount } from "../mount";
import { uncaughtDuring } from "../unhandledDuring";

declare module "treflex" {
	interface IExternalRegistry {
		"bridge/Count": number;
	}
}

interface IRoot extends IEntity {
	A: number;
	B: number;
	C: number;
	D: number;
	E: number;
	K: number;
	N: number;
}

const createRuntime = <T extends object>(state: T): IRuntimeInternal<T> => createCoreRuntime(state) as IRuntimeInternal<T>;

const seed = (): IRoot => ({
	$Id: "root",
	A: 0,
	B: 0,
	C: 0,
	D: 0,
	E: 0,
	K: 0,
	N: 0
});

function* set(draft: IRoot, key: keyof Omit<IRoot, "$Id">, value: number): IActionGenerator {
	draft[key] = value;
}

function countMirrors() {
	const made: IMirror[] = [];
	const real = solidGraph.createMirror.bind(solidGraph);
	const spy = vi.spyOn(solidGraph, "createMirror").mockImplementation(() => {
		const mirror = real();
		made.push(mirror);
		return mirror;
	});
	return {
		made,
		restore: () => spy.mockRestore()
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("1. granularity", () => {
	interface IRow {
		N: number;
	}
	interface IList extends IEntity {
		Rows: IRow[];
	}
	function* doubled(row: IRow): ISelectorGenerator<number> {
		return row.N * 2;
	}
	function* total(list: IList): ISelectorGenerator<number> {
		let sum = 0;
		for (const row of list.Rows) {
			sum += row.N;
		}
		return sum;
	}
	function* setRow(draft: IList, index: number, value: number): IActionGenerator {
		draft.Rows[index]!.N = value;
	}

	it("re-runs exactly the written rows' two effects, and the list effect once per write", async () => {
		const size = 10_000;
		const runtime = createRuntime<IList>({
			$Id: "list",
			Rows: Array.from(
				{
					length: size
				},
				() => ({
					N: 0
				})
			)
		});
		const fieldRuns = new Array<number>(size).fill(0);
		const selectorRuns = new Array<number>(size).fill(0);
		let listRuns = 0;
		const dispose = createRoot((d) => {
			runtime.state.Rows.forEach((row, i) => {
				createRenderEffect(
					() => row.N,
					() => {
						fieldRuns[i]!++;
					}
				);
				createRenderEffect(
					() => runtime.runSelector(doubled, () => row),
					() => {
						selectorRuns[i]!++;
					}
				);
			});
			createRenderEffect(
				() => runtime.runSelector(total, () => runtime.state),
				() => {
					listRuns++;
				}
			);
			return d;
		});
		flush();
		fieldRuns.fill(0);
		selectorRuns.fill(0);
		listRuns = 0;
		const written = Array.from(
			{
				length: 50
			},
			(_, k) => k * 199
		);
		for (const [k, index] of written.entries()) {
			await runtime.dispatch(setRow, "list", index, k + 1);
			flush();
		}
		const expected = new Array<number>(size).fill(0);
		for (const index of written) {
			expected[index] = 1;
		}
		expect(fieldRuns).toEqual(expected);
		expect(selectorRuns).toEqual(expected);
		expect(listRuns).toBe(50);
		dispose();
		runtime.dispose();
	});
});

describe("2. no input subscription", () => {
	function* parity(state: IRoot): ISelectorGenerator<number> {
		return state.N % 2;
	}

	it("re-runs a selector's reader for a change to its value, not for a write to its input alone", async () => {
		const runtime = createRuntime<IRoot>(seed());
		const seen: number[] = [];
		const dispose = createRoot((d) => {
			createRenderEffect(
				() => runtime.runSelector(parity, () => runtime.state),
				(value) => {
					seen.push(value);
				}
			);
			return d;
		});
		flush();
		await runtime.dispatch(set, "root", "N", 2);
		flush();
		expect(seen).toEqual([
			0
		]);
		await runtime.dispatch(set, "root", "N", 3);
		flush();
		expect(seen).toEqual([
			0,
			1
		]);
		dispose();
		runtime.dispose();
	});
});

describe("3. one mirror per source", () => {
	it("makes one mirror for two readers of one key", () => {
		const runtime = createRuntime<IRoot>(seed());
		const mirrors = countMirrors();
		const dispose = createRoot((d) => {
			createRenderEffect(
				() => runtime.state.A,
				() => {}
			);
			return d;
		});
		const one = mirrors.made.length;
		expect(one).toBeGreaterThan(0);
		const second = createRoot((d) => {
			createRenderEffect(
				() => runtime.state.A,
				() => {}
			);
			return d;
		});
		expect(mirrors.made).toHaveLength(one);
		dispose();
		second();
		runtime.dispose();
	});

	it("makes none for an engine-side read, an untracked read, a component body's read, or isPending and latest outside a computation", () => {
		const runtime = createRuntime<IRoot>(seed());
		void runtime.state.A;
		const mirrors = countMirrors();
		const stop = watch(
			() => void runtime.state.B,
			() => {}
		);
		const dispose = createRoot((d) => {
			createRenderEffect(
				() => untrack(() => runtime.state.C),
				() => {}
			);
			return d;
		});
		const Body = () => {
			void runtime.state.D;
			return null;
		};
		const mounted = mount(() => (
			<TreflexProvider value={runtime}>
				<Body />
			</TreflexProvider>
		));
		expect(isPending(() => runtime.state.E)).toBe(false);
		expect(latest(() => runtime.state.E)).toBe(0);
		expect(mirrors.made).toEqual([]);
		stop();
		dispose();
		mounted.dispose();
		runtime.dispose();
	});

	it("makes a mirror under no owner, not the owner of the computation that read first", () => {
		const runtime = createRuntime<IRoot>(seed());
		const mirrors = countMirrors();
		let owner: ReturnType<typeof getOwner> = null;
		let root: ReturnType<typeof getOwner> = null;
		const dispose = createRoot((d) => {
			root = getOwner();
			createRenderEffect(
				() => {
					owner = getOwner();
					return runtime.state.A;
				},
				() => {}
			);
			return d;
		});
		expect(mirrors.made.length).toBeGreaterThan(0);
		expect(DEV!.getSignals(owner!)).toEqual([]);
		expect(DEV!.getSignals(root!)).toEqual([]);
		dispose();
		runtime.dispose();
	});

	it("raises no STRICT_READ_UNTRACKED for a treflex read in a component body, where a Solid signal and useComponentState's id and state do", () => {
		const runtime = createRuntime<IRoot>(seed());
		const said = vi.spyOn(console, "warn");
		const strict = () => said.mock.calls.filter((call) => String(call[0]).startsWith("[STRICT_READ_UNTRACKED]")).length;
		const [signal] = createSignal(0);
		const counts: Record<string, number> = {};
		const Body = () => {
			const local = useComponentState(() => ({
				Count: 0
			}));
			void runtime.state.A;
			counts.treflex = strict();
			void signal();
			counts.signal = strict();
			void local.id;
			counts.id = strict();
			void local.state.Count;
			counts.state = strict();
			return null;
		};
		mount(() => (
			<TreflexProvider value={runtime}>
				<Body />
			</TreflexProvider>
		)).dispose();
		expect(counts).toEqual({
			treflex: 0,
			signal: 1,
			id: 2,
			state: 3
		});
		runtime.dispose();
	});
});

describe("4. $TRACK", () => {
	interface IRow {
		Id: string;
	}
	interface IList extends IEntity {
		Rows: IRow[];
	}
	function* push(draft: IList, id: string): IActionGenerator {
		draft.Rows.push({
			Id: id
		});
	}
	function* replace(draft: IList, index: number, id: string): IActionGenerator {
		draft.Rows[index] = {
			Id: id
		};
	}
	function* reverse(draft: IList): IActionGenerator {
		draft.Rows.reverse();
	}
	function* rename(draft: IList, index: number, id: string): IActionGenerator {
		draft.Rows[index]!.Id = id;
	}

	it("diffs mapArray over a view by reference on a push, a replace in place, a reverse and a child write", async () => {
		const runtime = createRuntime<IList>({
			$Id: "list",
			Rows: [
				{
					Id: "a"
				},
				{
					Id: "b"
				}
			]
		});
		let created = 0;
		let mapped!: () => string[];
		const dispose = createRoot((d) => {
			mapped = mapArray(
				() => runtime.state.Rows,
				(row) => {
					created++;
					return untrack(() => row.Id);
				}
			);
			createRenderEffect(
				() => mapped(),
				() => {}
			);
			return d;
		});
		flush();
		expect(mapped()).toEqual([
			"a",
			"b"
		]);
		expect(created).toBe(2);
		await runtime.dispatch(push, "list", "c");
		flush();
		expect(mapped()).toEqual([
			"a",
			"b",
			"c"
		]);
		expect(created).toBe(3);
		await runtime.dispatch(replace, "list", 1, "B");
		flush();
		expect(mapped()).toEqual([
			"a",
			"B",
			"c"
		]);
		expect(created).toBe(4);
		await runtime.dispatch(reverse, "list");
		flush();
		expect(mapped()).toEqual([
			"c",
			"B",
			"a"
		]);
		expect(created).toBe(4);
		await runtime.dispatch(rename, "list", 0, "C");
		flush();
		expect(created).toBe(4);
		dispose();
		runtime.dispose();
	});
});

describe("5. both graphs untracked", () => {
	function* readK(draft: IRoot): IActionGenerator {
		void draft.K;
	}
	function* selectK(state: IRoot): ISelectorGenerator<number> {
		return state.K;
	}

	it("subscribes nothing for a read under Solid's untrack", async () => {
		const runtime = createRuntime<IRoot>(seed());
		let runs = 0;
		const dispose = createRoot((d) => {
			createRenderEffect(
				() => {
					runs++;
					return untrack(() => runtime.state.A);
				},
				() => {}
			);
			return d;
		});
		flush();
		await runtime.dispatch(set, "root", "A", 1);
		flush();
		expect(runs).toBe(1);
		dispose();
		runtime.dispose();
	});

	it("doesn't re-run a compute for what an action it dispatched read, and does for what a processSelector read", async () => {
		const runtime = createRuntime<IRoot>(seed());
		let dispatcher = 0;
		let selecting = 0;
		const dispose = createRoot((d) => {
			createRenderEffect(
				() => {
					dispatcher++;
					void runtime.dispatch(readK, "root");
				},
				() => {}
			);
			createRenderEffect(
				() => {
					selecting++;
					return runtime.processSelector(selectK, () => runtime.state);
				},
				() => {}
			);
			return d;
		});
		flush();
		await runtime.dispatch(set, "root", "K", 1);
		flush();
		expect(dispatcher).toBe(1);
		expect(selecting).toBe(2);
		dispose();
		runtime.dispose();
	});
});

describe("6. a write inside a Solid computation", () => {
	function* count(): ISelectorGenerator<number> {
		return (yield* external("bridge/Count")) ?? 0;
	}

	it("re-runs a compute that read the source once, for a dispatch from it, with no diagnostic", async () => {
		const runtime = createRuntime<IRoot>(seed());
		const said = vi.spyOn(console, "warn");
		const cried = vi.spyOn(console, "error");
		const seen: number[] = [];
		const dispose = createRoot((d) => {
			createRenderEffect(
				() => {
					const n = runtime.state.N;
					seen.push(n);
					if (n === 0) {
						void runtime.dispatch(set, "root", "N", 1);
					}
					return n;
				},
				() => {}
			);
			return d;
		});
		flush();
		await Promise.resolve();
		flush();
		expect(seen).toEqual([
			0,
			1
		]);
		expect([
			...said.mock.calls,
			...cried.mock.calls
		]).toEqual([]);
		dispose();
		runtime.dispose();
	});

	it("re-runs a compute that read the source once, for a changed from it, with no diagnostic", () => {
		const runtime = createRuntime<IRoot>(seed());
		let value = 0;
		const handle = runtime.provideExternal("bridge/Count", {
			read: () => value
		});
		const said = vi.spyOn(console, "warn");
		const cried = vi.spyOn(console, "error");
		const seen: number[] = [];
		const dispose = createRoot((d) => {
			createRenderEffect(
				() => {
					const n = runtime.processSelector(count, () => runtime.state);
					seen.push(n);
					if (n === 0) {
						value = 1;
						handle.changed();
					}
					return n;
				},
				() => {}
			);
			return d;
		});
		flush();
		expect(seen).toEqual([
			0,
			1
		]);
		expect([
			...said.mock.calls,
			...cried.mock.calls
		]).toEqual([]);
		dispose();
		runtime.dispose();
	});
});

describe("7. a selector that reads a Solid signal", () => {
	it("subscribes neither the reader that built its memo nor a later one", () => {
		const runtime = createRuntime<IRoot>(seed());
		const [outside, setOutside] = createSignal(0);
		function* readsOutside(state: IRoot): ISelectorGenerator<number> {
			return outside() + state.N;
		}
		const runs = [
			0,
			0
		];
		const reader = (at: number) =>
			createRoot((d) => {
				createRenderEffect(
					() => {
						runs[at]!++;
						return runtime.runSelector(readsOutside, () => runtime.state);
					},
					() => {}
				);
				return d;
			});
		const first = reader(0);
		flush();
		setOutside(1);
		flush();
		const second = reader(1);
		flush();
		setOutside(2);
		flush();
		expect(runs).toEqual([
			1,
			1
		]);
		first();
		second();
		runtime.dispose();
	});
});

describe("8. holds", () => {
	interface IHeld extends IEntity {
		Q: string;
		Other: number;
	}
	function* q(state: IHeld): ISelectorGenerator<string> {
		return state.Q;
	}
	function* other(state: IHeld): ISelectorGenerator<number> {
		return state.Other;
	}
	function* setQ(draft: IHeld, value: string): IActionGenerator<string> {
		draft.Q = value;
		return yield* select(q);
	}
	function* setOther(draft: IHeld, value: number): IActionGenerator {
		draft.Other = value;
	}
	function* setBoth(draft: IHeld, value: string, n: number): IActionGenerator {
		draft.Q = value;
		draft.Other = n;
	}

	it("holds a view of a write an on-screen async derivation reads, splits the effect timing, and tears within a frame", async () => {
		const runtime = createRuntime<IHeld>({
			$Id: "root",
			Q: "a",
			Other: 0
		});
		const gates = new Map<string, () => void>();
		const land = async (key: string) => {
			gates.get(key)!();
			gates.delete(key);
			await new Promise((resolve) => setTimeout(resolve, 0));
			flush();
		};
		const [id, setId] = createSignal(1);
		const [unrelated, setUnrelated] = createSignal(0);
		const log: string[] = [];
		const dispose = createRoot((d) => {
			const answer = createMemo(async () => {
				const key = `${runtime.runSelector(q, () => runtime.state)}/${id()}`;
				await new Promise<void>((resolve) => gates.set(key, resolve));
				return `ans(${key})`;
			});
			createRenderEffect(answer, (value) => {
				log.push(`async ${value}`);
			});
			createRenderEffect(
				() => runtime.runSelector(q, () => runtime.state),
				(value) => {
					log.push(`selector Q ${value}`);
				}
			);
			createRenderEffect(
				() => runtime.runSelector(other, () => runtime.state),
				(value) => {
					log.push(`selector Other ${value}`);
				}
			);
			createRenderEffect(
				() => isPending(answer),
				(value) => {
					log.push(`pending ${value}`);
				}
			);
			createRenderEffect(
				() => `${runtime.state.Q}|${unrelated()}`,
				(value) => {
					log.push(`raw Q ${value}`);
				}
			);
			return d;
		});
		const stop = watch(
			() => void runtime.state.Q,
			() => log.push(`watch Q ${runtime.state.Q}`)
		);
		flush();
		await land("a/1");
		log.push("-- a write the async reads");
		const answered = await runtime.dispatch(setQ, "root", "b");
		log.push(`dispatch answered ${answered}, raw Q ${runtime.state.Q}`);
		flush();
		log.push("-- a disjoint write in a later tick");
		await runtime.dispatch(setOther, "root", 1);
		flush();
		log.push("-- an unrelated Solid write during the hold");
		setUnrelated(1);
		flush();
		log.push("-- landing");
		await land("b/1");
		log.push("-- one step writes Q and Other");
		await runtime.dispatch(setBoth, "root", "c", 2);
		flush();
		log.push("-- landing");
		await land("c/1");
		log.push("-- Solid opens a hold, then a treflex write the async reads");
		setId(2);
		flush();
		await runtime.dispatch(setQ, "root", "d");
		flush();
		log.push("-- landing");
		await land("c/2");
		await land("d/2");
		expect(log).toEqual([
			"selector Q a",
			"selector Other 0",
			"raw Q a|0",
			"async ans(a/1)",
			"pending false",
			"-- a write the async reads",
			"watch Q b",
			"pending true",
			"dispatch answered b, raw Q b",
			"-- a disjoint write in a later tick",
			"selector Other 1",
			"-- an unrelated Solid write during the hold",
			"raw Q b|1",
			"-- landing",
			"async ans(b/1)",
			"raw Q b|1",
			"selector Q b",
			"pending false",
			"-- one step writes Q and Other",
			"watch Q c",
			"pending true",
			"-- landing",
			"async ans(c/1)",
			"raw Q c|1",
			"selector Q c",
			"selector Other 2",
			"pending false",
			"-- Solid opens a hold, then a treflex write the async reads",
			"pending true",
			"watch Q d",
			"pending true",
			"-- landing",
			"async ans(d/2)",
			"raw Q d|1",
			"selector Q d",
			"pending false"
		]);
		stop();
		dispose();
		runtime.dispose();
	});

	it("fails no step for a view's throw, which runs in Solid's flush", async () => {
		const runtime = createRuntime<IRoot>(seed());
		const dispose = createRoot((d) => {
			createRenderEffect(
				() => {
					if (runtime.state.N === 1) {
						throw new Error("view threw");
					}
				},
				() => {}
			);
			return d;
		});
		flush();
		let outcome = "pending";
		const heard = await uncaughtDuring(async () => {
			outcome = await runtime.dispatch(set, "root", "N", 1).then(
				() => "resolved",
				(error: Error) => error.message
			);
		});
		expect(outcome).toBe("resolved");
		expect(heard.map(String)).toEqual([
			"Error: view threw"
		]);
		dispose();
		runtime.dispose();
	});
});

describe("9. Loading and isPending", () => {
	it("never shows a Loading fallback over plain treflex reads, across writes", async () => {
		const runtime = createRuntime<IRoot>(seed());
		const mounted = mount(() => (
			<Loading fallback="loading">
				<p>{runtime.state.N}</p>
			</Loading>
		));
		expect(mounted.container.textContent).toBe("0");
		await runtime.dispatch(set, "root", "N", 1);
		flush();
		expect(mounted.container.textContent).toBe("1");
		mounted.dispose();
		runtime.dispose();
	});

	it("answers isPending false over a treflex read and a selector for the write that opens a hold, and latest the tree's value", async () => {
		function* n(state: IRoot): ISelectorGenerator<number> {
			return state.N;
		}
		const runtime = createRuntime<IRoot>(seed());
		let release!: () => void;
		const pending: boolean[] = [];
		const dispose = createRoot((d) => {
			const slow = createMemo(async () => {
				const value = runtime.state.N;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return value;
			});
			createRenderEffect(slow, () => {});
			createRenderEffect(
				() => [
					isPending(() => runtime.state.N),
					isPending(() => runtime.runSelector(n, () => runtime.state))
				],
				(values) => {
					pending.push(...values);
				}
			);
			return d;
		});
		flush();
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		flush();
		await runtime.dispatch(set, "root", "N", 1);
		flush();
		expect(isPending(() => runtime.state.N)).toBe(false);
		expect(isPending(() => runtime.runSelector(n, () => runtime.state))).toBe(false);
		expect(latest(() => runtime.state.N)).toBe(1);
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		flush();
		expect(pending.every((value) => value === false)).toBe(true);
		dispose();
		runtime.dispose();
	});

	it("answers isPending true over a treflex read and a selector for a second write while a hold is open, until the landing", async () => {
		function* n(state: IRoot): ISelectorGenerator<number> {
			return state.N;
		}
		const runtime = createRuntime<IRoot>(seed());
		const releases: (() => void)[] = [];
		const log: string[] = [];
		const dispose = createRoot((d) => {
			const slow = createMemo(async () => {
				const value = runtime.state.N;
				await new Promise<void>((resolve) => releases.push(resolve));
				return value;
			});
			createRenderEffect(slow, () => {});
			createRenderEffect(
				() => `${isPending(() => runtime.state.N)}/${isPending(() => runtime.runSelector(n, () => runtime.state))}`,
				(value) => {
					log.push(value);
				}
			);
			return d;
		});
		const landAll = async () => {
			for (const release of releases.splice(0)) {
				release();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
			flush();
		};
		flush();
		await landAll();
		log.push("-- the write that opens the hold");
		await runtime.dispatch(set, "root", "N", 1);
		flush();
		log.push("-- a second write while it is open");
		await runtime.dispatch(set, "root", "N", 2);
		flush();
		log.push("-- landing");
		await landAll();
		expect(log).toEqual([
			"false/false",
			"-- the write that opens the hold",
			"false/false",
			"-- a second write while it is open",
			"true/true",
			"-- landing",
			"false/false"
		]);
		dispose();
		runtime.dispose();
	});

	it("suspends an async memo over treflex state: the fallback on its first load, then the content kept and isPending true until a write's answer lands", async () => {
		const runtime = createRuntime<IRoot>(seed());
		const releases: (() => void)[] = [];
		let stale!: () => boolean;
		const Slow = () => {
			const value = createMemo(async () => {
				const n = runtime.state.N;
				await new Promise<void>((resolve) => releases.push(resolve));
				return n * 10;
			});
			stale = createMemo(() => isPending(value));
			return <p>{value()}</p>;
		};
		const mounted = mount(() => (
			<Loading fallback="loading">
				<Slow />
			</Loading>
		));
		const landNext = async () => {
			releases.shift()!();
			await new Promise((resolve) => setTimeout(resolve, 0));
			flush();
		};
		expect(mounted.container.textContent).toBe("loading");
		await landNext();
		expect(mounted.container.textContent).toBe("0");
		await runtime.dispatch(set, "root", "N", 1);
		flush();
		expect(mounted.container.textContent).toBe("0");
		expect(stale()).toBe(true);
		await landNext();
		expect(mounted.container.textContent).toBe("10");
		expect(stale()).toBe(false);
		mounted.dispose();
		runtime.dispose();
	});
});

describe("10. effect order", () => {
	it("runs a watch before dispatch returns, and applies a Solid render effect after it, at Solid's flush", () => {
		const runtime = createRuntime<IRoot>(seed());
		const log: string[] = [];
		const stop = watch(
			() => void runtime.state.N,
			() => log.push(`watch ${runtime.state.N}`)
		);
		const dispose = createRoot((d) => {
			createRenderEffect(
				() => runtime.state.N,
				(n) => {
					log.push(`render ${n}`);
				}
			);
			return d;
		});
		flush();
		void runtime.dispatch(set, "root", "N", 1);
		log.push("dispatch returned");
		flush();
		expect(log).toEqual([
			"render 0",
			"watch 1",
			"dispatch returned",
			"render 1"
		]);
		stop();
		dispose();
		runtime.dispose();
	});
});

describe("11. lifetimes", () => {
	interface IRow extends IEntity {
		N: number;
	}
	interface IList extends IEntity {
		Rows: IRow[];
	}

	function collect(): () => void {
		const v8 = (
			globalThis as unknown as {
				process: {
					getBuiltinModule(name: string): any;
				};
			}
		).process.getBuiltinModule("v8");
		v8.setFlagsFromString("--expose-gc");
		const vm = (
			globalThis as unknown as {
				process: {
					getBuiltinModule(name: string): any;
				};
			}
		).process.getBuiltinModule("vm");
		return vm.runInNewContext("gc");
	}

	it("collects the mirrors once their readers and the runtime go", async () => {
		const gc = collect();
		let collected = 0;
		const registry = new FinalizationRegistry(() => {
			collected++;
		});
		let made = 0;
		const real = solidGraph.createMirror;
		solidGraph.createMirror = () => {
			const mirror = real.call(solidGraph);
			made++;
			registry.register(mirror, null);
			return mirror;
		};
		(() => {
			const runtime = createRuntime<IList>({
				$Id: "list",
				Rows: Array.from(
					{
						length: 1000
					},
					(_, i) => ({
						$Id: `r${i}`,
						N: i
					})
				)
			});
			const dispose = createRoot((d) => {
				for (const row of runtime.state.Rows) {
					createRenderEffect(
						() => row.N,
						() => {}
					);
				}
				return d;
			});
			flush();
			dispose();
			runtime.dispose();
		})();
		solidGraph.createMirror = real;
		expect(made).toBeGreaterThanOrEqual(1000);
		for (let i = 0; i < 20 && collected < made; i++) {
			gc();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(collected).toBe(made);
	});

	it("writes a selector memo's mirror no more once its entity's removal disposed it", async () => {
		function* count(row: IRow): ISelectorGenerator<number> {
			return row.N + ((yield* external("bridge/Count")) ?? 0);
		}
		function* removeFirst(draft: IList): IActionGenerator {
			draft.Rows.splice(0, 1);
		}
		const runtime = createRuntime<IList>({
			$Id: "list",
			Rows: [
				{
					$Id: "r0",
					N: 0
				}
			]
		});
		let value = 0;
		const handle = runtime.provideExternal("bridge/Count", {
			read: () => value
		});
		let writes = 0;
		const real = solidGraph.createMirror.bind(solidGraph);
		vi.spyOn(solidGraph, "createMirror").mockImplementation(() => {
			const mirror = real();
			return {
				track: mirror.track,
				write: () => {
					writes++;
					mirror.write();
				}
			};
		});
		const row = runtime.state.Rows[0]!;
		const seen: number[] = [];
		const dispose = createRoot((d) => {
			createRenderEffect(
				() => runtime.runSelector(count, () => row),
				(n) => {
					seen.push(n);
				}
			);
			return d;
		});
		flush();
		value = 1;
		handle.changed();
		flush();
		expect(seen).toEqual([
			0,
			1
		]);
		await runtime.dispatch(removeFirst, "list");
		flush();
		writes = 0;
		value = 2;
		handle.changed();
		flush();
		expect(writes).toBe(0);
		dispose();
		runtime.dispose();
	});
});

describe("13. a view's throw", () => {
	function* checked(state: IRoot): ISelectorGenerator<number> {
		if (state.N === 1) {
			throw new Error("view threw");
		}
		return state.N;
	}

	it("resolves the dispatch, and reaches an app-owned Errored around the provider once, through Solid's channel", async () => {
		const runtime = createRuntime<IRoot>(seed());
		const reported: unknown[] = [];
		configureClientErrors({
			onError: (error) => {
				reported.push(error);
			}
		});
		const fallbacks: unknown[] = [];
		const View = () => <p>{runtime.runSelector(checked, () => runtime.state)}</p>;
		const mounted = mount(() => (
			<Errored
				fallback={(error) => {
					fallbacks.push(error());
					return "crashed";
				}}
			>
				<TreflexProvider value={runtime}>
					<View />
					<View />
				</TreflexProvider>
			</Errored>
		));
		expect(mounted.container.textContent).toBe("00");
		const outcome = await runtime.dispatch(set, "root", "N", 1).then(
			() => "resolved",
			(error: Error) => error.message
		);
		flush();
		expect(outcome).toBe("resolved");
		expect(mounted.container.textContent).toBe("crashed");
		expect(fallbacks.map(String)).toEqual([
			"Error: view threw"
		]);
		expect(reported.map(String)).toEqual([
			"Error: view threw"
		]);
		configureClientErrors({});
		mounted.dispose();
		runtime.dispose();
	});

	it("resolves the dispatch for a throw from a cached selector first built outside the view", async () => {
		const runtime = createRuntime<IRoot>(seed());
		const read = () => runtime.runSelector(checked, () => runtime.state);
		read();
		const fallbacks: unknown[] = [];
		const View = () => <p>{read()}</p>;
		const mounted = mount(() => (
			<Errored
				fallback={(error) => {
					fallbacks.push(error());
					return "crashed";
				}}
			>
				<TreflexProvider value={runtime}>
					<View />
				</TreflexProvider>
			</Errored>
		));
		const outcome = await runtime.dispatch(set, "root", "N", 1).then(
			() => "resolved",
			(error: Error) => error.message
		);
		flush();
		expect(outcome).toBe("resolved");
		expect(fallbacks.map(String)).toEqual([
			"Error: view threw"
		]);
		mounted.dispose();
		runtime.dispose();
	});

	it("resolves the dispatch with no boundary, and Solid rethrows the view's error uncaught", async () => {
		const runtime = createRuntime<IRoot>(seed());
		const View = () => <p>{runtime.runSelector(checked, () => runtime.state)}</p>;
		const mounted = mount(() => (
			<TreflexProvider value={runtime}>
				<View />
			</TreflexProvider>
		));
		let outcome = "pending";
		const heard = await uncaughtDuring(async () => {
			outcome = await runtime.dispatch(set, "root", "N", 1).then(
				() => "resolved",
				(error: Error) => error.message
			);
		});
		expect(outcome).toBe("resolved");
		expect(heard.map(String)).toEqual([
			"Error: view threw"
		]);
		mounted.dispose();
		runtime.dispose();
	});
});

describe("15. a dispatch right after a reseat", () => {
	interface ITarget extends IEntity {
		Count: number;
	}
	interface IOwners extends IEntity {
		Target: string;
		Rows: Record<string, ITarget>;
	}
	function* inc(draft: ITarget): IActionGenerator {
		draft.Count++;
	}
	function* point(draft: IOwners, target: string): IActionGenerator {
		draft.Target = target;
	}
	function* dropAndPoint(draft: IOwners, key: string, target: string): IActionGenerator {
		delete draft.Rows[key];
		draft.Target = target;
	}

	it("reaches the fresh entity from the same flush, when the provider comes to show another entity and the state starts fresh", async () => {
		const runtime = createRuntime<IOwners>({
			$Id: "owners",
			Target: "a",
			Rows: {
				a: {
					$Id: "a",
					Count: 0
				},
				b: {
					$Id: "b",
					Count: 0
				}
			}
		});
		const Row = createEntityFeature<ITarget>("tests/bridge/Row")({});
		let widget!: ReturnType<typeof useComponentState<ITarget>>;
		let armed = false;
		let dispatched: Promise<unknown> | undefined;
		const Widget = () => {
			const row = Row.use();
			widget = useComponentState<ITarget>(() => ({
				Count: 0
			}));
			createRenderEffect(
				() => row.state.$Id,
				() => {
					if (armed) {
						armed = false;
						dispatched = widget.dispatch(inc);
					}
				}
			);
			return null;
		};
		const Shown = Row.provider(() => <Widget />);
		const mounted = mount(() => (
			<TreflexProvider value={runtime}>
				<Shown state={runtime.state.Rows[runtime.state.Target]!} />
			</TreflexProvider>
		));
		await runtime.dispatch(point, "owners", "b");
		const moved = widget.id;
		armed = true;
		await runtime.dispatch(dropAndPoint, "owners", "b", "a");
		expect(dispatched).toBeDefined();
		await dispatched;
		flush();
		expect(widget.id).not.toBe(moved);
		expect(widget.state.Count).toBe(1);
		mounted.dispose();
		runtime.dispose();
	});
});
