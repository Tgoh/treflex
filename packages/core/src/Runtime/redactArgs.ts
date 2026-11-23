import type { IMarkable, IOnEntity } from "./arrivalPolicy";
import { isResumable } from "../Resume/resumable";
import { DEV } from "../Utility/devMode";
import { displayName, receiverOf } from "./named";
import { hasArrived } from "./workTag";

// Symbol.for by the cross-module tag-symbol rule (see REGION_OP in open.ts).
const ARGS_REDACTED = Symbol.for("treflex.argsRedacted");

export function argsRedacted(fn: unknown): boolean {
	return typeof fn === "function" && (fn as unknown as Record<symbol, unknown>)[ARGS_REDACTED] === true;
}

/**
 * Marks `action` so that its records carry none of its arguments, for every caller, and returns it.
 * The action still receives them. A marked action can't be `resumable`. Call it in the module that
 * defines the action, once. See docs/reference/actions.md#the-redactargs-mark.
 */
export function redactArgs<F extends IMarkable>(action: F & IOnEntity<F>): F {
	if (typeof action !== "function") {
		throw new TypeError("[treflex] redactArgs(): pass the action function.");
	}
	const label = displayName(action);
	if (receiverOf(action) !== undefined) {
		throw new Error(
			`[treflex] redactArgs(): "${label}" is a receiver's handle, which takes no redactArgs mark: a message is recorded where it was sent. ` +
				`Send a handle, and have the case fetch the secret through a redacted effect.`
		);
	}
	if (argsRedacted(action)) {
		throw new Error(
			`[treflex] redactArgs(): action "${label}" is already marked redactArgs. ` +
				`A function takes the mark once, in the module that defines it.`
		);
	}
	if (isResumable(action)) {
		throw new Error(
			`[treflex] redactArgs(): action "${label}" is marked resumable, and a restore resumes an action with its saved arguments, ` +
				`which this mark keeps out of the save. A function takes one of the two marks.`
		);
	}
	if (DEV && hasArrived(action)) {
		throw new Error(
			`[treflex] redactArgs(): action "${label}" has already been dispatched or delivered, so the records made before this mark ` +
				`carry its arguments. Mark it in the module that defines it, straight after its declaration.`
		);
	}
	Object.defineProperty(action, ARGS_REDACTED, {
		value: true
	});
	return action;
}
