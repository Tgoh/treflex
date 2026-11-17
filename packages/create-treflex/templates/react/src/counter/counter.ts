import {
	type IActionGenerator,
	type IEntity,
	type ISelectorGenerator,
	leading,
} from "treflex";
import { createEntityFeature } from "treflex-react";
import { delay } from "./effects";

export interface ICounter extends IEntity {
	Count: number;
	Notice: string;
}

export function* increment(draft: ICounter): IActionGenerator {
	yield* delay({ Ms: 1000 });
	draft.Count++;
	draft.Notice = "";
}
leading(increment);

export function* interrupted(draft: ICounter): IActionGenerator {
	draft.Notice = "A reload cut an increment short. Click again to count it.";
}

export function* clicks(draft: ICounter): ISelectorGenerator<string> {
	return draft.Count === 1 ? "1 click" : `${draft.Count} clicks`;
}

export const Counter = createEntityFeature<ICounter>("Counter")(
	{ increment },
	{ clicks },
);
