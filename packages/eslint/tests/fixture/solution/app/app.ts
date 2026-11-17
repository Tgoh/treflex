import type { IActionGenerator, IEntity } from "treflex";
import { move } from "../shared/actions";
import { runtime, save } from "../shared/shared";

export function* load(draft: IEntity): IActionGenerator {}

export function* sync(draft: IEntity): IActionGenerator {}

export function run(): Promise<unknown[]> {
	return Promise.all([
		runtime.dispatch(save, "doc"),
		runtime.dispatch(load, "doc"),
		runtime.dispatch(sync, "doc"),
		runtime.dispatch(move, "doc")
	]);
}
