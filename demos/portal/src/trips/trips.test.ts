import type { IActionGenerator, IAskId, IRuntime } from "treflex";
import type { ICheckProvider } from "../backend/backend";
import type { IWait } from "../backend/fakeBackend";
import type { IPortal } from "../portal/Portal";
import type { ITour } from "../tour/Tour";
import type { IDestinationKey, ILegKind } from "./destinations";
import type { ILeg } from "./Leg";
import type { ITrip } from "./Trip";
import { createTestRuntime, guids, implementation, named, pendingAsks, settled } from "treflex";
import { createSnapshot, restoreTestRuntime } from "treflex/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { checkProvider, now } from "../backend/backend";
import { fakeBackend } from "../backend/fakeBackend";
import { followToast, getDefaultState, openApp, ROOT_ID, toast } from "../portal/Portal";
import { restoreBanner } from "../portal/restoreBanner";
import { registerReceivers, repairRestore } from "../portal/session";
import { tourHint } from "../portal/tourHints";
import { currentStep } from "../tour/Tour";
import { legStatus, search } from "./Leg";
import { openTrip, removeTrip, startTrip, summary } from "./Planner";
import {
	awayMark,
	chooseFlight,
	flightOptions,
	HOLD_SECONDS,
	headline,
	holdAgain,
	holdLeft,
	legOf,
	legViews,
	pickFare,
	question,
	searchAgain,
	statusLine,
	TripReceiver,
	tip,
	tripFacts
} from "./Trip";

interface IPending {
	effect: ICheckProvider;
	signal: AbortSignal | undefined;
	resolve: () => void;
	reject: (error: unknown) => void;
}

function gate(...through: ILegKind[]) {
	const open = new Set(through);
	const pending: IPending[] = [];
	const calls: ICheckProvider[] = [];
	const wait: IWait = (_ms, signal, effect) => {
		calls.push(effect);
		if (open.has(effect.Kind)) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			pending.push({
				effect,
				signal,
				resolve,
				reject
			});
			signal?.addEventListener("abort", () => reject(signal.reason), {
				once: true
			});
		});
	};
	const release = async (kind: ILegKind, count = 1): Promise<void> => {
		for (let i = 0; i < count; i++) {
			const index = pending.findIndex((p) => p.effect.Kind === kind);
			if (index === -1) break;
			pending.splice(index, 1)[0].resolve();
			await settled();
		}
	};
	const allow = async (kind: ILegKind): Promise<void> => {
		open.add(kind);
		for (const p of pending.filter((x) => x.effect.Kind === kind)) p.resolve();
		await settled();
	};
	const close = (kind: ILegKind): void => {
		open.delete(kind);
	};
	const fail = async (...kinds: ILegKind[]): Promise<void> => {
		for (const kind of kinds) {
			const index = pending.findIndex((p) => p.effect.Kind === kind);
			if (index !== -1) pending.splice(index, 1)[0].reject(new Error("the provider's line dropped"));
		}
		await settled();
	};
	return {
		wait,
		pending,
		calls,
		release,
		allow,
		close,
		fail
	};
}

const runtimes: IRuntime<IPortal>[] = [];

const START = 1_700_000_000_000;
let clockAt = START;
const testClock = implementation(now, () => clockAt);

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	clockAt = START;
});

const RESUMING = {
	build: "test",
	resume: true
} as const;

function portal(wait: IWait, { backend = fakeBackend(wait), failing = false, resuming = false } = {}) {
	const runtime = createTestRuntime<IPortal>(
		getDefaultState(),
		{
			generateGuid: guids("a")
		},
		{
			allowFailures: failing
				? [
						search
					]
				: [],
			...(resuming ? RESUMING : {})
		}
	);
	registerReceivers(runtime);
	runtime.registerImplementation(backend);
	runtime.registerImplementation(testClock);
	runtimes.push(runtime);
	return runtime;
}

let restores = 0;

async function restored(json: string, wait: IWait, options: object = {}) {
	const { runtime, result } = await restoreTestRuntime<IPortal>(json, {
		rootId: ROOT_ID,
		effectStubs: {
			generateGuid: guids(`r${++restores}`)
		},
		options,
		setup: (r) => {
			registerReceivers(r);
			r.registerImplementation(fakeBackend(wait));
			r.registerImplementation(testClock);
		},
		repair: repairRestore
	});
	runtimes.push(runtime);
	await settled();
	return {
		runtime,
		result
	};
}

const trip = (runtime: IRuntime<IPortal>, index = 0): ITrip => runtime.state.Trips.Trips[index];
const leg = (runtime: IRuntime<IPortal>, kind: ILegKind, index = 0): ILeg => legOf(trip(runtime, index), kind)!;
const statusOf = (runtime: IRuntime<IPortal>, kind: ILegKind, index = 0) =>
	runtime.processSelector(legStatus, () => leg(runtime, kind, index));
const questionOf = (runtime: IRuntime<IPortal>, index = 0) => runtime.processSelector(question, () => trip(runtime, index));
const factsOf = (runtime: IRuntime<IPortal>, index = 0) => runtime.processSelector(tripFacts, () => trip(runtime, index));
const hintOf = (runtime: IRuntime<IPortal>) => runtime.processSelector(tourHint, () => runtime.state);
const tipOf = (runtime: IRuntime<IPortal>, index = 0) => runtime.processSelector(tip, () => trip(runtime, index));
const awayOf = (runtime: IRuntime<IPortal>, index = 0) =>
	runtime.processSelector(
		function* (draft: ITrip) {
			return (yield* awayMark(draft)).Away;
		},
		() => trip(runtime, index)
	);
