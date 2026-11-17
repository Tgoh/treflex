import type { IActionGenerator, IEntity, IReceiverId, ISelectorGenerator } from "treflex";
import { named, receiver } from "treflex";

export interface ITour extends IEntity {
	readonly $Receiver?: IReceiverId<ITour>;
	Started: boolean;
	Answered: boolean;
	CameBack: boolean;
	Reloaded: boolean;
	TwoAtOnce: boolean;
	Skipped: boolean;
}

export type ITourMark = "Started" | "Answered" | "CameBack" | "Reloaded" | "TwoAtOnce";

export interface ITourStep {
	Mark: ITourMark;
	Label: string;
}

export const TOUR_STEPS: readonly ITourStep[] = [
	{
		Mark: "Started",
		Label: "Start a trip"
	},
	{
		Mark: "Answered",
		Label: "Answer the agent"
	},
	{
		Mark: "CameBack",
		Label: "Leave and come back"
	},
	{
		Mark: "Reloaded",
		Label: "Reload the page"
	},
	{
		Mark: "TwoAtOnce",
		Label: "Run two at once"
	}
];

export function getDefaultState(id: string): ITour {
	return {
		$Id: id,
		$Receiver: TourReceiver.Id,
		Started: false,
		Answered: false,
		CameBack: false,
		Reloaded: false,
		TwoAtOnce: false,
		Skipped: false
	};
}

export function* skipTour(draft: ITour): IActionGenerator {
	draft.Skipped = true;
}
named(skipTour, "Tour/Skip");

export const actions = {
	skipTour
};

export const TourReceiver = receiver<ITour>("TourReceiver")({
	*"Trip/Started"(draft, message) {
		draft.Started = true;
		if (message.OthersRunning) draft.TwoAtOnce = true;
	},
	*"Trip/Answered"(draft) {
		draft.Answered = true;
	},
	*"Trip/CameBack"(draft) {
		draft.CameBack = true;
	},
	*"Portal/Restored"(draft) {
		if (draft.CameBack) draft.Reloaded = true;
	}
});

export function* currentStep(draft: ITour): ISelectorGenerator<number> {
	const index = TOUR_STEPS.findIndex((step) => !draft[step.Mark]);
	return index === -1 ? TOUR_STEPS.length + 1 : index + 1;
}

export const selectors = {
	currentStep
};
