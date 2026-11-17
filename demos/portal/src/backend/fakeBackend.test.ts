import type { IDestinationKey, ILegKind } from "../trips/destinations";
import type { ICheckProvider } from "./backend";
import { describe, expect, it } from "vitest";
import { DESTINATION_KEYS, DESTINATIONS, LEG_KINDS } from "../trips/destinations";
import { ProviderError } from "./backend";
import { providerAnswer, providerDelay } from "./fakeBackend";

const query = (destination: IDestinationKey, kind: ILegKind, index: number, attempt = 0): ICheckProvider => ({
	Type: "Backend/CheckProvider",
	Destination: destination,
	Kind: kind,
	Index: index,
	Attempt: attempt
});

const fails = (effect: ICheckProvider): boolean => {
	try {
		providerAnswer(effect);
		return false;
	} catch (error) {
		if (!(error instanceof ProviderError)) throw error;
		return true;
	}
};

function legMs(destination: IDestinationKey, kind: ILegKind): number {
	let total = 0;
	for (let i = 0; i < DESTINATIONS[destination].Providers[kind]; i++) {
		total += providerDelay(query(destination, kind, i));
		if (fails(query(destination, kind, i))) total += providerDelay(query(destination, kind, i, 1));
	}
	return total;
}

describe("the fake backend", () => {
	it("answers every visitor the same way, and some providers fail on the first try", () => {
		expect(providerAnswer(query("lisbon", "hotel", 3, 1))).toEqual(providerAnswer(query("lisbon", "hotel", 3, 1)));
		const failures = [
			...Array(36).keys()
		].filter((i) => fails(query("lisbon", "hotel", i)));
		expect(failures.length).toBeGreaterThan(0);
		for (const i of failures) expect(fails(query("lisbon", "hotel", i, 1))).toBe(false);
	});

	it.each(DESTINATION_KEYS)("runs a whole %s search in 30 to 40 seconds, with the flights in first", (destination) => {
		const legs = Object.fromEntries(
			LEG_KINDS.map((kind) => [
				kind,
				legMs(destination, kind)
			])
		);
		const run = Math.max(...Object.values(legs));
		expect(run).toBeGreaterThanOrEqual(30_000);
		expect(run).toBeLessThanOrEqual(40_000);
		expect(legs.flights).toBeLessThan(15_000);
	});
});
