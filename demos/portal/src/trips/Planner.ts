import type { IActionGenerator, IEntity, IReceiverId, ISelectorGenerator } from "treflex";
import type { IRestoreDrop } from "treflex/snapshot";
import type { IFare } from "../backend/backend";
import type { IDestinationKey, ILegKind } from "./destinations";
import type { ILeg } from "./Leg";
import type { ITrip, ITripDot } from "./Trip";
import { entity, mapGen, named, publish, publishToNearest, receiver, someGen, start } from "treflex";
import { now } from "../backend/backend";
import { money, plural } from "../text";
import { DESTINATIONS, LEG_KINDS } from "./destinations";
import { newLeg, SEARCH_NAME } from "./Leg";
import {
	beginTrip,
	dot,
	holdLeftAt,
	isSearching,
	legOf,
	markBack,
	markLeft,
	searchAgain,
	TripReceiver,
	tripFacts,
	whatTheRestoreFound
} from "./Trip";

declare module "treflex" {
	interface IMessageRegistry {
		"Trip/Started": {
			OthersRunning: boolean;
		};
	}
}

/** One trip as the restore found it, kept as it was so the banner reports the restore, not what happened after it. */
export interface IRestoredTrip {
	TripId: string;
	Name: string;
	Slot: IFare["Slot"] | null;
	Fares: number;
	Hotels: number;
	Providers: number;
	/** The hold's seconds left at the restore, 0 if it had run out by then, or null if no hold was running when it was saved. */
	HoldLeft: number | null;
	CarriedOn: ILegKind[];
	Unanswered: boolean;
	AskedAgain: boolean;
}

export interface IPlannerRestore {
	Trips: IRestoredTrip[];
}

/** The travel voucher from the chat, which takes Percent off every trip, current and future. */
export interface IPlannerVoucher {
	Percent: number;
	/** The first name of the teammate who sent it. */
	From: string;
	/** Whether a planner view has started the flourish, which it does the first time it shows the voucher. */
	Played: boolean;
}

export interface IPlanner extends IEntity {
	readonly $Receiver?: IReceiverId<IPlanner>;
	Trips: ITrip[];
	OpenTripId: string | null;
	Visible: boolean;
	Restore: IPlannerRestore | null;
	Voucher: IPlannerVoucher | null;
}

export function getDefaultState(id: string): IPlanner {
	return {
		$Id: id,
		$Receiver: PlannerReceiver.Id,
		Trips: [],
		OpenTripId: null,
		Visible: true,
		Restore: null,
		Voucher: null
	};
}

function* leave(draft: IPlanner): IActionGenerator {
	const current = draft.Trips.find((t) => t.$Id === draft.OpenTripId);
	if (current) yield* start(markLeft, current);
}

function* arrive(draft: IPlanner): IActionGenerator {
	const current = draft.Trips.find((t) => t.$Id === draft.OpenTripId);
	if (current) yield* start(markBack, current);
}

function tripName(trips: readonly ITrip[], destination: IDestinationKey): string {
	const base = DESTINATIONS[destination].Name;
	const taken = new Set(trips.map((t) => t.Name));
	let n = 1;
	while (taken.has(n === 1 ? base : `${base} ${n}`)) n++;
	return n === 1 ? base : `${base} ${n}`;
}

export function* startTrip(draft: IPlanner, destination: IDestinationKey): IActionGenerator {
	const legs: ILeg[] = yield* mapGen(LEG_KINDS, (kind) => entity<ILeg>(newLeg(destination, kind)));
	const trip = yield* entity<ITrip>({
		$Receiver: TripReceiver.Id,
		Destination: destination,
		Name: tripName(draft.Trips, destination),
		Elapsed: 0,
		Legs: legs,
		Thread: [],
		Choice: null,
		HoldUntil: 0,
		HoldCheckedAt: 0,
		Finished: false
	});
	const othersRunning = yield* someGen(draft.Trips, isSearching);
	if (draft.Visible) yield* leave(draft);
	draft.Trips.push(trip);
	draft.OpenTripId = trip.$Id;
	yield* start(beginTrip, trip);
	yield* publish("Trip/Started", {
		OthersRunning: othersRunning
	});
}
named(startTrip, "Trips/StartTrip");

export function* openTrip(draft: IPlanner, tripId: string | null): IActionGenerator {
	if (draft.OpenTripId === tripId) return;
	if (draft.Visible) yield* leave(draft);
	draft.OpenTripId = tripId !== null && draft.Trips.some((t) => t.$Id === tripId) ? tripId : null;
	if (draft.Visible) yield* arrive(draft);
	yield* publishToNearest(draft, "Portal/Viewed");
}
named(openTrip, "Trips/OpenTrip");

export function* removeTrip(draft: IPlanner, tripId: string): IActionGenerator {
	draft.Trips = draft.Trips.filter((t) => t.$Id !== tripId);
	if (draft.OpenTripId === tripId) draft.OpenTripId = null;
	if (draft.Restore) {
		draft.Restore.Trips = draft.Restore.Trips.filter((t) => t.TripId !== tripId);
		if (draft.Restore.Trips.length === 0) draft.Restore = null;
	}
}
named(removeTrip, "Trips/RemoveTrip");