const bannerOf = (runtime: IRuntime<IPortal>) => restoreBanner(runtime.state);

async function plan(runtime: IRuntime<IPortal>, destination: IDestinationKey = "lisbon"): Promise<void> {
	await runtime.dispatch(startTrip, "Trips", destination);
	await settled();
}

async function answer(runtime: IRuntime<IPortal>, index = 0): Promise<string> {
	const entry = questionOf(runtime, index)!;
	const fare = trip(runtime, index).Legs[0].Fares[1];
	await runtime.dispatch(pickFare, entry.OwnerId, entry.Id as IAskId<string>, fare.Id);
	await settled();
	return fare.Id;
}

function tick(runtime: IRuntime<IPortal>, key: "Trip/Clock" | "Trip/Hold", index = 0) {
	const tripId = trip(runtime, index).$Id;
	return runtime.dispatch(
		TripReceiver.handle,
		tripId,
		{
			Type: key
		},
		{
			publisher: {
				Id: tripId
			}
		}
	);
}

describe("a trip", () => {
	it("reaches the flight question while the hotel and activity searches keep running", async () => {
		const backend = gate("flights");
		const runtime = portal(backend.wait);
		await plan(runtime);

		const entry = questionOf(runtime);
		expect(entry).toBeDefined();
		expect(leg(runtime, "flights").Done).toBe(true);
		expect(leg(runtime, "flights").Fares).toHaveLength(2);
		expect(statusOf(runtime, "hotel")).toBe("searching");
		expect(statusOf(runtime, "activities")).toBe("searching");

		await backend.release("hotel", 4);
		await backend.release("activities", 2);
		expect(leg(runtime, "hotel").Checked).toBeGreaterThan(0);
		expect(leg(runtime, "activities").Checked).toBeGreaterThan(0);
		expect(questionOf(runtime)?.Id).toBe(entry?.Id);
		expect(trip(runtime).Thread.some((line) => line.Asked)).toBe(true);
	});

	it("places a fare hold when a fare is chosen, and each tick measures it against its deadline", async () => {
		const runtime = portal(gate("flights").wait);
		await plan(runtime);
		const fareId = await answer(runtime);
		const tripId = trip(runtime).$Id;

		expect(trip(runtime).Choice?.Id).toBe(fareId);
		expect(trip(runtime).HoldUntil).toBe(START + HOLD_SECONDS * 1000);
		expect(holdLeft(trip(runtime))).toBe(HOLD_SECONDS);
		expect(questionOf(runtime)).toBeUndefined();
		expect(runtime.timers(tripId).find((row) => row.Key === "Trip/Hold")?.IntervalMs).toBe(1000);

		await tick(runtime, "Trip/Hold");
		await tick(runtime, "Trip/Hold");
		expect(holdLeft(trip(runtime))).toBe(HOLD_SECONDS);

		clockAt += 2000;
		await tick(runtime, "Trip/Hold");
		expect(holdLeft(trip(runtime))).toBe(HOLD_SECONDS - 2);
		expect(factsOf(runtime).HoldLeft).toBe(HOLD_SECONDS - 2);
	});

	it("lets the hold lapse at its deadline, and holds the same fare again on request", async () => {
		const runtime = portal(gate("flights").wait);
		await plan(runtime);
		const fareId = await answer(runtime);
		const tripId = trip(runtime).$Id;
		clockAt += HOLD_SECONDS * 1000;
		await tick(runtime, "Trip/Hold");
		expect(holdLeft(trip(runtime))).toBe(0);
		expect(factsOf(runtime).Lapsed).toBe(true);
		expect(runtime.timers(tripId).some((row) => row.Key === "Trip/Hold")).toBe(false);
		expect(trip(runtime).Thread.at(-1)?.Text).toContain("ran out");

		await runtime.dispatch(holdAgain, tripId);
		expect(holdLeft(trip(runtime))).toBe(HOLD_SECONDS);
		expect(trip(runtime).Choice?.Id).toBe(fareId);
		expect(factsOf(runtime).Lapsed).toBe(false);
		expect(runtime.timers(tripId).some((row) => row.Key === "Trip/Hold")).toBe(true);
		expect(trip(runtime).Thread.at(-1)?.Text).toContain("again");
	});

	it("cancels its searches, its question and its timers when it is removed", async () => {
		const backend = gate("flights");
		const runtime = portal(backend.wait);
		await plan(runtime);
		const tripId = trip(runtime).$Id;
		const waiting = backend.pending.map((p) => p.signal!);
		expect(waiting.length).toBeGreaterThanOrEqual(2);
		expect(questionOf(runtime)).toBeDefined();

		await runtime.dispatch(removeTrip, "Trips", tripId);
		await settled();

		expect(waiting.every((s) => s.aborted)).toBe(true);
		expect(runtime.state.Trips.Trips).toHaveLength(0);
		expect(runtime.timers(tripId)).toHaveLength(0);
		expect(
			runtime.processSelector(
				function* (draft: IPortal) {
					return yield* pendingAsks(draft);
				},
				() => runtime.state
			)
		).toHaveLength(0);
	});

	it("runs its clock only while something on it is running", async () => {
		const backend = gate("flights");
		const runtime = portal(backend.wait);
		await plan(runtime);
		await tick(runtime, "Trip/Clock");
		expect(trip(runtime).Elapsed).toBe(1);
		expect(runtime.processSelector(headline, () => trip(runtime))).toBe("Waiting on you · 0:01");

		const after = gate();
		const { runtime: back } = await restored(createSnapshot(runtime), after.wait);
		expect(back.processSelector(headline, () => trip(back))).toBe("Waiting on you · 0:01");
		await tick(back, "Trip/Clock");
		expect(trip(back).Elapsed).toBe(2);

		await after.allow("hotel");
		await after.allow("activities");
		await tick(back, "Trip/Clock");
		expect(trip(back).Elapsed).toBe(2);
		expect(back.timers(trip(back).$Id).some((row) => row.Key === "Trip/Clock")).toBe(false);

		void back.dispatch(chooseFlight, trip(back).$Id);
		await settled();
		expect(back.timers(trip(back).$Id).some((row) => row.Key === "Trip/Clock")).toBe(true);
		await tick(back, "Trip/Clock");
		expect(trip(back).Elapsed).toBe(3);
	});
});

