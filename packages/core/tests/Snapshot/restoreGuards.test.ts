import type { IRuntime, IRuntimeOptions } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateGuid } from "../../src/Effects/generateGuid";
import { startTimer } from "../../src/Effects/startTimer";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { AsyncSetupError, restoreRuntime, SnapshotOfDisposedRuntimeError, SnapshotRejectedError } from "../../src/Snapshot/index";
import { rawReceiver, rootSetState } from "../testHelpers";

vi.mock("../../src/Runtime/createRuntime", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/Runtime/createRuntime")>();
	return {
		...actual,
		createRuntime: vi.fn(actual.createRuntime)
	};
});

type IRootState = {
	$Id: string;
	Ticks: number;
	N: number;
	Stamp?: string;
};

const initialState = (): IRootState => ({
	$Id: "Root",
	Ticks: 0,
	N: 0
});

const startTimerAny = startTimer as unknown as (
	entity: {
		$Id: string;
	},
	key: string,
	receiver: {
		Id: string;
	},
	intervalMs: number
) => Generator<any, void, any>;

function dispatch<A extends any[], R>(
	runtime: IRuntime<IRootState>,
	action: (draft: IRootState, ...args: A) => Generator<any, R, any>,
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

function* tick(draft: IRootState): IActionGenerator {
	draft.Ticks += 1;
}

const GuardTick = rawReceiver(
	"GuardTickReceiver",
	[
		"Guard/Topic"
	],
	tick
);

function* arm(draft: IRootState): IActionGenerator {
	yield* startTimerAny(
		draft,
		"Tick",
		{
			Id: "GuardTickReceiver"
		},
		100
	);
}

function* setUp(draft: IRootState): IActionGenerator {
	draft.N = 42;
	bind(draft, GuardTick);
}

function* setUpAndArm(draft: IRootState): IActionGenerator {
	yield* setUp(draft);
	yield* arm(draft);
}

const boot = {
	rootId: "Root",
	options: {},
	setup: (runtime: IRuntime<IRootState>) => {
		runtime.registerReceiver(GuardTick);
	}
};

async function saved(action?: (draft: IRootState) => IActionGenerator): Promise<string> {
	const a = createRuntime<IRootState>(initialState(), {});
	a.registerReceiver(GuardTick);
	if (action) {
		await dispatch(a, action);
	}
	const envelope = createSnapshot(a);
	a.dispose();
	return envelope;
}

async function withArmedTimer(): Promise<string> {
	const a = createRuntime<IRootState>(initialState(), {});
	a.registerReceiver(GuardTick);
	await dispatch(a, arm);
	const envelope = createSnapshot(a);
	a.dispose();
	return envelope;
}

const builds = () => vi.mocked(createRuntime).mock.calls;

describe("snapshot and restore", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("createSnapshot is core-shaped, and restoreRuntime builds the runtime it describes", async () => {
		const envelope = await saved(setUp);
		const parsed = JSON.parse(envelope) as any;
		expect(parsed).not.toHaveProperty("Subscriptions");
		expect(parsed.AppState.$Receiver).toBe("GuardTickReceiver");
		expect(parsed.AppState.N).toBe(42);

		const { runtime, result } = await restoreRuntime<IRootState>(envelope, boot);
		expect(result.dropped).toStrictEqual([]);
		expect(runtime.state.N).toBe(42);
		expect((runtime as IRuntimeInternal<IRootState>).get("runtime/bindings").entries()).toStrictEqual([
			{
				OwnerId: "Root",
				ReceiverId: "GuardTickReceiver"
			}
		]);
		runtime.dispose();
	});

	it("with the same options builds the runtime a fresh createRuntime does, over the snapshot's tree", async () => {
		const envelope = await withArmedTimer();
		vi.useFakeTimers();
		const errors: unknown[] = [];
		const options: IRuntimeOptions = {
			onError: (error) => errors.push(error),
			pauseTimers: true,
			implementations: {
				generateGuid: () => "from-options"
			}
		};
		function* stampThenFail(draft: IRootState): IActionGenerator {
			draft.Stamp = yield* generateGuid();
			throw new Error("after the stamp");
		}
		const behaviour = async (runtime: IRuntime<IRootState>) => {
			errors.length = 0;
			await runtime.dispatch(stampThenFail, "Root").catch(() => {});
			await vi.advanceTimersByTimeAsync(500);
			return {
				Stamp: runtime.state.Stamp,
				Ticks: runtime.state.Ticks,
				errors: errors.length
			};
		};

		vi.mocked(createRuntime).mockClear();
		const { runtime } = await restoreRuntime<IRootState>(envelope, {
			...boot,
			options
		});
		expect(builds()).toHaveLength(1);
		const [tree, passed] = builds()[0]!;
		expect(passed).toBe(options);
		expect(tree).toStrictEqual(JSON.parse(envelope).AppState);

		const fresh = createRuntime<IRootState>(JSON.parse(envelope).AppState, options);
		boot.setup(fresh);
		const restored = await behaviour(runtime);
		expect(restored).toStrictEqual({
			Stamp: "from-options",
			Ticks: 0,
			errors: 1
		});
		expect(restored).toStrictEqual(await behaviour(fresh));
		expect(runtime.timers()).toHaveLength(1);
		fresh.dispose();
		runtime.dispose();
	});

	it("can be snapshotted from setup and from the repair, each seeing the loaded tables", async () => {
		const envelope = await saved(setUpAndArm);
		const taken: string[] = [];
		const { runtime } = await restoreRuntime<IRootState>(envelope, {
			...boot,
			setup: (runtime) => {
				boot.setup(runtime);
				taken.push(createSnapshot(runtime));
			},
			repair: (runtime) => {
				taken.push(createSnapshot(runtime));
			}
		});
		expect(parsedTimers(envelope)).toHaveLength(1);
		expect(taken.map(parsedTimers)).toStrictEqual([
			parsedTimers(envelope),
			parsedTimers(envelope)
		]);
		runtime.dispose();
	});
});

