import type { IActionGenerator, IAskEntry, IAskId, IEntity, IReceiverId, ISelectorGenerator } from "treflex";
import type { IFare } from "../backend/backend";
import type { IRestoredWork } from "../portal/topics";
import type { IDestinationKey, ILegKind } from "./destinations";
import type { ILeg, ILegStatus } from "./Leg";
import {
	answer,
	ask,
	inFlight,
	leading,
	named,
	open,
	pendingAsks,
	publish,
	receiver,
	resumable,
	someGen,
	start,
	startTimer,
	stopTimer,
	transient
} from "treflex";
import { now } from "../backend/backend";
import { clock, listed, money, plural } from "../text";
import { DESTINATIONS, LEG_KINDS } from "./destinations";
import { legStatus, search } from "./Leg";

declare module "treflex" {
	interface IMessageRegistry {
		"Trip/Answered": {};
		"Trip/CameBack": {};
	}

	interface ITimerRegistry {
		"Trip/Clock": {};
		"Trip/Hold": {};
	}
}

export const HOLD_SECONDS = 15 * 60;

export const FLIGHT_QUESTION = "Trips/ChooseFlight";

export interface IFlightQuestion {
	Path: typeof FLIGHT_QUESTION;
	Title: string;
	Fares: IFare[];
	Found: number;
}

export interface IThreadLine {
	At: number;
	Text: string;
	Asked?: true;
	Divider?: true;
}

export interface ITrip extends IEntity {
	readonly $Receiver?: IReceiverId<ITrip>;
	Destination: IDestinationKey;
	Name: string;
	Elapsed: number;
	Legs: ILeg[];
	Thread: IThreadLine[];
	Choice: IFare | null;
	/** When the fare hold runs out, in epoch milliseconds; 0 before any hold. */
	HoldUntil: number;
	/** The clock reading the hold was last measured at, by its placing or a `Trip/Hold` tick. */
	HoldCheckedAt: number;
	Finished: boolean;
}

function secondsUntil(deadline: number, at: number): number {
	return Math.max(0, Math.ceil((deadline - at) / 1000));
}

/** The hold's seconds left as of its last measurement, 0 once it has run out or before any hold. */
export function holdLeft(trip: ITrip): number {
	return secondsUntil(trip.HoldUntil, trip.HoldCheckedAt);
}

/** The hold's seconds left at `at`, or null when the hold had already run out at its last measurement. */
export function holdLeftAt(trip: ITrip, at: number): number | null {
	return holdLeft(trip) > 0 ? secondsUntil(trip.HoldUntil, at) : null;
}

export const LEG_NAMES: Record<ILegKind, string> = {
	flights: "Flights",
	hotel: "Hotel",
	activities: "Activities"
};

export const SEARCH_NOUNS: Record<ILegKind, string> = {
	flights: "flight",
	hotel: "hotel",
	activities: "activity"
};

export function legOf(trip: ITrip, kind: ILegKind): ILeg | undefined {
	return trip.Legs.find((leg) => leg.Kind === kind);
}

export function flightQuestionOf(entry: IAskEntry): IFlightQuestion | undefined {
	const request = entry.Request as IFlightQuestion | undefined;
	return request?.Path === FLIGHT_QUESTION ? request : undefined;
}

export function awaitingChoice(trip: ITrip): boolean {
	const flights = legOf(trip, "flights");
	return flights?.Done === true && flights.Fares.length >= 2 && trip.Choice === null;
}

export function* isSearching(trip: ITrip) {
	return yield* someGen(trip.Legs, (leg) => inFlight(search, leg));
}

export const awayMark = (trip: ITrip) =>
	transient(trip, "Trip/Away", {
		Away: false
	});

function say(draft: ITrip, text: string, extra?: Pick<IThreadLine, "Asked" | "Divider">): void {
	draft.Thread.push({
		At: draft.Elapsed,
		Text: text,
		...extra
	});
}

