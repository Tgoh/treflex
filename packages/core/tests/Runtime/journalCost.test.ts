import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it, vi } from "vitest";
import { select } from "../../src/Reads/select";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { rawOf } from "../../src/Runtime/viewProxy";
// tests/Runtime is not snapshot-free: a core-only CI filter keys on
// src/index.ts's import closure (importClosure.test.ts), never on this folder.
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import * as reactive from "../reactive";
import { minted, rootSetState } from "../testHelpers";

type TestState = {
	$Id: string;
	Count: number;
	Log: number[];
};

const initialState = (): TestState => ({
	$Id: "root",
	Count: 0,
	Log: []
});

describe("journal cost", () => {
	it("keeps the journal bounded under a long-running daemon", async () => {
		await reactive.root(async (dispose) => {
			const runtime = createRuntime<TestState>(initialState()) as IRuntimeInternal<TestState>;
			const inFlight = runtime.get("runtime/inFlightActions");

			const releases: (() => void)[] = [];
			let waited!: () => void;
			let nextWait = new Promise<void>((resolve) => {
				waited = resolve;
			});
			runtime.registerImplementation(
				"daemon_gate",
				() =>
					new Promise<void>((resolve) => {
						releases.push(resolve);
						waited();
					})
			);

			function* gate(): IActionGenerator {
				yield {
					Type: "daemon_gate"
				};
			}
			function* tick(draft: TestState) {
				while (true) {
					yield* open(gate());
					draft.Count++;
				}
			}

			void runtime.processAction(
				tick,
				() => runtime.state,
				rootSetState(runtime),
				() => "root"
			);

			const cycles = 500;
			for (let i = 0; i < cycles; i++) {
				await nextWait;
				nextWait = new Promise<void>((resolve) => {
					waited = resolve;
				});
				releases.shift()!();
			}
			await nextWait;

			expect(runtime.state.Count).toBe(cycles);
			expect(inFlight().map((action) => action.Label)).toEqual([
				"tick"
			]);

			function* ordinary(draft: TestState): IActionGenerator {
				draft.Log.push(draft.Count);
			}
			await runtime.processAction(
				ordinary,
				() => runtime.state,
				rootSetState(runtime),
				() => "root"
			);
			expect(inFlight().map((action) => action.Label)).toEqual([
				"tick"
			]);

			dispose();
			runtime.dispose();
		});
	});

	it("reports per-action journaling overhead (loosely bounded)", async () => {
		const N = 2000;

		function* work(draft: TestState): IActionGenerator {
			draft.Count++;
			draft.Log.push(draft.Count);
			if (draft.Log.length > 20) {
				draft.Log.shift();
			}
		}

		async function timeRun(journalOn: boolean): Promise<number> {
			return reactive.root(async (dispose) => {
				const runtime = createRuntime<TestState>(initialState());
				if (journalOn) {
					runtime.on("record", () => {});
				}
				const start = performance.now();
				for (let i = 0; i < N; i++) {
					await runtime.processAction(
						work,
						() => runtime.state,
						rootSetState(runtime),
						() => "root"
					);
				}
				const elapsed = performance.now() - start;
				dispose();
				runtime.dispose();
				return elapsed;
			});
		}

		// The first pass warms the JIT.
		await timeRun(false);
		const off = await timeRun(false);
		const on = await timeRun(true);

		const perActionOff = (off / N) * 1000;
		const perActionOn = (on / N) * 1000;
		const overhead = on / off;
		console.info(
			`[journal cost] off=${off.toFixed(0)}ms (${perActionOff.toFixed(1)}µs/action), ` +
				`on=${on.toFixed(0)}ms (${perActionOn.toFixed(1)}µs/action), ` +
				`overhead=${overhead.toFixed(2)}×`
		);

		expect(on).toBeLessThan(off * 8 + 200);
	});

	it("reports the action-side read snapshot cost (loosely bounded)", async () => {
		const N = 2000;

		function* small(s: TestState): Generator<
			any,
			{
				Count: number;
			},
			any
		> {
			return {
				Count: s.Count
			};
		}
		function* big(s: TestState): Generator<any, Record<string, number>, any> {
			const out: Record<string, number> = {};
			for (let i = 0; i < 100; i++) {
				out[`k${i}`] = s.Count + i;
			}
			return out;
		}
		function* workSmall(draft: TestState): IActionGenerator {
			const r: {
				Count: number;
			} = yield* select(small);
			draft.Count = r.Count + 1;
		}
		function* workBig(draft: TestState): IActionGenerator {
			const r: Record<string, number> = yield* select(big);
			draft.Count = r.k0 + 1;
		}

		async function timeRun(action: (draft: TestState) => IActionGenerator): Promise<number> {
			return reactive.root(async (dispose) => {
				const runtime = createRuntime<TestState>(initialState());
				const start = performance.now();
				for (let i = 0; i < N; i++) {
					await runtime.processAction(
						action,
						() => runtime.state,
						rootSetState(runtime),
						() => "root"
					);
				}
				const elapsed = performance.now() - start;
				dispose();
				runtime.dispose();
				return elapsed;
			});
		}

		await timeRun(workSmall);
		const smallMs = await timeRun(workSmall);
		const bigMs = await timeRun(workBig);
		console.info(
			`[read snapshot cost] projection-sized=${((smallMs / N) * 1000).toFixed(1)}µs/yield, ` +
				`100-field=${((bigMs / N) * 1000).toFixed(1)}µs/yield, ratio=${(bigMs / smallMs).toFixed(2)}×`
		);

		expect(bigMs).toBeLessThan(smallMs * 20 + 200);
	});
});

