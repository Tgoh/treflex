import type { ISelectorGenerator } from "treflex";
import type { IReplyStream } from "../chat/Chat";
import type { ITripFacts } from "../trips/Trip";
import type { IPortal } from "./Portal";
import { mapGen } from "treflex";
import { schoolFish } from "../aquarium/Aquarium";
import { streamOf } from "../chat/Chat";
import { conversationLabel } from "../chat/directory";
import { sendStatus } from "../chat/Message";
import { reloadLine } from "../chat/restoreLines";
import * as Tour from "../tour/Tour";
import { awayMark, keepGoing, searchesOf, tripFacts } from "../trips/Trip";

export interface ITourHint {
	Title: string;
	Text: string;
}

interface IHintTrip {
	Name: string;
	Open: boolean;
	Away: boolean;
	Facts: ITripFacts;
}

const hint = (title: string, text: string): ITourHint => ({
	Title: title,
	Text: text
});

const PICK = hint("Pick a destination.", "An agent plans the trip in the background, and asks you when it needs a decision.");

const searching = (trip: IHintTrip): boolean => trip.Facts.Searching.length > 0;
const stopped = (trip: IHintTrip): boolean => trip.Facts.Searching.length === 0 && trip.Facts.Stopped.length > 0;
const wantsYou = (trip: IHintTrip): boolean => trip.Facts.QuestionOpen || trip.Facts.NeedsChoice;

function answerHint(open: IHintTrip | undefined, others: readonly IHintTrip[]): ITourHint {
	if (open && wantsYou(open)) {
		if (!open.Facts.QuestionOpen)
			return hint("The agent wants your call.", "The reload closed its question. Choose a flight to answer it.");
		const meanwhile = searching(open) ? ` ${keepGoing(open.Facts.Searching)} while you decide.` : "";
		return hint("The agent wants your call.", `Choose one of the two flights below.${meanwhile}`);
	}
	const asking = others.find(wantsYou);
	if (asking) return hint("The agent wants your call.", `Open ${asking.Name} in the sidebar to answer its flight question.`);
	const subject = open ?? others.find((t) => t.Facts.FlightsStopped || t.Facts.Statuses.flights === "searching");
	if (!subject) return PICK;
	const where = subject === open ? "" : `Open ${subject.Name} in the sidebar. `;
	if (subject.Facts.FlightsStopped) {
		return hint("Restart the flight search.", `${where}Restart it from the Flights card, and the agent asks you once it finishes.`);
	}
	if (subject.Facts.Statuses.flights === "searching") {
		return hint("Watch the agent work.", `${where}The agent asks you once the flight search finishes.`);
	}
	return hint("Plan another trip.", "This trip's flight search didn't find two good fares to ask you about.");
}

function leaveHint(open: IHintTrip | undefined, others: readonly IHintTrip[], trips: readonly IHintTrip[]): ITourHint {
	const left = trips.find((t) => t.Away);
	if (left) {
		return searching(left)
			? hint("You've left the trip.", `${keepGoing(left.Facts.Searching)} on ${left.Name}. Watch it in the sidebar, then go back to it.`)
			: hint("You've left the trip.", `Go back to ${left.Name} in the sidebar.`);
	}
	if (open && searching(open)) {
		return hint(
			"Leave the trip while it searches.",
			`Go to the start screen or another trip, then come back to this one. ${keepGoing(open.Facts.Searching)} without a view.`
		);
	}
	if (open && stopped(open)) {
		return hint("Restart a search, then leave.", "Restart a search from its card, go to the start screen while it runs, then come back.");
	}
	const elsewhere = others.find(searching) ?? others.find(stopped);
	if (elsewhere && searching(elsewhere)) {
		return hint(
			"Leave a trip while it searches.",
			`Open ${elsewhere.Name}, go to the start screen while it searches, then come back to it.`
		);
	}
	if (elsewhere) {
		return hint(
			"Restart a search, then leave.",
			`Open ${elsewhere.Name}, restart a search from its card, then leave it while it runs and come back.`
		);
	}
	return hint("Leave a trip while it searches.", "Plan a trip, go to the start screen while it runs, then come back to it.");
}

/** What the chat and the aquarium have running, read for the reload hint. */
export interface IHintLive {
	/** A teammate's reply on its way, typing or streaming. */
	Streaming: IReplyStream | null;
	/** Where a message of yours is sending, or null. */
	Sending: string | null;
	/** Fish and giants in the tank. */
	Fish: number;
}