function* runClock(draft: ITrip): IActionGenerator {
	yield* startTimer(draft, "Trip/Clock", TripReceiver, 1000);
}

function* wrapUp(draft: ITrip): IActionGenerator {
	if (draft.Finished || draft.Choice === null || !draft.Legs.every((leg) => leg.Done)) return;
	draft.Finished = true;
	say(draft, `That's everything. **${draft.Name}** is ready to review.`);
	yield* stopTimer(draft, "Trip/Clock");
}

export function* beginTrip(draft: ITrip): IActionGenerator {
	const destination = DESTINATIONS[draft.Destination];
	yield* runClock(draft);
	say(draft, `Planning **${draft.Name}** for ${destination.TravellersWord}, ${destination.DatesSpoken}.`);
	say(draft, "Searching flights, hotels and activities at once.");
	for (const leg of draft.Legs) {
		yield* start(search, leg);
	}
}
named(beginTrip, "Trips/BeginTrip");

export function* searchAgain(draft: ITrip, legId: string): IActionGenerator {
	const leg = draft.Legs.find((l) => l.$Id === legId);
	if (!leg || leg.Done) return;
	yield* runClock(draft);
	yield* start(search, leg);
}
named(searchAgain, "Trips/SearchAgain");

export function* chooseFlight(draft: ITrip) {
	if (!awaitingChoice(draft)) return;
	const flights = legOf(draft, "flights")!;
	const request: IFlightQuestion = {
		Path: FLIGHT_QUESTION,
		Title: "Which flight?",
		Fares: flights.Fares.map((fare) => ({
			...fare
		})),
		Found: flights.Found
	};
	yield* runClock(draft);
	const fareId = yield* open(ask<string>(draft, request));
	if (fareId === undefined || draft.Choice !== null) return;
	const fare = request.Fares.find((f) => f.Id === fareId);
	if (!fare) return;
	draft.Choice = fare;
	yield* holdFor(draft, `You chose the ${fare.Slot.toLowerCase()} flight. **Holding it for 15 minutes.**`);
	yield* publish("Trip/Answered");
	yield* wrapUp(draft);
}
export const CHOOSE_FLIGHT_NAME = "Trips/ChooseFlight";
named(chooseFlight, CHOOSE_FLIGHT_NAME);
leading(chooseFlight);
resumable(chooseFlight);

function* holdFor(draft: ITrip, line: string): IActionGenerator {
	const at = yield* now();
	draft.HoldUntil = at + HOLD_SECONDS * 1000;
	draft.HoldCheckedAt = at;
	say(draft, line);
	yield* startTimer(draft, "Trip/Hold", TripReceiver, 1000);
}

export function* pickFare(_draft: ITrip, askId: IAskId<string>, fareId: string): IActionGenerator {
	yield* answer(askId, fareId);
}
named(pickFare, "Trips/PickFare");

export function* holdAgain(draft: ITrip): IActionGenerator {
	if (draft.Choice === null || holdLeft(draft) > 0) return;
	yield* holdFor(draft, `Holding the ${draft.Choice.Carrier} fare again for 15 minutes.`);
}
named(holdAgain, "Trips/HoldAgain");

export function* markLeft(draft: ITrip): IActionGenerator {
	if (!(yield* isSearching(draft))) return;
	const away = yield* awayMark(draft);
	away.Away = true;
}
named(markLeft, "Trips/MarkLeft");

export function* markBack(draft: ITrip): IActionGenerator {
	const away = yield* awayMark(draft);
	if (!away.Away) return;
	away.Away = false;
	yield* publish("Trip/CameBack");
}
named(markBack, "Trips/MarkBack");

export const actions = {
	chooseFlight,
	pickFare,
	holdAgain,
	searchAgain
};

