import type { ISelector } from "../Types/ISelector";
import type { IExternalRead } from "./createExternalTable";
import { TreflexRefusal } from "./refusal";
import { runningStep } from "./runningStep";

/** An action's external reads, nested selects' included. */
export interface IActionExternalReads {
	readonly answers: IExternalRead[];
	/** The action's frozen copy of a value read, as every action read copies. */
	copy(value: unknown, key: string): unknown;
}

export interface IReadContext {
	getState: () => any;
	accessor?: ((state: any) => any) | undefined;
	/** Present for an action's read, nested selects included: collects each `inFlight` answer, for its step record. */
	inFlightAnswers?: boolean[] | undefined;
	/** Present for an action's read, nested selects included: copies each `external` answer and collects it, for its step record. */
	externalReads?: IActionExternalReads | undefined;
}

export type IReadHandler = (yielded: any, context: IReadContext) => any;

export function processSelector<S, R>(
	selector: ISelector<S, R>,
	getState: () => any,
	accessor: ((state: any) => any) | undefined,
	processRead: IReadHandler,
	inFlightAnswers?: boolean[],
	externalReads?: IActionExternalReads
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
				inFlightAnswers,
				externalReads
			});
			next = generator.next(value);
		}

		return next.value as R;
	});
}
