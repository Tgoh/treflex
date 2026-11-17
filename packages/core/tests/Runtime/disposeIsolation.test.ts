import type { IDisposePhase, IWriteGateway } from "../../src/Runtime/createWriteGateway";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { ISetState } from "../../src/Runtime/sliceSetState";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import { createEffect, createRoot, onCleanup } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDataGlobal } from "../../src/Reads/getData";
import { createGetDataCache } from "../../src/Runtime/createGetDataCache";
import { createJournal } from "../../src/Runtime/createJournal";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { createWriteGateway } from "../../src/Runtime/createWriteGateway";
import { DraftDetachedError } from "../../src/Runtime/draftNode";
import { rawOf } from "../../src/Runtime/viewProxy";
import { consoleDiag } from "../../src/Types/IRuntimeEvent";
import { createTreeState, treeWrite } from "../testHelpers";

declare module "../../src/Registries/IExternalRegistry" {
	interface IExternalRegistry {
		"dispose/Key": number;
	}
}

const PHASES: IDisposePhase[] = [
	"cancel",
	"tables",
	"caches",
	"resources"
];
const POSITIONS = [
	"first",
	"middle",
	"last"
] as const;

const CHILDREN_FIRST = [
	"first-leaf",
	"first",
	"second-leaf",
	"second",
	"parent"
];

const nested = () => ({
	$Id: "root",
	Slot: 0,
	Parent: {
		$Id: "parent",
		First: {
			$Id: "first",
			Leaf: {
				$Id: "first-leaf"
			}
		},
		Second: {
			$Id: "second",
			Leaf: {
				$Id: "second-leaf"
			}
		}
	},
	Other: {
		$Id: "other"
	}
});

function buildGateway<T extends object>(initial: T) {
	const records: IRecord[] = [];
	const journal = createJournal();
	journal.tap((record) => {
		records.push(record);
	});
	const gateway = createWriteGateway({
		journal,
		emitDiag: consoleDiag
	});
	const { raw, state, setState: wrapped } = createTreeState<T>(initial, gateway);
	gateway.connect(raw, wrapped);
	const setState: ISetState<T> = (...args: ((x: any) => any)[]) => gateway.exemptFrame(() => wrapped(...args));
	return {
		raw,
		state,
		setState,
		gateway,
		disposedRecords: () =>
			records.flatMap((record) =>
				record.Kind === "entity:dispose"
					? [
							record.EntityId
						]
					: []
			),
		cells: () => Object.keys(gateway.lookup())
	};
}

function captureReported() {
	const deferred: (() => void)[] = [];
	const reported: unknown[] = [];
	vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
		deferred.push(callback);
	});
	vi.spyOn(console, "warn").mockImplementation((_message: unknown, data?: unknown) => {
		if (data !== null && typeof data === "object" && "source" in data && "error" in data) {
			reported.push(data.error);
		}
	});
	return {
		surface(): unknown[] {
			const surfaced = reported.splice(0);
			for (const callback of deferred.splice(0)) {
				try {
					callback();
				} catch (error) {
					surfaced.push(error);
				}
			}
			surfaced.push(...reported.splice(0));
			return surfaced;
		}
	};
}

function attempt(fn: () => void): unknown {
	try {
		fn();
		return undefined;
	} catch (error) {
		return error;
	}
}

function gatewayOf(runtime: unknown): IWriteGateway {
	return (runtime as IRuntimeInternal<object>).get("runtime/writeGateway");
}

function throwOn(gateway: IWriteGateway, doomedId: string, error: Error): void {
	gateway.onDispose((id) => {
		if (id === doomedId) {
			throw error;
		}
	}, "tables");
}

