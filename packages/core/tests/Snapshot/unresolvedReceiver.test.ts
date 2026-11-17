import type { IAction, IActionGenerator } from "../../src/Types/IAction";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { publish } from "../../src/Effects/publish";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { receiver } from "../../src/Runtime/receiver";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { SNAPSHOT_FORMAT_VERSION } from "../../src/Snapshot/ISnapshot";
import { restoreRuntime, restoreTestRuntime } from "../../src/Snapshot/index";
import { rootSetState } from "../testHelpers";

const publishAny = publish as unknown as (key: string) => Generator<any, void, any>;

type IRootState = {
	$Id: string;
	Sub: {
		$Id: string;
		Seen: number;
	};
};

const initialState = (): IRootState => ({
	$Id: "Root",
	Sub: {
		$Id: "Sub",
		Seen: 0
	}
});

function makeReceiver(id: string) {
	return receiver<{
		$Id: string;
		Seen: number;
	}>(id)({
		["Ping" as any]: function* (draft: any) {
			draft.Seen++;
		}
	});
}

function* setup(draft: IRootState): IActionGenerator {
	bind(draft.Sub, makeReceiver("OldReceiver"));
}

function* send(_draft: IRootState): IActionGenerator {
	yield* publishAny("Ping");
}

const dispatch = (runtime: ReturnType<typeof createRuntime<IRootState>>, action: IAction<IRootState>) =>
	runtime.processAction(
		action,
		() => runtime.state,
		rootSetState(runtime),
		() => "Root"
	);

describe("a restored binding whose receiver this build no longer registers", () => {
	it("is reported at restore and in the result, and is deaf until registered", async () => {
		const snapshot = await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<IRootState>(initialState(), {});
				runtime.registerReceiver(makeReceiver("OldReceiver"));
				await dispatch(runtime, setup);
				await dispatch(runtime, send);
				await Promise.resolve();
				expect(runtime.state.Sub.Seen).toBe(1);
				const json = createSnapshot(runtime);
				runtime.dispose();
				return json;
			} finally {
				dispose();
			}
		});

		await createRoot(async (dispose) => {
			try {
				const diags: any[] = [];
				const { runtime, result } = await restoreRuntime<IRootState>(snapshot, {
					rootId: "Root",
					options: {},
					setup: (runtime) => {
						runtime.registerReceiver(makeReceiver("NewReceiver"));
						runtime.on("diag", (event) => diags.push(event));
					}
				});

				expect(result.sweptOrphanedRows).toBe(0);
				expect(result.unresolved).toStrictEqual([
					{
						ownerId: "Sub",
						key: null,
						receiverId: "OldReceiver"
					}
				]);
				expect(diags).toContainEqual(
					expect.objectContaining({
						severity: "warn",
						code: "restore/unresolved-receiver",
						data: {
							count: 1,
							receiverIds: [
								"OldReceiver"
							],
							sample: [
								{
									ownerId: "Sub",
									key: null,
									receiverId: "OldReceiver"
								}
							]
						}
					})
				);

				// Seen carries in from the snapshot at 1, so an unchanged 1 is the publish doing nothing.
				await dispatch(runtime, send);
				await Promise.resolve();
				expect(runtime.state.Sub.Seen).toBe(1);

				runtime.registerReceiver(makeReceiver("OldReceiver"));
				await dispatch(runtime, send);
				await Promise.resolve();
				expect(runtime.state.Sub.Seen).toBe(2);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("says nothing when every restored binding resolves", async () => {
		const snapshot = await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<IRootState>(initialState(), {});
				runtime.registerReceiver(makeReceiver("OldReceiver"));
				await dispatch(runtime, setup);
				const json = createSnapshot(runtime);
				runtime.dispose();
				return json;
			} finally {
				dispose();
			}
		});

		await createRoot(async (dispose) => {
			try {
				const diags: string[] = [];
				const { runtime, result } = await restoreRuntime<IRootState>(snapshot, {
					rootId: "Root",
					options: {},
					setup: (runtime) => {
						runtime.registerReceiver(makeReceiver("OldReceiver"));
						runtime.on("diag", (event) => diags.push(event.code));
					}
				});

				expect(diags).not.toContain("restore/unresolved-receiver");
				expect(result.unresolved).toStrictEqual([]);
				await dispatch(runtime, send);
				await Promise.resolve();
				expect(runtime.state.Sub.Seen).toBe(1);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("reports a binding whose receiver id is a prototype member name", async () => {
		const snapshot = await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<IRootState>(initialState(), {});
				const Poisoned = makeReceiver("constructor");
				runtime.registerReceiver(Poisoned);
				await dispatch(runtime, function* (draft: IRootState): IActionGenerator {
					bind(draft.Sub, Poisoned);
				});
				const json = createSnapshot(runtime);
				runtime.dispose();
				return json;
			} finally {
				dispose();
			}
		});

		await createRoot(async (dispose) => {
			try {
				const diags: any[] = [];
				const { runtime } = await restoreRuntime<IRootState>(snapshot, {
					rootId: "Root",
					options: {},
					setup: (runtime) => {
						runtime.on("diag", (event) => diags.push(event));
					}
				});

				expect(diags).toContainEqual(
					expect.objectContaining({
						code: "restore/unresolved-receiver",
						data: expect.objectContaining({
							count: 1,
							receiverIds: [
								"constructor"
							]
						})
					})
				);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});
});

describe("restored bindings, timer and resource rows whose receiver this build no longer registers", () => {
	it("are listed in the result's unresolved, and a receiver-less resource row is not", async () => {
		const envelope = {
			Version: SNAPSHOT_FORMAT_VERSION,
			AppState: {
				$Id: "Root",
				Sub: {
					$Id: "Sub",
					Seen: 0,
					$Receiver: "GoneBindingReceiver"
				}
			},
			DataSources: [],
			Timers: [
				{
					Key: "Sub/Tick",
					OwnerId: "Sub",
					ReceiverId: "GoneTimerReceiver",
					IntervalMs: 100,
					Payload: null
				}
			],
			Resources: [
				{
					Key: "Sub/Feed",
					OwnerId: "Sub",
					Params: {
						Type: "unresolved/feed"
					},
					ReceiverId: "GoneFeedReceiver",
					ResumeFrom: null
				},
				{
					Key: "Sub/Upload",
					OwnerId: "Sub",
					Params: {
						Type: "unresolved/upload"
					},
					ReceiverId: null,
					ResumeFrom: null
				}
			],
			InFlight: []
		};
		const { runtime, result } = await restoreTestRuntime<IRootState>(JSON.stringify(envelope), {
			rootId: "Root",
			options: {
				allowDiags: [
					"restore/unresolved-receiver",
					"receiver/unresolved"
				]
			}
		});
		expect(result.unresolved).toStrictEqual([
			{
				ownerId: "Sub",
				key: null,
				receiverId: "GoneBindingReceiver"
			},
			{
				ownerId: "Sub",
				key: "Sub/Tick",
				receiverId: "GoneTimerReceiver"
			},
			{
				ownerId: "Sub",
				key: "Sub/Feed",
				receiverId: "GoneFeedReceiver"
			}
		]);
		runtime.dispose();
	});
});
