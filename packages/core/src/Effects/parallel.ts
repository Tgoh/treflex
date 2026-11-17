import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";

export interface IParallelEffect extends IEffect {
	Type: "parallel";
	Generators: Generator[];
}

type ParallelResults<T extends IActionGenerator<any>[]> = {
	[K in keyof T]: T[K] extends Generator<any, infer R, any> ? R : never;
};

/**
 * Runs each generator as a branch and resumes with their results once every branch has ended. A
 * branch that throws stops the others, and the first failure is rethrown once they have ended. A
 * branch can't open or ask.
 */
export function* parallel<T extends IActionGenerator<any>[]>(
	...generators: [
		...T
	]
): IActionGenerator<ParallelResults<T>> {
	const result = yield {
		Type: "parallel",
		Generators: generators
	};
	return result as ParallelResults<T>;
}