const settled = (promise: Promise<unknown>): Promise<unknown> =>
	promise.then(
		(value) => ({
			resolved: value
		}),
		(error) => ({
			rejected: error
		})
	);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a throwing dispose callback", () => {
	describe("in a removed subtree", () => {
		const cases = PHASES.flatMap((phase) =>
			POSITIONS.map((position) => ({
				phase,
				position
			}))
		);

		it.each(cases)("in the $position position of $phase leaves the rest of the cascade whole", ({ phase, position }) => {
			const reported = captureReported();
			const world = buildGateway<any>(nested());
			const fired: string[] = [];
			const boom = new Error("cleanup failed");
			for (const p of PHASES) {
				for (const at of POSITIONS) {
					world.gateway.onDispose((id) => {
						fired.push(`${id}:${p}:${at}`);
						if (id === "first" && p === phase && at === position) {
							throw boom;
						}
					}, p);
				}
			}

			const thrown = attempt(() =>
				world.setState((s: any) => {
					s.Parent = null;
				})
			);

			const everyCallback = (id: string) => PHASES.flatMap((p) => POSITIONS.map((at) => `${id}:${p}:${at}`));
			expect
				.soft(
					fired.filter((entry) => entry.startsWith("first:")),
					"later callbacks for the throwing id"
				)
				.toEqual(everyCallback("first"));
			expect.soft(world.disposedRecords(), "entity:dispose records").toEqual(CHILDREN_FIRST);
			expect.soft(world.cells(), "cells left in lookup()").toEqual([
				"root",
				"other"
			]);
			expect.soft(fired, "the whole walk, children first").toEqual(CHILDREN_FIRST.flatMap(everyCallback));
			expect.soft(thrown, "a synchronous throw out of the write").toBeUndefined();
			expect.soft(reported.surface(), "errors reported").toEqual([
				boom
			]);
		});

		it("handles every node when every node's callback throws, and surfaces each throw once, in cascade order", () => {
			const reported = captureReported();
			const world = buildGateway<any>(nested());
			const fired: string[] = [];
			world.gateway.onDispose((id) => {
				fired.push(id);
				throw new Error(`failed:${id}`);
			}, "cancel");

			const thrown = attempt(() =>
				world.setState((s: any) => {
					s.Parent = null;
				})
			);

			expect(thrown).toBeUndefined();
			expect(fired).toEqual(CHILDREN_FIRST);
			expect(world.disposedRecords()).toEqual(CHILDREN_FIRST);
			expect(world.cells()).toEqual([
				"root",
				"other"
			]);
			expect(reported.surface().map(String)).toEqual(CHILDREN_FIRST.map((id) => `Error: failed:${id}`));
		});
	});

	describe("on the other entry paths", () => {
		it("keeps an identity-lost cascade whole", () => {
			const reported = captureReported();
			const world = buildGateway<any>(nested());
			const boom = new Error("cleanup failed");
			const fired: string[] = [];
			throwOn(world.gateway, "other", boom);
			world.gateway.onDispose((id) => fired.push(id), "resources");

			const thrown = attempt(() =>
				world.setState((s: any) => {
					rawOf(s.Other).$Id = "renamed";
					s.Other.Touched = true;
				})
			);

			expect(thrown).toBeUndefined();
			expect(fired).toEqual([
				"other"
			]);
			expect(world.disposedRecords()).toEqual([
				"other"
			]);
			expect(world.cells()).not.toContain("other");
			expect(world.cells()).toContain("renamed");
			expect(reported.surface()).toEqual([
				boom
			]);
		});

		it("keeps a resync's dropped loop whole", () => {
			const reported = captureReported();
			const world = buildGateway<any>(nested());
			const boom = new Error("cleanup failed");
			const fired: string[] = [];
			throwOn(world.gateway, "second", boom);
			world.gateway.onDispose((id) => fired.push(id), "resources");

			world.raw.Parent = null;
			const thrown = attempt(() => world.gateway.resync());

			const descendantsFirst = [
				"second-leaf",
				"second",
				"first-leaf",
				"first",
				"parent"
			];
			expect(thrown).toBeUndefined();
			expect(fired).toEqual(descendantsFirst);
			expect(world.disposedRecords()).toEqual(descendantsFirst);
			expect(world.cells()).toEqual([
				"root",
				"other"
			]);
			expect(reported.surface()).toEqual([
				boom
			]);
		});

		it("keeps the gateway's teardown whole", () => {
			const reported = captureReported();
			const world = buildGateway<any>(nested());
			const boom = new Error("cleanup failed");
			const fired: string[] = [];
			throwOn(world.gateway, "first", boom);
			world.gateway.onDispose((id) => fired.push(id), "resources");

			const thrown = attempt(() => world.gateway.dispose());

			const whole = [
				...CHILDREN_FIRST,
				"other",
				"root"
			];
			expect(thrown).toBeUndefined();
			expect(fired).toEqual(whole);
			expect(world.disposedRecords()).toEqual(whole);
			expect(world.cells()).toEqual([]);
			expect(reported.surface()).toEqual([
				boom
			]);
		});

		it("lets createRuntime's dispose reach the steps after the cascade", async () => {
			const reported = captureReported();
			const runtime = createRuntime<any>(nested()) as IRuntimeInternal<any>;
			const boom = new Error("cleanup failed");
			throwOn(gatewayOf(runtime), "first", boom);
			const dataSources = runtime.get("runtime/dataSources");
			const resolveGlobal = vi.spyOn(dataSources, "resolveGlobal");
			function* read(): IActionGenerator<unknown> {
				return yield* (getDataGlobal as unknown as (key: string) => Generator<any, any, any>)("dispose/Theme");
			}
			await runtime.dispatch(read, "root");
			dataSources.add("dispose/Theme", "root", "other");
			expect(resolveGlobal).toHaveBeenCalledTimes(2);

			const thrown = attempt(() => runtime.dispose());
			const atDispose = resolveGlobal.mock.calls.length;
			dataSources.add("dispose/Theme", "parent", "other");

			expect(thrown).toBeUndefined();
			expect(resolveGlobal).toHaveBeenCalledTimes(atDispose);
			expect(reported.surface()).toEqual([
				boom
			]);
		});

		it("stops every external subscription, and leaves changed doing nothing", () => {
			const runtime = createRuntime<any>(nested());
			let subscribed = 0;
			let reads = 0;
			const handle = runtime.provideExternal("dispose/Key", {
				read: () => ++reads,
				subscribe: () => {
					subscribed++;
					return () => {
						subscribed--;
					};
				}
			});

			const thrown = attempt(() => runtime.dispose());
			handle.changed();

			expect(thrown).toBeUndefined();
			expect(subscribed).toBe(0);
			expect(reads).toBe(1);
		});
	});

	describe("surfacing", () => {
		it("reaches no writer, and is reported once", () => {
			const reported = captureReported();
			const world = buildGateway<any>(nested());
			const boom = new Error("cleanup failed");
			throwOn(world.gateway, "parent", boom);

			expect(() =>
				world.setState((s: any) => {
					s.Parent = null;
				})
			).not.toThrow();

			expect(reported.surface()).toEqual([
				boom
			]);
			expect(reported.surface()).toEqual([]);
		});

		it("surfaces two throws on one id, each once, in order", () => {
			const reported = captureReported();
			const world = buildGateway<any>(nested());
			const earlier = new Error("earlier");
			const later = new Error("later");
			throwOn(world.gateway, "first", earlier);
			throwOn(world.gateway, "first", later);

			world.setState((s: any) => {
				s.Parent = null;
			});

			expect(reported.surface()).toEqual([
				earlier,
				later
			]);
		});
	});

	describe("what follows the cascade in the same reconcile", () => {
		it("wakes a view effect on the written slot", () => {
			const reported = captureReported();
			const world = buildGateway<any>(nested());
			const boom = new Error("cleanup failed");
			throwOn(world.gateway, "first", boom);
			const seen: number[] = [];
			const dispose = createRoot((d) => {
				createEffect(() => seen.push(world.state.Slot));
				return d;
			});

			attempt(() =>
				world.setState((s: any) => {
					s.Slot = 1;
					s.Parent = null;
				})
			);

			expect(seen).toEqual([
				0,
				1
			]);
			expect(reported.surface()).toEqual([
				boom
			]);
			dispose();
		});
	});

	it("stays isolated inside a re-entrant resync from another callback, and in the callback that resynced", () => {
		const reported = captureReported();
		const world = buildGateway<any>(nested());
		const inner = new Error("inside the resync");
		const outer = new Error("after the resync");
		let resynced = false;
		const fired: string[] = [];
		world.gateway.onDispose((id) => {
			if (id === "first-leaf" && !resynced) {
				resynced = true;
				world.gateway.resync();
				throw outer;
			}
		}, "cancel");
		throwOn(world.gateway, "second", inner);
		world.gateway.onDispose((id) => fired.push(id), "resources");

		const thrown = attempt(() =>
			world.setState((s: any) => {
				s.Parent = null;
			})
		);

		expect(thrown).toBeUndefined();
		expect(new Set(fired)).toEqual(new Set(CHILDREN_FIRST));
		expect(world.cells()).toEqual([
			"root",
			"other"
		]);
		expect(reported.surface()).toEqual([
			inner,
			outer
		]);
	});
});

