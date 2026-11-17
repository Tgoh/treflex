import type { IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it } from "vitest";
import { openResource } from "../../src/Effects/openResource";
import { startTimer } from "../../src/Effects/startTimer";
import { stopTimer } from "../../src/Effects/stopTimer";
import { receiver } from "../../src/Runtime/receiver";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreTestRuntime } from "../../src/Snapshot/index";
import { createTestRuntime } from "../../src/Testing/createTestRuntime";
import { isEnded } from "../../src/Types/IResource";

type IWorkspace = {
	$Id: string;
	Retries: number;
	LastSequence: number;
};

const seed = (): IWorkspace => ({
	$Id: "ws-1",
	Retries: 0,
	LastSequence: 0
});

const startTimerAny = startTimer as unknown as (
	entity: IWorkspace,
	key: string,
	target: {
		Id: string;
	},
	intervalMs: number
) => Generator<any, void, any>;
const stopTimerAny = stopTimer as unknown as (entity: IWorkspace, key: string) => Generator<any, void, any>;
const openResourceAny = openResource as unknown as (
	entity: IWorkspace,
	key: string,
	target: {
		Id: string;
	},
	params: {
		Type: string;
	}
) => Generator<any, void, any>;

function* openEvents(draft: IWorkspace): IActionGenerator {
	yield* openResourceAny(draft, "Workspace/Events", WorkspaceReceiver, {
		Type: "workspace/events"
	});
}

function* reopenLater(draft: IWorkspace): IActionGenerator {
	draft.Retries++;
	yield* startTimerAny(draft, "Workspace/Reconnect", WorkspaceReceiver, Math.min(30_000, 500 * 2 ** draft.Retries));
}

const WorkspaceReceiver = receiver<IWorkspace>("BackoffWorkspaceReceiver")({
	*"Workspace/Events"(draft: IWorkspace, e: any): IActionGenerator {
		if (isEnded(e)) {
			if (e.$Ended.Reason !== "receiver-failed") {
				yield* reopenLater(draft);
			}
			return;
		}
		draft.Retries = 0;
		draft.LastSequence = (
			e as {
				Last: number;
			}
		).Last;
	},
	*"Workspace/Reconnect"(draft: IWorkspace): IActionGenerator {
		yield* stopTimerAny(draft, "Workspace/Reconnect");
		yield* openEvents(draft);
	}
} as never);

const ended = (Reason: string) =>
	({
		Type: "Workspace/Events",
		$Ended: {
			Reason
		}
	}) as never;

const context = {
	publisher: {
		Id: "ws-1"
	}
} as never;

function build() {
	const runtime = createTestRuntime(seed());
	runtime.registerReceiver(WorkspaceReceiver);
	const deliver = (message: never) => runtime.dispatch(WorkspaceReceiver.handle as any, "ws-1", message, context);
	const tick = () =>
		runtime.dispatch(
			WorkspaceReceiver.handle as any,
			"ws-1",
			{
				Type: "Workspace/Reconnect"
			} as never,
			context
		);
	return {
		runtime,
		deliver,
		tick
	};
}

describe("runtime.timers", () => {
	it("reads every row or one owner's, as copies", async () => {
		const runtime = createTestRuntime({
			$Id: "root",
			Child: {
				$Id: "child"
			}
		});
		function* arm(draft: any): IActionGenerator {
			yield* startTimerAny(draft, "Rows/Tick", WorkspaceReceiver, 100);
		}
		await runtime.dispatch(arm, "root");
		await runtime.dispatch(arm, "child");
		expect(
			runtime
				.timers()
				.map((row) => row.OwnerId)
				.sort()
		).toEqual([
			"child",
			"root"
		]);
		expect(runtime.timers("child")).toEqual([
			{
				Key: "Rows/Tick",
				OwnerId: "child",
				ReceiverId: WorkspaceReceiver.Id,
				IntervalMs: 100,
				Payload: null
			}
		]);
		expect(runtime.timers(runtime.state)).toHaveLength(1);
		const row = runtime.timers("child")[0]!;
		row.IntervalMs = 1;
		expect(runtime.timers("child")[0]!.IntervalMs).toBe(100);
	});
});

describe("runtime.timers after a restore", () => {
	it("hands out a Payload a write to doesn't reach the row", async () => {
		const before = createTestRuntime({
			$Id: "root"
		});
		function* arm(draft: any): IActionGenerator {
			yield* (startTimer as any)(draft, "Rows/Tick", WorkspaceReceiver, 100, {
				Deep: {
					Tag: "kept"
				}
			});
		}
		await before.dispatch(arm, "root");

		const { runtime: after } = await restoreTestRuntime<{
			$Id: string;
		}>(createSnapshot(before), {
			rootId: "root",
			setup: (runtime) => runtime.registerReceiver(WorkspaceReceiver)
		});

		const payload = after.timers()[0]!.Payload as {
			Deep: {
				Tag: string;
			};
		};
		payload.Deep.Tag = "scribbled";

		expect(after.timers()[0]!.Payload).toEqual({
			Deep: {
				Tag: "kept"
			}
		});
	});
});

describe("the backoff recipe in live-sources.md", () => {
	it("doubles the wait on each ending, up to the cap", async () => {
		const { runtime, deliver, tick } = build();
		const waits: number[] = [];
		for (let round = 0; round < 8; round++) {
			await deliver(ended("failed"));
			waits.push(runtime.timers("ws-1")[0]!.IntervalMs);
			await tick();
			expect(runtime.timers("ws-1")).toEqual([]);
		}
		expect(waits).toEqual([
			1_000,
			2_000,
			4_000,
			8_000,
			16_000,
			30_000,
			30_000,
			30_000
		]);
		expect(runtime.resources("ws-1").map((row) => row.Key)).toEqual([
			"Workspace/Events"
		]);
	});

	it("starts again from the first wait once a message gets through", async () => {
		const { runtime, deliver, tick } = build();
		await deliver(ended("failed"));
		await tick();
		await deliver({
			Type: "Workspace/Events",
			Last: 7
		} as never);
		expect(runtime.state.LastSequence).toBe(7);
		await deliver(ended("failed"));
		expect(runtime.timers("ws-1")[0]!.IntervalMs).toBe(1_000);
	});

	it("does not wait to reopen after a receiver failed", async () => {
		const { runtime, deliver } = build();
		await deliver(ended("receiver-failed"));
		expect(runtime.timers("ws-1")).toEqual([]);
	});
});
