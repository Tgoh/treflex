import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IReadHandler } from "../../src/Runtime/processSelector";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { ISelector, ISelectorGenerator } from "../../src/Types/ISelector";
import { afterEach, describe, expect, it, vi } from "vitest";
import { host } from "../../src/Reactive/host";
import { select } from "../../src/Reads/select";
import { createDiagService } from "../../src/Runtime/createDiagService";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createSelectorCache } from "../../src/Runtime/createSelectorCache";
import { processSelector } from "../../src/Runtime/processSelector";
import * as reactive from "../reactive";

function stubRead(): IReadHandler {
	return () => {
		throw new Error("nested select not used in this test");
	};
}

function makeCache() {
	const disposeCallbacks: ((id: string) => void)[] = [];
	const cache = createSelectorCache({
		onDispose: (cb) => disposeCallbacks.push(cb),
		processRead: stubRead(),
		diag: createDiagService(() => {}),
		stateOf: () => undefined
	});
	const fireDispose = (id: string) => {
		disposeCallbacks.forEach((cb) => {
			cb(id);
		});
	};
	return {
		cache,
		fireDispose
	};
}

function sameNamed() {
	const runs = [
		0,
		0
	];
	const times1: ISelector<IRow, number> = {
		total: function* (s: IRow): ISelectorGenerator<number> {
			runs[0]!++;
			return s.N;
		}
	}.total;
	const times100: ISelector<IRow, number> = {
		total: function* (s: IRow): ISelectorGenerator<number> {
			runs[1]!++;
			return s.N * 100;
		}
	}.total;
	return {
		times1,
		times100,
		runs
	};
}

interface IRow {
	$Id: string;
	N: number;
}

interface IList {
	$Id: string;
	Rows: IRow[];
	Selected: number;
}

function* doubled(row: IRow): ISelectorGenerator<number> {
	return row.N * 2;
}

describe("createSelectorCache", () => {
	it("memoizes per entity and function: the same function returns the cached result", () => {
		const state = {
			$Id: "entity",
			Count: 1
		};
		let runs = 0;
		function* getCount(s: { Count: number }): ISelectorGenerator<number> {
			runs++;
			return s.Count;
		}
		const { cache } = makeCache();

		expect(cache.runSelector(getCount, () => state, undefined, true)).toBe(1);
		expect(cache.runSelector(getCount, () => state, undefined, true)).toBe(1);
		expect(runs).toBe(1);
	});

	it("keeps two functions under one name apart on one entity", () => {
		const state = {
			$Id: "entity",
			N: 1
		};
		const { times1, times100 } = sameNamed();
		expect(times1.name).toBe(times100.name);

		const { cache } = makeCache();
		expect(cache.runSelector(times1, () => state, undefined, true)).toBe(1);
		expect(cache.runSelector(times100, () => state, undefined, true)).toBe(100);
		expect(cache.runSelector(times1, () => state, undefined, true)).toBe(1);
	});

	it("memoizes an anonymous selector by its reference", () => {
		const state = {
			$Id: "entity",
			Count: 1
		};
		let runs = 0;
		const anon: ISelector<typeof state, number> = function* (s): ISelectorGenerator<number> {
			runs++;
			return s.Count;
		};
		const { cache } = makeCache();
		expect(cache.runSelector(anon, () => state, undefined, true)).toBe(1);
		expect(cache.runSelector(anon, () => state, undefined, true)).toBe(1);
		expect(runs).toBe(1);
	});

	it("dispose-by-entity sweeps every slot for that entity", () => {
		const state = {
			$Id: "entity",
			Count: 1
		};
		let runs = 0;
		function* getCount(s: typeof state): ISelectorGenerator<number> {
			runs++;
			return s.Count;
		}
		const { cache, fireDispose } = makeCache();

		cache.runSelector(getCount, () => state, undefined, true);
		fireDispose("entity");

		expect(cache.runSelector(getCount, () => state, undefined, true)).toBe(1);
		expect(runs).toBe(2);
	});

	it("uncached path: a slice without $Id runs every call (no memoization)", () => {
		const state = {
			Count: 1
		};
		let calls = 0;
		function* getCount(s: typeof state): ISelectorGenerator<number> {
			calls++;
			return s.Count;
		}
		const { cache } = makeCache();
		cache.runSelector(getCount, () => state, undefined, true);
		cache.runSelector(getCount, () => state, undefined, true);
		expect(calls).toBe(2);
	});

	it("processSelector returns the selector's terminal value", () => {
		function* selector(): ISelectorGenerator<number> {
			return 42;
		}
		expect(processSelector(selector, () => undefined, undefined, stubRead())).toBe(42);
	});
});