const parsedTimers = (envelope: string) => (JSON.parse(envelope) as any).Timers;

describe("a boot that follows the contract", () => {
	async function bootFrom(saved: string, options: IRuntimeOptions): Promise<IRuntime<IRootState>> {
		try {
			const { runtime } = await restoreRuntime<IRootState>(saved, {
				...boot,
				options
			});
			return runtime;
		} catch (error) {
			if (!(error instanceof SnapshotRejectedError)) {
				throw error;
			}
		}
		const runtime = createRuntime<IRootState>(initialState(), options);
		boot.setup(runtime);
		return runtime;
	}

	it("boots fresh on a rejected snapshot, the restore having built nothing", async () => {
		const foreign = JSON.parse(await saved(setUp)) as any;
		foreign.AppState.$Id = "Other";
		const options: IRuntimeOptions = {};
		vi.mocked(createRuntime).mockClear();
		const runtime = await bootFrom(JSON.stringify(foreign), options);
		expect(builds()).toStrictEqual([
			[
				initialState(),
				options
			]
		]);
		expect(runtime.state.N).toBe(0);
		runtime.dispose();
	});
});

describe("setup", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("that throws rejects as that throw, keeping the save, and disposes the runtime, so no restored timer ticks", async () => {
		const envelope = await withArmedTimer();
		let built!: IRuntime<IRootState>;
		const failure = new Error("registration broke");
		const rejection = restoreRuntime<IRootState>(envelope, {
			...boot,
			setup: (runtime) => {
				built = runtime;
				boot.setup(runtime);
				throw failure;
			}
		});
		await expect(rejection).rejects.toBe(failure);
		await vi.advanceTimersByTimeAsync(500);
		expect(built.state.Ticks).toBe(0);
		expect((built as IRuntimeInternal<IRootState>).disposed()).toBe(true);
	});

	it("that returns a promise hears the load's diags, disposes the runtime and rejects with AsyncSetupError", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const envelope = JSON.parse(await withArmedTimer()) as any;
		envelope.Timers.push(null);
		let built!: IRuntime<IRootState>;
		const codes: string[] = [];
		const asyncSetup = async (runtime: IRuntime<IRootState>) => {
			built = runtime;
			runtime.registerReceiver(GuardTick);
			runtime.on("diag", (event) => codes.push(event.code));
			throw new Error("a later failure nobody awaits");
		};
		await expect(
			restoreRuntime<IRootState>(JSON.stringify(envelope), {
				...boot,
				setup: asyncSetup
			})
		).rejects.toBeInstanceOf(AsyncSetupError);
		expect(codes).toContain("restore/malformed-rows");
		await vi.advanceTimersByTimeAsync(500);
		expect(built.state.Ticks).toBe(0);
	});
});

