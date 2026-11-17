import { type IActionGenerator, type IEntity, leading } from "treflex";

export function* stamp(draft: IEntity): IActionGenerator {}
leading(stamp);
