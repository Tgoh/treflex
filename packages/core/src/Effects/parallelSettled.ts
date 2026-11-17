import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";

export interface IParallelSettledEffect extends IEffect {
	Type: "parallelSettled";
	Generators: Generator[];
}

export type IBranchOutcome<R> =
	| {
			ok: true;
			value: R;
	  }
	| {
			ok: false;
			error: unknown;
	  };

type ParallelSettledResults<T extends IActionGenerator<any>[]> = {
	[K in keyof T]: T[K] extends Generator<any, infer R, any> ? IBranchOutcome<R> : never;
};

/**
 * Runs each generator as a branch and resumes once every branch has ended, with each one's
 * outcome in order. A failing branch stops none of the others. A branch can't open or ask.
 */
export function* parallelSettled<T extends IActionGenerator<any>[]>(
	...generators: [
		...T
	]
): IActionGenerator<ParallelSettledResults<T>> {
	const result = yield {
		Type: "parallelSettled",
		Generators: generators
	};
	return result as ParallelSettledResults<T>;
}
