import type { ISelectorGenerator } from "treflex";
import type { ITodoList } from "./State";

export function* remaining(draft: ITodoList): ISelectorGenerator<number> {
	return draft.Todos.filter((t) => !t.Done).length;
}
