import type { IActionGenerator, IEntity } from "treflex";

interface IRow extends IEntity {
	X: { A?: number };
}

declare function work(): IActionGenerator;

export function* yieldsInFinally(): IActionGenerator {
	try {
		yield* work();
	} finally {
		yield* work();
	}
}

export function* editsAfterWrite(draft: IRow): IActionGenerator {
	const x = {};
	draft.X = x;
	x.A = 1;
}

export function* selectorWithoutYield(draft: IRow): Generator<never, number> {
	return draft.X.A ?? 0;
}
