import type { IFiber } from "../../src/Runtime/Fiber";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator, IActionYield } from "../../src/Types/IAction";
import type { IAskId } from "../../src/Types/IAskId";
import type { IEntity } from "../../src/Types/IEntity";
import type { IRecord } from "../../src/Types/IRecord";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { describe, expect, it } from "vitest";
import { answer } from "../../src/Effects/answer";
import { ask } from "../../src/Effects/ask";
import { entity } from "../../src/Effects/entity";
import { parallel } from "../../src/Effects/parallel";
import { start } from "../../src/Effects/start";
import { latest } from "../../src/Runtime/arrivalPolicy";
import { createRuntime, type IRuntime } from "../../src/Runtime/createRuntime";
import { open } from "../../src/Runtime/open";
import { stepAction } from "../../src/Runtime/runningStep";
import { minted, pendingAsksOf } from "../testHelpers";

type IDiag = IRuntimeEventOf<"diag">;

interface IHolder {
	$Id: string;
	Row: IEntity | null;
}

interface IUpload extends IHolder {
	Name: string;
	Progress: number;
}

interface IWorld extends IHolder {
	Outcome: string | null;
	Uploads: IUpload[];
	Child: IHolder | null;
}

function buildRuntime() {
	const runtime = createRuntime<IWorld>(
		{
			$Id: "root",
			Row: null,
			Outcome: null,
			Uploads: [],
			Child: null
		},
		{
			onError: () => {}
		}
	) as IRuntimeInternal<IWorld>;
	const records: IRecord[] = [];
	const recordWaiters: {
		match: (r: IRecord) => boolean;
		resolve: () => void;
	}[] = [];
	runtime.on("record", (r) => {
		records.push(r);
		for (let i = recordWaiters.length - 1; i >= 0; i--) {
			if (recordWaiters[i].match(r)) {
				recordWaiters[i].resolve();
				recordWaiters.splice(i, 1);
			}
		}
	});
	const untilRecord = (match: (r: IRecord) => boolean): Promise<void> => {
		if (records.some(match)) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			recordWaiters.push({
				match,
				resolve
			});
		});
	};
	const untilEffect = (type: string) =>
		untilRecord(
			(r) =>
				r.Kind === "effect" &&
				(
					r as {
						Type: string;
					}
				).Type === type
		);
	const diags: IDiag[] = [];
	runtime.on("diag", (d) => diags.push(d));
	return {
		runtime,
		records,
		diags,
		untilRecord,
		untilEffect
	};
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function* openOn(draft: IHolder) {
	draft.Row = yield* entity({});
	return yield* open(
		ask<string>(draft.Row, {
			Path: "Park"
		})
	);
}

const rowOf = (
	runtime: IRuntime<IWorld>
): [
	string,
	IAskId<string | undefined>
] => {
	const [entry] = pendingAsksOf(runtime, runtime.state);
	return [
		entry!.OwnerId,
		entry!.Id as IAskId<string | undefined>
	];
};

// The asker's finally runs as a close, after its open has let the entity go, so it logs outside the draft.
function* asker(draft: IWorld, log: string[]) {
	try {
		const choice = yield* openOn(draft);
		draft.Outcome = `answered:${choice}`;
	} finally {
		log.push("finally");
	}
}

// A replacement that doesn't ask stops the asker in its own arrival.
function replaceable(log: string[]) {
	return latest(function* asking(draft: IWorld, asks: boolean) {
		if (asks) {
			yield* asker(draft, log);
		}
	});
}