describe("a boot that misbehaves", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("can't snapshot a disposed runtime", () => {
		const runtime = createRuntime<IRootState>(initialState(), {});
		runtime.dispose();
		expect(() => createSnapshot(runtime)).toThrow(SnapshotOfDisposedRuntimeError);
	});

	it.each([
		"",
		5,
		undefined
	])("with a rootId of %j throws TypeError before reading the snapshot", async (rootId) => {
		await expect(
			restoreRuntime<IRootState>("not even json", {
				...boot,
				rootId: rootId as string
			})
		).rejects.toBeInstanceOf(TypeError);
	});

	it("with a parsed envelope in place of the string throws TypeError, building nothing", async () => {
		const parsed = JSON.parse(await saved(setUp)) as string;
		vi.mocked(createRuntime).mockClear();
		await expect(restoreRuntime<IRootState>(parsed, boot)).rejects.toBeInstanceOf(TypeError);
		expect(createRuntime).not.toHaveBeenCalled();
	});
});

describe("a console that throws", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function corruptWithArmedTimer(): Promise<string> {
		const envelope = JSON.parse(await withArmedTimer()) as any;
		envelope.Timers.push(null);
		return JSON.stringify(envelope);
	}

	function throwingWarn(): Error {
		const failure = new Error("console broke");
		vi.spyOn(console, "warn").mockImplementation(() => {
			throw failure;
		});
		return failure;
	}

	it("on the load's diags rejects with that throw, not as a bad snapshot, and leaves no timer ticking", async () => {
		const envelope = await corruptWithArmedTimer();
		const failure = throwingWarn();
		let built!: IRuntime<IRootState>;
		await expect(
			restoreRuntime<IRootState>(envelope, {
				...boot,
				setup: (runtime) => {
					built = runtime;
					boot.setup(runtime);
				}
			})
		).rejects.toBe(failure);
		await vi.advanceTimersByTimeAsync(500);
		expect(built.state.Ticks).toBe(0);
	});

	it("while a load fails still rejects with SnapshotRejectedError, and leaves no timer ticking", async () => {
		const envelope = await corruptWithArmedTimer();
		throwingWarn();
		const { createRuntime: build } =
			await vi.importActual<typeof import("../../src/Runtime/createRuntime")>("../../src/Runtime/createRuntime");
		let built!: IRuntime<IRootState>;
		vi.mocked(createRuntime).mockImplementationOnce((state, options) => {
			built = build(state as IRootState, options);
			vi.spyOn((built as IRuntimeInternal<IRootState>).get("runtime/resources"), "load").mockImplementation(() => {
				throw new Error("load exploded");
			});
			return built;
		});
		await expect(restoreRuntime<IRootState>(envelope, boot)).rejects.toBeInstanceOf(SnapshotRejectedError);
		await vi.advanceTimersByTimeAsync(500);
		expect(built.state.Ticks).toBe(0);
	});
});

describe("restored timer rows", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("arm for the due time the snapshot saved", async () => {
		const a = createRuntime<IRootState>(initialState(), {});
		a.registerReceiver(GuardTick);
		await dispatch(a, arm);
		await vi.advanceTimersByTimeAsync(50);
		const envelope = createSnapshot(a);
		a.dispose();

		const { runtime } = await restoreRuntime<IRootState>(envelope, boot);
		await vi.advanceTimersByTimeAsync(49);
		expect(runtime.state.Ticks).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(runtime.state.Ticks).toBe(1);
		runtime.dispose();
	});

	it("never arm under pauseTimers: true", async () => {
		const a = createRuntime<IRootState>(initialState(), {});
		a.registerReceiver(GuardTick);
		await dispatch(a, arm);
		const envelope = createSnapshot(a);
		a.dispose();

		const { runtime } = await restoreRuntime<IRootState>(envelope, {
			...boot,
			options: {
				pauseTimers: true
			}
		});
		await vi.advanceTimersByTimeAsync(500);
		expect(runtime.state.Ticks).toBe(0);
		expect(runtime.timers()).toHaveLength(1);
		runtime.dispose();
	});
});

