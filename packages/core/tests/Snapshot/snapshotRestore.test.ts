import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IAction, IActionGenerator } from "../../src/Types/IAction";
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publish } from "../../src/Effects/publish";
import { registerDataSource } from "../../src/Effects/registerDataSource";
import { getDataGlobal } from "../../src/Reads/getData";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { sliceSetState } from "../../src/Runtime/sliceSetState";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { SNAPSHOT_FORMAT_VERSION } from "../../src/Snapshot/ISnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";
import { minted, rawReceiver, rootSetState } from "../testHelpers";

type IChild = {
	$Id: string;
	Value: number;
};
type IRootState = {
	$Id: string;
	Label: string;
	DaemonRuns: number;
	Resolved: string;
	Children: IChild[];
};

const initialState = (): IRootState => ({
	$Id: "Root",
	Label: "",
	DaemonRuns: 0,
	Resolved: "",
	Children: []
});

const publishAny = publish as unknown as (topic: string, data?: Record<string, unknown>) => Generator<any, void, any>;
const getDataAny = getDataGlobal as unknown as (key: string) => Generator<any, any, any>;
const registerDataSourceAny = registerDataSource as unknown as (
	owner: {
		$Id: string;
	},
	key: string
) => Generator<any, void, any>;

function createBarrier() {
	let resolve!: (v: any) => void;
	let signalStarted!: () => void;
	const started = new Promise<void>((r) => {
		signalStarted = r;
	});
	const promise = new Promise<any>((res) => {
		resolve = res;
	});
	return {
		started,
		resolve,
		run: () => {
			signalStarted();
			return promise;
		}
	};
}

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

afterEach(() => {
	vi.restoreAllMocks();
});

