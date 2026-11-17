import type { IRestoreLines } from "../portal/restoreBanner";
import type { IPlannerRestore, IRestoredTrip } from "./Planner";
import { clock, listed, plural } from "../text";
import { SEARCH_NOUNS } from "./Trip";

function found(trip: IRestoredTrip): string | null {
	const parts = [];
	if (trip.Fares > 0) parts.push(plural(trip.Fares, "fare"));
	if (trip.Hotels > 0) parts.push(`${plural(trip.Hotels, "hotel")} checked`);
	if (trip.Providers > 0) parts.push(`${plural(trip.Providers, "activity provider")} asked`);
	if (parts.length === 0) return null;
	const line = `${listed(parts)} so far`;
	return line.charAt(0).toUpperCase() + line.slice(1);
}

function lostOn(trip: IRestoredTrip): string[] {
	const name = trip.Name;
	const lines: string[] = [];
	if (trip.Stopped.length > 0) {
		const nouns = listed(trip.Stopped.map((kind) => SEARCH_NOUNS[kind]));
		lines.push(
			`${name}'s ${nouns} ${trip.Stopped.length === 1 ? "search" : "searches"}, which ${trip.Stopped.length === 1 ? "was" : "were"} running`
		);
	}
	if (trip.Unanswered) lines.push(`${name}'s open flight question`);
	return lines;
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

	const lost = note.Trips.flatMap(lostOn);
	if (note.Trips.some((t) => t.Stopped.length > 0))
		lost.push("The stopped searches came back marked interrupted, with what they'd found kept");
	return {
		Back: back,
		Lost: lost
	};
}
