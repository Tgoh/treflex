import type { IActionGenerator, IOpenGenerator, IRuntime, ISelectorGenerator } from "../../src/index";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import { describe, expect, it } from "vitest";
import { startTimer } from "../../src/Effects/startTimer";
import { resumable } from "../../src/Resume/resumable";
import { inFlight } from "../../src/Runtime/arrivals";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { pendingAsks } from "../../src/Runtime/pendingAsks";
import { receiver } from "../../src/Runtime/receiver";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { settled } from "../../src/Testing/createTestRuntime";
import * as reactive from "../reactive";
import { restoreWithResume, runEngine } from "./replayHarness";
import { harness, type IOrder, type IShop, shop, until, wait } from "./resumeHarness";

function* watchedFlow(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	d.Note = String(yield* open(wait("first")));
}
named(watchedFlow, "Watched/Flow");
resumable(watchedFlow);

const Ticker = (receiver as (id: string) => (cases: object) => never)("Watched/Ticker")({
	*"Watched/Tick"(draft: IOrder) {
		draft.Note = "tick";
	}
});

function* arm(d: IOrder): IActionGenerator {
	yield* (startTimer as (...args: unknown[]) => IActionGenerator)(d, "Watched/Tick", Ticker, 3_600_000);
}

let json = "";

async function snapshot(): Promise<string> {
	if (json === "") {
		const h = harness<IShop>(shop());
		h.runtime.dispatch(watchedFlow, "o1").catch(() => {});
		await until(() => h.waiting.length > 0);
		json = createSnapshot(h.runtime);
		h.runtime.dispose();
	}
	return json;
}

async function restoredWith(setup: (runtime: IRuntime<IShop>) => (() => void) | undefined) {
	const stops: (() => void)[] = [];
	const run = await restoreWithResume<IShop>(await snapshot(), "shop", {
		setup: (restored) => {
			const stop = setup(restored as IRuntime<IShop>);
			if (stop) {
				stops.push(stop);
			}
		}
	});
	const engine = runEngine(run);
	for (const stop of stops) {
		stop();
	}
	run.runtime.dispose();
	return engine;
}

describe("the tree is watched only by what an app made reactive", () => {
	it("is not tripped by an ordinary setup: implementations, receivers, resources, taps, a timer, plain reads and processSelector", async () => {
		const engine = await restoredWith((runtime) => {
			runtime.registerImplementation("Watched/Other", () => 1);
			runtime.registerReceiver(Ticker);
			runtime.registerResourceType("watched/feed" as never, () => {});
			runtime.on("record", () => {});
			runtime.on("diag", () => {});
			runtime.dispatch(arm, "o2").catch(() => {});
			void runtime.state.Orders.o1!.Qty;
			void JSON.stringify(runtime.state);
			const read = runtime.processSelector(
				function* (): ISelectorGenerator<unknown> {
					const order = runtime.state.Orders.o1!;
					return [
						order.Qty,
						yield* inFlight(watchedFlow, order),
						(yield* pendingAsks(order)).length
					];
				},
				() => runtime.state
			);
			expect(read).toEqual([
				2,
				false,
				0
			]);
		});
		expect(engine.dropped).toEqual([]);
		expect(engine.resumed.map((resumed) => resumed.name)).toEqual([
			"Watched/Flow"
		]);
	});

	it("is tripped by an effect reading the entity, and says where it read", async () => {
		const engine = await restoredWith((runtime) =>
			reactive.root((dispose) => {
				reactive.effect(() => runtime.state.Orders.o1!.Qty);
				return dispose;
			})
		);
		expect(
			engine.dropped.map((drop) => [
				drop.reason,
				drop.detail
			])
		).toEqual([
			[
				"watched",
				"a reactive scope has read the tree at AppState.Orders.o1, and would see the replay"
			]
		]);
	});

	it("is tripped by a memo that is read", async () => {
		const engine = await restoredWith((runtime) =>
			reactive.root((dispose) => {
				const qty = reactive.memo(() => runtime.state.Orders.o1!.Qty);
				void qty();
				return dispose;
			})
		);
		expect(engine.dropped.map((drop) => drop.reason)).toEqual([
			"watched"
		]);
	});

	it("is tripped by a memo that is never read", async () => {
		const engine = await restoredWith((runtime) =>
			reactive.root((dispose) => {
				reactive.memo(() => runtime.state.Orders.o1!.Qty);
				return dispose;
			})
		);
		expect(engine.dropped.map((drop) => drop.detail)).toEqual([
			"a reactive scope has read the tree at AppState.Orders.o1, and would see the replay"
		]);
	});

	it("is tripped by a computation disposed after it ran: tracking records outlive their scope", async () => {
		let ran = 0;
		const engine = await restoredWith((runtime) => {
			const dispose = reactive.root((given) => {
				reactive.effect(() => {
					ran++;
					void runtime.state.Orders.o1!.Qty;
				});
				return given;
			});
			dispose();
			return undefined;
		});
		expect(ran).toBe(1);
		expect(engine.dropped.map((drop) => drop.detail)).toEqual([
			"a reactive scope has read the tree at AppState.Orders.o1, and would see the replay"
		]);
	});

	it("is tripped by a binding's memoized read of the entity, which a view's selector makes", async () => {
		const engine = await restoredWith((runtime) => {
			(runtime as IRuntimeInternal<IShop>).runSelector(
				function* (order: IOrder): ISelectorGenerator<number> {
					return order.Qty;
				},
				() => runtime.state.Orders.o1
			);
		});
		expect(engine.dropped.map((drop) => drop.detail)).toEqual([
			"a reactive scope has read the tree at AppState.Orders.o1, and would see the replay"
		]);
	});

	it("is tripped by an effect reading only an unrelated part of the tree", async () => {
		const engine = await restoredWith((runtime) =>
			reactive.root((dispose) => {
				reactive.effect(() => runtime.state.Clock);
				return dispose;
			})
		);
		expect(engine.dropped.map((drop) => drop.detail)).toEqual([
			"a reactive scope has read the tree at AppState, and would see the replay"
		]);
	});
});

