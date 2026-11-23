import type { IActionGenerator, IEntity, ISelectorGenerator } from "treflex";
import type { IFare, IPick, IProviderResult } from "../backend/backend";
import type { IDestinationKey, ILegKind } from "./destinations";
import { inFlight, leading, named, publishToNearest } from "treflex";
import { checkProvider } from "../backend/backend";
import { DESTINATIONS } from "./destinations";

declare module "treflex" {
	interface IMessageRegistry {
		"Leg/Finished": {
			Kind: ILegKind;
		};
	}
}

export interface ILeg extends IEntity {
	Kind: ILegKind;
	Destination: IDestinationKey;
	Checked: number;
	Total: number;
	Found: number;
	Picks: IPick[];
	Fares: IFare[];
	Started: boolean;
	Done: boolean;
}

export type ILegStatus = "waiting" | "searching" | "failed" | "done";

export const MAX_PICKS = 3;

export function newLeg(destination: IDestinationKey, kind: ILegKind): Omit<ILeg, "$Id"> {
	return {
		Kind: kind,
		Destination: destination,
		Checked: 0,
		Total: DESTINATIONS[destination].Providers[kind],
		Found: 0,
		Picks: [],
		Fares: [],
		Started: false,
		Done: false
	};
}

function bestBySlot(fares: readonly IFare[]): IFare[] {
	const cheapest = (slot: IFare["Slot"]) =>
		fares
			.filter((f) => f.Slot === slot)
			.reduce<IFare | undefined>((best, f) => (best === undefined || f.Price < best.Price ? f : best), undefined);
	return [
		cheapest("Morning"),
		cheapest("Evening")
	]
		.filter((f): f is IFare => f !== undefined)
		.map((f) => ({
			...f
		}));
}

function bestPicks(picks: readonly IPick[]): IPick[] {
	const byName = new Map<string, IPick>();
	for (const pick of picks) {
		if (!byName.has(pick.Name)) byName.set(pick.Name, pick);
	}
	return [
		...byName.values()
	]
		.sort((a, b) => b.Rating - a.Rating || a.Price - b.Price)
		.slice(0, MAX_PICKS)
		.map((p) => ({
			...p
		}));
}

function take(draft: ILeg, result: IProviderResult): void {
	if (draft.Kind === "flights") {
		draft.Found += result.Fares.length;
		draft.Fares = bestBySlot([
			...draft.Fares,
			...result.Fares
		]);
		return;
	}
	draft.Found += result.Picks.length;
	writePicks(
		draft.Picks,
		bestPicks([
			...draft.Picks,
			...result.Picks
		])
	);
}

// Field by field, not a new array: a resumable flight question's history merges another writer's scalar sets, and
// an array set on every provider check stops the merging, so the history grows with each check.
function writePicks(picks: IPick[], next: readonly IPick[]): void {
	for (const [i, pick] of next.entries()) {
		const kept = picks[i];
		if (!kept) {
			picks.push({
				...pick
			});
			continue;
		}
		for (const key of Object.keys(pick) as (keyof IPick)[]) {
			if (kept[key] !== pick[key]) (kept as Record<keyof IPick, unknown>)[key] = pick[key];
		}
	}
	if (picks.length > next.length) picks.splice(next.length);
}

export function* search(draft: ILeg): IActionGenerator {
	if (draft.Done) return;
	draft.Started = true;
	while (draft.Checked < draft.Total) {
		const index = draft.Checked;
		const result = yield* checkProvider({
			Destination: draft.Destination,
			Kind: draft.Kind,
			Index: index,
			Retries: 1
		});
		take(draft, result);
		draft.Checked = index + 1;
	}
	draft.Done = true;
	yield* publishToNearest(draft, "Leg/Finished", {
		Kind: draft.Kind
	});
}
export const SEARCH_NAME = "Trips/SearchLeg";
named(search, SEARCH_NAME);
leading(search);

export const actions = {};

export function* legStatus(draft: ILeg): ISelectorGenerator<ILegStatus> {
	if (draft.Done) return "done";
	if (yield* inFlight(search, draft)) return "searching";
	return draft.Started ? "failed" : "waiting";
}

export const selectors = {
	legStatus
};
