import type { IMarkable, IOnEntity } from "../Runtime/arrivalPolicy";
import { displayName, nameOf } from "../Runtime/named";
import { argsRedacted } from "../Runtime/redactArgs";

// Symbol.for by the cross-module tag-symbol rule (see REGION_OP in open.ts).
const RESUMABLE = Symbol.for("treflex.resumable");

export function isResumable(fn: unknown): boolean {
	return typeof fn === "function" && (fn as unknown as Record<symbol, unknown>)[RESUMABLE] === true;
}

/**
 * Marks `action` as one a restore may continue from the middle, for every caller, and returns it.
 * It needs the durable name `named` gives, already on the function, and does nothing on a runtime
 * without the `resume` option. See docs/reference/actions.md#the-resumable-mark.
 *
 * @experimental
 */
export function resumable<F extends IMarkable>(action: F & IOnEntity<F>): F {
	if (typeof action !== "function") {
		throw new TypeError("[treflex] resumable(): pass the action function.");
	}
	if (isResumable(action)) {
		throw new Error(
			`[treflex] resumable(): action "${displayName(action)}" is already marked resumable. ` +
				`A function takes the mark once, in the module that defines it.`
		);
	}
	if (argsRedacted(action)) {
		throw new Error(
			`[treflex] resumable(): action "${displayName(action)}" is marked redactArgs, and a restore resumes an action with its saved arguments, ` +
				`which that mark keeps out of the save. A function takes one of the two marks.`
		);
	}
	if (nameOf(action) === null) {
		throw new Error(
			`[treflex] resumable(): action "${displayName(action)}" has no durable name, and a restore finds a resumable action by its name. ` +
				`Name it with named(action, "Feature/Action") before this mark.`
		);
	}
	Object.defineProperty(action, RESUMABLE, {
		value: true
	});
	return action;
}
