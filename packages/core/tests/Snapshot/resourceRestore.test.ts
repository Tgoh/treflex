import type { IResourceRow } from "../../src/Runtime/createResourceTable";
import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IRestoreBoot } from "../../src/Snapshot/index";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IResourceContext } from "../../src/Types/IResource";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeResource } from "../../src/Effects/closeResource";
import { openResource } from "../../src/Effects/openResource";
import { resource } from "../../src/Effects/resource";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { receiver } from "../../src/Runtime/receiver";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { SNAPSHOT_FORMAT_VERSION } from "../../src/Snapshot/ISnapshot";
import { restoreRuntime, SnapshotRejectedError } from "../../src/Snapshot/index";
import { isEnded } from "../../src/Types/IResource";
import { mountComponent } from "../testHelpers";

vi.mock("../../src/Runtime/createRuntime", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/Runtime/createRuntime")>();
	return {
		...actual,
		createRuntime: vi.fn(actual.createRuntime)
	};
});

declare module "../../src/Registries/IResourceRegistry" {
	interface IResourceTypeRegistry {
		"restore/stream": {
			Params: {
				Endpoint: string;
			};
			Message: {
				Seq: number;
			};
			Methods: {
				peek(): string;
			};
		};
	}
	interface IResourceRegistry {
		"Restore/Stream": {
			Type: "restore/stream";
		};
	}
}

type IChild = {
	$Id: string;
	Seq: number;
};
type IRoot = {
	$Id: string;
	Seq: number;
	Children: IChild[];
};

const initialState = (): IRoot => ({
	$Id: "root",
	Seq: 0,
	Children: [
		{
			$Id: "child-1",
			Seq: 0
		}
	]
});

const StreamReceiver = receiver<IChild>("RestoreStreamReceiver")({
	*"Restore/Stream"(draft, e) {
		if (!isEnded(e)) {
			draft.Seq = e.Seq;
		}
	}
});

function* openStream(draft: IChild): IActionGenerator {
	yield* openResource(draft, "Restore/Stream", StreamReceiver, {
		Type: "restore/stream",
		Endpoint: "/s"
	});
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setupWorld(runtime: IRuntime<IRoot>) {
	runtime.registerReceiver(StreamReceiver);
	const internal = runtime as IRuntimeInternal<IRoot>;
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (d) => diags.push(d));
	const contexts: IResourceContext<"restore/stream">[] = [];
	const order: string[] = [];
	runtime.registerResourceType("restore/stream", (_params, r) => {
		contexts.push(r);
		order.push(`setup:${r.ownerId}`);
		r.methods({
			peek: () => "peeked"
		});
	});
	return {
		runtime,
		internal,
		diags,
		contexts,
		order,
		codes: () => diags.map((d) => d.code)
	};
}

type IWorld = ReturnType<typeof setupWorld>;

function build(state = initialState()): IWorld {
	return setupWorld(createRuntime<IRoot>(state, {}));
}

async function restoreWorld(snapshot: string, repair?: (world: IWorld) => unknown) {
	let world!: IWorld;
	const boot: IRestoreBoot<IRoot> = {
		rootId: "root",
		options: {},
		setup: (runtime) => {
			world = setupWorld(runtime);
		}
	};
	if (repair) {
		boot.repair = () => repair(world);
	}
	const { result } = await restoreRuntime(snapshot, boot);
	return {
		world,
		result
	};
}

