import type { IActionGenerator, IRuntime } from "treflex";
import type { IPortal } from "../portal/Portal";
import type { ITour } from "../tour/Tour";
import { createTestRuntime, guids, implementation, named, settled } from "treflex";
import { createSnapshot, restoreTestRuntime } from "treflex/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { now } from "../backend/backend";
import { fakeRandom } from "../backend/fakeBackend";
import { getDefaultState, ROOT_ID } from "../portal/Portal";
import { restoreBanner } from "../portal/restoreBanner";
import { registerReceivers, repairRestore } from "../portal/session";
import { tourHint } from "../portal/tourHints";
import { currentStep } from "../tour/Tour";
import {
	addFish,
	addGiant,
	addSchool,
	init,
	MAX_FISH,
	MAX_GIANTS,
	MAX_SCHOOLS,
	releaseFish,
	releaseSchool,
	swimLine,
	tankFacts
} from "./Aquarium";
import { FishReceiver, SWIM_MS, swimInProgress } from "./Fish";
import { aquariumRestoreLines } from "./restoreLines";

const runtimes: IRuntime<IPortal>[] = [];

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

const CLOCK = 1_700_000_000_000;

function setup(runtime: IRuntime<IPortal>): void {
	registerReceivers(runtime);
	runtime.registerImplementation(fakeRandom());
	runtime.registerImplementation(implementation(now, () => CLOCK));
}

async function tank(): Promise<IRuntime<IPortal>> {
	const runtime = createTestRuntime<IPortal>(getDefaultState(), {
		generateGuid: guids("q")
	});
	setup(runtime);
	runtimes.push(runtime);
	await runtime.dispatch(init, "Aquarium");
	await settled();
	return runtime;
}

async function reload(before: IRuntime<IPortal>): Promise<IRuntime<IPortal>> {
	const { runtime } = await restoreTestRuntime<IPortal>(createSnapshot(before), {
		rootId: ROOT_ID,
		effectStubs: {
			generateGuid: guids("qr")
		},
		setup,
		repair: repairRestore
	});
	runtimes.push(runtime);
	await settled();
	return runtime;
}

function swim(runtime: IRuntime<IPortal>, fishId: string): Promise<unknown> {
	return runtime.dispatch(
		FishReceiver.handle,
		fishId,
		{
			Type: "Fish/Swim"
		},
		{
			publisher: {
				Id: fishId
			}
		}
	);
}

function* cameBack(draft: ITour): IActionGenerator {
	draft.Started = true;
	draft.Answered = true;
	draft.CameBack = true;
}
named(cameBack, "Aquarium/CameBack");

const swimRows = (runtime: IRuntime<IPortal>) => runtime.timers().filter((row) => row.Key === "Fish/Swim");
const factsOf = (runtime: IRuntime<IPortal>) => runtime.processSelector(tankFacts, () => runtime.state.Aquarium);