export const TripReceiver = receiver<ITrip>("TripReceiver")({
	*"Trip/Clock"(draft) {
		if ((yield* isSearching(draft)) || (yield* inFlight(chooseFlight, draft))) {
			draft.Elapsed++;
			return;
		}
		yield* stopTimer(draft, "Trip/Clock");
	},
	*"Trip/Hold"(draft) {
		const wasHolding = holdLeft(draft) > 0;
		draft.HoldCheckedAt = yield* now();
		if (holdLeft(draft) > 0) return;
		yield* stopTimer(draft, "Trip/Hold");
		if (wasHolding && draft.Choice) say(draft, `The hold on the ${draft.Choice.Carrier} fare ran out. Flights can hold it again.`);
	},
	*"Leg/Finished"(draft, _message, { publisher }) {
		const leg = draft.Legs.find((l) => l.$Id === publisher.Id);
		if (!leg) return;
		switch (leg.Kind) {
			case "flights":
				if (leg.Fares.length < 2) {
					say(draft, `Checked ${plural(leg.Found, "fare")}, but not two good ones.`);
					break;
				}
				say(draft, `Narrowed ${leg.Found} fares to two.`, {
					Asked: true
				});
				yield* start(chooseFlight, draft);
				break;
			case "hotel": {
				const best = leg.Picks[0];
				say(
					draft,
					best
						? `Checked ${leg.Total} hotels. **${best.Name}** leads at ${money(best.Price)} a night.`
						: `Checked ${leg.Total} hotels and found none free.`
				);
				break;
			}
			case "activities":
				say(draft, `Found ${plural(leg.Found, "thing")} to do, and kept the best ${leg.Picks.length}.`);
				break;
			default:
				leg.Kind satisfies never;
		}
		const said = draft.Thread[draft.Thread.length - 1].Text;
		yield* publish("Portal/Finished", {
			App: "trips",
			Target: draft.$Id,
			Title: `${draft.Name}: ${SEARCH_NOUNS[leg.Kind]} search finished`,
			Text: said.replaceAll("**", ""),
			Link: "Open the trip →"
		});
		yield* wrapUp(draft);
	},
	*"Portal/Restored"(draft, message) {
		const found = whatTheRestoreFound(draft, message);
		if (found.CarriedOn.length === 0 && !found.Unanswered) return;
		say(draft, `Page reloaded at ${clock(draft.Elapsed)}`, {
			Divider: true
		});
		const parts = [
			"Back."
		];
		const left = holdLeftAt(draft, yield* now());
		if (left !== null && left > 0) parts.push(`The hold had ${clock(left)} left.`);
		if (found.CarriedOn.length > 0) parts.push(`The ${searchesOf(found.CarriedOn)} ${carriesOn(found.CarriedOn)}.`);
		if (found.Unanswered) parts.push("The flight question closed, so choose a flight when you're ready.");
		say(draft, parts.join(" "));
	}
});

export interface IRestoreFound {
	/** The searches the restore dropped, which its repair starts again. */
	CarriedOn: ILegKind[];
	/** The restore dropped the open flight question. */
	Unanswered: boolean;
	/** The restore resumed the open flight question, which is asked again. */
	AskedAgain: boolean;
}

export function whatTheRestoreFound(
	trip: ITrip,
	{
		Resumed,
		Dropped
	}: {
		Resumed: readonly IRestoredWork[];
		Dropped: readonly IRestoredWork[];
	}
): IRestoreFound {
	const dropped = new Set(Dropped.map((work) => work.EntityId));
	const asker = (work: IRestoredWork): boolean => work.Name === CHOOSE_FLIGHT_NAME && work.EntityId === trip.$Id;
	return {
		CarriedOn: trip.Legs.filter((leg) => dropped.has(leg.$Id) && !leg.Done).map((leg) => leg.Kind),
		Unanswered: Dropped.some(asker) && awaitingChoice(trip),
		AskedAgain: Resumed.some(asker)
	};
}

export type ITripDot = "amber" | "blue" | "rose" | "green" | "";