describe("a restore mid-run", () => {
	it("brings the trip back with its searches carrying on from the provider each had reached, the hold still on its timer, and the open question gone", async () => {
		const backend = gate("flights");
		const before = portal(backend.wait);
		await plan(before, "lisbon");
		await answer(before, 0);
		await plan(before, "kyoto");
		await backend.release("hotel", 6);
		expect(questionOf(before, 1)).toBeDefined();

		const hotelBefore = {
			...leg(before, "hotel")
		};
		const holdBefore = holdLeft(trip(before, 0));
		expect(hotelBefore.Checked).toBeGreaterThan(0);
		expect(hotelBefore.Picks.length).toBeGreaterThan(0);

		const after = gate();
		const { runtime, result } = await restored(createSnapshot(before), after.wait);

		expect(result.dropped.map((d) => d.entityId)).toContain(hotelBefore.$Id);
		expect(statusOf(runtime, "hotel")).toBe("searching");
		expect(statusOf(runtime, "activities")).toBe("searching");
		expect(leg(runtime, "hotel").Checked).toBe(hotelBefore.Checked);
		expect(leg(runtime, "hotel").Picks).toEqual(hotelBefore.Picks);
		expect(after.calls.find((call) => call.Destination === "lisbon" && call.Kind === "hotel")?.Index).toBe(hotelBefore.Checked);

		expect(holdLeft(trip(runtime, 0))).toBe(holdBefore);
		expect(runtime.timers(trip(runtime, 0).$Id).map((row) => row.Key)).toContain("Trip/Hold");

		expect(questionOf(runtime, 1)).toBeUndefined();
		expect(factsOf(runtime, 1).NeedsChoice).toBe(true);

		const note = runtime.state.Trips.Restore!;
		expect(note.Trips.find((t) => t.TripId === trip(runtime, 0).$Id)?.CarriedOn).toEqual([
			"hotel",
			"activities"
		]);
		expect(note.Trips.find((t) => t.TripId === trip(runtime, 1).$Id)?.Unanswered).toBe(true);
		expect(trip(runtime, 0).Thread.filter((line) => line.Divider)).toHaveLength(1);
		expect(trip(runtime, 0).Thread.at(-1)?.Text).toContain("The hotel and activity searches carry on where they left off.");
	});

	it("names a carried-on search even when it finishes as soon as it starts again", async () => {
		const backend = gate("flights", "activities");
		const before = portal(backend.wait);
		await plan(before);
		const total = leg(before, "hotel").Total;
		for (let answered = 0; answered < 2 * total && leg(before, "hotel").Checked < total - 1; answered++) await backend.release("hotel");
		expect(leg(before, "hotel").Checked).toBe(total - 1);

		const { runtime } = await restored(createSnapshot(before), gate("flights", "hotel", "activities").wait);
		expect(leg(runtime, "hotel").Done).toBe(true);
		expect(runtime.state.Trips.Restore?.Trips[0].CarriedOn).toEqual([
			"hotel"
		]);
		const thread = trip(runtime).Thread.map((line) => line.Text);
		const reloaded = thread.findIndex((text) => text.startsWith("Page reloaded"));
		expect(thread.slice(reloaded + 1)).toEqual([
			"Back. The hotel search carries on where it left off. The flight question closed, so choose a flight when you're ready.",
			expect.stringMatching(/^Checked 36 hotels\./)
		]);
	});

	it("doesn't start again a search that had failed before the reload", async () => {
		const backend = gate("flights");
		const before = portal(backend.wait, {
			failing: true
		});
		await plan(before);
		await backend.fail("hotel");
		expect(statusOf(before, "hotel")).toBe("failed");

		const after = gate();
		const { runtime } = await restored(createSnapshot(before), after.wait);
		expect(statusOf(runtime, "hotel")).toBe("failed");
		expect(statusOf(runtime, "activities")).toBe("searching");
		expect(after.calls.map((call) => call.Kind)).toEqual([
			"activities"
		]);
		expect(runtime.state.Trips.Restore?.Trips[0].CarriedOn).toEqual([
			"activities"
		]);
	});

	it("expires a hold that ran out while the page was closed at the restore's first tick, and the banner says it had run out", async () => {
		const before = portal(gate("flights").wait);
		await plan(before);
		await answer(before);
		clockAt += 60_000;
		await tick(before, "Trip/Hold");
		expect(holdLeft(trip(before))).toBe(HOLD_SECONDS - 60);

		const json = createSnapshot(before);
		clockAt += HOLD_SECONDS * 1000;
		const { runtime } = await restored(json, gate().wait);
		expect(bannerOf(runtime)!.Back).toContain("The fare hold, which had run out by the reload");
		expect(trip(runtime).Thread.at(-1)?.Text).not.toMatch(/hold/);
		expect(runtime.timers(trip(runtime).$Id).map((row) => row.Key)).toContain("Trip/Hold");

		await tick(runtime, "Trip/Hold");
		expect(holdLeft(trip(runtime))).toBe(0);
		expect(factsOf(runtime).Lapsed).toBe(true);
		expect(trip(runtime).Thread.at(-1)?.Text).toContain("ran out");
		expect(runtime.timers(trip(runtime).$Id).map((row) => row.Key)).not.toContain("Trip/Hold");
		expect(bannerOf(runtime)!.Back).toContain("The fare hold, which had run out by the reload");
	});

	it("brings back a hold after a short close with the time it has left, and the banner records that time", async () => {
		const before = portal(gate("flights").wait);
		await plan(before);
		await answer(before);

		const json = createSnapshot(before);
		clockAt += 90_000;
		const { runtime } = await restored(json, gate().wait);
		expect(bannerOf(runtime)!.Back).toContain("The fare hold, with 13:30 left at the reload");
		expect(trip(runtime).Thread.at(-1)?.Text).toContain("The hold had 13:30 left.");

		await tick(runtime, "Trip/Hold");
		expect(holdLeft(trip(runtime))).toBe(HOLD_SECONDS - 90);
		expect(factsOf(runtime).Holding).toBe(true);

		clockAt += 30_000;
		await tick(runtime, "Trip/Hold");
		expect(holdLeft(trip(runtime))).toBe(HOLD_SECONDS - 120);
		expect(bannerOf(runtime)!.Back).toContain("The fare hold, with 13:30 left at the reload");
	});

	it("keeps the banner to what came back at the restore, whatever happens after it", async () => {
		const backend = gate("flights");
		const before = portal(backend.wait);
		await plan(before, "lisbon");
		await backend.release("hotel", 4);
		const checked = leg(before, "hotel").Checked;
		expect(checked).toBeGreaterThan(1);

		const after = gate("flights", "hotel", "activities");
		const { runtime } = await restored(createSnapshot(before), after.wait);
		const banner = bannerOf(runtime)!;
		expect(banner.Back.join(" | ")).toContain(`${checked} hotels checked`);

		expect(leg(runtime, "hotel").Checked).toBe(leg(runtime, "hotel").Total);
		await plan(runtime, "kyoto");
		expect(bannerOf(runtime)?.Back).toEqual([
			"1 trip and everything the agent found",
			"Lisbon's hotel and activity searches, which carry on where they left off"
		]);
		await runtime.dispatch(openTrip, "Trips", trip(runtime, 0).$Id);
		await settled();

		expect(runtime.state.Trips.Restore?.Trips).toHaveLength(1);
		expect(bannerOf(runtime)).toEqual(banner);
	});

	it("drops a removed trip from the restore note, and the note with the last trip", async () => {
		const backend = gate("flights");
		const before = portal(backend.wait);
		await plan(before, "lisbon");
		backend.close("flights");
		await plan(before, "kyoto");
		await before.dispatch(openTrip, "Trips", trip(before, 0).$Id);
		await settled();

		const { runtime } = await restored(createSnapshot(before), gate().wait);
		expect(runtime.state.Trips.Restore?.Trips).toHaveLength(2);
		expect(bannerOf(runtime)?.Lost).toContain("Lisbon's open flight question");

		await runtime.dispatch(removeTrip, "Trips", trip(runtime, 0).$Id);
		await settled();
		expect(runtime.state.Trips.Restore?.Trips.map((t) => t.Name)).toEqual([
			"Kyoto"
		]);
		const banner = bannerOf(runtime)!;
		expect(banner.Back).toEqual([
			"1 trip and everything the agent found",
			"Kyoto's flight, hotel and activity searches, which carry on where they left off"
		]);
		expect(
			[
				...banner.Back,
				...banner.Lost
			].some((line) => line.includes("Lisbon"))
		).toBe(false);
		expect(banner.Lost).toEqual([
			"Nothing on what's still here"
		]);

		await runtime.dispatch(removeTrip, "Trips", trip(runtime, 0).$Id);
		await settled();
		expect(runtime.state.Trips.Restore).toBeNull();
	});

	it("doesn't say nothing was lost once the only trip that lost something is removed", async () => {
		const backend = gate("flights", "hotel", "activities");
		const before = portal(backend.wait);
		await plan(before, "lisbon");
		await answer(before, 0);
		expect(trip(before, 0).Finished).toBe(true);
		await plan(before, "kyoto");
		expect(questionOf(before, 1)).toBeDefined();

		const { runtime } = await restored(createSnapshot(before), gate().wait);
		await runtime.dispatch(removeTrip, "Trips", trip(runtime, 1).$Id);
		await settled();
		const lost = bannerOf(runtime)!.Lost;
		expect(lost.some((line) => line.includes("Kyoto"))).toBe(false);
		expect(lost).toEqual([
			"Nothing on what's still here"
		]);
	});

	it("tells the banner what the restore did, not what to do or what is still so", async () => {
		const before = portal(gate("flights").wait);
		await plan(before);
		const { runtime } = await restored(createSnapshot(before), gate("flights", "hotel", "activities").wait);
		expect(trip(runtime).Legs.every((l) => l.Done)).toBe(true);
		const banner = bannerOf(runtime)!;
		expect(banner.Back).toContain("Lisbon's hotel and activity searches, which carry on where they left off");
		expect(banner.Lost).toEqual([
			"Lisbon's open flight question"
		]);
		expect(
			[
				...banner.Back,
				...banner.Lost
			].join(" | ")
		).not.toMatch(/choose a flight|interrupted|finished/i);
	});

	it("reports a question only at the reload that closed it", async () => {
		const before = portal(gate("flights", "hotel", "activities").wait);
		await plan(before);
		expect(questionOf(before)).toBeDefined();

		const { runtime: first } = await restored(createSnapshot(before), gate().wait);
		expect(first.state.Trips.Restore?.Trips[0].Unanswered).toBe(true);
		expect(trip(first).Thread.at(-1)?.Text).toContain("flight question closed");

		const { runtime: second } = await restored(createSnapshot(first), gate().wait);
		expect(second.state.Trips.Restore?.Trips[0]).toMatchObject({
			Unanswered: false,
			CarriedOn: []
		});
		expect(trip(second).Thread.filter((line) => line.Divider)).toHaveLength(1);
		expect(bannerOf(second)?.Lost).toEqual([
			"Nothing: no question or message was cut off"
		]);
	});

	it("asks the open question again when the restore resumes it, and says so only in the banner", async () => {
		const before = portal(gate("flights").wait, {
			resuming: true
		});
		await plan(before);
		const asked = questionOf(before)!;

		const { runtime, result } = await restored(createSnapshot(before), gate().wait, RESUMING);
		expect(
			result.resumed.map((entry) => [
				entry.name,
				entry.entityId
			])
		).toEqual([
			[
				"Trips/ChooseFlight",
				trip(runtime).$Id
			]
		]);
		expect(questionOf(runtime)?.Request).toEqual(asked.Request);
		expect(factsOf(runtime).NeedsChoice).toBe(false);
		expect(runtime.state.Trips.Restore?.Trips[0]).toMatchObject({
			AskedAgain: true,
			Unanswered: false
		});
		expect(bannerOf(runtime)).toEqual({
			Back: [
				"The trip and what the agent had written",
				"37 fares so far",
				"Lisbon's hotel and activity searches, which carry on where they left off",
				"Lisbon's open flight question, which is asked again"
			],
			Lost: [
				"Nothing: no question or message was cut off"
			]
		});
		expect(trip(runtime).Thread.at(-1)?.Text).toBe("Back. The hotel and activity searches carry on where they left off.");

		await answer(runtime);
		expect(trip(runtime).Choice).not.toBeNull();
	});

	it("closes the open question when the save is another build's", async () => {
		const before = portal(gate("flights").wait, {
			resuming: true
		});
		await plan(before);

		const { runtime, result } = await restored(createSnapshot(before), gate().wait, {
			...RESUMING,
			build: "next"
		});
		expect(result.resumed).toEqual([]);
		expect(questionOf(runtime)).toBeUndefined();
		expect(factsOf(runtime).NeedsChoice).toBe(true);
		expect(bannerOf(runtime)?.Lost).toEqual([
			"Lisbon's open flight question"
		]);
		expect(trip(runtime).Thread.at(-1)?.Text).toContain("The flight question closed");
	});

	it("names every trip's searches and questions on whichever trip is open", async () => {
		const backend = gate("flights", "hotel", "activities");
		const before = portal(backend.wait);
		await plan(before, "lisbon");
		await answer(before, 0);
		expect(trip(before, 0).Finished).toBe(true);
		backend.close("hotel");
		await plan(before, "kyoto");
		expect(statusOf(before, "hotel", 1)).toBe("searching");
		await before.dispatch(openTrip, "Trips", trip(before, 0).$Id);
		await settled();

		const { runtime } = await restored(createSnapshot(before), gate().wait);
		const banner = bannerOf(runtime)!;
		expect(banner.Back).toContain("Kyoto's hotel search, which carries on where it left off");
		expect(banner.Lost).toEqual([
			"Kyoto's open flight question"
		]);
		expect(banner.Back).toContain("Your trip to Kyoto, with what it had found");

		await runtime.dispatch(openTrip, "Trips", null);
		await settled();
		expect(bannerOf(runtime)?.Back).toContain("Kyoto's hotel search, which carries on where it left off");
		expect(bannerOf(runtime)?.Lost).toEqual([
			"Kyoto's open flight question"
		]);
	});

	it("carries a search on from the provider it had reached and finishes it", async () => {
		const backend = gate("flights");
		const before = portal(backend.wait);
		await plan(before);
		await backend.release("hotel", 5);
		const checked = leg(before, "hotel").Checked;
		expect(checked).toBeGreaterThan(0);

		const after = gate("flights", "hotel", "activities");
		const { runtime } = await restored(createSnapshot(before), after.wait);

		const hotelCalls = after.calls.filter((call) => call.Kind === "hotel");
		expect(hotelCalls[0].Index).toBe(checked);
		const hotel = leg(runtime, "hotel");
		expect(hotel.Done).toBe(true);
		expect(hotel.Checked).toBe(hotel.Total);
		expect(statusOf(runtime, "hotel")).toBe("done");
		const reloaded = trip(runtime).Thread.findIndex((line) => line.Divider);
		expect(
			trip(runtime)
				.Thread.slice(reloaded)
				.some((line) => line.Text.startsWith(`Checked ${hotel.Total} hotels`))
		).toBe(true);
	});
});

