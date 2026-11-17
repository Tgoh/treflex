import type { IRuntime } from "treflex";
import type { IPortal } from "./Portal";
import { createTestRuntime, guids, settled } from "treflex";
import { createSnapshot, restoreTestRuntime } from "treflex/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { registerFakeBackend } from "../backend/fakeBackend";
import { openTrip, removeTrip, startTrip } from "../trips/Planner";
import { getDefaultState, init, ROOT_ID } from "./Portal";
import { restoreBanner } from "./restoreBanner";
import { announceDropped, registerReceivers } from "./session";

const runtimes: IRuntime<IPortal>[] = [];

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

const never = () => new Promise<void>(() => {});

const setup = (runtime: IRuntime<IPortal>): void => {
	registerReceivers(runtime);
	registerFakeBackend(runtime, {
		wait: never,
		chatWait: never
	});
};

async function restoredWithATripRunning(): Promise<IRuntime<IPortal>> {
	const before = createTestRuntime<IPortal>(getDefaultState(), {
		generateGuid: guids("b")
	});
	setup(before);
	runtimes.push(before);
	await before.dispatch(init, ROOT_ID);
	await settled();
	await before.dispatch(startTrip, "Trips", "lisbon");
	await settled();
	const { runtime } = await restoreTestRuntime<IPortal>(createSnapshot(before), {
		rootId: ROOT_ID,
		effectStubs: {
			generateGuid: guids("br")
		},
		setup,
		repair: announceDropped
	});
	runtimes.push(runtime);
	await settled();
	return runtime;
}

const bannerOf = (runtime: IRuntime<IPortal>) => restoreBanner(runtime.state);

describe("the restore banner across the apps", () => {
	it("keeps saying something was lost after the trip that lost it is removed", async () => {
		const runtime = await restoredWithATripRunning();
		expect(runtime.state.Restore?.LostAny).toBe(true);
		expect(bannerOf(runtime)?.Lost.join(" ")).toContain("Lisbon's flight, hotel and activity searches");

		await runtime.dispatch(removeTrip, "Trips", runtime.state.Trips.Trips[0].$Id);
		await settled();
		expect(runtime.state.Trips.Restore).toBeNull();
		const banner = bannerOf(runtime)!;
		expect(banner.Back.some((line) => line.startsWith("Team chat's"))).toBe(true);
		expect(banner.Lost).toEqual([
			"Nothing on what's still here"
		]);
	});

	it("stays up on a trip started after the restore, with no line about that trip", async () => {
		const runtime = await restoredWithATripRunning();
		const lisbon = runtime.state.Trips.Trips[0].$Id;
		await runtime.dispatch(startTrip, "Trips", "kyoto");
		await settled();

		const banner = bannerOf(runtime)!;
		expect(banner.Back).toContain("1 trip and everything the agent found");
		expect(banner.Back.some((line) => line.startsWith("The trip"))).toBe(false);
		expect(banner.Back.some((line) => line.startsWith("The aquarium's"))).toBe(true);
		expect(banner.Back.some((line) => line.startsWith("Team chat's"))).toBe(true);
		expect(banner.Lost.join(" ")).toContain("Lisbon's flight, hotel and activity searches");
		expect(banner.Lost.join(" ")).not.toContain("Kyoto");

		await runtime.dispatch(openTrip, "Trips", lisbon);
		await settled();
		expect(bannerOf(runtime)?.Back[0]).toBe("The trip and what the agent had written");
	});
});