export interface ITripFacts {
	Statuses: Record<ILegKind, ILegStatus>;
	Running: number;
	Failed: number;
	Searching: ILegKind[];
	Stopped: ILegKind[];
	QuestionOpen: boolean;
	NeedsChoice: boolean;
	/** The hold's seconds left, worked out from its deadline as of its last measurement. */
	HoldLeft: number;
	Holding: boolean;
	Lapsed: boolean;
	Progress: number;
}

export function searchesOf(kinds: readonly ILegKind[]): string {
	return `${listed(kinds.map((kind) => SEARCH_NOUNS[kind]))} ${kinds.length === 1 ? "search" : "searches"}`;
}

export function keepGoing(kinds: readonly ILegKind[]): string {
	return `The ${searchesOf(kinds)} ${kinds.length === 1 ? "keeps" : "keep"} going`;
}

export function carriesOn(kinds: readonly ILegKind[]): string {
	return kinds.length === 1 ? "carries on where it left off" : "carry on where they left off";
}

export function* tripFacts(draft: ITrip): ISelectorGenerator<ITripFacts> {
	const statuses = {} as Record<ILegKind, ILegStatus>;
	for (const kind of LEG_KINDS) {
		const leg = legOf(draft, kind);
		statuses[kind] = leg ? yield* legStatus(leg) : "waiting";
	}
	const kinds = Object.values(statuses);
	const questionOpen = (yield* question(draft)) !== undefined;
	const flights = legOf(draft, "flights");
	const needsChoice =
		awaitingChoice(draft) && !questionOpen && !(yield* inFlight(chooseFlight, draft)) && !(flights && (yield* inFlight(search, flights)));
	const checked = draft.Legs.reduce((n, leg) => n + leg.Checked, 0);
	const total = draft.Legs.reduce((n, leg) => n + leg.Total, 0);
	const searching = LEG_KINDS.filter((kind) => statuses[kind] === "searching");
	const stopped = LEG_KINDS.filter((kind) => statuses[kind] === "failed" || statuses[kind] === "waiting");
	return {
		Statuses: statuses,
		Running: searching.length,
		Failed: kinds.filter((s) => s === "failed").length,
		Searching: searching,
		Stopped: stopped,
		QuestionOpen: questionOpen,
		NeedsChoice: needsChoice,
		HoldLeft: holdLeft(draft),
		Holding: holdLeft(draft) > 0,
		Lapsed: draft.Choice !== null && holdLeft(draft) === 0,
		Progress: draft.Finished ? 1 : total === 0 ? 0 : checked / total
	};
}

export function* headline(draft: ITrip): ISelectorGenerator<string> {
	const f = yield* tripFacts(draft);
	const time = clock(draft.Elapsed);
	if (draft.Finished) return `Ready · planned in ${time}`;
	if (f.QuestionOpen || f.NeedsChoice) return `Waiting on you · ${time}`;
	if (f.Running > 0) return `Planning · ${time}`;
	if (f.Failed > 0) return `Stopped · ${time}`;
	return `Paused · ${time}`;
}

export function* statusLine(draft: ITrip): ISelectorGenerator<string> {
	const f = yield* tripFacts(draft);
	if (draft.Finished) return f.Holding ? `Ready · hold ${clock(f.HoldLeft)}` : "Ready to review";
	const running = f.Running > 0 ? ` · ${f.Running} running` : "";
	if (f.QuestionOpen) return `Waiting on you${running}`;
	if (f.NeedsChoice) return `Choose a flight${running}`;
	if (f.Failed > 0 && f.Running === 0) return `${plural(f.Failed, "search", "searches")} failed`;
	if (f.Running > 0) {
		const done = LEG_KINDS.filter((kind) => kind !== "flights" && f.Statuses[kind] === "done");
		if (done.length === 1) return `${LEG_NAMES[done[0]]} search done${running}`;
		return `${plural(f.Running, "search", "searches")} running`;
	}
	return "Paused";
}