/** A planner view's word that it has started the flourish, so no view plays it again. */
export function* flourishPlayed(draft: IPlanner): IActionGenerator {
	if (draft.Voucher && !draft.Voucher.Played) draft.Voucher.Played = true;
}
named(flourishPlayed, "Trips/FlourishPlayed");

/** Starts again each search a restore dropped, from the provider it had reached. `repairRestore` in session.ts dispatches it. */
export function* carryOn(draft: IPlanner, dropped: IRestoreDrop[]): IActionGenerator {
	for (const entry of dropped) {
		if (entry.name !== SEARCH_NAME || entry.state === "stopping") continue;
		const trip = draft.Trips.find((t) => t.Legs.some((leg) => leg.$Id === entry.entityId));
		if (trip) yield* start(searchAgain, trip, entry.entityId);
	}
}
named(carryOn, "Trips/CarryOn");

export const actions = {
	startTrip,
	openTrip,
	removeTrip,
	flourishPlayed
};

export const PlannerReceiver = receiver<IPlanner>("PlannerReceiver")({
	*"Portal/AppShown"(draft, message) {
		if (message.App !== "trips" || draft.Visible) return;
		draft.Visible = true;
		yield* arrive(draft);
	},
	*"Portal/AppHidden"(draft, message) {
		if (message.App !== "trips" || !draft.Visible) return;
		draft.Visible = false;
		yield* leave(draft);
	},
	*"Portal/VoucherApplied"(draft, message) {
		if (draft.Voucher) return;
		draft.Voucher = {
			Percent: message.Percent,
			From: message.From,
			Played: false
		};
	},
	*"Portal/Restored"(draft, message) {
		const at = yield* now();
		const trips: IRestoredTrip[] = draft.Trips.map((trip) => ({
			TripId: trip.$Id,
			Name: trip.Name,
			Slot: trip.Choice?.Slot ?? null,
			Fares: legOf(trip, "flights")?.Found ?? 0,
			Hotels: legOf(trip, "hotel")?.Checked ?? 0,
			Providers: legOf(trip, "activities")?.Checked ?? 0,
			HoldLeft: holdLeftAt(trip, at),
			...whatTheRestoreFound(trip, message)
		}));
		draft.Restore =
			trips.length > 0
				? {
						Trips: trips
					}
				: null;
		yield* publishToNearest(draft, "Portal/RestoreFound", {
			CutOff: trips.some((t) => t.Unanswered)
		});
	}
});

export interface IPlannerSummary {
	Line: string;
	Dot: ITripDot;
}

export function* summary(draft: IPlanner): ISelectorGenerator<IPlannerSummary> {
	if (draft.Trips.length === 0) {
		return {
			Line: "No trips yet",
			Dot: ""
		};
	}
	const dots = yield* mapGen(draft.Trips, dot);
	const facts = yield* mapGen(draft.Trips, tripFacts);
	const finished = draft.Trips.filter((t) => t.Finished).length;
	const stopped = draft.Trips.filter((t, i) => !t.Finished && facts[i].Searching.length === 0 && facts[i].Stopped.length > 0).length;
	const parts: string[] = [];
	const count = (n: number, label: string): void => {
		if (n > 0) parts.push(parts.length === 0 ? `${plural(n, "trip")} ${label}` : `${n} ${label}`);
	};
	count(draft.Trips.length - finished - stopped, "planning");
	count(stopped, "stopped");
	count(finished, "ready");
	const line = parts.join(" · ");
	const order: ITripDot[] = [
		"blue",
		"amber",
		"rose",
		"green"
	];
	return {
		Line: line,
		Dot: order.find((d) => dots.includes(d)) ?? ""
	};
}

export function* currentTrip(draft: IPlanner): ISelectorGenerator<ITrip | undefined> {
	return draft.Trips.find((t) => t.$Id === draft.OpenTripId);
}

export interface IVoucherView {
	Percent: number;
	/** The pill under each discounted total, as "−10% · Marcus's voucher". */
	Pill: string;
	Played: boolean;
}

export function* voucher(draft: IPlanner): ISelectorGenerator<IVoucherView | null> {
	if (!draft.Voucher) return null;
	return {
		Percent: draft.Voucher.Percent,
		Pill: `−${draft.Voucher.Percent}% · ${draft.Voucher.From}'s voucher`,
		Played: draft.Voucher.Played
	};
}

export interface IPrice {
	/** The price after the voucher, where the flourish's ticker ends. */
	Amount: number;
	Now: string;
	/** The price before the voucher, where the flourish's ticker starts. */
	Full: number;
	/** Full formatted, struck through beside Now, or null when nothing came off. */
	Was: string | null;
}

export function priced(amount: number, voucher: IVoucherView | null): IPrice {
	const discounted = voucher ? Math.round((amount * (100 - voucher.Percent)) / 100) : amount;
	return {
		Amount: discounted,
		Now: money(discounted),
		Full: amount,
		Was: discounted === amount ? null : money(amount)
	};
}

/** The ticker's text `progress` of the way (0 to 1) from Full down to Amount, eased out and formatted as the total is. */
export function tickerText(price: IPrice, progress: number): string {
	if (progress >= 1) return price.Now;
	const eased = 1 - (1 - Math.max(0, progress)) ** 3;
	return money(price.Full + (price.Amount - price.Full) * eased);
}

export const selectors = {
	summary,
	currentTrip,
	voucher
};
