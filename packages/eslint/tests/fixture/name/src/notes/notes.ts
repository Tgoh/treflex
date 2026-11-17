import type { IActionGenerator, IEntity } from "treflex";

export interface INote extends IEntity {
	Text: string;
}

export function* edit(draft: INote, text: string): IActionGenerator {
	draft.Text = text;
}

export function* clear(draft: INote): IActionGenerator {
	draft.Text = "";
}

export const actions = {
	edit,
	clear
};
