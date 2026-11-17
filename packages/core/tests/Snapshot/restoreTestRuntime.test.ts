import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IEffectStub, ITestRuntimeOptions } from "../../src/Testing/createTestRuntime";
import type { IActionGenerator } from "../../src/Types/IAction";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateGuid } from "../../src/Effects/generateGuid";
import { openResource } from "../../src/Effects/openResource";
import { resource } from "../../src/Effects/resource";
import { startTimer } from "../../src/Effects/startTimer";
import { inFlight } from "../../src/Runtime/arrivals";
import { receiver } from "../../src/Runtime/receiver";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreRuntime, restoreTestRuntime } from "../../src/Snapshot/index";
import { createTestRuntime, guids } from "../../src/Testing/createTestRuntime";

type IDialog = {
	$Id: string;
	Log: string[];
	Stamp: string | null;
};

const initial = (): IDialog => ({
	$Id: "dialog",
	Log: [],
	Stamp: null
});

const DialogReceiver = receiver<IDialog>("RestoreTestDialogReceiver")({
	*["RestoreTest/Tick" as any](draft: IDialog) {
		draft.Log.push("tick");
	}
});

const register = (runtime: IRuntime<IDialog>) => {
	runtime.registerReceiver(DialogReceiver);
};

function* open(draft: IDialog): IActionGenerator {
	yield* (openResource as any)(draft, "RestoreTest/Upload", DialogReceiver, {
		Type: "restoreTest/upload"
	});
	yield* (startTimer as any)(draft, "RestoreTest/Tick", DialogReceiver, 100);
}

function* upload(draft: IDialog): IActionGenerator {
	const id: string | undefined = yield* (resource as any)(draft, "RestoreTest/Upload").upload("f1");
	draft.Log.push(id ?? "none");
}

function* stamp(draft: IDialog): IActionGenerator {
	draft.Stamp = yield* generateGuid();
}

function* busy(draft: IDialog): IActionGenerator<boolean> {
	return yield* inFlight(upload, draft);
}

async function saved(): Promise<string> {
	const before = createTestRuntime(initial());
	register(before);
	await before.dispatch(open, "dialog");
	const json = createSnapshot(before);
	before.dispose();
	return json;
}

async function freshTestRuntime(effectStubs?: Record<string, IEffectStub>, options?: ITestRuntimeOptions) {
	const fresh = createTestRuntime<IDialog>(initial(), effectStubs, options);
	register(fresh);
	await fresh.dispatch(open, "dialog");
	return fresh;
}

const failureOf = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: unknown) => (error as Error).message
	);

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("restoreTestRuntime", () => {
	it("builds what a fresh createTestRuntime does: an unstubbed method throws, and an unstubbed guid refuses", async () => {
		const json = await saved();
		const fresh = await freshTestRuntime();
		const { runtime } = await restoreTestRuntime<IDialog>(json, {
			rootId: "dialog",
			setup: register
		});

		const freshUpload = await failureOf(fresh.dispatch(upload, "dialog"));
		expect(freshUpload).toMatch(/has no stub/);
		expect(await failureOf(runtime.dispatch(upload, "dialog"))).toBe(freshUpload);
		const freshStamp = await failureOf(fresh.dispatch(stamp, "dialog"));
		expect(freshStamp).toBeDefined();
		expect(await failureOf(runtime.dispatch(stamp, "dialog"))).toBe(freshStamp);
		fresh.dispose();
		runtime.dispose();
	});

	it("differs from a bare restore under the same pauses, whose unstubbed method resolves undefined", async () => {
		const { runtime } = await restoreRuntime<IDialog>(await saved(), {
			rootId: "dialog",
			options: {
				pauseTimers: true,
				pauseResources: true
			},
			setup: register
		});
		await runtime.dispatch(upload, "dialog");
		expect(runtime.state.Log).toStrictEqual([
			"none"
		]);
		runtime.dispose();
	});

	it("builds from the effect stubs and options given, other stubs included, with no restored timer ticking", async () => {
		const json = await saved();
		vi.useFakeTimers();
		const boot = () => ({
			effectStubs: {
				generateGuid: guids("after")
			},
			options: {
				resources: {
					methods: {
						"RestoreTest/Upload": {
							upload: (_ctx: unknown, id: string) => `guid-${id}`
						}
					}
				},
				inFlight: (ownerId: string) =>
					ownerId === "dialog"
						? [
								upload
							]
						: undefined
			}
		});
		const answers = async (runtime: IRuntime<IDialog>) => {
			await runtime.dispatch(upload, "dialog");
			await runtime.dispatch(stamp, "dialog");
			const isBusy = await runtime.dispatch(busy, "dialog");
			await vi.advanceTimersByTimeAsync(500);
			return {
				Log: [
					...runtime.state.Log
				],
				Stamp: runtime.state.Stamp,
				isBusy,
				timers: runtime.timers().length
			};
		};
		const { effectStubs, options } = boot();
		const fresh = await freshTestRuntime(effectStubs, options);
		const { runtime } = await restoreTestRuntime<IDialog>(json, {
			rootId: "dialog",
			...boot(),
			setup: register
		});

		const restored = await answers(runtime);
		expect(restored).toStrictEqual({
			Log: [
				"guid-f1"
			],
			Stamp: "after-1",
			isBusy: true,
			timers: 1
		});
		expect(restored).toStrictEqual(await answers(fresh));
		fresh.dispose();
		runtime.dispose();
	});
});
