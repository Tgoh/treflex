import type { IActionGenerator, IEntity } from "treflex";
import { other } from "../../vendor/utils/lib";
import { runtime } from "../runtime";

export function* save(draft: IEntity): IActionGenerator {}

export function dispatchBoth(): Promise<unknown[]> {
	return Promise.all([
		runtime.dispatch(save, "doc"),
		runtime.dispatch(other, "doc")
	]);
}
