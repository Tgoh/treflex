import { type IActionGenerator, type IEntity, named } from "treflex";
import { move } from "../shared/actions";
import { runtime, save } from "../shared/shared";

function* sync(draft: IEntity): IActionGenerator {}
named(sync, "App/Sync");

named(move, "Tools/Move");

export function run(): Promise<unknown[]> {
	return Promise.all([
		runtime.dispatch(save, "doc"),
		runtime.dispatch(sync, "doc")
	]);
}
