import type { IEffect } from "../Types/IEffect";
import type { IFiber } from "./Fiber";
import { OutsideActionError } from "./refusal";

export type IStepAnswer = (effect: IEffect) => unknown;

export type IStepRetake = () => boolean;

export interface IStepAction {
	readonly fiber: IFiber;
	readonly name: string;
	// Absent during a close, where no effect can dispatch.
	readonly answer?: IStepAnswer | undefined;
	// Absent during a close, where no hold is taken back.
	readonly retake?: IStepRetake | undefined;
	// Absent during a close, and for an action that holds no entity.
	readonly hold?: IActionHold | undefined;
	readonly refused?: ((refusal: object) => void) | undefined;
}

export interface IActionHold {
	readonly actionName: string;
	readonly entityId: string;
}

export interface IRunningStep {
	readonly draft: object;
	readonly close: boolean;
	readonly outer: IRunningStep | null;
	readonly action?: IStepAction | undefined;
	// A selector run inside a slice, where open refuses.
	readonly selecting?: true | undefined;
}

interface IRunningStepState {
	current: IRunningStep | null;
}

export { OutsideActionError };

// On globalThis, like effectDeclarations' open sync call: a second evaluation
// of this module must find the slice the first one opened.
const STATE_KEY = "__treflex_running_step__";

function state(): IRunningStepState {
	const g = globalThis as Record<string, unknown>;
	let held = g[STATE_KEY] as IRunningStepState | undefined;
	if (!held) {
		held = {
			current: null
		};
		g[STATE_KEY] = held;
	}
	return held;
}

const shared = state();

// A slice's flush and frame-end drain run with no step current, so a view's draft write there is refused.
export const runningStep = {
	enter(draft: object, close: boolean, action?: IStepAction): IRunningStep {
		const step: IRunningStep = {
			draft,
			close,
			outer: shared.current,
			action
		};
		shared.current = step;
		return step;
	},
	exit(step: IRunningStep): void {
		shared.current = step.outer;
	},
	closing(): boolean {
		return shared.current?.close === true;
	},
	draft(): object | undefined {
		return shared.current?.draft;
	},
	answer(): IStepAnswer | undefined {
		return shared.current?.action?.answer;
	},
	retake(): boolean {
		return shared.current?.action?.retake?.() ?? true;
	},
	refused(refusal: object): void {
		shared.current?.action?.refused?.(refusal);
	},
	selecting<R>(run: () => R): R {
		const outer = shared.current;
		if (!outer?.action) {
			return run();
		}
		const step: IRunningStep = {
			...outer,
			outer,
			selecting: true
		};
		shared.current = step;
		try {
			return run();
		} finally {
			runningStep.exit(step);
		}
	}
};

export function stepAction(call: string): IStepAction {
	const step = shared.current;
	const action = step?.action;
	if (!action || step.selecting) {
		throw new OutsideActionError(call);
	}
	return action;
}