function watchLine(trips: readonly IHintTrip[], live: IHintLive): string {
	const trip = trips.find((t) => searching(t) || t.Facts.QuestionOpen);
	if (trip) {
		const kinds = trip.Facts.Searching;
		return kinds.length > 0
			? `${trip.Name}'s ${searchesOf(kinds)} ${kinds.length === 1 ? "comes" : "come"} back interrupted, with what ${kinds.length === 1 ? "it" : "they"} found kept.`
			: `${trip.Name}'s open question closes, and the agent offers it again.`;
	}
	if (live.Streaming) return reloadLine(live.Streaming);
	if (live.Sending) return `Your message to ${live.Sending} comes back as Didn't send, with Retry.`;
	if (live.Fish === 1) return "The aquarium's fish carries on swimming from where it was.";
	if (live.Fish > 1) return `The aquarium's ${live.Fish} fish carry on swimming from where they were.`;
	return "It comes back as you left it.";
}

function reloadHint(open: IHintTrip | undefined, others: readonly IHintTrip[], live: IHintLive): ITourHint {
	const trips = open
		? [
				open,
				...others
			]
		: others;
	return hint("Reload the page.", `The session is saved in this browser. ${watchLine(trips, live)}`);
}

function twoHint(open: IHintTrip | undefined, others: readonly IHintTrip[]): ITourHint {
	const trips = open
		? [
				open,
				...others
			]
		: others;
	const live = trips.find(searching);
	if (live) {
		const kinds = live.Facts.Searching;
		const whose = live === open ? "this trip's" : `${live.Name}'s`;
		return hint("Run two at once.", `Plan another trip while ${whose} ${searchesOf(kinds)} ${kinds.length === 1 ? "runs" : "run"}.`);
	}
	if (open && stopped(open)) return hint("Run two at once.", "Restart a search from its card, then plan another trip while it runs.");
	const idle = others.find(stopped);
	if (idle) return hint("Run two at once.", `Open ${idle.Name} and restart a search, then plan another trip while it runs.`);
	return hint("Run two at once.", "Start a trip, then plan another while the first is still searching.");
}

function hintFor(step: number, trips: readonly IHintTrip[], live: IHintLive): ITourHint {
	const open = trips.find((t) => t.Open);
	const others = trips.filter((t) => !t.Open);
	switch (step) {
		case 1:
			return PICK;
		case 2:
			return answerHint(open, others);
		case 3:
			return leaveHint(open, others, trips);
		case 4:
			return reloadHint(open, others, live);
		case 5:
			return twoHint(open, others);
		default:
			return hint(
				"That's the tour.",
				"Every app here runs in the state tree, and the views only read it. Keep exploring, or close the tour."
			);
	}
}

export function* tourHint(draft: IPortal): ISelectorGenerator<ITourHint | null> {
	if (draft.Tour.Skipped) return null;
	const step = yield* Tour.currentStep(draft.Tour);
	const planner = draft.Trips;
	const openId = planner.Visible ? planner.OpenTripId : null;
	const trips = yield* mapGen(planner.Trips, function* (trip): ISelectorGenerator<IHintTrip> {
		return {
			Name: trip.Name,
			Open: trip.$Id === openId,
			Away: (yield* awayMark(trip)).Away,
			Facts: yield* tripFacts(trip)
		};
	});
	return hintFor(step, trips, step === 4 ? yield* liveWork(draft) : NOTHING_RUNNING);
}

const NOTHING_RUNNING: IHintLive = {
	Streaming: null,
	Sending: null,
	Fish: 0
};

function* liveWork(draft: IPortal): ISelectorGenerator<IHintLive> {
	const chat = draft.Chat;
	const replying = chat.Conversations.find((c) => c.Reply !== null);
	let sending: string | null = null;
	for (const c of chat.Conversations) {
		const statuses = yield* mapGen(c.Messages, sendStatus);
		if (statuses.includes("sending")) {
			sending = conversationLabel(c.Key);
			break;
		}
	}
	return {
		Streaming: replying ? streamOf(replying) : null,
		Sending: sending,
		Fish: schoolFish(draft.Aquarium) + draft.Aquarium.Giants.length
	};
}
