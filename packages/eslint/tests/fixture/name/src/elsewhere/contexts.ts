import { named } from "treflex";
import { runtime } from "../runtime";
import * as State from "./state";
import { retry } from "./state";

named(retry, "Elsewhere/RetryMessage");
named(State.hop, "Elsewhere/Jump");

export function dispatchBoth(): Promise<unknown[]> {
	return Promise.all([
		runtime.dispatch(retry, "doc"),
		runtime.dispatch(State.hop, "doc")
	]);
}
