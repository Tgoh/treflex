import * as T from "treflex";

export const Busy = T.workTag("Busy");

export function* load(draft: T.IEntity): T.IActionGenerator {}
Busy.mark(load);