let tick = 0;

function* divergingFlow(d: IOrder): IOpenGenerator {
	d.Note = `t${++tick}`;
	d.Key = String(yield* open(wait("first")));
}
named(divergingFlow, "Watched/Diverging");
resumable(divergingFlow);

const snapshots = new Map<Function, string>();

async function snapshotOf(action: Function): Promise<string> {
	if (!snapshots.has(action)) {
		const h = harness<IShop>(shop());
		h.runtime.dispatch(action as never, "o1").catch(() => {});
		await until(() => h.waiting.length > 0);
		snapshots.set(action, createSnapshot(h.runtime));
		h.runtime.dispose();
	}
	return snapshots.get(action)!;
}

/** How often a computation `setup` makes re-runs while the engine runs and its microtasks settle, and what the engine did. */
async function rerunsAcross(action: Function, watch: (runtime: IRuntimeInternal<IShop>) => unknown) {
	let runs = 0;
	let stop = (): void => {};
	const run = await restoreWithResume<IShop>(await snapshotOf(action), "shop", {
		setup: (restored) => {
			restored.provideExternal("Watched/Ext" as never, {
				read: () => "e" as never
			});
			stop = reactive.root((dispose) => {
				reactive.effect(() => {
					runs++;
					watch(restored as IRuntimeInternal<IShop>);
				});
				return dispose;
			});
		}
	});
	await settled();
	const before = runs;
	const engine = runEngine(run);
	await settled();
	const reruns = runs - before;
	run.runtime.provideExternal("Watched/Ext" as never, {
		read: () => "f" as never
	});
	await settled();
	const notified = runs - before - reruns;
	stop();
	run.runtime.dispose();
	return {
		engine,
		reruns,
		notified
	};
}

describe("what else a reactive scope can watch that a prefix could change", () => {
	it("inFlight on an entity drops every candidate as watched: a prefix lists its action and a fallback takes it off again", async () => {
		const { engine } = await rerunsAcross(watchedFlow, (runtime) => {
			const order = reactive.untrack(() => runtime.state.Orders.o1!);
			runtime.processSelector(
				function* (): ISelectorGenerator<boolean> {
					return yield* inFlight(watchedFlow, order);
				},
				() => runtime.state
			);
		});
		expect(engine.dropped.map((drop) => drop.detail)).toEqual([
			'a reactive scope has read inFlight on "o1", and would see the replay'
		]);
	});

	it("the index's cells drop every candidate as watched: the rewind takes entities out below the marked one and puts them back", async () => {
		const { engine } = await rerunsAcross(watchedFlow, (runtime) => runtime.get("runtime/stateIdLookup")()["o1-l1"]?.path);
		expect(engine.dropped.map((drop) => drop.detail)).toEqual([
			"a reactive scope has read the index, and would see the replay"
		]);
	});

	for (const [name, watch] of [
		[
			"the ask listing",
			(runtime: IRuntimeInternal<IShop>) => {
				const order = reactive.untrack(() => runtime.state.Orders.o1!);
				runtime.processSelector(
					function* (): ISelectorGenerator<number> {
						return (yield* pendingAsks(order)).length;
					},
					() => runtime.state
				);
			}
		],
		[
			"a resource's status",
			(runtime: IRuntimeInternal<IShop>) => runtime.get("runtime/resources").status("Watched/Feed", "o1")
		],
		[
			"an external value",
			(runtime: IRuntimeInternal<IShop>) => runtime.get("runtime/externals").read("Watched/Ext")
		],
		[
			"the timer rows",
			(runtime: IRuntimeInternal<IShop>) => runtime.timers()
		]
	] as const) {
		it(`${name} is never notified by a prefix, resumed or dropped`, async () => {
			const resumed = await rerunsAcross(watchedFlow, watch);
			expect(resumed.engine.resumed).toHaveLength(1);
			expect(resumed.reruns).toBe(0);
			const dropped = await rerunsAcross(divergingFlow, watch);
			expect(dropped.engine.dropped.map((drop) => drop.reason)).toEqual([
				"diverged"
			]);
			expect(dropped.reruns).toBe(0);
		});
	}

	it("the computations above do re-run when what they track changes, so a quiet engine is not a computation that tracks nothing", async () => {
		const { notified } = await rerunsAcross(watchedFlow, (runtime) => runtime.get("runtime/externals").read("Watched/Ext"));
		expect(notified).toBeGreaterThan(0);
	});
});
