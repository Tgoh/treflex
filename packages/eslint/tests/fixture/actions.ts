import { type IActionGenerator, type IEntity, named } from "treflex";

export interface IDoc extends IEntity {
	N: number;
}

export function* elsewhere(draft: IDoc): IActionGenerator {
	draft.N++;
}

export function* namedElsewhere(draft: IDoc): IActionGenerator {
	draft.N++;
}
named(namedElsewhere, "Fixture/NamedElsewhere");

export const actions = {
	elsewhere,
	renamed: namedElsewhere
};