describe("a throwing selector cleanup with a sibling memo behind it", () => {
	function selectorWorld(shape: "lookup" | "untracked" | "tracked") {
		const runtime = createRuntime<any>({
			$Id: "root",
			Slot: 0,
			Doomed: {
				$Id: "doomed",
				V: 1
			}
		}) as IRuntimeInternal<any>;
		const gateway = gatewayOf(runtime);
		const held = runtime.state.Doomed;
		const getState = {
			lookup: () => gateway.lookup().doomed?.state,
			untracked: () => held,
			tracked: () => runtime.state.Doomed
		}[shape];
		const boom = new Error("memo cleanup failed");
		function* thrower(draft: any): any {
			onCleanup(() => {
				throw boom;
			});
			return draft.V;
		}
		let siblingCleanups = 0;
		function* sibling(draft: any): any {
			onCleanup(() => {
				siblingCleanups++;
			});
			return draft.V;
		}
		runtime.runSelector(thrower, getState);
		runtime.runSelector(sibling, getState);
		const seen: number[] = [];
		const disposeRoot = createRoot((d) => {
			createEffect(() => seen.push(runtime.state.Slot));
			return d;
		});
		return {
			runtime,
			boom,
			seen,
			disposeRoot,
			siblingCleanups: () => siblingCleanups,
			cells: () => Object.keys(gateway.lookup()),
			remove: () =>
				attempt(() =>
					treeWrite(runtime, (s) => {
						s.Slot = 1;
						s.Doomed = null;
					})
				)
		};
	}

	it.each([
		"lookup",
		"untracked",
		"tracked"
	] as const)("on the %s shape, the write returns and the sweep finishes", (shape) => {
		const reported = captureReported();
		const world = selectorWorld(shape);

		const thrown = world.remove();

		expect(thrown).toBeUndefined();
		expect(reported.surface()).toEqual([
			world.boom
		]);
		expect(world.seen).toEqual([
			0,
			1
		]);
		expect(world.siblingCleanups()).toBe(1);
		expect(world.cells()).toEqual([
			"root"
		]);
		world.disposeRoot();
	});

	it("on a tracked slot, an action whose write removes the node resolves", async () => {
		const reported = captureReported();
		const world = selectorWorld("tracked");
		function* remove(draft: any): IActionGenerator {
			draft.Doomed = null;
		}

		const outcome = await settled(world.runtime.dispatch(remove, "root"));

		expect(outcome).toEqual({
			resolved: undefined
		});
		expect(reported.surface()).toEqual([
			world.boom
		]);
		world.disposeRoot();
	});
});

