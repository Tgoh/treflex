import { type IActionGenerator, type IEntity, named } from "treflex";

export function* other(draft: IEntity): IActionGenerator {}
named(other, "Utils/Save");
