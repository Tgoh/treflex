import type { IActionContext } from "treflex";
import type { IDestinationKey, ILegKind } from "../trips/destinations";
import type { ICheckProvider } from "./backend";
import type { IWait } from "./fakeBackend";
import { describe, expect, it } from "vitest";
import { DESTINATION_KEYS, DESTINATIONS, LEG_KINDS } from "../trips/destinations";
import { ProviderError } from "./backend";
import { fakeBackend, providerAnswer, providerDelay } from "./fakeBackend";

const query = (destination: IDestinationKey, kind: ILegKind, index: number, retries = 1): ICheckProvider => ({
	Type: "Backend/CheckProvider",
	Destination: destination,
	Kind: kind,
	Index: index,
	Retries: retries
});

const fails = (effect: ICheckProvider, attempt = 0): boolean => {
	try {
		providerAnswer(effect, attempt);
		return false;
	} catch (error) {
		if (!(error instanceof ProviderError)) throw error;
		return true;
	}
};

function legMs(destination: IDestinationKey, kind: ILegKind): number {
	let total = 0;
	for (let i = 0; i < DESTINATIONS[destination].Providers[kind]; i++) {
		total += providerDelay(query(destination, kind, i), 0);
		if (fails(query(destination, kind, i))) total += providerDelay(query(destination, kind, i), 1);
	}
	return total;
}

const FIRST_FAILING = [
	...Array(DESTINATIONS.lisbon.Providers.hotel).keys()
].find((i) => fails(query("lisbon", "hotel", i)))!;

function recording(onWait?: (attempt: number) => void) {
	const attempts: number[] = [];
	const wait: IWait = async (_ms, _signal, _effect, attempt) => {
		attempts.push(attempt);
		onWait?.(attempt);
	};
	return {
		attempts,
		check: (effect: ICheckProvider, signal = new AbortController().signal) =>
			fakeBackend(wait).fn(effect, {
				signal
			} as IActionContext)
	};
}

describe("the fake backend", () => {
	it("answers every visitor the same way, and some providers fail on the first try", () => {
		expect(providerAnswer(query("lisbon", "hotel", 3), 1)).toEqual(providerAnswer(query("lisbon", "hotel", 3), 1));
		const failures = [
			...Array(36).keys()
		].filter((i) => fails(query("lisbon", "hotel", i)));
		expect(failures.length).toBeGreaterThan(0);
		for (const i of failures) expect(fails(query("lisbon", "hotel", i), 1)).toBe(false);
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

describe("the provider check", () => {
	it("asks again after a ProviderError, and answers with the retry", async () => {
		const backend = recording();
		const effect = query("lisbon", "hotel", FIRST_FAILING);
		await expect(backend.check(effect)).resolves.toEqual(providerAnswer(effect, 1));
		expect(backend.attempts).toEqual([
			0,
			1
		]);
	});

	it("asks once for a provider that answers the first time", async () => {
		const backend = recording();
		const effect = query("lisbon", "hotel", FIRST_FAILING === 0 ? 1 : 0);
		expect(fails(effect)).toBe(false);
		await expect(backend.check(effect)).resolves.toEqual(providerAnswer(effect, 0));
		expect(backend.attempts).toEqual([
			0
		]);
	});

	it("throws an Error with the provider's message once the retries the call allows are spent", async () => {
		const backend = recording();
		const effect = query("lisbon", "hotel", FIRST_FAILING, 0);
		let failure: unknown;
		try {
			providerAnswer(effect, 0);
		} catch (error) {
			failure = error;
		}
		const rejection = await Promise.resolve(backend.check(effect)).then(
			() => undefined,
			(error: unknown) => error
		);
		expect(Object.getPrototypeOf(rejection)).toBe(Error.prototype);
		expect((rejection as Error).message).toBe((failure as ProviderError).message);
		expect(backend.attempts).toEqual([
			0
		]);
	});

	it("doesn't ask again once the action is told to end", async () => {
		const controller = new AbortController();
		const backend = recording(() => controller.abort(new Error("ended")));
		await expect(backend.check(query("lisbon", "hotel", FIRST_FAILING), controller.signal)).rejects.toThrow("ended");
		expect(backend.attempts).toEqual([
			0
		]);
	});
});