describe("journal cost at scale", () => {
	type IChild = {
		$Id: string;
		Label: string;
		Value: number;
		Weight: number;
		Active: boolean;
	};

	type IChurnState = {
		Children: IChild[];
	};

	let childSerial = 0;
	const makeChild = (): IChild => {
		const id = `child-${childSerial++}`;
		return minted(id, {
			Label: `label for ${id}`,
			Value: childSerial,
			Weight: childSerial / 3,
			Active: (childSerial & 1) === 0
		});
	};

	const churnState = (n: number): IChurnState => ({
		Children: Array.from(
			{
				length: n
			},
			() => makeChild()
		)
	});

	const sweep: readonly [
		n: number,
		iterations: number
	][] = [
		[
			10,
			300
		],
		[
			100,
			120
		],
		[
			1000,
			8
		]
	];

	async function timePerAction<T extends object>(
		initial: T,
		journalOn: boolean,
		iterations: number,
		action: (draft: T, i: number) => IActionGenerator,
		setup?: (runtime: IRuntime<T>) => void
	): Promise<number> {
		return reactive.root(async (dispose) => {
			const runtime = createRuntime<T>(initial, {
				// The suite arms the O(tree) consistency walk, which would
				// swamp what these measure.
				verifyIndex: false
			});
			if (journalOn) {
				runtime.on("record", () => {});
			}
			setup?.(runtime);
			const warm = Math.max(2, Math.ceil(iterations / 5));
			for (let i = 0; i < warm; i++) {
				await runtime.processAction(
					action,
					() => runtime.state,
					rootSetState(runtime),
					() => "root",
					i
				);
			}
			const start = performance.now();
			for (let i = 0; i < iterations; i++) {
				await runtime.processAction(
					action,
					() => runtime.state,
					rootSetState(runtime),
					() => "root",
					warm + i
				);
			}
			const elapsed = performance.now() - start;
			dispose();
			runtime.dispose();
			return elapsed;
		});
	}

	// Each arm's best of several alternating runs: load only ever adds time, and a single run of a few
	// microseconds per action swings the ratio by 10× or more on a busy machine.
	async function offAndOn<T extends object>(
		initial: () => T,
		iterations: number,
		action: (draft: T, i: number) => IActionGenerator,
		setup?: (runtime: IRuntime<T>) => void
	): Promise<{
		off: number;
		on: number;
	}> {
		let off = Number.POSITIVE_INFINITY;
		let on = Number.POSITIVE_INFINITY;
		for (let round = 0; round < 5; round++) {
			off = Math.min(off, await timePerAction(initial(), false, iterations, action, setup));
			on = Math.min(on, await timePerAction(initial(), true, iterations, action, setup));
		}
		return {
			off,
			on
		};
	}

	function* churn(draft: IChurnState): IActionGenerator {
		const victimId = draft.Children[0].$Id;
		draft.Children = draft.Children.filter((c) => c.$Id !== victimId);
		draft.Children.push(makeChild());
	}

	it("reports collection-replacement churn cost, journal off vs on, across N", {
		timeout: 60_000
	}, async () => {
		for (const [n, iterations] of sweep) {
			const { off, on } = await offAndOn(() => churnState(n), iterations, churn);
			const perOff = (off / iterations) * 1000;
			const perOn = (on / iterations) * 1000;
			const ratio = on / off;
			console.info(
				`[journal cost] churn N=${n}: off=${perOff.toFixed(1)}µs/action, on=${perOn.toFixed(1)}µs/action, ` +
					`ratio=${ratio.toFixed(2)}×, delta=${(perOn - perOff).toFixed(1)}µs/action`
			);
			expect(ratio).toBeLessThan(60);
			expect(perOn).toBeLessThan(5_000 + n * 1_000);
		}
	});

	function* touch(draft: IChurnState, i: number): IActionGenerator {
		const children = draft.Children;
		children[i % children.length].Value = i;
	}

	it("reports in-place child mutation cost, journal off vs on, across N", {
		timeout: 60_000
	}, async () => {
		const perOnByN = new Map<number, number>();
		for (const [n, iterations] of sweep) {
			const { off, on } = await offAndOn(() => churnState(n), iterations, touch);
			const perOff = (off / iterations) * 1000;
			const perOn = (on / iterations) * 1000;
			perOnByN.set(n, perOn);
			const ratio = on / off;
			console.info(
				`[journal cost] in-place N=${n}: off=${perOff.toFixed(1)}µs/action, on=${perOn.toFixed(1)}µs/action, ` +
					`ratio=${ratio.toFixed(2)}×, delta=${(perOn - perOff).toFixed(1)}µs/action`
			);
			expect(ratio).toBeLessThan(10);
			expect(perOn).toBeLessThan(5_000 + n * 1_000);
		}
		// A scalar write on a child entity must cost the write, not the sibling
		// count; a per-sibling index cost puts a ~100× step between N=10 and
		// N=1000.
		const flatnessBound = perOnByN.get(10)! * 3 + 200;
		console.info(
			`[journal cost] flatness: N=10 ${perOnByN.get(10)!.toFixed(1)}µs, N=1000 ${perOnByN.get(1000)!.toFixed(1)}µs, ` +
				`bound ${flatnessBound.toFixed(1)}µs`
		);
		expect(perOnByN.get(1000)!).toBeLessThan(flatnessBound);
	});

	// Built once, outside the timed dispatches: building it inside the action
	// would measure proxied reads on top of the refresh.
	let refreshPayload: IChild[] = [];
	const buildRefreshPayload = (runtime: IRuntime<IChurnState>): void => {
		refreshPayload = runtime.state.Children.map((c) => ({
			$Id: c.$Id,
			Label: c.Label,
			Value: c.Value,
			Weight: c.Weight,
			Active: c.Active
		}));
	};

	function* reconcileRefresh(draft: IChurnState, i: number): IActionGenerator {
		yield* reconcileRows(
			draft.Children,
			[
				{
					...refreshPayload[0],
					Value: i
				},
				...refreshPayload.slice(1)
			],
			(row) => row.$Id,
			{
				update: (row, item) => {
					row.Label = item.Label;
					row.Value = item.Value;
					row.Weight = item.Weight;
					row.Active = item.Active;
				}
			}
		);
	}

	it("reports reconcileRows-refresh cost, journal off vs on, across N", {
		timeout: 60_000
	}, async () => {
		for (const [n, iterations] of sweep) {
			const { off, on } = await offAndOn(() => churnState(n), iterations, reconcileRefresh, buildRefreshPayload);
			const perOff = (off / iterations) * 1000;
			const perOn = (on / iterations) * 1000;
			const ratio = on / off;
			console.info(
				`[journal cost] reconcileRows N=${n}: off=${perOff.toFixed(1)}µs/action, on=${perOn.toFixed(1)}µs/action, ` +
					`ratio=${ratio.toFixed(2)}×, delta=${(perOn - perOff).toFixed(1)}µs/action`
			);
			expect(ratio).toBeLessThan(20);
			expect(perOn).toBeLessThan(5_000 + n * 1_000);
		}
	});

	function* replaceOne(draft: IChurnState, i: number): IActionGenerator {
		const at = i % draft.Children.length;
		draft.Children[at] = minted(`fresh-${at}-${i}`, {
			...draft.Children[at],
			Value: i
		});
	}

	// The index looks a node's entry up in a WeakMap as it walks it, so a walk of the whole
	// container shows as a lookup per child, where the clock only shows it under no load.
	async function lookupsPerAction<T extends object>(
		initial: T,
		journalOn: boolean,
		iterations: number,
		action: (draft: T, i: number) => IActionGenerator
	): Promise<number> {
		return reactive.root(async (dispose) => {
			const runtime = createRuntime<T>(initial, {
				verifyIndex: false
			});
			if (journalOn) {
				runtime.on("record", () => {});
			}
			const run = (i: number) =>
				runtime.processAction(
					action,
					() => runtime.state,
					rootSetState(runtime),
					() => "root",
					i
				);
			for (let i = 0; i < 2; i++) {
				await run(i);
			}
			const get = WeakMap.prototype.get;
			let lookups = 0;
			WeakMap.prototype.get = function (this: WeakMap<WeakKey, unknown>, key: WeakKey) {
				lookups++;
				return get.call(this, key);
			};
			try {
				for (let i = 0; i < iterations; i++) {
					await run(2 + i);
				}
			} finally {
				WeakMap.prototype.get = get;
			}
			dispose();
			runtime.dispose();
			return lookups / iterations;
		});
	}

	it("reports structural single-slot cost at constant N, journal off vs on", {
		timeout: 60_000
	}, async () => {
		for (const [n, iterations] of sweep) {
			const { off, on } = await offAndOn(() => churnState(n), iterations, replaceOne);
			const perOff = (off / iterations) * 1000;
			const perOn = (on / iterations) * 1000;
			console.info(
				`[journal cost] replace-one N=${n}: off=${perOff.toFixed(1)}µs/action, on=${perOn.toFixed(1)}µs/action, ` +
					`delta=${(perOn - perOff).toFixed(1)}µs/action`
			);
		}
		for (const journalOn of [
			false,
			true
		]) {
			const atTen = await lookupsPerAction(churnState(10), journalOn, 20, replaceOne);
			expect(await lookupsPerAction(churnState(1000), journalOn, 20, replaceOne)).toBe(atTen);
		}
	});

	// The payload is pre-built, so off against on isolates settlement cost
	// from payload construction.
	it("reports large value-class settlement cost, journal off vs on", async () => {
		type ISettleState = {
			Count: number;
		};
		const bigArray = Array.from(
			{
				length: 1000
			},
			(_, i) => ({
				$Id: i,
				Name: `item ${i}`,
				Value: i * 2
			})
		);
		const bigString = "x".repeat(100_000);

		function* settleArray(draft: ISettleState): IActionGenerator {
			const result = (yield {
				Type: "big_array"
			}) as unknown[];
			draft.Count = result.length;
		}
		function* settleString(draft: ISettleState): IActionGenerator {
			const result = (yield {
				Type: "big_string"
			}) as string;
			draft.Count = result.length;
		}
		const setup = (runtime: IRuntime<ISettleState>) => {
			runtime.registerImplementation("big_array", () => bigArray);
			runtime.registerImplementation("big_string", () => bigString);
		};

		const variants: [
			name: string,
			action: (draft: ISettleState, i: number) => IActionGenerator,
			iterations: number
		][] = [
			[
				"1000-object array",
				settleArray,
				100
			],
			[
				"100KB string",
				settleString,
				150
			]
		];
		for (const [name, action, iterations] of variants) {
			const { off, on } = await offAndOn<ISettleState>(
				() => ({
					Count: 0
				}),
				iterations,
				action,
				setup
			);
			const perOff = (off / iterations) * 1000;
			const perOn = (on / iterations) * 1000;
			const ratio = on / off;
			console.info(
				`[journal cost] settlement (${name}): off=${perOff.toFixed(1)}µs/action, on=${perOn.toFixed(1)}µs/action, ` +
					`ratio=${ratio.toFixed(2)}×, delta=${(perOn - perOff).toFixed(1)}µs/action`
			);
			expect(perOn).toBeLessThan(20_000);
		}
	});

	it("reports createSnapshot wall time with an N=1000 tree", async () => {
		await reactive.root(async (dispose) => {
			const runtime = createRuntime<IChurnState>(churnState(1000));
			await runtime.processAction(
				churn,
				() => runtime.state,
				rootSetState(runtime),
				() => "root"
			);
			// The first pass warms the JIT.
			createSnapshot(runtime);
			const start = performance.now();
			const snapshot = createSnapshot(runtime);
			const elapsed = performance.now() - start;
			console.info(`[journal cost] createSnapshot N=1000: ${elapsed.toFixed(2)}ms (${(snapshot.length / 1024).toFixed(0)}KB envelope)`);
			expect(elapsed).toBeLessThan(1000);
			dispose();
			runtime.dispose();
		});
	});

	it("reports per-wait cost by held-reference count", {
		timeout: 60_000
	}, async () => {
		const waits = 500;
		const counts = [
			0,
			1,
			10,
			50
		];

		type IWaitState = IChurnState & {
			$Id: string;
		};
		const waitState = (n: number): IWaitState => ({
			$Id: "root",
			...churnState(n)
		});

		// One write per step, however many references are held: writing
		// through all of them would scale with the variable and read as
		// per-reference work at the boundary. The writeAll arm shows that.
		async function timeWaits(held: number, writeAll: boolean): Promise<number> {
			return reactive.root(async (dispose) => {
				const runtime = createRuntime<IWaitState>(waitState(1000), {
					verifyIndex: false
				});
				runtime.registerImplementation("wait_gate", () => Promise.resolve());
				function* holder(draft: IWaitState): IActionGenerator {
					const refs: IChild[] = [];
					for (let i = 0; i < held; i++) {
						refs.push(draft.Children[i]);
					}
					for (let i = 0; i < waits; i++) {
						yield {
							Type: "wait_gate"
						};
						if (writeAll) {
							for (const ref of refs) {
								ref.Value = i;
							}
						} else if (refs.length > 0) {
							refs[0].Value = i;
						}
					}
				}
				const start = performance.now();
				await runtime.processAction(
					holder,
					() => runtime.state,
					rootSetState(runtime),
					() => "root"
				);
				const elapsed = performance.now() - start;
				dispose();
				runtime.dispose();
				return elapsed;
			});
		}

		await timeWaits(1, false);
		const one = new Map<number, number>();
		const all = new Map<number, number>();
		const best = (m: Map<number, number>, held: number, elapsed: number) =>
			m.set(held, Math.min(m.get(held) ?? Number.POSITIVE_INFINITY, (elapsed / waits) * 1000));
		for (let round = 0; round < 5; round++) {
			for (const held of counts) {
				best(one, held, await timeWaits(held, false));
				best(all, held, await timeWaits(held, true));
			}
		}
		const line = (m: Map<number, number>) => counts.map((held) => `${held} held=${m.get(held)!.toFixed(1)}µs/wait`).join(", ");
		console.info(`[journal cost] wait boundary, one write per step: ${line(one)}`);
		console.info(`[journal cost] wait boundary, a write per reference: ${line(all)}`);
		// Against the one-held arm: the zero-held arm writes nothing, so it can't be the baseline.
		expect(one.get(50)!).toBeLessThan(one.get(1)! * 2 + 20);
	});
});