function* cameBack(draft: ITour): IActionGenerator {
	draft.CameBack = true;
}
named(cameBack, "Trips/CameBack");

describe("the tour", () => {
	const step = (runtime: IRuntime<IPortal>) => runtime.processSelector(currentStep, () => runtime.state.Tour);

	it("ticks each step from what the app does", async () => {
		const runtime = portal(gate("flights").wait);
		expect(step(runtime)).toBe(1);

		await plan(runtime);
		expect(runtime.state.Tour.Started).toBe(true);
		expect(step(runtime)).toBe(2);

		await answer(runtime);
		expect(runtime.state.Tour.Answered).toBe(true);
		expect(step(runtime)).toBe(3);

		const lisbon = trip(runtime).$Id;
		await runtime.dispatch(openTrip, "Trips", null);
		await settled();
		expect(hintOf(runtime)?.Title).toBe("You've left the trip.");
		expect(runtime.state.Tour.CameBack).toBe(false);
		await runtime.dispatch(openTrip, "Trips", lisbon);
		await settled();
		expect(runtime.state.Tour.CameBack).toBe(true);
		expect(step(runtime)).toBe(4);

		await plan(runtime, "kyoto");
		expect(runtime.state.Tour.TwoAtOnce).toBe(true);

		const { runtime: back } = await restored(createSnapshot(runtime), gate().wait);
		expect(back.state.Tour.Reloaded).toBe(true);
		expect(step(back)).toBe(6);
	});

	it("doesn't tick coming back to a trip that had nothing running when it was left", async () => {
		const runtime = portal(gate("flights", "hotel", "activities").wait);
		await plan(runtime);
		await answer(runtime);
		expect(trip(runtime).Finished).toBe(true);
		const id = trip(runtime).$Id;
		await runtime.dispatch(openTrip, "Trips", null);
		await runtime.dispatch(openTrip, "Trips", id);
		await settled();
		expect(runtime.state.Tour.CameBack).toBe(false);
	});

	it("forgets leaving a trip across a reload", async () => {
		const backend = gate("flights");
		const runtime = portal(backend.wait);
		await plan(runtime);
		await answer(runtime);
		const id = trip(runtime).$Id;
		await runtime.dispatch(openTrip, "Trips", null);
		await settled();
		expect(awayOf(runtime)).toBe(true);
		expect(hintOf(runtime)?.Title).toBe("You've left the trip.");

		const { runtime: back } = await restored(createSnapshot(runtime), gate().wait);
		expect(awayOf(back)).toBe(false);
		await back.dispatch(openTrip, "Trips", id);
		await settled();
		expect(back.state.Tour.CameBack).toBe(false);
	});

	it("doesn't tick the reload before the visitor reaches its step", async () => {
		const early = portal(gate().wait);
		await plan(early);
		expect(step(early)).toBe(2);
		const { runtime } = await restored(createSnapshot(early), gate().wait);
		expect(runtime.state.Tour.Reloaded).toBe(false);
		expect(step(runtime)).toBe(2);
	});

	it("ticks the reload at its step whatever was running", async () => {
		const done = portal(gate("flights", "hotel", "activities").wait);
		await plan(done);
		await answer(done);
		expect(trip(done).Finished).toBe(true);
		await done.dispatch(cameBack, "Tour");
		expect(step(done)).toBe(4);
		const { runtime: idle } = await restored(createSnapshot(done), gate().wait);
		expect(idle.state.Tour.Reloaded).toBe(true);
	});

	it("asks for a reload once the trip's searches finish, naming nothing that runs", async () => {
		const backend = gate("flights");
		const runtime = portal(backend.wait);
		await plan(runtime);
		await answer(runtime);
		const id = trip(runtime).$Id;
		await runtime.dispatch(openTrip, "Trips", null);
		await runtime.dispatch(openTrip, "Trips", id);
		await settled();
		expect(step(runtime)).toBe(4);
		expect(hintOf(runtime)?.Text).toBe(
			"The session is saved in this browser. Lisbon's hotel and activity searches carry on where they left off."
		);

		await backend.allow("hotel");
		await backend.allow("activities");
		expect(hintOf(runtime)).toEqual({
			Title: "Reload the page.",
			Text: "The session is saved in this browser. It comes back as you left it."
		});
	});

	it("goes back to the first hint when the only trip is removed", async () => {
		const runtime = portal(gate("flights").wait);
		await plan(runtime);
		expect(step(runtime)).toBe(2);
		await runtime.dispatch(removeTrip, "Trips", trip(runtime).$Id);
		await settled();
		expect(hintOf(runtime)?.Title).toBe("Pick a destination.");
	});
});

