import type { IActionGenerator } from "treflex";
import type { ITodoList } from "./State";

export function* setDraft(draft: ITodoList, text: string): IActionGenerator {
	draft.Draft = text;
}

export function* add(draft: ITodoList): IActionGenerator {
	draft.Todos.push({ Text: draft.Draft, Done: false });
}
