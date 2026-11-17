import { defineEffect, type IActionGenerator, type IEffect, type IEntity } from "treflex";

interface IRow extends IEntity {
	X: { A?: number };
}

interface IChunk extends IEffect {
	Type: "app/chunk";
	Text: string;
}

const sendChunk = defineEffect<IChunk, void>("app/chunk");

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

export function* dropsAnEffect(): IActionGenerator {
	yield* sendChunk({
		Text: "sent"
	});
	sendChunk({
		Text: "dropped"
	});
}