describe("the tour hint, the trip tip and the question's footer", () => {
	it("doesn't send the tour through restarting a failed flight search, and the tip names only the search still running", async () => {
		const backend = gate();
		const runtime = portal(backend.wait, {
			failing: true
		});
		await plan(runtime);
		await backend.fail("flights", "activities");
		expect(statusOf(runtime, "flights")).toBe("failed");
		expect(statusOf(runtime, "hotel")).toBe("searching");

		expect(hintOf(runtime)?.Title).toBe("Pick a destination.");
		const tip = tipOf(runtime).Text;
		expect(tip).toContain("hotel search keeps going");
		expect(tip).not.toMatch(/flight|activit/);
	});

	it("names only the searches that run beside the question", async () => {
		const backend = gate("flights");
		const runtime = portal(backend.wait, {
			failing: true
		});
		await plan(runtime);
		await backend.fail("activities");
		expect(questionOf(runtime)).toBeDefined();
		expect(statusOf(runtime, "hotel")).toBe("searching");
		expect(statusOf(runtime, "activities")).toBe("failed");

		const footer = runtime.processSelector(flightOptions, () => trip(runtime))!.Meanwhile;
		for (const text of [
			hintOf(runtime)!.Text,
			tipOf(runtime).Text,
			footer
		]) {
			expect(text).toContain("hotel search keeps going");
			expect(text).not.toMatch(/activit|other searches/);
		}
	});

	it("asks for a flight after a reload during the question, while the other searches keep going", async () => {
		const before = portal(gate("flights").wait);
		await plan(before);
		expect(hintOf(before)?.Text).toContain("hotel and activity searches keep going");

		const { runtime } = await restored(createSnapshot(before), gate().wait);
		expect(hintOf(runtime)?.Text).toMatch(/choose a flight/i);
		expect(hintOf(runtime)?.Text).not.toMatch(/keep/);
		expect(tipOf(runtime).Text).toContain("hotel and activity searches keep going");
	});

	it("sends the visitor to the asking trip from the start screen and from another trip", async () => {
		const backend = gate("flights");
		const runtime = portal(backend.wait);
		await plan(runtime, "lisbon");
		await runtime.dispatch(openTrip, "Trips", null);
		await settled();
		expect(hintOf(runtime)?.Text).toContain("Open Lisbon");

		backend.close("flights");
		await plan(runtime, "kyoto");
		expect(runtime.state.Trips.OpenTripId).toBe(trip(runtime, 1).$Id);
		expect(hintOf(runtime)?.Text).toContain("Open Lisbon");
	});

	it("says nothing keeps going once the trip is finished", async () => {
		const runtime = portal(gate("flights", "hotel", "activities").wait);
		await plan(runtime);
		await answer(runtime);
		expect(trip(runtime).Finished).toBe(true);
		expect(tipOf(runtime).Text).not.toMatch(/keep|carr/);
		expect(hintOf(runtime)?.Text).not.toMatch(/keep|carr/);
	});

	it("sends the visitor back to a trip they left once it finishes, without saying it keeps planning", async () => {
		const backend = gate("flights");
		const runtime = portal(backend.wait);
		await plan(runtime);
		await answer(runtime);
		await runtime.dispatch(openTrip, "Trips", null);
		await settled();
		expect(hintOf(runtime)?.Text).toContain("hotel and activity searches keep going on Lisbon");

		await backend.allow("hotel");
		await backend.allow("activities");
		expect(trip(runtime).Finished).toBe(true);
		const hint = hintOf(runtime)!;
		expect(hint.Text).toMatch(/go back to Lisbon/i);
		expect(hint.Text).not.toMatch(/keep|planning/);
	});

	it("doesn't promise a question when the flights found fewer than two good fares", async () => {
		const real = fakeBackend(gate("flights", "hotel", "activities").wait);
		const morningOnly = implementation(checkProvider, async (effect, action) => {
			const result = await real.fn(effect, action);
			return {
				...result,
				Fares: result.Fares.filter((fare) => fare.Slot === "Morning")
			};
		});
		const runtime = portal(gate().wait, {
			backend: morningOnly
		});
		await plan(runtime);
		expect(leg(runtime, "flights").Fares).toHaveLength(1);
		expect(hintOf(runtime)?.Text).not.toMatch(/asks you/);
	});

	it("doesn't say the hold came back from the reload when it was placed after it", async () => {
		const before = portal(gate("flights").wait);
		await plan(before);
		const { runtime } = await restored(createSnapshot(before), gate().wait);
		void runtime.dispatch(chooseFlight, trip(runtime).$Id);
		await settled();
		await answer(runtime);
		expect(holdLeft(trip(runtime))).toBe(HOLD_SECONDS);
		expect(statusOf(runtime, "hotel")).toBe("searching");
		expect(tipOf(runtime).Text).not.toMatch(/re-arm|countdown/);
	});

	it("doesn't say anything was kept when a failed search had found nothing", async () => {
		const backend = gate();
		const runtime = portal(backend.wait, {
			failing: true
		});
		await plan(runtime);
		await backend.fail("flights", "hotel", "activities");
		expect(trip(runtime).Legs.every((l) => l.Checked === 0)).toBe(true);
		const notes = Object.values(runtime.processSelector(legViews, () => trip(runtime))).map((view) => view.Note?.Text ?? "");
		expect(notes.join(" ")).toMatch(/failed/i);
		expect(notes.join(" ")).not.toMatch(/kept/);
		expect(tipOf(runtime).Text).not.toMatch(/kept/);
	});

	it("says what a failed search kept, and that searching again starts at the next provider", async () => {
		const backend = gate();
		const runtime = portal(backend.wait, {
			failing: true
		});
		await plan(runtime);
		await backend.release("hotel", 3);
		await backend.fail("flights", "activities");
		await backend.fail("hotel");
		const hotel = leg(runtime, "hotel");
		expect(hotel.Checked).toBe(3);
		const view = runtime.processSelector(legViews, () => trip(runtime)).hotel;
		expect(view.Badge.Label).toBe("Failed");
		expect(view.Note).toMatchObject({
			Action: "searchAgain",
			Label: "Search again"
		});
		expect(view.Note?.Text).toContain("kept");
		expect(tipOf(runtime).Text).toContain("starts at the next provider");
		expect(runtime.processSelector(statusLine, () => trip(runtime))).toBe("3 searches failed");

		const after = backend.calls.length;
		await runtime.dispatch(searchAgain, trip(runtime).$Id, hotel.$Id);
		expect(backend.calls[after]).toMatchObject({
			Kind: "hotel",
			Index: 3
		});
	});
});