describe("the aquarium", () => {
	it("starts with three schools of four fish, each fish on its own swim timer", async () => {
		const runtime = await tank();
		const schools = runtime.state.Aquarium.Schools;
		expect(schools.map((s) => s.Name)).toEqual([
			"Lanternfish",
			"Hatchetfish",
			"Viperfish"
		]);
		expect(schools.every((s) => s.Fish.length === 4)).toBe(true);
		const rows = swimRows(runtime);
		expect(rows).toHaveLength(12);
		expect(new Set(rows.map((row) => row.OwnerId))).toEqual(new Set(schools.flatMap((s) => s.Fish.map((f) => f.$Id))));
		expect(rows.every((row) => row.IntervalMs >= 2200 && row.IntervalMs < 5800)).toBe(true);
		expect(factsOf(runtime).Line).toBe("12 fish · 3 schools");
	});

	it("moves a fish one waypoint on each swim tick", async () => {
		const runtime = await tank();
		const fish = {
			...runtime.state.Aquarium.Schools[0].Fish[0]
		};
		await swim(runtime, fish.$Id);
		const moved = runtime.state.Aquarium.Schools[0].Fish[0];
		expect(moved.Cycles).toBe(1);
		expect(moved.X).not.toBe(fish.X);
		expect(moved.Facing).toBe(moved.X >= fish.X ? 1 : -1);
	});

	it("takes a released school's fish and their timers with it, and a released fish only its own", async () => {
		const runtime = await tank();
		const [first, second] = runtime.state.Aquarium.Schools;
		await runtime.dispatch(releaseSchool, "Aquarium", first.$Id);
		expect(swimRows(runtime)).toHaveLength(8);
		expect(swimRows(runtime).some((row) => first.Fish.some((f) => f.$Id === row.OwnerId))).toBe(false);

		await runtime.dispatch(releaseFish, "Aquarium", second.$Id, second.Fish[0].$Id);
		expect(swimRows(runtime)).toHaveLength(7);
		expect(runtime.state.Aquarium.Schools[0].Fish).toHaveLength(3);
	});

	it("drops the per-fish wording from the tank bar once the tank is empty", async () => {
		const runtime = await tank();
		for (const school of [
			...runtime.state.Aquarium.Schools
		]) {
			await runtime.dispatch(releaseSchool, "Aquarium", school.$Id);
		}
		expect(factsOf(runtime).Bar).toBe("Depth 800 m · no fish");
		expect(runtime.processSelector(swimLine, () => runtime.state.Aquarium)).toBe("");
	});

	it("brings back the first species missing from the tank when a school is added", async () => {
		const runtime = await tank();
		await runtime.dispatch(releaseSchool, "Aquarium", runtime.state.Aquarium.Schools[1].$Id);
		await runtime.dispatch(addSchool, "Aquarium");
		expect(runtime.state.Aquarium.Schools.map((s) => s.Name)).toEqual([
			"Lanternfish",
			"Viperfish",
			"Hatchetfish"
		]);
	});

	it("counts a giant's swims in the tank bar", async () => {
		const runtime = await tank();
		for (const school of [
			...runtime.state.Aquarium.Schools
		]) {
			await runtime.dispatch(releaseSchool, "Aquarium", school.$Id);
		}
		await runtime.dispatch(addGiant, "Aquarium");
		const giant = runtime.state.Aquarium.Giants[0].$Id;
		await swim(runtime, giant);
		expect(runtime.processSelector(swimLine, () => runtime.state.Aquarium)).toBe("1 swim · click a fish to release it");
	});

	it("keeps to its limits on schools, fish and giants", async () => {
		const runtime = await tank();
		for (let i = 0; i < MAX_SCHOOLS + 2; i++) await runtime.dispatch(addSchool, "Aquarium");
		expect(runtime.state.Aquarium.Schools).toHaveLength(MAX_SCHOOLS);
		expect(new Set(runtime.state.Aquarium.Schools.map((s) => s.Name)).size).toBe(MAX_SCHOOLS);
		const schoolId = runtime.state.Aquarium.Schools[0].$Id;
		for (let i = 0; i < MAX_FISH; i++) await runtime.dispatch(addFish, "Aquarium", schoolId);
		expect(runtime.state.Aquarium.Schools.reduce((n, s) => n + s.Fish.length, 0)).toBe(MAX_FISH);
		expect(factsOf(runtime).CanAddFish).toBe(false);
		for (let i = 0; i < MAX_GIANTS + 1; i++) await runtime.dispatch(addGiant, "Aquarium");
		expect(runtime.state.Aquarium.Giants).toHaveLength(MAX_GIANTS);
		expect(factsOf(runtime).Line).toBe(`${MAX_FISH + MAX_GIANTS} fish · ${MAX_SCHOOLS} schools`);
	});

	it("records where and when each swim set off, for a view to pick it up part-way", async () => {
		const runtime = await tank();
		const fish = runtime.state.Aquarium.Schools[0].Fish[0];
		expect(swimInProgress(fish, CLOCK)).toBeNull();
		const start = {
			X: fish.X,
			Y: fish.Y
		};
		await swim(runtime, fish.$Id);
		const moved = runtime.state.Aquarium.Schools[0].Fish[0];
		expect(moved).toMatchObject({
			FromX: start.X,
			FromY: start.Y,
			SwamAt: CLOCK
		});
		expect(swimInProgress(moved, CLOCK + 1000)).toEqual({
			FromX: start.X,
			FromY: start.Y,
			Elapsed: 1000
		});
		expect(swimInProgress(moved, CLOCK + SWIM_MS)).toBeNull();
	});

	it("comes back from a restore with every fish on its swim timer, and says so", async () => {
		const before = await tank();
		await before.dispatch(addGiant, "Aquarium");
		const fishIds = swimRows(before)
			.map((row) => row.OwnerId)
			.sort();

		const runtime = await reload(before);

		expect(
			swimRows(runtime)
				.map((row) => row.OwnerId)
				.sort()
		).toEqual(fishIds);
		expect(runtime.state.Aquarium.Restore).toEqual({
			Fish: 12,
			Schools: 3,
			Giants: 1
		});
		const line = "The aquarium's 12 fish in 3 schools and 1 giant, each with its swim timer";
		expect(restoreBanner(runtime.state)?.Back).toContain(line);

		await runtime.dispatch(releaseSchool, "Aquarium", runtime.state.Aquarium.Schools[0].$Id);
		expect(runtime.state.Aquarium.Schools).toHaveLength(2);
		expect(restoreBanner(runtime.state)?.Back).toContain(line);
	});

	it("ticks the tour's reload step with only fish swimming, and names them in its hint", async () => {
		const before = await tank();
		await before.dispatch(cameBack, "Tour");
		expect(before.processSelector(currentStep, () => before.state.Tour)).toBe(4);
		expect(before.processSelector(tourHint, () => before.state)).toEqual({
			Title: "Reload the page.",
			Text: "The session is saved in this browser. The aquarium's 12 fish carry on swimming from where they were."
		});

		const runtime = await reload(before);
		expect(runtime.state.Tour.Reloaded).toBe(true);
		expect(runtime.processSelector(currentStep, () => runtime.state.Tour)).toBe(5);
	});

	it("leaves the parts of a restore line that the tank had none of", () => {
		const back = (fish: number, schools: number, giants: number) =>
			aquariumRestoreLines({
				Fish: fish,
				Schools: schools,
				Giants: giants
			})?.Back;
		expect(back(0, 0, 1)).toEqual([
			"The aquarium's 1 giant, with its swim timer"
		]);
		expect(back(0, 1, 0)).toEqual([
			"The aquarium's 1 empty school"
		]);
		expect(back(4, 1, 0)).toEqual([
			"The aquarium's 4 fish in 1 school, each with its swim timer"
		]);
		expect(back(0, 0, 0)).toBeUndefined();
	});
});
