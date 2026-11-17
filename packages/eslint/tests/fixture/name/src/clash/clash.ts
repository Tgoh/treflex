import { type IActionGenerator, type IEntity, named } from "treflex";
import { runtime } from "../runtime";

interface IDoc extends IEntity {
	N: number;
}

function* other(draft: IDoc): IActionGenerator {
	draft.N--;
}
named(other, "Clash/Save");

export function* save(draft: IDoc): IActionGenerator {
	draft.N++;
}

export function* saveDraft(draft: IDoc): IActionGenerator {
	draft.N++;
}

export function* save_draft(draft: IDoc): IActionGenerator {
	draft.N--;
}

export function dispatchAll(): Promise<unknown[]> {
	return Promise.all([
		runtime.dispatch(other, "doc"),
		runtime.dispatch(save, "doc"),
		runtime.dispatch(saveDraft, "doc"),
		runtime.dispatch(save_draft, "doc")
	]);
}