export function* dot(draft: ITrip): ISelectorGenerator<ITripDot> {
	const f = yield* tripFacts(draft);
	if (f.QuestionOpen || f.NeedsChoice) return "blue";
	if (f.Running > 0) return "amber";
	if (f.Failed > 0) return "rose";
	if (draft.Finished) return "green";
	return "";
}

export function* agentStatus(draft: ITrip): ISelectorGenerator<string> {
	const f = yield* tripFacts(draft);
	if (draft.Finished) return "Done · everything is ready to review";
	if (f.Statuses.hotel === "searching") return "Comparing hotel reviews…";
	if (f.Statuses.flights === "searching") return "Comparing fares…";
	if (f.Statuses.activities === "searching") return "Checking day trips…";
	if (f.QuestionOpen || f.NeedsChoice) return "Waiting for your call";
	if (f.Failed > 0) return "Idle · waiting for you to restart a search";
	return "Idle";
}

export function* typing(draft: ITrip): ISelectorGenerator<string> {
	const f = yield* tripFacts(draft);
	const destination = DESTINATIONS[draft.Destination];
	const hotel = legOf(draft, "hotel");
	if (hotel && f.Statuses.hotel === "searching")
		return `Reading reviews for ${destination.Hotels[hotel.Checked % destination.Hotels.length]}`;
	const activities = legOf(draft, "activities");
	if (activities && f.Statuses.activities === "searching") return `Asking provider ${activities.Checked + 1} of ${activities.Total}`;
	return "";
}

export function* soFar(draft: ITrip): ISelectorGenerator<number> {
	const destination = DESTINATIONS[draft.Destination];
	const hotel = legOf(draft, "hotel")?.Picks[0];
	const activities = legOf(draft, "activities")?.Picks ?? [];
	return (
		(draft.Choice ? draft.Choice.Price * destination.Travellers : 0) +
		(hotel ? hotel.Price * destination.Nights : 0) +
		activities.reduce((n, pick) => n + pick.Price, 0)
	);
}

export function* question(draft: ITrip): ISelectorGenerator<IAskEntry | undefined> {
	return (yield* pendingAsks(draft)).find((entry) => flightQuestionOf(entry) !== undefined);
}

export type ILegAction = "holdAgain" | "chooseFlight" | "searchAgain";

/** The trip feature's methods a leg card's note can call, in either build. */
export interface ILegActions {
	holdAgain(): Promise<unknown>;
	chooseFlight(): Promise<unknown>;
	searchAgain(legId: string): Promise<unknown>;
}

/** Dispatches the action a leg card's note names, through the view's trip feature. */
export function runLegAction(trip: ILegActions, legId: string, action: ILegAction): void {
	switch (action) {
		case "holdAgain":
			void trip.holdAgain();
			return;
		case "chooseFlight":
			void trip.chooseFlight();
			return;
		case "searchAgain":
			void trip.searchAgain(legId);
			return;
		default:
			action satisfies never;
	}
}

export interface ILegView {
	Badge: {
		Tone: "held" | "stop" | "ask" | "work" | "done" | "";
		Label: string;
	};
	Bar: "" | "ask" | "stop" | "done";
	Progress: number;
	Counted: string;
	Kept: string;
	StillToCheck: number;
	PriceUnit: string;
	Hold: {
		Left: string;
		Fraction: number;
		Detail: string;
	} | null;
	Note: {
		Tone: "stop" | "ask";
		Text: string;
		Action: ILegAction;
		Label: string;
	} | null;
}

