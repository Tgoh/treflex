import type { ISelector } from "../Types/ISelector";
import { TreflexRefusal } from "./refusal";
import { runningStep } from "./runningStep";

// `accessor` scopes nested selects to the caller's sub-slice — the select
// handler composes it with any accessor on the yield (see createRuntime).
export interface IReadContext {
	getState: () => any;
	accessor?: ((state: any) => any) | undefined;
	/** Present for an action's read, nested selects included: collects each `inFlight` answer, for its step record. */
	inFlightAnswers?: boolean[] | undefined;
}

export type IReadHandler = (yielded: any, context: IReadContext) => any;

export function processSelector<S, R>(
	selector: ISelector<S, R>,
	getState: () => any,
	accessor: ((state: any) => any) | undefined,
	processRead: IReadHandler,
	inFlightAnswers?: boolean[]
): R {
	return runningStep.selecting(() => {
		const draft: S = accessor ? accessor(getState()) : (getState() as S);
		const generator = selector(draft);
		let next = generator.next();

		while (!next.done) {
			const yielded = next.value;
			if (!yielded || typeof yielded.Type !== "string") {
				throw new TreflexRefusal("[treflex] Selectors can only yield read objects with a Type property.");
			}

			const value = processRead(yielded, {
				getState,
				accessor,
				inFlightAnswers
			});
			next = generator.next(value);
		}

		return next.value as R;
	});
}