describe("delete cost", () => {
	type IBook = {
		$Id: string;
		ById: Record<string, number>;
		Ids: string[];
		Rows: {
			$Id: string;
		}[];
		Sel?: unknown;
	};

	const N = 2000;

	const book = (): IBook => {
		const ById: Record<string, number> = {};
		const Ids: string[] = [];
		for (let i = 0; i < N; i++) {
			ById[`k${i}`] = i;
			Ids.push(`k${i}`);
		}
		return {
			$Id: "root",
			ById,
			Ids,
			Rows: [
				{
					$Id: "row"
				}
			]
		};
	};

	async function keyCopies(write: (draft: IBook) => void): Promise<{
		copies: number;
		state: IBook;
	}> {
		const runtime = createRuntime<IBook>(book(), {
			verifyIndex: false,
			onError: () => {}
		});
		const record = (rawOf(runtime.state) as IBook).ById;
		const keys = vi.spyOn(Object, "keys");
		function* action(draft: IBook): IActionGenerator {
			write(draft);
		}
		await runtime.dispatch(action, "root").catch(() => {});
		const copies = keys.mock.calls.filter(([target]) => target === record).length;
		keys.mockRestore();
		const state = rawOf(runtime.state) as IBook;
		runtime.dispose();
		return {
			copies,
			state
		};
	}

	it("reads a record's keys a fixed number of times for a frame that deletes half of them", async () => {
		const { copies, state } = await keyCopies((draft) => {
			for (let i = 0; i < N; i += 2) {
				delete draft.ById[`k${i}`];
			}
		});
		expect(Object.keys(state.ById)).toHaveLength(N / 2);
		expect(copies).toBeLessThan(5);
	});

	it("reads them a fixed number of times when each delete is followed by a splice", async () => {
		const { copies, state } = await keyCopies((draft) => {
			for (let i = N - 1; i >= N / 2; i--) {
				delete draft.ById[draft.Ids[i]!];
				draft.Ids.splice(i, 1);
			}
		});
		expect(state.Ids).toHaveLength(N / 2);
		expect(Object.keys(state.ById)).toEqual(state.Ids);
		expect(copies).toBeLessThan(5);
	});

	it("reads them a fixed number of times when the frame is rolled back, and puts every key back in its place", async () => {
		const { copies, state } = await keyCopies((draft) => {
			for (let i = 0; i < N; i += 2) {
				draft.ById[`k${i}`] = undefined as never;
			}
			draft.Sel = draft.Rows[0];
		});
		expect(state.Sel).toBeUndefined();
		expect(Object.keys(state.ById)).toEqual(book().Ids);
		expect(copies).toBeLessThan(5);
	});
});