describe("the gate's rejection contract", () => {
	it("rejects non-JSON, a version mismatch, and a structurally incomplete envelope with SnapshotRejectedError, building nothing", async () => {
		const envelope = await saved();
		const legacy = JSON.parse(envelope) as any;
		legacy.Version = 5;
		legacy.AppState = {
			Id: "Root"
		};
		const incomplete = JSON.parse(envelope) as any;
		delete incomplete.Timers;
		vi.mocked(createRuntime).mockClear();

		for (const json of [
			"not json {",
			JSON.stringify({
				Version: 99
			}),
			JSON.stringify(legacy),
			JSON.stringify(incomplete)
		]) {
			await expect(restoreRuntime<IRootState>(json, boot)).rejects.toBeInstanceOf(SnapshotRejectedError);
		}
		expect(createRuntime).not.toHaveBeenCalled();
	});

	it.each([
		[
			"an array",
			[]
		],
		[
			"no $Id",
			{}
		],
		[
			"a number $Id",
			{
				$Id: 5
			}
		],
		[
			"an empty $Id",
			{
				$Id: ""
			}
		]
	])("rejects a root with %s, building nothing", async (_name, root) => {
		const envelope = JSON.parse(await saved()) as any;
		envelope.AppState = root;
		vi.mocked(createRuntime).mockClear();
		await expect(restoreRuntime<IRootState>(JSON.stringify(envelope), boot)).rejects.toBeInstanceOf(SnapshotRejectedError);
		expect(createRuntime).not.toHaveBeenCalled();
	});

	it("rejects another app's root when the boot names its own, building nothing", async () => {
		const foreign = JSON.parse(await saved()) as any;
		foreign.AppState.$Id = "Other";
		vi.mocked(createRuntime).mockClear();
		await expect(restoreRuntime<IRootState>(JSON.stringify(foreign), boot)).rejects.toThrow(SnapshotRejectedError);
		expect(createRuntime).not.toHaveBeenCalled();
		const { runtime } = await restoreRuntime<IRootState>(await saved(), boot);
		expect(runtime.state.$Id).toBe("Root");
		runtime.dispose();
	});

	it("tolerates malformed rows: null table rows skip with one diag, the rest loads", async () => {
		const parsed = JSON.parse(await saved(setUp)) as any;

		parsed.DataSources.push(null);
		parsed.RestartList = [
			{
				Key: 5
			}
		];
		parsed.IdCounters = {
			branch: "corrupt"
		};
		parsed.PendingRequests = [
			null,
			{
				RequestId: "req-1",
				OwnerId: "gone",
				Topic: "T"
			}
		];

		const diags: string[] = [];
		const { runtime, result } = await restoreRuntime<IRootState>(JSON.stringify(parsed), {
			...boot,
			setup: (runtime) => {
				boot.setup(runtime);
				runtime.on("diag", (event) => diags.push(event.code));
			}
		});

		expect(runtime.state.N).toBe(42);
		expect(result).toStrictEqual({
			resumed: [],
			dropped: [],
			unresolved: [],
			sweptOrphanedRows: 0,
			savedBuild: null,
			sameBuild: false
		});
		expect(diags).toContain("restore/malformed-rows");
		await dispatch(runtime, tick);
		expect(runtime.state.Ticks).toBe(1);
		runtime.dispose();
	});

	it("drops in-flight rows whose ActionId or EntityId is not a string, counted as malformed", async () => {
		const parsed = JSON.parse(await saved(setUp)) as any;
		parsed.InFlight = [
			{
				ActionId: 5,
				Name: "numberId",
				EntityId: "Root",
				State: "holding"
			},
			{
				ActionId: "action-2",
				Name: "objectEntity",
				EntityId: {},
				State: "holding"
			},
			{
				Name: "noIds",
				State: "holding"
			},
			{
				ActionId: "action-4",
				Name: "kept",
				EntityId: "Root",
				State: "holding"
			}
		];
		const malformed: unknown[] = [];
		const { runtime, result } = await restoreRuntime<IRootState>(JSON.stringify(parsed), {
			...boot,
			setup: (runtime) => {
				boot.setup(runtime);
				runtime.on("diag", (event) => {
					if (event.code === "restore/malformed-rows") {
						malformed.push(event.data);
					}
				});
			}
		});
		expect(result.dropped).toStrictEqual([
			{
				actionId: "action-4",
				name: "kept",
				label: null,
				entityId: "Root",
				state: "holding",
				reason: "resume-off"
			}
		]);
		expect(malformed).toStrictEqual([
			{
				droppedRows: 3
			}
		]);
		runtime.dispose();
	});

	it("reads an in-flight row's Name, Label and Receiver, each null or absent when it isn't a string", async () => {
		const parsed = JSON.parse(await saved(setUp)) as any;
		parsed.InFlight = [
			{
				ActionId: "action-1",
				Name: 5,
				Label: {},
				Receiver: 7,
				EntityId: "Root",
				State: "holding"
			},
			{
				ActionId: "action-2",
				Name: "Ticker/Tick",
				Label: "t",
				EntityId: "Root",
				State: "holding"
			},
			{
				ActionId: "action-3",
				Name: null,
				Label: "TickReceiver",
				Receiver: "TickReceiver",
				EntityId: "Root",
				State: "holding"
			}
		];
		const { runtime, result } = await restoreRuntime<IRootState>(JSON.stringify(parsed), boot);
		expect(result.dropped).toStrictEqual([
			{
				actionId: "action-1",
				name: null,
				label: null,
				entityId: "Root",
				state: "holding",
				reason: "resume-off"
			},
			{
				actionId: "action-2",
				name: "Ticker/Tick",
				label: "t",
				entityId: "Root",
				state: "holding",
				reason: "resume-off"
			},
			{
				actionId: "action-3",
				name: null,
				label: "TickReceiver",
				receiver: "TickReceiver",
				entityId: "Root",
				state: "holding",
				reason: "resume-off"
			}
		]);
		runtime.dispose();
	});

	it.each([
		[
			"a Place without State",
			{
				Place: 0
			}
		],
		[
			"a null State",
			{
				State: null
			}
		],
		[
			"an unknown State",
			{
				State: "running"
			}
		],
		[
			"a State that isn't a string",
			{
				State: 1
			}
		],
		[
			"a Place on a holding entry",
			{
				State: "holding",
				Place: 0
			}
		],
		[
			"a null Place on an open entry",
			{
				State: "open",
				Place: null
			}
		],
		[
			"a Place on a stopping entry",
			{
				State: "stopping",
				Place: 2
			}
		],
		[
			"no Place on a queued entry",
			{
				State: "queued"
			}
		],
		[
			"no Place on a regaining entry",
			{
				State: "regaining"
			}
		],
		[
			"a negative Place",
			{
				State: "queued",
				Place: -1
			}
		],
		[
			"a fractional Place",
			{
				State: "regaining",
				Place: 0.5
			}
		],
		[
			"a string Place",
			{
				State: "queued",
				Place: "0"
			}
		]
	])("drops a version 8 in-flight row with %s, counted as malformed", async (_name, shape) => {
		const parsed = JSON.parse(await saved(setUp)) as any;
		parsed.InFlight = [
			{
				ActionId: "action-1",
				Name: "bad",
				EntityId: "Root",
				...shape
			},
			{
				ActionId: "action-2",
				Name: "kept",
				EntityId: "Root",
				State: "queued",
				Place: 0
			}
		];
		const malformed: unknown[] = [];
		const { runtime, result } = await restoreRuntime<IRootState>(JSON.stringify(parsed), {
			...boot,
			setup: (runtime) => {
				boot.setup(runtime);
				runtime.on("diag", (event) => {
					if (event.code === "restore/malformed-rows") {
						malformed.push(event.data);
					}
				});
			}
		});
		expect(result.dropped).toStrictEqual([
			{
				actionId: "action-2",
				name: "kept",
				label: null,
				entityId: "Root",
				state: "queued",
				place: 0,
				reason: "resume-off"
			}
		]);
		expect(malformed).toStrictEqual([
			{
				droppedRows: 1
			}
		]);
		runtime.dispose();
	});

	it("labels a version 7 row by its Name or legacy Key, null when neither is a string, and names none", async () => {
		const parsed = JSON.parse(await saved(setUp)) as any;
		parsed.Version = 7;
		delete parsed.Build;
		parsed.InFlight = [
			{
				ActionId: "action-1",
				Name: 5,
				EntityId: "Root"
			},
			{
				ActionId: "action-2",
				Key: {
					label: "legacy"
				},
				EntityId: "Root"
			},
			{
				ActionId: "action-3",
				Key: "legacyName",
				EntityId: "Root"
			}
		];
		const { runtime, result } = await restoreRuntime<IRootState>(JSON.stringify(parsed), boot);
		expect(result.dropped).toStrictEqual([
			{
				actionId: "action-1",
				name: null,
				label: null,
				entityId: "Root",
				reason: "resume-off"
			},
			{
				actionId: "action-2",
				name: null,
				label: null,
				entityId: "Root",
				reason: "resume-off"
			},
			{
				actionId: "action-3",
				name: null,
				label: "legacyName",
				entityId: "Root",
				reason: "resume-off"
			}
		]);
		expect(result.savedBuild).toBeNull();
		runtime.dispose();
	});
});
