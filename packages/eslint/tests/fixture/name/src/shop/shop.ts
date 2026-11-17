import { type IActionGenerator, type IEntity, named } from "treflex";
import { runtime } from "../runtime";

const SHOP = "Shop";
const PAY = "Shop/Pay";

function* settle(draft: IEntity): IActionGenerator {}
named(settle, PAY);

function* giveBack(draft: IEntity): IActionGenerator {}
named(giveBack, `${SHOP}/Refund`);

export function* pay(draft: IEntity): IActionGenerator {}

export function* refund(draft: IEntity): IActionGenerator {}

export function dispatchAll(): Promise<unknown[]> {
	return Promise.all([
		runtime.dispatch(settle, "doc"),
		runtime.dispatch(giveBack, "doc"),
		runtime.dispatch(pay, "doc"),
		runtime.dispatch(refund, "doc")
	]);
}