describe("the ask park settles on the branch axis", () => {
	it("a stop of a parked asker abandons the ask", async () => {
		const world = buildRuntime();
		const log: string[] = [];
		const asking = replaceable(log);
		const first = world.runtime.dispatch(asking, "root", true);
		await world.untilEffect("ask");
		await world.runtime.dispatch(asking, "root", false);
		await first;
		await settle();

		expect(world.runtime.state.Outcome).toBeNull();
		expect(log).toEqual([
			"finally"
		]);
		expect(
			world.records
				.filter((r) => r.Kind === "action:end")
				.map(
					(r) =>
						(
							r as {
								Status: string;
							}
						).Status
				)
		).toEqual([
			"completed",
			"cancelled"
		]);
		const opened = world.records.find((r) => r.Kind === "table" && r.Table === "asks");
		expect(world.records.find((r) => r.Kind === "ask:abandon")).toMatchObject({
			AskId: (
				opened as {
					AskId: string;
				}
			).AskId,
			Reason: "cancelled"
		});
	});

	it("a disposal beats the listener: the deferred abandonment no-ops by row absence and 'disposed' survives", async () => {
		const world = buildRuntime();
		let childSignal: AbortSignal | null = null;
		world.runtime.registerImplementation("captureSignal", (_effect, action) => {
			childSignal = action!.signal;
		});
		function* captureSignal(): IActionGenerator {
			yield {
				Type: "captureSignal"
			};
		}
		function* childRoot(draft: IHolder) {
			yield* captureSignal();
			yield* openOn(draft);
		}
		await world.runtime.dispatch(function* openChild(draft: IWorld): IActionGenerator {
			draft.Child = minted("child", {
				Row: null
			});
		}, "root");
		const childParked = world.runtime.dispatch(childRoot, "~child");
		await world.untilEffect("ask");
		expect(childSignal!.aborted).toBe(false);
		const originalQueueMicrotask = globalThis.queueMicrotask;
		const disposedBefore: boolean[] = [];
		globalThis.queueMicrotask = (callback: () => void) => {
			originalQueueMicrotask(() => {
				disposedBefore.push(world.records.some((r) => r.Kind === "ask:abandon"));
				callback();
			});
		};
		try {
			await world.runtime.dispatch(function* dropChild(draft: IWorld): IActionGenerator {
				draft.Child = null;
			}, "root");
		} finally {
			globalThis.queueMicrotask = originalQueueMicrotask;
		}
		await childParked;
		await settle();
		expect(childSignal!.aborted).toBe(true);
		// Exact on purpose, because it is what catches a double-queue: the deferred
		// abandonment, the pendingAsks() listing's version bump and the asker's close.
		expect(disposedBefore).toEqual([
			true,
			true,
			true
		]);
		const abandons = world.records.filter((r) => r.Kind === "ask:abandon");
		expect(abandons.length).toBe(1);
		expect(abandons[0]).toMatchObject({
			Reason: "disposed"
		});
	});

	it("first event wins: an answer landing before the stop's microtask consumes, and the stopped asker discards the delivery", async () => {
		const world = buildRuntime();
		const log: string[] = [];
		const asking = replaceable(log);
		void world.runtime.dispatch(asking, "root", true);
		await world.untilEffect("ask");
		await world.runtime.dispatch(
			function* stopThenAnswer(_draft: IEntity, id: IAskId<string | undefined>): IActionGenerator {
				void world.runtime.dispatch(asking, "root", false);
				yield* answer(id, "yes");
			},
			...rowOf(world.runtime)
		);
		await settle();
		expect(world.records.find((r) => r.Kind === "ask:answer")).toBeDefined();
		expect(world.records.filter((r) => r.Kind === "ask:abandon")).toEqual([]);
		expect(world.runtime.state.Outcome).toBeNull();
		expect(log).toEqual([
			"finally"
		]);
	});
});

describe("the listener lifecycle", () => {
	it("a looping asker accumulates no stop listeners", async () => {
		const world = buildRuntime();
		let fiber!: IFiber;
		function* quickWorker(): Generator<IActionYield, number, any> {
			return 1;
		}
		function* looper(draft: IWorld) {
			fiber = stepAction("looper").fiber;
			for (let round = 0; round < 3; round++) {
				yield* openOn(draft);
			}
			for (let round = 0; round < 5; round++) {
				yield* parallel(quickWorker());
			}
		}
		const looping = world.runtime.dispatch(looper, "root");
		for (let round = 0; round < 3; round++) {
			await world.untilRecord(
				(r) =>
					r.Kind === "effect" &&
					(
						r as {
							Type: string;
						}
					).Type === "ask" &&
					world.records.filter(
						(x) =>
							x.Kind === "effect" &&
							(
								x as {
									Type: string;
								}
							).Type === "ask"
					).length > round
			);
			await world.runtime.dispatch(
				function* answerIt(_draft: IEntity, id: IAskId<string | undefined>): IActionGenerator {
					yield* answer(id, "ok");
				},
				...rowOf(world.runtime)
			);
		}
		await looping;
		await settle();
		expect(fiber.stopListeners?.size ?? 0).toBe(0);
	});
});

describe("the work-entity pattern", () => {
	it("the composite acceptance: splicing the work row cancels the started action and abandons its park", async () => {
		const world = buildRuntime();
		function* runUpload(draft: IUpload) {
			draft.Progress = 1;
			yield* openOn(draft);
			draft.Progress = 100;
		}
		function* startUpload(draft: IWorld): IActionGenerator {
			draft.Uploads.push(
				minted("upload-1", {
					Name: "report.pdf",
					Progress: 0,
					Row: null
				})
			);
			yield* start(runUpload, "~upload-1");
		}
		function* cancelUpload(draft: IWorld): IActionGenerator {
			draft.Uploads = draft.Uploads.filter((u) => u.$Id !== "~upload-1");
		}
		await world.runtime.dispatch(startUpload, "root");
		await world.untilEffect("ask");
		await world.runtime.dispatch(cancelUpload, "root");
		await settle();

		expect(
			world.records.find(
				(r) =>
					r.Kind === "action:end" &&
					(
						r as {
							Status: string;
						}
					).Status === "cancelled"
			)
		).toBeDefined();
		expect(world.records.filter((r) => r.Kind === "ask:abandon")).toMatchObject([
			{
				Reason: "disposed"
			}
		]);
		expect(world.runtime.state.Uploads).toEqual([]);
	});
});
