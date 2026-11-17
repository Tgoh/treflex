import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { ISnapshot } from "../../src/Snapshot/ISnapshot";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publish } from "../../src/Effects/publish";
import { registerDataSource } from "../../src/Effects/registerDataSource";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";
import { mountComponent, rawReceiver, rootSetState } from "../testHelpers";

type TestState = {
	$Id: string;
	Data: string;
	Count: number;
};

type ILocal = {
	$Id: string;
	Note?: string;
};

const initialState = (): TestState => ({
	$Id: "Root",
	Data: "before",
	Count: 0
});

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const R1 = rawReceiver(
	"R1",
	[
		"Legit/Topic",
		"Orphaned/Topic"
	],
	function* (): IActionGenerator {}
);

let localReceived: string[] = [];
const LR = rawReceiver(
	"LR",
	[
		"Local/Topic"
	],
	function* (_draft: ILocal, data: any): IActionGenerator {
		localReceived.push(data.Type as string);
	}
);

const registerDataSourceAny = registerDataSource as unknown as (
	owner: {
		$Id: string;
	},
	key: string
) => Generator<any, void, any>;
const publishAny = publish as unknown as (topic: string, data?: unknown) => Generator<any, void, any>;

function* rootSetup(draft: TestState): IActionGenerator {
	bind(draft, R1);
	yield* registerDataSourceAny(draft, "LegitSource");
}

function* localSetup(draft: ILocal): IActionGenerator {
	bind(draft, R1);
	yield* registerDataSourceAny(draft, "OrphanedSource");
}

function* localParker(draft: ILocal): IActionGenerator {
	bind(draft, R1);
	yield {
		Type: "gate",
		Name: "lp"
	} as any;
}

function* parked(draft: TestState): IActionGenerator {
	draft.Data = "during";
	yield {
		Type: "gate",
		Name: "p"
	} as any;
	draft.Data = "after";
}

function* localSubscriber(draft: ILocal): IActionGenerator {
	bind(draft, LR);
}

function* rootPublisher(): IActionGenerator {
	yield* publishAny("Local/Topic", {});
}

function createBarrier() {
	let resolve!: (v?: unknown) => void;
	const promise = new Promise<unknown>((r) => {
		resolve = r;
	});
	return {
		resolve,
		run: () => promise
	};
}

function makeWorld() {
	return setupWorld(createRuntime<TestState>(initialState(), {}));
}

async function restoreWorld(snapshot: string) {
	let world!: ReturnType<typeof setupWorld>;
	const { result } = await restoreRuntime<TestState>(snapshot, {
		rootId: "Root",
		options: {},
		setup: (runtime) => {
			world = setupWorld(runtime);
		}
	});
	return {
		b: world,
		result
	};
}

function setupWorld(runtime: IRuntime<TestState>) {
	const gates = new Map<string, ReturnType<typeof createBarrier>>();
	const barrier = (name: string) => {
		let b = gates.get(name);
		if (!b) {
			b = createBarrier();
			gates.set(name, b);
		}
		return b;
	};
	runtime.registerImplementation("gate", (e) =>
		barrier(
			(
				e as unknown as {
					Name: string;
				}
			).Name
		).run()
	);
	runtime.registerReceiver(R1);
	runtime.registerReceiver(LR);
	localReceived = [];
	return {
		runtime,
		internal: runtime as IRuntimeInternal<TestState>,
		release: (name: string) => barrier(name).resolve(),
		localReceived,
		mounted: new Map<string, string>()
	};
}

async function settle(): Promise<void> {
	await new Promise<void>((r) => {
		setTimeout(r, 0);
	});
	await new Promise<void>((r) => {
		setTimeout(r, 0);
	});
}

function dispatch<A extends any[], R>(
	runtime: IRuntime<TestState>,
	action: (draft: TestState, ...args: A) => Generator<any, R, any>,
	...args: A
): Promise<R | undefined> {
	return runtime.processAction(
		action as any,
		() => runtime.state,
		rootSetState(runtime),
		() => "Root",
		...args
	);
}