describe("a cleanup writing through a cell's setter", () => {
	function setterWorld() {
		const runtime = createRuntime<any>(nested());
		const initial: any = rawOf(runtime.state);
		const gateway = gatewayOf(runtime);
		const walked: string[] = [];
		gateway.onDispose((id) => walked.push(id), "resources");
		return {
			initial,
			runtime,
			gateway,
			walked
		};
	}
	type ISetterWorld = ReturnType<typeof setterWorld>;

	const removal = {
		path: "phase 2 removal",
		go: (world: ISetterWorld) =>
			treeWrite(world.runtime, (s) => {
				s.Parent = null;
			}),
		walk: CHILDREN_FIRST,
		cells: [
			"root",
			"other"
		]
	};
	const dropped = {
		path: "resync's dropped loop",
		go: (world: ISetterWorld) => {
			world.initial.Parent = null;
			world.gateway.resync();
		},
		walk: [
			"second-leaf",
			"second",
			"first-leaf",
			"first",
			"parent"
		],
		cells: [
			"root",
			"other"
		]
	};
	const teardown = {
		path: "teardown",
		go: (world: ISetterWorld) => world.runtime.dispose(),
		walk: [
			...CHILDREN_FIRST,
			"other",
			"root"
		],
		cells: [] as string[]
	};

	function writeWhileFirstDisposes(world: ISetterWorld, setter: () => ISetState<any>): void {
		world.gateway.onDispose((id) => {
			if (id === "first") {
				setter()((node: any) => {
					node.Mark = "written";
				});
			}
		}, "tables");
	}

	function expectWholeWalk(world: ISetterWorld, path: typeof removal, thrown: unknown): void {
		expect(thrown).toBeUndefined();
		expect(world.walked).toEqual(path.walk);
		expect(Object.keys(world.gateway.lookup())).toEqual(path.cells);
	}

	it.each([
		removal,
		dropped,
		teardown
	])("to the disposing id throws DraftDetachedError, on $path", (path) => {
		const reported = captureReported();
		const world = setterWorld();
		const first = world.initial.Parent.First;
		writeWhileFirstDisposes(world, () => world.gateway.lookup().first.setState);

		const thrown = attempt(() => path.go(world));

		expectWholeWalk(world, path, thrown);
		const surfaced = reported.surface();
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]).toBeInstanceOf(DraftDetachedError);
		expect(first.Mark).toBeUndefined();
	});

	it.each([
		removal,
		teardown
	])("to an ancestor the walk has marked throws DraftDetachedError, on $path", (path) => {
		const reported = captureReported();
		const world = setterWorld();
		const parent = world.initial.Parent;
		writeWhileFirstDisposes(world, () => world.gateway.lookup().parent.setState);

		const thrown = attempt(() => path.go(world));

		expectWholeWalk(world, path, thrown);
		const surfaced = reported.surface();
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]).toBeInstanceOf(DraftDetachedError);
		expect(parent.Mark).toBeUndefined();
	});

	it.each([
		removal,
		dropped,
		teardown
	])("held for an id whose cell has gone returns silently and writes nothing, on $path", (path) => {
		const reported = captureReported();
		const world = setterWorld();
		const leaf = world.initial.Parent.Second.Leaf;
		const setter = world.gateway.lookup()["second-leaf"].setState;
		world.gateway.onDispose((id) => {
			if (id === "second") {
				setter((node: any) => {
					node.Mark = "written";
				});
			}
		}, "tables");

		const thrown = attempt(() => path.go(world));

		expectWholeWalk(world, path, thrown);
		expect(reported.surface()).toEqual([]);
		expect(leaf.Mark).toBeUndefined();
	});

	it.each([
		{
			...removal,
			target: "second"
		},
		{
			...dropped,
			target: "parent"
		},
		{
			...teardown,
			target: "second"
		}
	])("to a subtree node the walk has not reached meets the outside-write check, on $path", (path) => {
		const reported = captureReported();
		const world = setterWorld();
		const node = path.target === "parent" ? world.initial.Parent : world.initial.Parent.Second;
		writeWhileFirstDisposes(world, () => world.gateway.lookup()[path.target].setState);

		const thrown = attempt(() => path.go(world));

		expectWholeWalk(world, path, thrown);
		const surfaced = reported.surface();
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]).not.toBeInstanceOf(DraftDetachedError);
		expect(String(surfaced[0])).toContain("state mutations belong to actions");
		expect(node.Mark).toBeUndefined();
	});
});