describe("the finished-while-away toast", () => {
	const toastOf = (runtime: IRuntime<IPortal>) => runtime.processSelector(toast, () => runtime.state);

	it("says which search finished, and what it found, when the trip's view isn't on screen", async () => {
		const backend = gate("flights", "activities");
		const runtime = portal(backend.wait);
		await plan(runtime, "lisbon");
		await runtime.dispatch(openApp, ROOT_ID, "aquarium");
		await settled();
		expect(toastOf(runtime)).toBeNull();

		await backend.allow("hotel");
		const hotel = leg(runtime, "hotel");
		const shown = toastOf(runtime)!;
		expect(shown.Title).toBe("Lisbon: hotel search finished");
		expect(shown.Text).toBe(`Checked ${hotel.Total} hotels. ${hotel.Picks[0].Name} leads at A$${hotel.Picks[0].Price} a night.`);
		expect(shown.Link).toBe("Open the trip →");
		expect(runtime.timers(ROOT_ID).map((row) => row.Key)).toContain("Portal/ToastTimeout");

		await runtime.dispatch(followToast, ROOT_ID);
		await settled();
		expect(runtime.state.ActiveApp).toBe("trips");
		expect(runtime.state.Trips.OpenTripId).toBe(trip(runtime).$Id);
		expect(toastOf(runtime)).toBeNull();
	});

	it("goes once its trip comes on screen without the link, and doesn't come back after you leave", async () => {
		const backend = gate("flights", "activities");
		const runtime = portal(backend.wait);
		await plan(runtime, "lisbon");
		await runtime.dispatch(openApp, ROOT_ID, "aquarium");
		await settled();
		await backend.allow("hotel");
		expect(toastOf(runtime)).not.toBeNull();

		await runtime.dispatch(openApp, ROOT_ID, "trips");
		await settled();
		expect(toastOf(runtime)).toBeNull();
		await runtime.dispatch(openApp, ROOT_ID, "aquarium");
		await settled();
		expect(toastOf(runtime)).toBeNull();
	});

	it("stays quiet while the trip is on screen, and shows for a trip that isn't", async () => {
		const backend = gate("flights", "activities");
		const runtime = portal(backend.wait);
		await plan(runtime, "lisbon");
		await backend.allow("hotel");
		expect(leg(runtime, "hotel").Done).toBe(true);
		expect(toastOf(runtime)).toBeNull();

		backend.close("hotel");
		await plan(runtime, "kyoto");
		await runtime.dispatch(openTrip, "Trips", trip(runtime, 0).$Id);
		await settled();
		await backend.allow("hotel");
		expect(toastOf(runtime)?.Title).toBe("Kyoto: hotel search finished");

		await runtime.dispatch(openTrip, "Trips", trip(runtime, 1).$Id);
		await settled();
		expect(toastOf(runtime)).toBeNull();
		await runtime.dispatch(openTrip, "Trips", trip(runtime, 0).$Id);
		await settled();
		expect(toastOf(runtime)).toBeNull();
	});
});

