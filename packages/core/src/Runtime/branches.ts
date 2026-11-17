import type { IParallelEffect } from "../Effects/parallel";
import type { IBranchOutcome, IParallelSettledEffect } from "../Effects/parallelSettled";
import type { IFiber } from "./Fiber";
import { stopFiber } from "./Fiber";
import { TreflexRefusal } from "./refusal";

export interface IBranchGroup {
	readonly fibers: IFiber[];
	failed: boolean;
	// Called synchronously at a branch's failing terminal, so a sibling still to
	// start in the same loop starts stopped.
	fail(error: unknown): void;
}

export type IBranchEnd =
	| {
			ok: true;
			value: unknown;
	  }
	| {
			ok: false;
			error: unknown;
	  };

export type IStartBranch = (generator: Generator<unknown, unknown>, group: IBranchGroup, ended: (end: IBranchEnd) => void) => void;

function generatorsOf(effect: IParallelEffect | IParallelSettledEffect): Generator<unknown, unknown>[] {
	const generators: unknown = effect.Generators;
	if (!Array.isArray(generators)) {
		throw new TreflexRefusal(`[treflex] ${effect.Type}: yield* ${effect.Type}(...gens) with the generators to run as branches.`);
	}
	return generators as Generator<unknown, unknown>[];
}

function whenAllEnded(count: number, settle: (end: IBranchEnd) => void, result: () => IBranchEnd): () => void {
	let pending = count;
	if (pending === 0) {
		settle(result());
	}
	return () => {
		if (--pending === 0) {
			settle(result());
		}
	};
}

function runParallel(generators: Generator<unknown, unknown>[], start: IStartBranch, settle: (end: IBranchEnd) => void): void {
	const fibers: IFiber[] = [];
	const results: unknown[] = new Array(generators.length);
	let firstFailure: unknown;
	const group: IBranchGroup = {
		fibers,
		failed: false,
		fail(error) {
			if (!group.failed) {
				group.failed = true;
				firstFailure = error;
				for (const fiber of fibers) {
					stopFiber(fiber, "group");
				}
			}
		}
	};
	const ended = whenAllEnded(generators.length, settle, () =>
		group.failed
			? {
					ok: false,
					error: firstFailure
				}
			: {
					ok: true,
					value: results
				}
	);
	generators.forEach((generator, index) => {
		start(generator, group, (end) => {
			if (end.ok) {
				results[index] = end.value;
			} else {
				group.fail(end.error);
			}
			ended();
		});
	});
}

function runParallelSettled(
	generators: Generator<unknown, unknown>[],
	start: IStartBranch,
	handedBack: (error: unknown) => void,
	settle: (end: IBranchEnd) => void
): void {
	const group: IBranchGroup = {
		fibers: [],
		failed: false,
		fail() {}
	};
	const outcomes: IBranchOutcome<unknown>[] = new Array(generators.length);
	const ended = whenAllEnded(generators.length, settle, () => ({
		ok: true,
		value: outcomes
	}));
	generators.forEach((generator, index) => {
		start(generator, group, (end) => {
			if (end.ok) {
				outcomes[index] = {
					ok: true,
					value: end.value
				};
			} else {
				handedBack(end.error);
				outcomes[index] = {
					ok: false,
					error: end.error
				};
			}
			ended();
		});
	});
}

/**
 * Starts the branches at once, each running its first slice now; `settle` hears the outcome once every
 * branch has ended. `handedBack` hears each branch failure `parallelSettled` returns to the action's code.
 */
export function runFanOut(
	effect: IParallelEffect | IParallelSettledEffect,
	start: IStartBranch,
	handedBack: (error: unknown) => void,
	settle: (end: IBranchEnd) => void
): void {
	const generators = generatorsOf(effect);
	if (effect.Type === "parallel") {
		runParallel(generators, start, settle);
	} else {
		runParallelSettled(generators, start, handedBack, settle);
	}
}
