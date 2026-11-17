import type { IActionYield, IOpenMark } from "../Types/IAction";
import type { IEntity } from "../Types/IEntity";
import { ARRIVAL_POLICY, type IArrivalPolicy, policyOf } from "./arrivals";

export type IMarkable = (draft: never, ...args: never[]) => Generator<IActionYield | IOpenMark, unknown, any>;

export type IOnEntity<F> = F extends (draft: infer S, ...args: any[]) => unknown ? (S extends IEntity ? unknown : never) : never;

function mark<F extends Function>(action: F, policy: IArrivalPolicy): F {
	if (typeof action !== "function") {
		throw new TypeError(`[treflex] ${policy.kind}(): pass the action function.`);
	}
	const marked = policyOf(action);
	if (marked) {
		throw new Error(
			`[treflex] ${policy.kind}(): action "${action.name || "(anonymous)"}" is already marked ${marked.kind}. ` +
				`A function takes one mark, once, in the module that defines it.`
		);
	}
	Object.defineProperty(action, ARRIVAL_POLICY, {
		value: policy
	});
	return action;
}

/**
 * Marks `action` so that an arrival on an owner where it is already running or queued is dropped:
 * the dispatch resolves `undefined` and runs nothing. Returns `action` itself, marked for every
 * caller. See docs/reference/actions.md#arrival-marks.
 */
export function leading<F extends IMarkable>(action: F & IOnEntity<F>): F {
	return mark(action, {
		kind: "leading"
	});
}

/**
 * Marks `action` so that an arrival on an owner stops its running or queued instance there, and
 * the newest one wins. Returns `action` itself, marked for every caller.
 */
export function latest<F extends IMarkable>(action: F & IOnEntity<F>): F {
	return mark(action, {
		kind: "latest"
	});
}
