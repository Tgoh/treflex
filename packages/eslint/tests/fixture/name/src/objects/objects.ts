import { type IActionGenerator, type IEntity, named } from "treflex";
import { runtime } from "../runtime";

export function* tidy(draft: IEntity): IActionGenerator {}

export function* sweep(draft: IEntity): IActionGenerator {}

export const actions = {
	tidy,
	clean: sweep
};
named(actions.tidy, "Object/Clean");
named(actions.clean, "Object/Sweep");

export function dispatchAll(): Promise<unknown[]> {
	return Promise.all([
		runtime.dispatch(tidy, "doc"),
		runtime.dispatch(sweep, "doc")
	]);
}
