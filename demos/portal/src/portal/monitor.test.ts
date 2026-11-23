import type { IRuntime } from "treflex";
import type { ICheckProvider } from "../backend/backend";
import type { IPortal } from "./Portal";
import { createRuntime, createTestRuntime, guids, settled } from "treflex";
import { afterEach, expect, it } from "vitest";
import { providerAnswer } from "../backend/fakeBackend";
import { search } from "../trips/Leg";
import { startTrip } from "../trips/Planner";
import { createMonitor } from "./monitor";
import { getDefaultState } from "./Portal";
import { RECEIVER_IDS, registerReceivers } from "./session";

const runtimes: IRuntime<IPortal>[] = [];

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

it("names each line by the entity it ran on, and shows a provider failure and the question", async () => {
	const runtime = createTestRuntime<IPortal>(
		getDefaultState(),
		{
			generateGuid: guids("m"),
			"Backend/CheckProvider": (effect: ICheckProvider) => {
				if (effect.Kind === "hotel" && effect.Index === 0) throw new Error("provider timeout");
				if (effect.Kind !== "flights" && effect.Index > 0) return new Promise(() => {});
				return Promise.resolve(providerAnswer(effect, 1));
			}
		},
		{
			allowFailures: [
				search
			]
		}
	);
	registerReceivers(runtime);
	runtimes.push(runtime);
	const monitor = createMonitor(runtime, {
		receivers: RECEIVER_IDS
	});

	await runtime.dispatch(startTrip, "Trips", "lisbon");
	await settled();

	const lines = monitor.lines();
	const failure = lines.find((line) => line.Tone === "stop" && line.Detail.includes("provider timeout"));
	expect(failure?.Label).toBe("Lisbon/Hotel");
	expect(failure?.Lane).toBe("lisbon");
	expect(lines.some((line) => line.Detail === "ask open · Which flight?" && line.Label === "Lisbon/Trip")).toBe(true);
	expect(lines.some((line) => line.What === "Leg/Finished" && line.Label === "Lisbon/Trip")).toBe(true);
	expect(lines.some((line) => line.What === "Trips/SearchLeg" && line.Detail === "flight 9/9" && line.Label === "Lisbon/Flights")).toBe(
		true
	);
});

it("leaves timer ticks out of the lines and counts them instead", async () => {
	const runtime = createRuntime<IPortal>(getDefaultState(), {
		implementations: {
			"Backend/CheckProvider": () => new Promise(() => {})
		}
	});
	registerReceivers(runtime);
	runtimes.push(runtime);
	const monitor = createMonitor(runtime, {
		receivers: RECEIVER_IDS
	});
	await runtime.dispatch(startTrip, "Trips", "kyoto");
	await settled();
	const before = monitor.lines().length;

	await new Promise((resolve) => setTimeout(resolve, 1200));

	expect(runtime.state.Trips.Trips[0].Elapsed).toBeGreaterThan(0);
	expect(monitor.ticks()).toBeGreaterThan(0);
	expect(monitor.lines().length).toBe(before);
});