async function savedWithStream(): Promise<string> {
	const world = build();
	await world.runtime.dispatch(openStream, "child-1");
	const snapshot = createSnapshot(world.runtime);
	world.runtime.dispose();
	return snapshot;
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("resources: the snapshot section", () => {
	it("writes every row except a ComponentState owner's", async () => {
		const world = build();
		await world.runtime.dispatch(openStream, "child-1");
		const local = mountComponent(world.internal, "child-1", {
			Seq: 0
		});
		await world.runtime.dispatch(openStream as any, local);
		expect(world.runtime.resources()).toHaveLength(2);
		const envelope = JSON.parse(createSnapshot(world.runtime));
		expect(envelope.Resources).toEqual([
			{
				Key: "Restore/Stream",
				OwnerId: "child-1",
				Params: {
					Type: "restore/stream",
					Endpoint: "/s"
				},
				ReceiverId: "RestoreStreamReceiver",
				ResumeFrom: null
			}
		]);
		world.runtime.dispose();
	});

	it("leaves resource-started actions out of the in-flight list", async () => {
		const world = build();
		let release!: () => void;
		world.runtime.registerImplementation(
			"restore/gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const Parking = receiver<IChild>("RestoreParking")({
			*"Restore/Stream"(_draft, e) {
				if (!isEnded(e)) {
					yield {
						Type: "restore/gate"
					};
				}
			}
		});
		world.runtime.registerReceiver(Parking);
		function* open(draft: IChild): IActionGenerator {
			yield* openResource(draft, "Restore/Stream", Parking, {
				Type: "restore/stream",
				Endpoint: "/s"
			});
		}
		await world.runtime.dispatch(open, "child-1");
		void world.contexts[0].emit({
			Seq: 1
		});
		await settle();
		expect(JSON.parse(createSnapshot(world.runtime)).InFlight).toEqual([]);
		release();
		await settle();
		world.runtime.dispose();
	});

	it("reads a missing section as no resources", async () => {
		const source = build();
		const envelope = JSON.parse(createSnapshot(source.runtime));
		source.runtime.dispose();
		delete envelope.Resources;
		const { world } = await restoreWorld(JSON.stringify(envelope));
		expect(world.runtime.resources()).toEqual([]);
		world.runtime.dispose();
	});

	it("rejects a mis-shaped section before anything is built, and drops malformed rows with a diag", async () => {
		const source = build();
		const envelope = JSON.parse(createSnapshot(source.runtime));
		source.runtime.dispose();
		await expect(
			restoreWorld(
				JSON.stringify({
					...envelope,
					Resources: {}
				})
			)
		).rejects.toThrow(/structurally incomplete/);
		const good: IResourceRow = {
			Key: "Restore/Stream",
			OwnerId: "child-1",
			Params: {
				Type: "restore/stream",
				Endpoint: "/s"
			},
			ReceiverId: null,
			ResumeFrom: null
		};
		const { world } = await restoreWorld(
			JSON.stringify({
				...envelope,
				Resources: [
					good,
					{
						Key: "Restore/Stream",
						OwnerId: "child-1"
					},
					null
				]
			})
		);
		expect(world.codes()).toContain("restore/malformed-rows");
		expect(world.runtime.resources()).toEqual([
			good
		]);
		world.runtime.dispose();
	});
});

