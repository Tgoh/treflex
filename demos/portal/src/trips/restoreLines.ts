import type { IRestoreLines } from "../portal/restoreBanner";
import type { IPlannerRestore, IRestoredTrip } from "./Planner";
import { clock, listed, plural } from "../text";
import { carriesOn, searchesOf } from "./Trip";

function found(trip: IRestoredTrip): string | null {
	const parts = [];
	if (trip.Fares > 0) parts.push(plural(trip.Fares, "fare"));
	if (trip.Hotels > 0) parts.push(`${plural(trip.Hotels, "hotel")} checked`);
	if (trip.Providers > 0) parts.push(`${plural(trip.Providers, "activity provider")} asked`);
	if (parts.length === 0) return null;
	const line = `${listed(parts)} so far`;
	return line.charAt(0).toUpperCase() + line.slice(1);
}

function carriedOn(trip: IRestoredTrip): string[] {
	const kinds = trip.CarriedOn;
	return kinds.length === 0
		? []
		: [
				`${trip.Name}'s ${searchesOf(kinds)}, which ${carriesOn(kinds)}`
			];
}

/** On a trip the restore didn't find, the lines name the restored trips as they do away from the planner. */
export function tripRestoreLines(note: IPlannerRestore, openTripId: string | null): IRestoreLines {
	const open = note.Trips.find((t) => t.TripId === openTripId);
	const back: string[] = [];

	if (open) {
		back.push(open.Slot ? `The trip, your answers and the ${open.Slot.toLowerCase()} flight` : "The trip and what the agent had written");
		const so = found(open);
		if (so) back.push(so);
		if (open.HoldLeft !== null) {
			back.push(
				open.HoldLeft > 0
					? `The fare hold, with ${clock(open.HoldLeft)} left at the reload`
					: "The fare hold, which had run out by the reload"
			);
		}
		const others = note.Trips.filter((t) => t !== open).map((t) => t.Name);
		if (others.length > 0) {
			const one = others.length === 1;
			back.push(`Your ${one ? "trip" : "trips"} to ${listed(others)}, with what ${one ? "it" : "they"} had found`);
		}
	} else {
		back.push(`${plural(note.Trips.length, "trip")} and everything the agent found`);
	}

	back.push(...note.Trips.flatMap(carriedOn));
	back.push(...note.Trips.filter((t) => t.AskedAgain).map((t) => `${t.Name}'s open flight question, which is asked again`));
	const lost = note.Trips.filter((t) => t.Unanswered).map((t) => `${t.Name}'s open flight question`);
	return {
		Back: back,
		Lost: lost
	};
}