describe("a selector memo through the runtime", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function build() {
		return createRuntime<IList>({
			$Id: "list",
			Rows: [
				{
					$Id: "a",
					N: 1
				},
				{
					$Id: "b",
					N: 2
				}
			],
			Selected: 0
		}) as IRuntimeInternal<IList>;
	}

	function* moveFirstToEnd(draft: IList): IActionGenerator {
		const [row] = draft.Rows.splice(0, 1);
		draft.Rows.push(row!);
	}

	function* setN(draft: IList, id: string, n: number): IActionGenerator {
		draft.Rows.find((row) => row.$Id === id)!.N = n;
	}

	function* toggle(draft: IList): IActionGenerator {
		draft.Selected++;
	}

	function* dropFirst(draft: IList): IActionGenerator {
		draft.Rows.splice(0, 1);
	}

	it("gives each entity its own value after a reorder moves a positional reader to another entity", async () => {
		const runtime = build();
		const byId = (id: string) => () => runtime.state.Rows.find((row) => row.$Id === id);
		await reactive.root(async (dispose) => {
			const positional = reactive.memo(() => runtime.runSelector(doubled, () => runtime.state.Rows[0]));
			const ofA = reactive.memo(() => runtime.runSelector(doubled, byId("a")));
			expect(positional()).toBe(2);
			expect(ofA()).toBe(2);

			await runtime.dispatch(moveFirstToEnd, "list");
			expect(positional()).toBe(4);
			expect(ofA()).toBe(2);

			await runtime.dispatch(setN, "list", "a", 10);
			expect(ofA()).toBe(20);
			expect(positional()).toBe(4);
			expect(runtime.runSelector(doubled, byId("a"))).toBe(20);
			expect(runtime.runSelector(doubled, byId("b"))).toBe(4);
			dispose();
		});
	});

	it("gives a nested select through an accessor the entity it lands on after a reorder", async () => {
		const runtime = build();
		function* selected(draft: IList): ISelectorGenerator<number> {
			return yield* select(doubled, (list: IList) => list.Rows[list.Selected]!);
		}
		await reactive.root(async (dispose) => {
			const viaSelection = reactive.memo(() => runtime.runSelector(selected, () => runtime.state));
			const ofA = reactive.memo(() => runtime.runSelector(doubled, () => runtime.state.Rows.find((row) => row.$Id === "a")));
			expect(viaSelection()).toBe(2);
			await runtime.dispatch(moveFirstToEnd, "list");
			expect(viaSelection()).toBe(4);
			expect(ofA()).toBe(2);
			dispose();
		});
	});

	it("keeps two same-named selectors on one entity right, and updating, while both are read", async () => {
		const runtime = build();
		const { times1, times100 } = sameNamed();
		const a = () => runtime.state.Rows[0];
		await reactive.root(async (dispose) => {
			const first = reactive.memo(() => runtime.runSelector(times1, a));
			const second = reactive.memo(() => runtime.runSelector(times100, a));
			expect([
				first(),
				second()
			]).toEqual([
				1,
				100
			]);
			await runtime.dispatch(setN, "list", "a", 2);
			expect([
				first(),
				second()
			]).toEqual([
				2,
				200
			]);
			await runtime.dispatch(setN, "list", "a", 3);
			expect([
				first(),
				second()
			]).toEqual([
				3,
				300
			]);
			dispose();
		});
	});

	it("keeps two same-named selectors reached by select apart, from an action", async () => {
		const runtime = build();
		const { times1, times100 } = sameNamed();
		const seen = await runtime.dispatch(function* (draft: IList): IActionGenerator<number[]> {
			const row = (list: IList) => list.Rows[0]!;
			const before = [
				yield* select(times1, row),
				yield* select(times100, row)
			];
			draft.Rows[0]!.N = 5;
			return [
				...before,
				yield* select(times1, row),
				yield* select(times100, row)
			];
		}, "list");
		expect(seen).toEqual([
			1,
			100,
			5,
			500
		]);
	});

	it("runs each of two same-named selectors once when one outer selector selects one or the other as a field toggles", async () => {
		const runtime = build();
		const { times1, times100, runs } = sameNamed();
		function* outer(list: IList): ISelectorGenerator<number> {
			const row = () => list.Rows[0]!;
			return list.Selected % 2 ? yield* select(times1, row) : yield* select(times100, row);
		}
		await reactive.root(async (dispose) => {
			const view = reactive.memo(() => runtime.runSelector(outer, () => runtime.state));
			const seen = [
				view()
			];
			for (let i = 0; i < 6; i++) {
				await runtime.dispatch(toggle, "list");
				seen.push(view());
			}
			expect(seen).toEqual([
				100,
				1,
				100,
				1,
				100,
				1,
				100
			]);
			dispose();
		});
		expect(runs).toEqual([
			1,
			1
		]);
	});

	it("runs each of two same-named selectors once when one outer selector reads both and re-runs on a toggled field", async () => {
		const runtime = build();
		const { times1, times100, runs } = sameNamed();
		function* outer(list: IList): ISelectorGenerator<number> {
			const row = () => list.Rows[0]!;
			return list.Selected * 1000 + (yield* select(times1, row)) + (yield* select(times100, row));
		}
		await reactive.root(async (dispose) => {
			const view = reactive.memo(() => runtime.runSelector(outer, () => runtime.state));
			expect(view()).toBe(101);
			for (let i = 1; i <= 6; i++) {
				await runtime.dispatch(toggle, "list");
				expect(view()).toBe(i * 1000 + 101);
			}
			dispose();
		});
		expect(runs).toEqual([
			1,
			1
		]);
	});

	it("builds a memo on every run for a selector declared inside another one, and disposes them all with the entity", async () => {
		const runtime = build();
		function* outer(row: IRow): ISelectorGenerator<number> {
			return yield* select(function* inner(r: IRow): ISelectorGenerator<number> {
				return r.N;
			});
		}
		const createOwnedMemo = host.createOwnedMemo.bind(host);
		let disposed = 0;
		const built = vi.spyOn(host, "createOwnedMemo").mockImplementation((compute) => {
			const memo = createOwnedMemo(compute);
			return {
				read: memo.read,
				dispose: () => {
					disposed++;
					memo.dispose();
				}
			};
		});
		await reactive.root(async (dispose) => {
			const view = reactive.memo(() => runtime.runSelector(outer, () => runtime.state.Rows[0]));
			expect(view()).toBe(1);
			for (let n = 2; n <= 21; n++) {
				await runtime.dispatch(setN, "list", "a", n);
				expect(view()).toBe(n);
			}
			dispose();
		});
		expect(built).toHaveBeenCalledTimes(22);
		expect(disposed).toBe(0);
		await runtime.dispatch(dropFirst, "list");
		expect(disposed).toBe(22);
	});

	it("leaves no memo behind an inline anonymous select in an action, over 10 dispatches", async () => {
		const runtime = build();
		let inlineRuns = 0;
		function* readThenWrite(draft: IList, n: number): IActionGenerator<number> {
			const seen = yield* select(
				function* (r: IRow): ISelectorGenerator<number> {
					inlineRuns++;
					return r.N;
				},
				(list: IList) => list.Rows[0]!
			);
			draft.Rows[0]!.N = n;
			return seen;
		}
		for (let n = 2; n <= 11; n++) {
			expect(await runtime.dispatch(readThenWrite, "list", n)).toBe(n - 1);
		}
		expect(inlineRuns).toBe(10);
		await runtime.dispatch(setN, "list", "a", 100);
		expect(inlineRuns).toBe(10);
	});

	it("runs an action's select itself rather than through a view's memo, and leaves the memo to the view", async () => {
		const runtime = build();
		let runs = 0;
		function* counted(row: IRow): ISelectorGenerator<number> {
			runs++;
			return row.N;
		}
		await reactive.root(async (dispose) => {
			const view = reactive.memo(() => runtime.runSelector(counted, () => runtime.state.Rows[0]));
			expect(view()).toBe(1);
			expect(runs).toBe(1);
			const seen = await runtime.dispatch(function* (): IActionGenerator<number> {
				return yield* select(counted, (list: IList) => list.Rows[0]!);
			}, "list");
			expect(seen).toBe(1);
			expect(runs).toBe(2);
			expect(view()).toBe(1);
			expect(runs).toBe(2);
			await runtime.dispatch(setN, "list", "a", 5);
			expect(view()).toBe(5);
			expect(runs).toBe(3);
			dispose();
		});
	});

	it("builds no memo for two anonymous selectors an action reads in turn, and answers each", async () => {
		const runtime = build();
		const runs = [
			0,
			0
		];
		const [first, second] = [
			function* (r: IRow): ISelectorGenerator<number> {
				runs[0]!++;
				return r.N;
			},
			function* (r: IRow): ISelectorGenerator<number> {
				runs[1]!++;
				return r.N * 10;
			}
		] as const;
		expect(first.name).toBe("");
		expect(second.name).toBe("");
		const row = (list: IList) => list.Rows[0]!;
		const seen = await runtime.dispatch(function* (): IActionGenerator<number[]> {
			const values: number[] = [];
			for (let i = 0; i < 3; i++) {
				values.push(yield* select(first, row), yield* select(second, row));
			}
			return values;
		}, "list");
		expect(seen).toEqual([
			1,
			10,
			1,
			10,
			1,
			10
		]);
		expect(runs).toEqual([
			3,
			3
		]);
		await runtime.dispatch(setN, "list", "a", 2);
		expect(runs).toEqual([
			3,
			3
		]);
	});
});
