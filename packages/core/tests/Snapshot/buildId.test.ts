import type { IRuntimeOptions } from "../../src/Runtime/createRuntime";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publish } from "../../src/Effects/publish";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { named } from "../../src/Runtime/named";
import { receiver } from "../../src/Runtime/receiver";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { SNAPSHOT_FORMAT_VERSION } from "../../src/Snapshot/ISnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";
import { settled } from "../../src/Testing/createTestRuntime";

interface IRoot extends IEntity {
	N: number;
}

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"Build/Hang": {};
	}
}

function* hangs(_draft: IRoot): IActionGenerator {
	yield {
		Type: "test/hang"
	};
}
named(hangs, "Build/Hangs");

function* bumps(draft: IRoot): IActionGenerator {
	draft.N++;
}
named(bumps, "Build/Bumps");

function runtimeWith(options: IRuntimeOptions = {}) {
	const runtime = createRuntime<IRoot>(
		{
			$Id: "Root",
			N: 0
		},
		options
	);
	runtime.registerImplementation("test/hang", () => new Promise(() => {}));
	return runtime;
}

async function savedBy(options: IRuntimeOptions): Promise<string> {
	const runtime = runtimeWith(options);
	void runtime.dispatch(hangs, "Root");
	await settled();
	const snapshot = createSnapshot(runtime);
	runtime.dispose();
	return snapshot;
}

const boot = (options: IRuntimeOptions = {}) => ({
	rootId: "Root",
	options
});

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the build in a snapshot", () => {
	it("writes the runtime's build as Build, or null when it has none, in a version 8 envelope", async () => {
		const withBuild = JSON.parse(
			await savedBy({
				build: "build-1"
			})
		);
		expect(SNAPSHOT_FORMAT_VERSION).toBe(8);
		expect(withBuild.Version).toBe(8);
		expect(withBuild.Build).toBe("build-1");
		expect(JSON.parse(await savedBy({})).Build).toBeNull();
	});

	it.each([
		[
			"the same build",
			"build-1",
			"build-1",
			true
		],
		[
			"another build",
			"build-1",
			"build-2",
			false
		],
		[
			"a save with no build",
			undefined,
			"build-1",
			false
		],
		[
			"a runtime with no build",
			"build-1",
			undefined,
			false
		],
		[
			"neither with a build",
			undefined,
			undefined,
			false
		]
	] as const)("answers sameBuild for %s, and drops the in-flight work either way", async (_case, saved, running, same) => {
		const { runtime, result } = await restoreRuntime<IRoot>(
			await savedBy({
				build: saved
			}),
			boot({
				build: running
			})
		);
		expect(result.savedBuild).toBe(saved ?? null);
		expect(result.sameBuild).toBe(same);
		expect(result.dropped).toEqual([
			{
				actionId: expect.any(String),
				name: "Build/Hangs",
				label: "hangs",
				entityId: "Root"
			}
		]);
		expect(JSON.parse(createSnapshot(runtime)).InFlight).toEqual([]);
		await runtime.dispatch(bumps, "Root");
		expect(runtime.state.N).toBe(1);
		runtime.dispose();
	});

	it("names a delivery in flight by its receiver", async () => {
		const Root = receiver<IRoot>("Build/RootReceiver")({
			*"Build/Hang"() {
				yield {
					Type: "test/hang"
				};
			}
		});
		const runtime = runtimeWith();
		runtime.registerReceiver(Root);
		await runtime.dispatch(function* binds(draft: IRoot): IActionGenerator {
			bind(draft, Root);
		}, "Root");
		await runtime.dispatch(function* (_draft: IRoot): IActionGenerator {
			yield* publish("Build/Hang");
		}, "Root");
		await settled();
		const inFlight = JSON.parse(createSnapshot(runtime)).InFlight;
		expect(inFlight).toEqual([
			{
				ActionId: expect.any(String),
				Name: null,
				Label: "Build/RootReceiver",
				Receiver: "Build/RootReceiver",
				EntityId: "Root"
			}
		]);
		runtime.dispose();
	});
});

describe("a version 7 envelope", () => {
	it("loads, with each in-flight Name read as a label, no names and no build", async () => {
		const v7 = {
			Version: 7,
			AppState: {
				$Id: "Root",
				N: 3
			},
			DataSources: [],
			Timers: [],
			Resources: [],
			InFlight: [
				{
					ActionId: "branch-1",
					Name: "hangs",
					EntityId: "Root"
				},
				{
					ActionId: "branch-2",
					Name: null,
					EntityId: "Root"
				}
			]
		};
		const { runtime, result } = await restoreRuntime<IRoot>(
			JSON.stringify(v7),
			boot({
				build: "build-1"
			})
		);
		expect(runtime.state.N).toBe(3);
		expect(result.savedBuild).toBeNull();
		expect(result.sameBuild).toBe(false);
		expect(result.dropped).toEqual([
			{
				actionId: "branch-1",
				name: null,
				label: "hangs",
				entityId: "Root"
			},
			{
				actionId: "branch-2",
				name: null,
				label: null,
				entityId: "Root"
			}
		]);
		runtime.dispose();
	});

	it("ignores a Build a version 7 envelope happens to carry", async () => {
		const v7 = {
			Version: 7,
			Build: "build-1",
			AppState: {
				$Id: "Root",
				N: 0
			},
			DataSources: [],
			Timers: [],
			InFlight: []
		};
		const { runtime, result } = await restoreRuntime<IRoot>(
			JSON.stringify(v7),
			boot({
				build: "build-1"
			})
		);
		expect(result.savedBuild).toBeNull();
		expect(result.sameBuild).toBe(false);
		runtime.dispose();
	});

	it.each([
		6,
		9
	])("still rejects version %i", async (version) => {
		const envelope = {
			Version: version,
			AppState: {
				$Id: "Root",
				N: 0
			},
			DataSources: [],
			Timers: [],
			InFlight: []
		};
		await expect(restoreRuntime<IRoot>(JSON.stringify(envelope), boot())).rejects.toThrow("is not one this treflex reads, v7 or v8");
	});
});