function dispatchLocal<A extends any[], R>(
	world: ReturnType<typeof makeWorld>,
	label: string,
	action: (draft: ILocal, ...args: A) => Generator<any, R, any>,
	...args: A
): Promise<R | undefined> {
	const id = mountComponent(world.internal, undefined, {});
	world.mounted.set(label, id);
	return world.internal.dispatch(action as any, id, ...args) as Promise<R | undefined>;
}

function tableRows(world: ReturnType<typeof makeWorld>) {
	return {
		bindings: world.internal.get("runtime/bindings").entries(),
		dataSources: world.internal.get("runtime/dataSources").entries()
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("restore — orphaned table-row sweep", () => {
	it("leaves ComponentState-owned rows out of the snapshot, so a restore has none to sweep", async () => {
		const a = makeWorld();
		await dispatch(a.runtime, rootSetup);
		await dispatchLocal(a, "local-1", localSetup);
		const local = a.mounted.get("local-1")!;
		expect(tableRows(a).bindings.map((s) => s.OwnerId)).toContain(local);

		const snapshot = createSnapshot(a.runtime);
		const parsed = JSON.parse(snapshot) as ISnapshot;
		expect((parsed.AppState as any).$Receiver).toBe("R1");
		expect(parsed.DataSources.map((c) => c.OwnerId)).toStrictEqual([
			"Root"
		]);
		expect(snapshot).not.toContain(local);

		const { b, result } = await restoreWorld(snapshot);
		expect(result.sweptOrphanedRows).toBe(0);

		const rows = tableRows(b);
		expect(rows.bindings).toStrictEqual([
			{
				OwnerId: "Root",
				ReceiverId: "R1"
			}
		]);
		expect(rows.dataSources).toStrictEqual([
			{
				Key: "LegitSource",
				OwnerId: "Root",
				DataId: "Root"
			}
		]);
	});

	it("sweeps orphaned rows alongside dropping the in-flight AppState action", async () => {
		const a = makeWorld();
		await dispatch(a.runtime, rootSetup);
		const pending = dispatch(a.runtime, parked);
		await dispatchLocal(a, "local-2", localSetup);
		const snapshot = createSnapshot(a.runtime);

		const { b, result } = await restoreWorld(snapshot);
		expect(result.dropped.map((d) => d.name)).toStrictEqual([
			"parked"
		]);
		expect(result.sweptOrphanedRows).toBe(0);

		const rows = tableRows(b);
		expect(rows.bindings.map((s) => s.OwnerId)).toStrictEqual([
			"Root"
		]);
		expect(rows.dataSources.map((c) => c.OwnerId)).toStrictEqual([
			"Root"
		]);

		// The dropped action never runs on B — the snapshot's partial write
		// is the restored picture.
		expect(b.runtime.state.Data).toBe("during");

		a.release("p");
		await pending;
	});

	it("leaves out a timer row whose owner the tree does not hold, and keeps one it does", async () => {
		const a = makeWorld();
		const envelope = JSON.parse(createSnapshot(a.runtime)) as ISnapshot;
		const row = (owner: string) => ({
			Key: "Orphaned/Tick",
			OwnerId: owner,
			ReceiverId: "R1",
			IntervalMs: 1000,
			Payload: null
		});
		envelope.Timers = [
			row("Root"),
			row("local-7")
		];
		const { b, result } = await restoreWorld(JSON.stringify(envelope));
		expect(result.sweptOrphanedRows).toBe(1);
		expect(b.internal.get("runtime/timers").entries()).toStrictEqual([
			row("Root")
		]);
		b.runtime.dispose();
	});

	it("carries no ComponentState rows into a second-generation snapshot", async () => {
		const a = makeWorld();
		await dispatch(a.runtime, rootSetup);
		await dispatchLocal(a, "local-3", localSetup);
		const s1 = createSnapshot(a.runtime);
		expect(s1).not.toContain(a.mounted.get("local-3")!);

		const { b } = await restoreWorld(s1);
		const s2 = createSnapshot(b.runtime);
		const s2Parsed = JSON.parse(s2) as ISnapshot;
		expect((s2Parsed.AppState as any).$Receiver).toBe("R1");
		expect(tableRows(b).bindings.map((s) => s.OwnerId)).toStrictEqual([
			"Root"
		]);
		expect(s2Parsed.DataSources.map((c) => c.OwnerId)).toStrictEqual([
			"Root"
		]);

		const { result } = await restoreWorld(s2);
		expect(result.sweptOrphanedRows).toBe(0);
	});

	it("leaves an in-flight ComponentState action out: no InFlight entry, no drop, no row", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const a = makeWorld();
		const pending = dispatchLocal(a, "local-5", localParker);
		const snapshot = createSnapshot(a.runtime);
		const parsed = JSON.parse(snapshot) as ISnapshot;
		expect(parsed.InFlight).toStrictEqual([]);
		expect(snapshot).not.toContain(a.mounted.get("local-5")!);
		expect(parsed.AppState).not.toHaveProperty("$Receiver");
		expect(warn).not.toHaveBeenCalled();

		const { b, result } = await restoreWorld(snapshot);

		expect(result.dropped).toStrictEqual([]);
		expect(result.sweptOrphanedRows).toBe(0);
		expect(tableRows(b).bindings).toStrictEqual([]);
		expect(roundTrip(b.runtime.state)).toStrictEqual(roundTrip(a.runtime.state));

		a.release("lp");
		await pending;
	});

	it("drops only the AppState in-flight action when a ComponentState action is also in flight", async () => {
		const a = makeWorld();
		const pendingParked = dispatch(a.runtime, parked);
		const pendingLocal = dispatchLocal(a, "local-6", localParker);
		const snapshot = createSnapshot(a.runtime);
		const parsed = JSON.parse(snapshot) as ISnapshot;
		expect(parsed.InFlight.map((e) => e.Name)).toStrictEqual([
			"parked"
		]);

		const { b, result } = await restoreWorld(snapshot);
		expect(result.dropped.map((d) => d.name)).toStrictEqual([
			"parked"
		]);
		expect(result.sweptOrphanedRows).toBe(0);
		expect(tableRows(b).bindings).toStrictEqual([]);

		a.release("p");
		a.release("lp");
		await Promise.all([
			pendingParked,
			pendingLocal
		]);
	});
});

describe("ComponentState records", () => {
	it("are ordinary records, with a path through the root", async () => {
		const a = makeWorld();
		const tapped: IRecord[] = [];
		a.runtime.on("record", (record) => {
			tapped.push(record);
		});

		await dispatchLocal(a, "local-8", localSetup);
		const local = a.mounted.get("local-8")!;

		const start = tapped.find((r) => r.Kind === "action:start" && r.EntityId === local);
		expect(start).toBeDefined();
		expect((start as any).Path).toStrictEqual([
			"Root",
			local
		]);
	});

	it("a bound ComponentState entity hears a publish and stays bound", async () => {
		const a = makeWorld();
		await dispatchLocal(a, "local-9", localSubscriber);
		const local = a.mounted.get("local-9")!;
		expect(tableRows(a).bindings).toStrictEqual([
			{
				OwnerId: local,
				ReceiverId: "LR"
			}
		]);

		await dispatch(a.runtime, rootPublisher);
		await settle();

		expect(a.localReceived).toStrictEqual([
			"Local/Topic"
		]);
		expect(tableRows(a).bindings).toStrictEqual([
			{
				OwnerId: local,
				ReceiverId: "LR"
			}
		]);
	});
});
