import type { IRuntime } from "treflex";
import type { IPortal } from "./Portal";
import type { IFinished } from "./topics";
import { createRuntime } from "treflex";
import { createSnapshot, restoreRuntime } from "treflex/snapshot";
import { afterEach, expect, it, vi } from "vitest";
import { registerFakeBackend } from "../backend/fakeBackend";
import { getDefaultState, PortalReceiver, ROOT_ID, TOAST_MS, toast } from "./Portal";
import { registerReceivers, repairRestore } from "./session";

const runtimes: IRuntime<IPortal>[] = [];

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	vi.useRealTimers();
});

const never = () => new Promise<void>(() => {});

const setup = (runtime: IRuntime<IPortal>): void => {
	registerReceivers(runtime);
	registerFakeBackend(runtime, {
		wait: never,
		chatWait: never
	});
};

function finished(title: string): IFinished {
	return {
		App: "chat",
		Target: "not-on-screen",
		Title: title,
		Text: "",
		Link: ""
	};
}

const raise = (runtime: IRuntime<IPortal>, title: string) =>
	runtime.dispatch(
		PortalReceiver.handle,
		ROOT_ID,
		{
			Type: "Portal/Finished",
			...finished(title)
		},
		{
			publisher: {
				Id: ROOT_ID
			}
		}
	);

const shown = (runtime: IRuntime<IPortal>) => runtime.processSelector(toast, () => runtime.state)?.Title ?? null;

it("gives a second toast raised within the first one's time its own full time", async () => {
	vi.useFakeTimers({
		toFake: [
			"setTimeout",
			"clearTimeout"
		]
	});
	const runtime = createRuntime<IPortal>(getDefaultState());
	setup(runtime);
	runtimes.push(runtime);
	await raise(runtime, "first");
	await vi.advanceTimersByTimeAsync(TOAST_MS - 2000);
	await raise(runtime, "second");
	await vi.advanceTimersByTimeAsync(TOAST_MS - 1000);
	expect(shown(runtime)).toBe("second");
	await vi.advanceTimersByTimeAsync(2000);
	expect(shown(runtime)).toBeNull();
});

it("keeps a toast raised soon after a restore up for its own full time", async () => {
	vi.useFakeTimers({
		toFake: [
			"setTimeout",
			"clearTimeout"
		]
	});
	const before = createRuntime<IPortal>(getDefaultState());
	setup(before);
	await raise(before, "before the reload");
	expect(before.timers(ROOT_ID).map((row) => row.Key)).toEqual([
		"Portal/ToastTimeout"
	]);
	const json = createSnapshot(before);
	before.dispose();

	const { runtime } = await restoreRuntime<IPortal>(json, {
		rootId: ROOT_ID,
		options: {},
		setup,
		repair: repairRestore
	});
	runtimes.push(runtime);
	await vi.advanceTimersByTimeAsync(TOAST_MS - 2000);
	await raise(runtime, "after the reload");
	expect(shown(runtime)).toBe("after the reload");

	await vi.advanceTimersByTimeAsync(3000);
	expect(shown(runtime)).toBe("after the reload");
	await vi.advanceTimersByTimeAsync(TOAST_MS);
	expect(shown(runtime)).toBeNull();
});
