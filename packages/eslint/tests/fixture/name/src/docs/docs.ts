import type { IActionGenerator, IEntity } from "treflex";
import { publish } from "@ws/docs";
import { runtime } from "../runtime";

export function* save(draft: IEntity): IActionGenerator {}

export function dispatchBoth(): Promise<unknown[]> {
	return Promise.all([
		runtime.dispatch(save, "doc"),
		runtime.dispatch(publish, "doc")
	]);
}