describe("snapshot/restore (restart-only)", () => {
	it("round-trips state, bindings, and data sources into a fresh runtime", async () => {
		await createRoot(async (dispose) => {
			try {
				const a = createRuntime<IRootState>(initialState(), {});

				const RestoreReceiver = rawReceiver(
					"RestoreReceiver",
					[
						"Restore/Topic"
					],
					function* (draft: IRootState, data: any): IActionGenerator {
						draft.Label = `received:${data.Tag}`;
					}
				);

				function* setup(draft: IRootState): IActionGenerator {
					draft.Children.push(
						minted("child-1", {
							Value: 7
						})
					);
					bind(draft, RestoreReceiver);
					yield* registerDataSourceAny(draft, "RootSource");
				}

				a.registerReceiver(RestoreReceiver);
				await dispatch(a, setup);

				const snapshot = createSnapshot(a);

				const bActionIds: string[] = [];
				const { runtime: b, result } = await restoreRuntime<IRootState>(snapshot, {
					rootId: "Root",
					options: {},
					setup: (runtime) => {
						runtime.registerReceiver(RestoreReceiver);
						runtime.on("record", (record) => {
							if (record.Kind === "action:start") {
								bActionIds.push(record.ActionId);
							}
						});
					}
				});
				expect(result.dropped).toEqual([]);

				expect(JSON.parse(JSON.stringify(b.state))).toEqual(JSON.parse(JSON.stringify(a.state)));
				expect(b.state.Children[0].Value).toBe(7);

				function* shout(_draft: IRootState): IActionGenerator {
					yield* publishAny("Restore/Topic", {
						Tag: "alive"
					});
				}
				await dispatch(b, shout);
				await new Promise((r) => setTimeout(r, 0));
				expect(b.state.Label).toBe("received:alive");

				function* resolveSource(draft: IRootState): IActionGenerator {
					const source: IRootState | undefined = yield* getDataAny("RootSource");
					draft.Resolved = source ? source.$Id : "(missing)";
				}
				await dispatch(b, resolveSource);
				expect(b.state.Resolved).toBe("Root");

				// Minted ids are session-local trace identity: no restored
				// row is keyed by one, so B numbers its own branches from the
				// start instead of continuing A's — and its ids stay unique
				// because a counter that is never rewound cannot repeat one.
				expect(bActionIds[0]).toBe("branch-1");
				expect(new Set(bActionIds).size).toBe(bActionIds.length);
			} finally {
				dispose();
			}
		});
	});

	it("excludes live actions whose entity has already left the tree from the snapshot's lists", async () => {
		await createRoot(async (dispose) => {
			try {
				const a = createRuntime<IRootState>(
					{
						...initialState(),
						Children: [
							{
								$Id: "child-1",
								Value: 0
							}
						]
					},
					{}
				);
				// Never settles and ignores the signal — the cancelled action's
				// abort is noticed only at settlement, so its start record
				// stays in the live map indefinitely.
				a.registerImplementation("hangForever", () => new Promise(() => {}));
				function* childStory(draft: IChild): IActionGenerator {
					draft.Value = 1;
					yield {
						Type: "hangForever"
					};
				}
				void a.processAction(
					childStory as IAction<any>,
					() => a.state.Children[0],
					sliceSetState(rootSetState(a), (s: IRootState) => s.Children[0]),
					() => "child-1"
				);
				await new Promise<void>((resolve) => setTimeout(resolve, 0));

				function* removeChild(draft: IRootState): IActionGenerator {
					draft.Children = [];
				}
				await dispatch(a, removeChild);

				const parsed = JSON.parse(createSnapshot(a)) as any;
				expect(parsed.InFlight).toEqual([]);
			} finally {
				dispose();
			}
		});
	});

	it("carries each live action's own name in the in-flight index, and the restore reports it", async () => {
		await createRoot(async (dispose) => {
			try {
				const barrier = createBarrier();
				const a = createRuntime<IRootState>(initialState(), {});
				a.registerImplementation("hang", () => barrier.run());

				function* hangNamed(_draft: IRootState): IActionGenerator {
					yield {
						Type: "hang"
					};
				}
				void dispatch(a, hangNamed);
				// Passed straight to the dispatcher: an argument position is
				// not a name binding, so the function carries none.
				void dispatch(a, function* (_draft: IRootState): IActionGenerator {
					yield {
						Type: "hang"
					};
				});
				await barrier.started;

				const parsed = JSON.parse(createSnapshot(a)) as any;
				const names = (
					parsed.InFlight as {
						Label: string | null;
					}[]
				)
					.map((entry) => entry.Label)
					.sort();
				expect(names).toEqual([
					"hangNamed",
					null
				]);

				const { result } = await restoreRuntime<IRootState>(JSON.stringify(parsed), {
					rootId: "Root",
					options: {}
				});
				expect(result.dropped.map((e) => e.label).sort()).toEqual([
					"hangNamed",
					null
				]);
				barrier.resolve(undefined);
			} finally {
				dispose();
			}
		});
	});

	it("labels a drop from a version 7 row's legacy Key when the row carries no Name", async () => {
		await createRoot(async (dispose) => {
			try {
				const legacy = {
					Version: 7,
					AppState: initialState(),
					DataSources: [],
					Timers: [],
					InFlight: [
						{
							ActionId: "act-1",
							Key: "Features/Feature/Actions.ts#hangDurable",
							EntityId: "root"
						},
						{
							ActionId: "act-2",
							Key: null,
							EntityId: "root"
						}
					]
				};

				const { result } = await restoreRuntime<IRootState>(JSON.stringify(legacy), {
					rootId: "Root",
					options: {}
				});
				expect(
					result.dropped.map((e) => [
						e.name,
						e.label
					])
				).toEqual([
					[
						null,
						"Features/Feature/Actions.ts#hangDurable"
					],
					[
						null,
						null
					]
				]);
			} finally {
				dispose();
			}
		});
	});

	it("names the dropped in-flight actions in the result", async () => {
		await createRoot(async (dispose) => {
			try {
				const barrier = createBarrier();
				const a = createRuntime<IRootState>(initialState(), {});
				a.registerImplementation("hang", () => barrier.run());

				function* hangs(): IActionGenerator {
					yield {
						Type: "hang"
					};
				}
				const aRun = dispatch(a, hangs);
				await new Promise((r) => setTimeout(r, 0));

				const snapshot = createSnapshot(a);
				const parsed = JSON.parse(snapshot);
				expect((parsed.InFlight as unknown[]).length).toBe(1);
				expect(parsed).not.toHaveProperty("PendingRequests");

				const { result } = await restoreRuntime<IRootState>(snapshot, {
					rootId: "Root",
					options: {}
				});

				expect(result.dropped).toEqual([
					{
						actionId: parsed.InFlight[0].ActionId,
						name: null,
						label: "hangs",
						entityId: "Root"
					}
				]);

				barrier.resolve(undefined);
				await aRun;
			} finally {
				dispose();
			}
		});
	});

	it("loads an envelope written while request and reply existed, and reports nothing about its PendingRequests", async () => {
		await createRoot(async (dispose) => {
			try {
				const written = {
					Version: SNAPSHOT_FORMAT_VERSION,
					AppState: initialState(),
					DataSources: [],
					Timers: [],
					PendingRequests: [
						{
							RequestId: "req-3",
							OwnerId: "Root",
							Topic: "Restore/Question"
						}
					],
					InFlight: []
				};
				const { runtime: b, result } = await restoreRuntime<IRootState>(JSON.stringify(written), {
					rootId: "Root",
					options: {}
				});
				expect(result).toStrictEqual({
					dropped: [],
					unresolved: [],
					sweptOrphanedRows: 0,
					savedBuild: null,
					sameBuild: false
				});
				b.dispose();
			} finally {
				dispose();
			}
		});
	});
});