function legView(trip: ITrip, leg: ILeg, f: ITripFacts): ILegView {
	const status = f.Statuses[leg.Kind];
	const flights = leg.Kind === "flights";
	const held = flights && f.Holding;
	const lapsed = flights && f.Lapsed;
	const asking = flights && status === "done" && (f.QuestionOpen || f.NeedsChoice);
	const badge: ILegView["Badge"] = held
		? {
				Tone: "held",
				Label: "Held"
			}
		: lapsed
			? {
					Tone: "stop",
					Label: "Hold ran out"
				}
			: asking
				? {
						Tone: "ask",
						Label: "Your call"
					}
				: status === "searching"
					? {
							Tone: "work",
							Label: "Searching"
						}
					: status === "failed"
						? {
								Tone: "stop",
								Label: "Failed"
							}
						: status === "done"
							? {
									Tone: "done",
									Label: "Done"
								}
							: {
									Tone: "",
									Label: "Not started"
								};
	let note: ILegView["Note"] = null;
	if (lapsed) {
		note = {
			Tone: "stop",
			Text: `The hold on the ${trip.Choice?.Carrier} fare ran out.`,
			Action: "holdAgain",
			Label: "Hold again"
		};
	} else if (flights && f.NeedsChoice) {
		note = {
			Tone: "ask",
			Text: "The reload closed the question. Its fares are kept.",
			Action: "chooseFlight",
			Label: "Choose a flight"
		};
	} else if (status === "failed") {
		note = {
			Tone: "stop",
			Text:
				leg.Kind === "activities"
					? `Failed at provider ${leg.Checked + 1} of ${leg.Total}.`
					: leg.Checked > 0
						? `This search failed. Its ${flights ? "fares" : "quotes"} are kept.`
						: "This search failed.",
			Action: "searchAgain",
			Label: "Search again"
		};
	} else if (status === "waiting") {
		note = {
			Tone: "ask",
			Text: "This search hasn't started.",
			Action: "searchAgain",
			Label: "Search"
		};
	}
	return {
		Badge: badge,
		Bar: asking ? "ask" : status === "failed" ? "stop" : status === "done" ? "done" : "",
		Progress: leg.Total === 0 ? 0 : leg.Checked / leg.Total,
		Counted: counted(leg),
		Kept: kept(leg),
		StillToCheck: leg.Kind === "hotel" && status === "searching" ? leg.Total - leg.Checked : 0,
		PriceUnit: leg.Kind === "hotel" ? "night" : "",
		Hold:
			held && trip.Choice
				? {
						Left: clock(f.HoldLeft),
						Fraction: f.HoldLeft / HOLD_SECONDS,
						Detail: `${trip.Choice.Carrier} · ${trip.Choice.Slot.toLowerCase()} · ${money(trip.Choice.Price * DESTINATIONS[trip.Destination].Travellers)} for ${DESTINATIONS[trip.Destination].TravellersWord}`
					}
				: null,
		Note: note
	};
}

function counted(leg: ILeg): string {
	switch (leg.Kind) {
		case "flights":
			return `${leg.Checked} of ${leg.Total} carriers · ${leg.Found} fares`;
		case "hotel":
			return `${leg.Checked} of ${leg.Total} hotels checked`;
		case "activities":
			return `${leg.Checked} of ${leg.Total} providers`;
		default:
			return leg.Kind satisfies never;
	}
}

function kept(leg: ILeg): string {
	if (leg.Kind === "flights") return leg.Done ? `Narrowed to ${leg.Fares.length}` : "";
	if (leg.Kind === "hotel") return leg.Picks.length > 0 ? "Best so far" : "";
	return plural(leg.Picks.length, "pick");
}

export function* legViews(draft: ITrip): ISelectorGenerator<Record<ILegKind, ILegView>> {
	const f = yield* tripFacts(draft);
	const views = {} as Record<ILegKind, ILegView>;
	for (const leg of draft.Legs) views[leg.Kind] = legView(draft, leg, f);
	return views;
}

function partOfDay(hour: number): string {
	if (hour >= 5 && hour < 12) return "morning";
	if (hour >= 12 && hour < 17) return "afternoon";
	if (hour >= 17 && hour < 22) return "evening";
	return "late";
}

