import type { IEntity } from "treflex";
import { createEntityFeature } from "../feature";

export const Counter = createEntityFeature<IEntity>("App/Methods")({
	*bump(draft: IEntity) {}
});
