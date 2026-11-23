import type { IActionGenerator, IEffect, IEntity, IOpenGenerator, IRuntime } from "treflex";
import { createMemo, createRoot } from "solid-js";
import { createRuntime, defineEffect, named, open, resumable } from "treflex";
import { createSnapshot, type IRestoreOutcome, restoreRuntime } from "treflex/snapshot";
import { beforeAll, describe, expect, it } from "vitest";
import { createEntityFeature } from "../../src/Context/createEntityFeature";
import { TreflexProvider } from "../../src/Context/TreflexContext";
import { useInFlight } from "../../src/Hooks/useInFlight";
import { type IMounted, mount } from "../mount";

interface IOrder extends IEntity {
	Qty: number;
	Note: string;
}

interface IShop extends IEntity {
	Orders: Record<string, IOrder>;
}

interface ICore {
	resumable(action: Function): void;
	harness(state: IShop): {
		runtime: IRuntime<IShop>;
		waiting: unknown[];
	};
	shop(): IShop;
	until(predicate: () => boolean): Promise<void>;
	wait(name: string): IActionGenerator<unknown>;
	restoreWithResume(
		json: string,
		rootId: string,
		options: {
			setup: (runtime: IRuntime<IShop>) => void;
		}
	): Promise<{
		runtime: IRuntime<IShop>;
	}>;
	runEngine(run: unknown): {
		dropped: {
			reason: string;
			detail: string;
		}[];
		resumed: {
			name: string | null;
		}[];
	};
}

let core: ICore;

// Computed specifiers: a static import of core's sources puts them in this package's typecheck, outside its rootDir.
beforeAll(async () => {
	const coreDir = import.meta.url.replace(/packages\/solid\/.*$/, "packages/core/");
	const load = (path: string) => import(/* @vite-ignore */ `${coreDir}${path}.ts`);
	core = Object.assign(
		{},
		await load("src/Resume/resumable"),
		await load("tests/Resume/resumeHarness"),
		await load("tests/Resume/replayHarness")
	);
	core.resumable(watchedFlow);
});

function* watchedFlow(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	d.Note = String(yield* open(core.wait("first")));
}
named(watchedFlow, "Bridge/Watched");

const Order = createEntityFeature<IOrder>("Bridge/Order")({}, {});

async function snapshot(): Promise<string> {
	const h = core.harness(core.shop());
	h.runtime.dispatch(watchedFlow, "o1").catch(() => {});
	await core.until(() => h.waiting.length > 0);
	const json = createSnapshot(h.runtime);
	h.runtime.dispose();
	return json;
}

async function resumedUnder(view: (runtime: IRuntime<IShop>) => IMounted) {
	let mounted: IMounted | undefined;
	const run = await core.restoreWithResume(await snapshot(), "shop", {
		setup: (restored) => {
			mounted = view(restored);
		}
	});
	const engine = core.runEngine(run);
	mounted?.dispose();
	run.runtime.dispose();
	return {
		dropped: engine.dropped.map((drop) => [
			drop.reason,
			drop.detail
		]),
		resumed: engine.resumed.map((resumed) => resumed.name)
	};
}

describe("resume's watching check under the Solid 2 bridge", () => {
	it("resumes the in-flight row under a Solid view that reads neither", async () => {
		expect(await resumedUnder(() => mount(() => <p>static</p>))).toEqual({
			dropped: [],
			resumed: [
				"Bridge/Watched"
			]
		});
	});

	it("drops the in-flight row as watched when a Solid view reads the tree", async () => {
		const { dropped } = await resumedUnder((runtime) => mount(() => <p>{runtime.state.Orders.o1!.Qty}</p>));
		expect(dropped).toEqual([
			[
				"watched",
				"a reactive scope has read the tree at AppState.Orders.o1, and would see the replay"
			]
		]);
	});

	it("drops the in-flight row as watched when a Solid view reads inFlight", async () => {
		const Busy = Order.provider(() => {
			const order = Order.use();
			const busy = useInFlight(watchedFlow, order.state);
			return <p>{busy() ? "busy" : "idle"}</p>;
		});
		const { dropped } = await resumedUnder((runtime) =>
			mount(() => (
				<TreflexProvider value={runtime}>
					<Busy state={runtime.state.Orders.o1!} />
				</TreflexProvider>
			))
		);
		expect(dropped).toEqual([
			[
				"watched",
				'a reactive scope has read inFlight on "o1", and would see the replay'
			]
		]);
	});

	it("resumes a flow through restoreRuntime started inside a Solid createMemo", async () => {
		const options = {
			build: "bridge",
			resume: true as const,
			implementations: {
				"Bridge/Ask": () => new Promise<string>(() => {})
			}
		};
		const live = createRuntime<IShop>(core.shop(), options);
		live.dispatch(askedFlow, "o1").catch(() => {});
		await core.until(() => live.state.Orders.o1!.Qty === 2);
		const json = createSnapshot(live);
		live.dispose();
		let restoring: Promise<{
			runtime: IRuntime<IShop>;
			result: IRestoreOutcome;
		}> | null = null;
		const dispose = createRoot((d) => {
			const booted = createMemo(() => {
				restoring ??= restoreRuntime<IShop>(json, {
					rootId: "shop",
					options
				});
				return true;
			});
			booted();
			return d;
		});
		const { runtime, result } = await restoring!;
		expect(result.dropped).toEqual([]);
		expect(result.resumed.map((entry) => entry.name)).toEqual([
			"Bridge/Asked"
		]);
		dispose();
		runtime.dispose();
	});
});

interface IAskEffect extends IEffect {
	Type: "Bridge/Ask";
}

const ask = defineEffect<IAskEffect, string>("Bridge/Ask", {
	idempotent: true
});

function* askedFlow(d: IOrder): IOpenGenerator {
	d.Qty += 1;
	d.Note = yield* open(ask());
}
named(askedFlow, "Bridge/Asked");
resumable(askedFlow);