describe("a throwing memo cleanup in the data cache", () => {
	function buildCache() {
		const disposeCallbacks: ((id: string) => void)[] = [];
		const boom = new Error("memo cleanup failed");
		const cleaned: string[] = [];
		const cleanup = (entry: string) => {
			onCleanup(() => {
				cleaned.push(entry);
				if (entry === "scoped:thrower") {
					throw boom;
				}
			});
		};
		const cache = createGetDataCache({
			onDispose: (callback) => disposeCallbacks.push(callback),
			resolveData: (key) => {
				cleanup(`scoped:${key}`);
				return key;
			},
			resolveGlobalData: (key) => {
				cleanup(`global:${key}`);
				return key;
			}
		});
		return {
			cache,
			boom,
			cleaned,
			sweep: (id: string) => {
				for (const callback of disposeCallbacks) {
					callback(id);
				}
			}
		};
	}

	it("sweeps the rest of a scoped bucket", () => {
		const reported = captureReported();
		const world = buildCache();
		world.cache.resolve("thrower", "owner");
		world.cache.resolve("sibling", "owner");
		world.cache.resolve("elsewhere", "other-owner");

		const thrown = attempt(() => world.sweep("owner"));

		expect(thrown).toBeUndefined();
		expect(world.cleaned).toEqual([
			"scoped:thrower",
			"scoped:sibling"
		]);
		expect(reported.surface()).toEqual([
			world.boom
		]);
		world.sweep("owner");
		expect(world.cleaned).toEqual([
			"scoped:thrower",
			"scoped:sibling"
		]);
	});

	it("disposes every bucket and then the global store, and clears them", () => {
		const reported = captureReported();
		const world = buildCache();
		world.cache.resolve("thrower", "owner");
		world.cache.resolve("sibling", "owner");
		world.cache.resolve("elsewhere", "other-owner");
		world.cache.resolveGlobal("key");
		const everything = [
			"scoped:thrower",
			"scoped:sibling",
			"scoped:elsewhere",
			"global:key"
		];

		const thrown = attempt(() => world.cache.dispose());

		expect(thrown).toBeUndefined();
		expect(world.cleaned).toEqual(everything);
		expect(reported.surface()).toEqual([
			world.boom
		]);
		expect(attempt(() => world.cache.dispose())).toBeUndefined();
		expect(world.cleaned).toEqual(everything);
		expect(reported.surface()).toEqual([]);
	});
});

