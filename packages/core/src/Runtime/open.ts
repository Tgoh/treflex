import type { IActionGenerator, IActionYield, IOpenMark } from "../Types/IAction";
import { TreflexRefusal } from "./refusal";
import { runningStep, stepAction } from "./runningStep";

// `Symbol.for` (the global registry) is load-bearing, not just `Symbol`. If a Vite
// HMR cascade or file:-linked package re-evaluation produces two module instances
// of this file, plain `Symbol(...)` would mint two distinct symbols, and the op
// would dispatch as an effect and hit "no implementation registered".
export const REGION_OP = Symbol.for("treflex.regionOp");

export interface IRegainOp {
	[REGION_OP]: "regain";
}

const REGAIN: IRegainOp = {
	[REGION_OP]: "regain"
};

function* region<R>(gen: IActionGenerator<R>): IActionGenerator<R> {
	const { fiber, name } = stepAction("open");
	if (fiber.branch) {
		throw new TreflexRefusal(
			`[treflex] open: action "${name}" called open(...) in a branch of parallel or parallelSettled. A branch runs inside open(...) or not, ` +
				`as its fan-out does, and can't change that: wrap the whole fan-out, as open(parallel(...)), or start the work ` +
				`(docs/reference/fibers.md#branches-and-the-hold).`
		);
	}
	if (fiber.open) {
		throw new TreflexRefusal(
			`[treflex] open: action "${name}" called open(...) inside open(...). The action is let go at the outer one's first wait ` +
				`and takes the hold back when it ends, so an inner one has nothing to change. Call the inner function with a plain yield*, ` +
				`or split it where its wait meets the draft (docs/reference/actions.md#open-functions).`
		);
	}
	fiber.open = true;
	let left = false;
	try {
		const result = yield* gen;
		left = true;
		fiber.open = false;
		if (!runningStep.retake()) {
			yield REGAIN as unknown as IActionYield;
		}
		return result;
	} catch (error) {
		if (!left) {
			left = true;
			fiber.open = false;
			if (!runningStep.retake()) {
				yield REGAIN as unknown as IActionYield;
			}
		}
		throw error;
	} finally {
		if (!left) {
			fiber.open = false;
		}
	}
}

/**
 * Lets other work on the entity in during the waits of `gen`. The hold goes at `gen`'s first
 * wait, the action's draft throws from then until `gen` ends, because what it read may no longer
 * be true, and the hold comes back when `gen` ends. `gen` can't open, and neither can a branch of
 * `parallel` or `parallelSettled`: an `open(...)` there throws before `gen` runs. Where the action
 * holds nothing, it changes nothing.
 */
export function open<R>(gen: IActionGenerator<R>): Generator<IOpenMark, R, any> {
	return region(gen) as unknown as Generator<IOpenMark, R, any>;
}