export interface IFareOption {
	Fare: IFare;
	Cheaper: boolean;
	Tag: {
		Tone: "" | "amber";
		Text: string;
	};
	Button: string;
}

export interface IFlightOptions {
	Entry: IAskEntry;
	Heading: string;
	Sub: string;
	Options: IFareOption[];
	Meanwhile: string;
}

export function* flightOptions(draft: ITrip): ISelectorGenerator<IFlightOptions | undefined> {
	const entry = yield* question(draft);
	const request = entry && flightQuestionOf(entry);
	if (!entry || !request) return undefined;
	const f = yield* tripFacts(draft);
	const prices = request.Fares.map((fare) => fare.Price);
	const gap = Math.max(...prices) - Math.min(...prices);
	const cheapest = request.Fares.reduce((best, fare) => (fare.Price < best.Price ? fare : best));
	const travellers = DESTINATIONS[draft.Destination].Travellers;
	return {
		Entry: entry,
		Heading: gap === 0 ? "Two good flights at the same price. Which suits you?" : `Two good flights, ${money(gap)} apart. Which suits you?`,
		Sub: `I narrowed ${request.Found} fares to these. Both have one stop and a checked bag each. Picking one holds the fare for 15 minutes.`,
		Options: request.Fares.map((fare) => {
			const cheaper = gap > 0 && fare.Id === cheapest.Id;
			return {
				Fare: fare,
				Cheaper: cheaper,
				Tag: cheaper
					? {
							Tone: "amber",
							Text: `${money(gap * travellers)} cheaper`
						}
					: {
							Tone: "",
							Text: `Arrives ${partOfDay(fare.ArriveHour)}`
						},
				Button: cheaper ? "Choose and hold" : "Choose"
			};
		}),
		Meanwhile: f.Searching.length > 0 ? `${keepGoing(f.Searching)} while you decide.` : ""
	};
}

export interface ITripTip {
	Lead: string;
	Text: string;
}

const tipOf = (lead: string, text: string): ITripTip => ({
	Lead: lead,
	Text: text
});

export function* tip(draft: ITrip): ISelectorGenerator<ITripTip> {
	const f = yield* tripFacts(draft);
	if (f.Searching.length > 0) {
		const each = f.Searching.length === 1 ? "it is" : "each is";
		return tipOf(
			"Try this:",
			`go to the start screen and come back. ${keepGoing(f.Searching)}, because ${each} an entity in the state tree, not a component.`
		);
	}
	if (f.QuestionOpen) {
		return tipOf(
			"Try this:",
			"go to the start screen and come back. The question waits for you, because it is an ask in the state tree, not a dialog."
		);
	}
	if (f.Stopped.length > 0) {
		const found = f.Stopped.some((kind) => (legOf(draft, kind)?.Checked ?? 0) > 0);
		return tipOf(
			"Why:",
			found
				? `each provider's answer is written to its leg as it arrives, so the ${searchesOf(f.Stopped)} kept what ${f.Stopped.length === 1 ? "it" : "they"} found, and searching again starts at the next provider.`
				: `no provider had answered the ${searchesOf(f.Stopped)}, so searching again starts at the first.`
		);
	}
	if (f.NeedsChoice) {
		return tipOf(
			"Why:",
			"a reload asks an open question again only when it can bring back the action that asked it. This time it couldn't, as happens with a save from another build of the page, so it closed the question and kept its fares."
		);
	}
	if (draft.Finished && f.Holding) {
		return tipOf("Try this:", "reload the page. The hold's deadline is in state, so time with the page closed counts too.");
	}
	return tipOf("Why:", "the trip is an entity in the state tree, so what it found stays here until you start over.");
}

export const selectors = {
	flightOptions,
	tip,
	tripFacts,
	headline,
	statusLine,
	dot,
	agentStatus,
	typing,
	soFar,
	question,
	legViews
};