describe("the writer of a cascade whose callback throws", () => {
	const doomedWorld = () => ({
		$Id: "root",
		Slot: 0,
		Doomed: {
			$Id: "doomed"
		}
	});

	it("the writer returns", () => {
		const reported = captureReported();
		const runtime = createRuntime<any>(doomedWorld());
		const boom = new Error("cleanup failed");
		throwOn(gatewayOf(runtime), "doomed", boom);

		const thrown = attempt(() =>
			treeWrite(runtime, (s) => {
				s.Doomed = null;
			})
		);

		expect(thrown).toBeUndefined();
		expect(reported.surface()).toEqual([
			boom
		]);
	});

	it("an action carries on and completes, with no onError and no escalation", async () => {
		const reported = captureReported();
		const onError = vi.fn();
		const runtime = createRuntime<any>(doomedWorld(), {
			onError,
			implementations: {
				ping: () => "pong"
			}
		});
		const records: IRecord[] = [];
		runtime.on("record", (record) => {
			records.push(record);
		});
		const boom = new Error("cleanup failed");
		throwOn(gatewayOf(runtime), "doomed", boom);
		const trail: string[] = [];
		function* remove(draft: any): IActionGenerator<string> {
			draft.Doomed = null;
			yield {
				Type: "ping"
			};
			trail.push("after the yield");
			return "done";
		}

		const outcome = await settled(runtime.dispatch(remove, "root"));

		expect(outcome).toEqual({
			resolved: "done"
		});
		expect(trail).toEqual([
			"after the yield"
		]);
		expect(onError).not.toHaveBeenCalled();
		expect(
			records.flatMap((record) =>
				record.Kind === "action:end"
					? [
							record.Status
						]
					: []
			)
		).toEqual([
			"completed"
		]);
		expect(records.some((record) => record.Kind === "message:deliver")).toBe(false);
		expect(reported.surface()).toEqual([
			boom
		]);
	});

	it("an action's own throw keeps its place, beside the cleanup's", async () => {
		const reported = captureReported();
		const runtime = createRuntime<any>(doomedWorld(), {
			onError: () => {}
		});
		const boom = new Error("cleanup failed");
		const own = new Error("body failed");
		throwOn(gatewayOf(runtime), "doomed", boom);
		function* remove(draft: any): IActionGenerator {
			draft.Doomed = null;
			throw own;
		}

		const outcome = await settled(runtime.dispatch(remove, "root"));

		expect(outcome).toEqual({
			rejected: own
		});
		expect(reported.surface()).toEqual([
			boom
		]);
	});
});
