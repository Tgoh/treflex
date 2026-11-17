import { type IActionGenerator, type IEntity, leading } from "treflex";
import { createEntityFeature } from "../feature";

export interface ICard extends IEntity {
	Column: number;
}

export function* move(draft: ICard, column: number): IActionGenerator {
	draft.Column = column;
}
leading(move);

export function* archive(draft: ICard): IActionGenerator {
	draft.Column = -1;
}

export const Card = createEntityFeature<ICard>("App/Kanban")({
	move
});
