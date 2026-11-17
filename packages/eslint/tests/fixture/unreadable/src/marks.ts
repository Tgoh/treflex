import { type IAction, type IActionGenerator, type IEntity, leading, named } from "treflex";

const FEATURE = "Marks";

function* pay(draft: IEntity): IActionGenerator {}
named(pay, `${FEATURE.toLowerCase()}/Pay`);

declare const ghost: IAction<IEntity>;
named(ghost, "Marks/Ghost");

export function* stamp(draft: IEntity): IActionGenerator {}
leading(stamp);
