import { DEV } from "../Utility/devMode";
import { errorClass } from "../Utility/errorClasses";
import { runningStep } from "./runningStep";

// Symbol.for, so a refusal from a second evaluation of this module (a Vite duplicate load) still answers.
const REFUSAL = Symbol.for("treflex.refusal");

/**
 * A treflex rule the calling code broke, the same whatever the data. A `catch` that can meet one rethrows it.
 * See docs/reference/failure.md#refusals.
 */
export class TreflexRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TreflexRefusal";
		if (DEV) {
			runningStep.refused(this);
		}
	}
}

Object.defineProperty(TreflexRefusal.prototype, REFUSAL, {
	value: true
});

export class OutsideActionError extends TreflexRefusal {
	constructor(call: string) {
		super(
			`[treflex] ${call}(...) ran outside an action. It works on the running action's branch, so yield* it from an action's generator.`
		);
		this.name = "OutsideActionError";
	}
}

errorClass("treflex/TreflexRefusal", TreflexRefusal);
errorClass("treflex/OutsideActionError", OutsideActionError);

export function isRefusal(error: unknown): error is TreflexRefusal {
	if (error === null || typeof error !== "object") {
		return false;
	}
	// A proxy can refuse the read, and this runs on the error path.
	try {
		return (
			(
				error as {
					[REFUSAL]?: unknown;
				}
			)[REFUSAL] === true
		);
	} catch {
		return false;
	}
}