describe("resources: restore", () => {
	it("sets up every loaded row once setup has registered its type", async () => {
		const snapshot = await savedWithStream();
		const { world } = await restoreWorld(snapshot);
		await settle();
		expect(world.order).toEqual([
			"setup:child-1"
		]);
		expect(world.codes()).not.toContain("resource/unregistered-type");
		expect(world.runtime.resources().map((row) => row.OwnerId)).toEqual([
			"child-1"
		]);
		world.runtime.dispose();
	});

	it("with a repair, keeps resources paused until its own promise settles, and resolves at that point", async () => {
		const snapshot = await savedWithStream();
		let peekedInRepair: unknown = "unset";
		const { world, result } = await restoreWorld(snapshot, async (world) => {
			world.order.push("repair");
			function* peek(draft: IChild): IActionGenerator {
				peekedInRepair = yield* resource(draft, "Restore/Stream").peek();
			}
			await world.runtime.dispatch(peek, "child-1");
			world.order.push("repaired");
		});
		expect(peekedInRepair).toBeUndefined();
		expect(world.order).toEqual([
			"repair",
			"repaired",
			"setup:child-1"
		]);
		expect(result.repairError).toBeUndefined();
		world.runtime.dispose();
	});

	it("hands the repair the runtime and the result", async () => {
		const snapshot = await savedWithStream();
		let seen: unknown;
		const { runtime, result } = await restoreRuntime<IRoot>(snapshot, {
			rootId: "root",
			options: {},
			setup: (runtime) => {
				setupWorld(runtime);
			},
			repair: (runtime, result) => {
				seen = {
					runtime,
					result
				};
			}
		});
		expect(seen).toStrictEqual({
			runtime,
			result
		});
		runtime.dispose();
	});

	it("does not set up a row the repair closes, and a throwing repair rides the result while resources resume", async () => {
		const snapshot = await savedWithStream();
		function* close(draft: IChild): IActionGenerator {
			yield* closeResource(draft, "Restore/Stream");
		}
		const closed = await restoreWorld(snapshot, (world) => world.runtime.dispatch(close, "child-1"));
		expect(closed.result.repairError).toBeUndefined();
		expect(closed.world.order).toEqual([]);

		const failure = new Error("repair broke");
		const second = await restoreWorld(snapshot, () => {
			throw failure;
		});
		expect(second.result.repairError).toBe(failure);
		expect(second.world.order).toEqual([
			"setup:child-1"
		]);
		closed.world.runtime.dispose();
		second.world.runtime.dispose();
	});

	it("names a repair still running a few seconds after the load", async () => {
		const snapshot = await savedWithStream();
		vi.useFakeTimers();
		let finish!: () => void;
		let world!: IWorld;
		const restored = restoreRuntime<IRoot>(snapshot, {
			rootId: "root",
			options: {},
			setup: (runtime) => {
				world = setupWorld(runtime);
			},
			repair: function slowRepair() {
				return new Promise<void>((resolve) => {
					finish = resolve;
				});
			}
		});
		await vi.advanceTimersByTimeAsync(3500);
		expect(world.diags.find((d) => d.code === "resource/still-paused")?.data).toEqual({
			repair: "slowRepair"
		});
		finish();
		await restored;
		vi.useRealTimers();
		world.runtime.dispose();
	});

	it("emits the load's diags, disposes the runtime and rejects the snapshot with its cause when the table load throws", async () => {
		const envelope = JSON.parse(await savedWithStream());
		envelope.DataSources.push(null);
		const failure = new Error("load exploded");
		const order: string[] = [];
		const { createRuntime: build } =
			await vi.importActual<typeof import("../../src/Runtime/createRuntime")>("../../src/Runtime/createRuntime");
		vi.mocked(createRuntime).mockImplementationOnce((state, options) => {
			const built = build(state, options);
			built.on("diag", (event) => order.push(event.code));
			const dispose = built.dispose;
			built.dispose = () => {
				order.push("dispose");
				dispose();
			};
			vi.spyOn((built as IRuntimeInternal<IRoot>).get("runtime/resources"), "load").mockImplementation(() => {
				throw failure;
			});
			return built;
		});
		const rejection = restoreRuntime(JSON.stringify(envelope), {
			rootId: "root",
			options: {}
		});
		await expect(rejection).rejects.toThrow(SnapshotRejectedError);
		await expect(rejection).rejects.toMatchObject({
			cause: failure
		});
		expect(order).toStrictEqual([
			"restore/malformed-rows",
			"dispose"
		]);
	});

	it("reads loaded rows as pending paused while the repair runs", async () => {
		const snapshot = await savedWithStream();
		let during: unknown;
		const { world } = await restoreWorld(snapshot, (world) => {
			during = world.internal.get("runtime/resources").status("Restore/Stream", "child-1");
		});
		expect(during).toEqual({
			State: "pending",
			Waiting: "paused"
		});
		world.runtime.dispose();
	});

	it("leaves out rows whose owner the restored tree does not hold", async () => {
		const source = build();
		const envelope = JSON.parse(createSnapshot(source.runtime));
		source.runtime.dispose();
		const { world, result } = await restoreWorld(
			JSON.stringify({
				...envelope,
				Version: SNAPSHOT_FORMAT_VERSION,
				Resources: [
					{
						Key: "Restore/Stream",
						OwnerId: "gone",
						Params: {
							Type: "restore/stream",
							Endpoint: "/s"
						},
						ReceiverId: null,
						ResumeFrom: null
					}
				]
			})
		);
		expect(result.sweptOrphanedRows).toBe(1);
		expect(world.runtime.resources()).toEqual([]);
		world.runtime.dispose();
	});
});
