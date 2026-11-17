import type { IActionGenerator, IEntity, ISelectorGenerator } from "treflex";
import type { IFare, IPick, IProviderResult } from "../backend/backend";
import type { IDestinationKey, ILegKind } from "./destinations";
import { inFlight, leading, publishToNearest } from "treflex";
import { checkProvider, ProviderError } from "../backend/backend";
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

export type ILegStatus = "waiting" | "searching" | "interrupted" | "done";

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
	draft.Picks = bestPicks([
		...draft.Picks,
		...result.Picks
	]);
}

export function* search(draft: ILeg): IActionGenerator {
	if (draft.Done) return;
	draft.Started = true;
	while (draft.Checked < draft.Total) {
		const query = {
			Destination: draft.Destination,
			Kind: draft.Kind,
			Index: draft.Checked
		};
		let result: IProviderResult;
		try {
			result = yield* checkProvider({
				...query,
				Attempt: 0
			});
		} catch (error) {
			if (!(error instanceof ProviderError)) throw error;
			result = yield* checkProvider({
				...query,
				Attempt: 1
			});
		}
		take(draft, result);
		draft.Checked = query.Index + 1;
	}
	draft.Done = true;
	yield* publishToNearest(draft, "Leg/Finished", {
		Kind: draft.Kind
	});
}
leading(search);

export const actions = {};

export function* legStatus(draft: ILeg): ISelectorGenerator<ILegStatus> {
	if (draft.Done) return "done";
	if (yield* inFlight(search, draft)) return "searching";
	return draft.Started ? "interrupted" : "waiting";
}

export const selectors = {
	legStatus
};