describe("the planner's sidebar", () => {
	const lineOf = (runtime: IRuntime<IPortal>) => runtime.processSelector(summary, () => runtime.state.Trips).Line;

	it("counts a trip whose searches have all failed apart from the ones planning", async () => {
		const backend = gate();
		const runtime = portal(backend.wait, {
			failing: true
		});
		await plan(runtime);
		await backend.fail("flights", "hotel", "activities");
		expect(lineOf(runtime)).toBe("1 trip stopped");

		await plan(runtime, "kyoto");
		expect(lineOf(runtime)).toBe("1 trip planning · 1 stopped");
	});

	it("counts a reloaded trip as planning, since its searches carry on", async () => {
		const before = portal(gate().wait);
		await plan(before);
		const { runtime } = await restored(createSnapshot(before), gate().wait);
		expect(lineOf(runtime)).toBe("1 trip planning");
	});

	it("numbers a second trip to the same destination, and keeps its number", async () => {
		const runtime = portal(gate("flights").wait);
		await plan(runtime, "lisbon");
		await plan(runtime, "lisbon");
		expect(trip(runtime, 1).Name).toBe("Lisbon 2");
		expect(trip(runtime, 1).Thread[0].Text).toContain("Lisbon 2");

		await runtime.dispatch(openTrip, "Trips", null);
		await settled();
		const { runtime: back } = await restored(createSnapshot(runtime), gate().wait);
		await back.dispatch(openTrip, "Trips", trip(back, 0).$Id);
		await settled();
		const banner = bannerOf(back)!;
		expect(banner.Back.join(" ")).toContain("Lisbon 2");
		expect(banner.Lost.join(" ")).toContain("Lisbon 2's");

		await back.dispatch(removeTrip, "Trips", trip(back, 0).$Id);
		await settled();
		expect(trip(back, 0).Name).toBe("Lisbon 2");
		await plan(back, "lisbon");
		expect(back.state.Trips.Trips.map((t) => t.Name)).toEqual([
			"Lisbon 2",
			"Lisbon"
		]);
	});
});
