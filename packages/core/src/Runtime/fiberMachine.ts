import type { IEffect } from "../Types/IEffect";
import type { IRecordChange } from "../Types/IRecord";
import type { IExternalRead } from "./createExternalTable";
import type { ISliceHooks } from "./createWriteGateway";
import type { IFiberContext } from "./processAction";
import { host } from "../Solid/host";
import { serializeThrow } from "../Utility/serializeThrow";
import { externalAnswer } from "./createExternalTable";
import { copyEffectInput } from "./crossing";
import { isRedacted } from "./effectDeclarations";
import { NonPlainDataError, PROMISE_OR_THENABLE } from "./nonPlainDataError";
import { type IRegainOp, REGION_OP } from "./open";
import { copyYield, isRead, journalDescriptor, journalResponse } from "./operations";
import { runningStep } from "./runningStep";

// Classification (advance) and settlement (settle) stay separate transitions:
// the driver's stop gate sits between a resume slice and the next yield's
// classification, and another action's slice can stop this fiber across
// the dispatch. Folding classification into settle would append records the
// live run never showed.

function isRegainOp(yielded: unknown): yielded is IRegainOp {
	return !!yielded && typeof yielded === "object" && REGION_OP in yielded;
}

// A value whose `then` can't be read counts as one, so the read can't throw out of the wake.
function isPromiseLike(value: unknown): boolean {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) {
		return false;
	}
	try {
		return (
			typeof (
				value as {
					then?: unknown;
				}
			).then === "function"
		);
	} catch {
		return true;
	}
}

// The intrinsic `then`, not the value's own: it throws for anything but a native promise.
function markHandled(value: unknown): void {
	try {
		Promise.prototype.then.call(value, undefined, () => {});
	} catch {}
}

export const FINALLY_YIELD_LIMIT = 100;

export const REFUSAL_LIMIT = 100;

/** What a slice's resuming read answered from outside the tree, each list absent when empty. */
interface IStepAnswers {
	readonly inFlight?: readonly boolean[] | undefined;
	readonly external?: readonly IExternalRead[] | undefined;
}

function stepAnswers(input: IFiberSettleInput): IStepAnswers | undefined {
	const inFlight = input.inFlightAnswers?.length ? input.inFlightAnswers : undefined;
	const external = input.externalAnswers?.length ? input.externalAnswers : undefined;
	return inFlight || external
		? {
				inFlight,
				external
			}
		: undefined;
}

// The Cancelling, InFlightAnswers and ExternalAnswers keys are absent, not false or empty, on ordinary
// steps, so serialized forms agree field-for-field.
function journalStep<T>(ctx: IFiberContext<T>, changes: IRecordChange[] | null, cancelling?: true, answers?: IStepAnswers): void {
	if (!changes || (changes.length === 0 && answers === undefined)) {
		return;
	}
	ctx.env.journal.append({
		T: performance.now(),
		Kind: "step",
		ActionId: ctx.env.actionId,
		BranchId: ctx.fiber.id,
		Changes: changes,
		...(cancelling
			? {
					Cancelling: true
				}
			: {}),
		...(answers?.inFlight === undefined
			? {}
			: {
					InFlightAnswers: [
						...answers.inFlight
					]
				}),
		...(answers?.external === undefined
			? {}
			: {
					ExternalAnswers: answers.external.map(externalAnswer)
				})
	});
}

function stepGenerator<T>(
	ctx: IFiberContext<T>,
	journalPending: IRecordChange[] | null,
	fn: () => IteratorResult<unknown, unknown>,
	hooks: ISliceHooks
): IteratorResult<unknown, unknown> {
	const recording = ctx.env.recording;
	const run = (): IteratorResult<unknown, unknown> => {
		const prevJournalChanges = recording.currentJournalChanges;
		recording.currentJournalChanges = journalPending;
		try {
			return host.batch(() => {
				const step = runningStep.enter(recording, false, ctx.step);
				try {
					return fn();
				} finally {
					runningStep.exit(step);
				}
			});
		} finally {
			recording.currentJournalChanges = prevJournalChanges;
		}
	};
	const gateway = ctx.env.gateway;
	return gateway ? gateway.actionFrame(run, ctx.fiber, hooks) : run();
}

function sliceEnd(ended: IteratorResult<unknown, unknown> | undefined): string {
	if (!ended) {
		return "the step ending in a throw";
	}
	if (ended.done) {
		return "the step ending at its return";
	}
	if (isRegainOp(ended.value)) {
		return "the step ending at the end of open(...)";
	}
	const type = (ended.value as Partial<IEffect> | null | undefined)?.Type;
	// entity() mints through this yield, and its caller wrote entity(), not the effect.
	if (type === "generateGuid") {
		return "the step ending at an entity() call";
	}
	return typeof type === "string" ? `the step ending at the yield of "${type}"` : "the step ending at a yield";
}

export type IFiberSettleInput =
	| {
			verb: "next";
			value: unknown;
			/** The `inFlight` answers a read gave, for the step it resumes. */
			inFlightAnswers?: readonly boolean[];
			/** The `external` answers a read gave, for the step it resumes. */
			externalAnswers?: readonly IExternalRead[];
	  }
	| {
			verb: "throw";
			error: unknown;
			/** The `inFlight` answers a read gave before it threw. */
			inFlightAnswers?: readonly boolean[];
			/** The `external` answers a read gave before it threw. */
			externalAnswers?: readonly IExternalRead[];
	  };

export type IFiberSettleOutcome =
	| {
			kind: "stepped";
	  }
	| {
			kind: "done";
			value: unknown;
	  }
	| {
			kind: "cancelled";
	  }
	| {
			kind: "errored";
			error: unknown;
	  };

export type IFiberAdvanceOutcome =
	| IFiberSettleOutcome
	| {
			kind: "effect";
			effect: IEffect;
	  }
	| {
			kind: "read";
			yielded: unknown;
	  }
	| {
			kind: "regain";
	  };

export type IFiberPosition = "created" | "running" | "awaiting" | "done" | "cancelled" | "errored";

export interface IFiberMachine {
	readonly position: IFiberPosition;
	readonly result: unknown;
	start(): IFiberSettleOutcome;
	advance(): IFiberAdvanceOutcome;
	settle(input: IFiberSettleInput): IFiberSettleOutcome;
	abort(): void;
}

interface IAwaiting {
	effect: IEffect;
	// Resolved once at the effect record, so the settlement record agrees.
	redact: boolean;
	journalingEffect: boolean;
	// 0 means no effect record landed: Seq starts at 1, and the descriptor's
	// copy or record can throw before the append.
	effectSeq: number;
	effectStart: number;
	settled: boolean;
}

// A response names its effect record by Seq, so the two are made together for a tap of either.
function journalsEffects<T>(ctx: IFiberContext<T>): boolean {
	return ctx.env.journaling.effect || ctx.env.journaling.response;
}

function recordEffect<T>(ctx: IFiberContext<T>, aw: IAwaiting): void {
	aw.redact = isRedacted(aw.effect.Type);
	aw.effectSeq = ctx.env.journal.append({
		T: aw.effectStart,
		Kind: "effect",
		ActionId: ctx.env.actionId,
		BranchId: ctx.fiber.id,
		Type: aw.effect.Type,
		Descriptor: journalDescriptor(aw.effect, aw.redact)
	});
}

function recordSettlement<T>(ctx: IFiberContext<T>, aw: IAwaiting, yieldResult: unknown): void {
	// A void settlement omits the Value key: settlement variants
	// discriminate on the presence of `Error`, never `Value`.
	const settlementValue = journalResponse(aw.effect, aw.redact, yieldResult);
	const settlementT = performance.now();
	const live = aw.redact
		? {
				duration: settlementT - aw.effectStart
			}
		: {
				result: yieldResult,
				duration: settlementT - aw.effectStart
			};
	ctx.env.journal.append(
		settlementValue === undefined
			? {
					T: settlementT,
					Kind: "response",
					ForSeq: aw.effectSeq
				}
			: {
					T: settlementT,
					Kind: "response",
					ForSeq: aw.effectSeq,
					Value: settlementValue
				},
		live
	);
	aw.settled = true;
}

function recordFailure<T>(ctx: IFiberContext<T>, aw: IAwaiting, effectError: unknown): void {
	if (aw.journalingEffect && aw.effectSeq > 0 && !aw.settled) {
		const settlementT = performance.now();
		const duration = settlementT - aw.effectStart;
		ctx.env.journal.append(
			{
				T: settlementT,
				Kind: "response",
				ForSeq: aw.effectSeq,
				Error: aw.redact
					? {
							Thrown: "redacted"
						}
					: serializeThrow(effectError)
			},
			aw.redact
				? {
						duration
					}
				: {
						error: effectError,
						duration
					}
		);
	}
}

/**
 * Dispatches a `settles: "sync"` effect from inside the open step, for `reconcileRows`: the same
 * copy and records as a yield, with no frame end and no flush.
 */
export function answerInStep<T>(ctx: IFiberContext<T>, yielded: IEffect, dispatch: (effect: IEffect) => IFiberSettleInput): unknown {
	const aw: IAwaiting = {
		effect: copyEffectInput(yielded),
		redact: false,
		journalingEffect: journalsEffects(ctx),
		effectSeq: 0,
		effectStart: performance.now(),
		settled: false
	};
	if (aw.journalingEffect) {
		recordEffect(ctx, aw);
	}
	let input: IFiberSettleInput;
	try {
		input = dispatch(aw.effect);
	} catch (error) {
		input = {
			verb: "throw",
			error
		};
	}
	if (input.verb === "throw") {
		recordFailure(ctx, aw, input.error);
		throw input.error;
	}
	if (aw.journalingEffect) {
		recordSettlement(ctx, aw, input.value);
	}
	return input.value;
}

// A root's builder runs inside slice zero, so a construction throw is an
// action-body error like any other first-slice throw.
export function createFiberMachine<T>(
	ctx: IFiberContext<T>,
	source: Generator<unknown, unknown, unknown> | (() => Generator<unknown, unknown, unknown>)
): IFiberMachine {
	let generator: Generator<unknown, unknown, unknown> | null = typeof source === "function" ? null : source;
	let position: IFiberPosition = "created";
	let result: unknown;
	let next!: IteratorResult<unknown, unknown>;
	let awaiting: IAwaiting | null = null;
	let opPending = false;

	function cancel(): {
		kind: "cancelled";
	} {
		if (position !== "cancelled") {
			closeGenerator(true);
			ctx.fiber.status = "cancelled";
			position = "cancelled";
		}
		return {
			kind: "cancelled"
		};
	}

	function reportCloseThrow(closeError: unknown, stopped: boolean): void {
		ctx.env.refusalOut(closeError);
		ctx.env.closeThrew(ctx.fiber, closeError, stopped);
	}

	function throwIn(error: unknown): IteratorResult<unknown, unknown> {
		ctx.env.refusalIn(error);
		return generator!.throw(error);
	}

	// One frame for the whole close, so a refusal undoes every finally block in it.
	function closeGenerator(stopped: boolean): void {
		const recording = ctx.env.recording;
		const closeChanges: IRecordChange[] | null = ctx.env.journaling.step ? [] : null;
		let threw = false;
		let refusal: Error | null = null;
		let release: (() => void) | null = null;
		const run = () => {
			const diag = ctx.env.emitDiag;
			const prevJournalChanges = recording.currentJournalChanges;
			recording.currentJournalChanges = closeChanges;
			const step = runningStep.enter(recording, true, ctx.closeStep);
			try {
				let r = generator?.return(undefined);
				let answered = 0;
				while (r && !r.done) {
					if (++answered > FINALLY_YIELD_LIMIT) {
						diag({
							severity: "warn",
							code: "cancel/finally-yield-limit",
							message:
								`[treflex] Action "${ctx.env.actionName}": its finally blocks yielded more than ${FINALLY_YIELD_LIMIT} times while its generator was being closed, ` +
								`so the generator was abandoned with the rest of its finally blocks unrun.`,
							data: {
								actionName: ctx.env.actionName,
								branchId: ctx.fiber.id
							}
						});
						break;
					}
					const yieldedType = (r.value as IEffect | undefined)?.Type;
					diag({
						severity: "warn",
						code: "cancel/finally-yield",
						message:
							`[treflex] Action "${ctx.env.actionName}" yielded ${yieldedType ? `"${yieldedType}"` : "a value"} from a finally block while its generator was being closed. ` +
							`Effects cannot be dispatched during a close, so the rest of that finally block was skipped; outer finally blocks still run. ` +
							`Move cleanup that needs an effect to an action that outlives it — see fibers.md.`,
						data: {
							actionName: ctx.env.actionName,
							branchId: ctx.fiber.id,
							yieldedType: yieldedType ?? null
						}
					});
					r = generator?.return(undefined);
				}
			} catch (closeError) {
				threw = true;
				reportCloseThrow(closeError, stopped);
			} finally {
				recording.currentJournalChanges = prevJournalChanges;
				runningStep.exit(step);
			}
		};
		const gateway = ctx.env.gateway;
		try {
			if (gateway) {
				gateway.actionFrame(run, ctx.fiber, {
					endedAt: () => "its close",
					rolledBack: (error) => {
						refusal = error;
					},
					release: (settle) => {
						release = settle;
					}
				});
			} else {
				run();
			}
		} catch (error) {
			if (error !== refusal) {
				throw error;
			}
			if (!threw) {
				reportCloseThrow(error, stopped);
			}
		} finally {
			// After the frame, so the records land on a tree the index has
			// reconciled.
			if (!refusal) {
				journalStep(ctx, closeChanges, true);
			}
			(release as (() => void) | null)?.();
		}
	}

	// The Error record must land before the generator.throw slice: journal order
	// is delivery order.
	function settleError(effectError: unknown, aw: IAwaiting): IFiberSettleOutcome | null {
		recordFailure(ctx, aw, effectError);
		return ctx.fiber.stopped ? cancel() : null;
	}

	function runSlice(
		fn: () => IteratorResult<unknown, unknown>,
		readAnswers?: IStepAnswers
	):
		| {
				kind: "result";
				r: IteratorResult<unknown, unknown>;
		  }
		| {
				kind: "errored";
				error: unknown;
		  } {
		let body = fn;
		let answers = readAnswers;
		let refusals = 0;
		let r!: IteratorResult<unknown, unknown>;
		// A refusal at a yield is thrown into the generator there, as a slice of its own.
		while (true) {
			const stepJournal: IRecordChange[] | null = ctx.env.journaling.step ? [] : null;
			let ended: IteratorResult<unknown, unknown> | undefined;
			let refusal: Error | null = null;
			let release: (() => void) | null = null;
			const run = body;
			const slice = (): IteratorResult<unknown, unknown> => {
				next = run();
				ended = next;
				return next;
			};
			try {
				try {
					r = stepGenerator(ctx, stepJournal, slice, {
						endedAt: () => sliceEnd(ended),
						rolledBack: (error) => {
							refusal = error;
						},
						release: (settle) => {
							release = settle;
						}
					});
				} finally {
					// A refused slice's answers were still read, so they stay on a record of their own.
					journalStep(ctx, refusal ? (answers && stepJournal ? [] : null) : stepJournal, undefined, answers);
					(release as (() => void) | null)?.();
				}
			} catch (error) {
				const reached = ended as IteratorResult<unknown, unknown> | undefined;
				if (refusal !== null && error === refusal && reached && !reached.done) {
					if (++refusals > REFUSAL_LIMIT) {
						reportRefusalLoop(error as Error);
						return failSlice(error);
					}
					body = () => throwIn(error);
					answers = undefined;
					continue;
				}
				return failSlice(error);
			}
			break;
		}
		return {
			kind: "result",
			r
		};
	}

	function reportRefusalLoop(refusal: Error): void {
		ctx.env.emitDiag({
			severity: "warn",
			code: "action/refusal-loop",
			message:
				`[treflex] Action "${ctx.env.actionName}" was refused ${REFUSAL_LIMIT} times running at its yields for writes that left an alias, a ` +
				`loop, two nodes with one $Id or an empty array index in the tree, each step undone and the refusal thrown back in, with no step ` +
				`passing between, so the next refusal ended the action. A catch around ` +
				`a yield that retries the same writes meets the same refusal: rethrow it, or change the writes.`,
			data: {
				actionName: ctx.env.actionName,
				branchId: ctx.fiber.id,
				error: serializeThrow(refusal)
			}
		});
	}

	function failSlice(error: unknown): {
		kind: "errored";
		error: unknown;
	} {
		position = "errored";
		ctx.env.refusalOut(error);
		// A flush can throw with the generator suspended, and its finally blocks still have to run.
		try {
			closeGenerator(false);
		} catch (closeError) {
			queueMicrotask(() => {
				throw closeError;
			});
		}
		return {
			kind: "errored",
			error
		};
	}

	function foldIteration(r: IteratorResult<unknown, unknown>): IFiberSettleOutcome {
		next = r;
		if (r.done && isPromiseLike(r.value)) {
			markHandled(r.value);
			position = "errored";
			const error = new NonPlainDataError(
				`${ctx.fiber.branch ? "a branch of action" : "action"} "${ctx.env.actionName}": the return value`,
				PROMISE_OR_THENABLE,
				[]
			);
			return {
				kind: "errored",
				error
			};
		}
		if (r.done) {
			position = "done";
			result = r.value;
			return {
				kind: "done",
				value: r.value
			};
		}
		position = "running";
		return {
			kind: "stepped"
		};
	}

	function settleInternal(input: IFiberSettleInput): IFiberSettleOutcome {
		const aw = awaiting!;
		awaiting = null;
		let resume: IFiberSettleInput;
		if (input.verb === "next") {
			const yieldResult = input.value;
			try {
				if (aw.journalingEffect) {
					recordSettlement(ctx, aw, yieldResult);
				}
				if (ctx.fiber.stopped) {
					return cancel();
				}
				resume = input;
			} catch (effectError) {
				const cancelled = settleError(effectError, aw);
				if (cancelled) {
					return cancelled;
				}
				resume = {
					verb: "throw",
					error: effectError
				};
			}
		} else {
			const cancelled = settleError(input.error, aw);
			if (cancelled) {
				return cancelled;
			}
			resume = input;
		}

		// Outside the settlement try above: a throw from the generator body is
		// an action failure, and must not settle the effect again or be thrown
		// back into the generator.
		const r = resume;
		const sliced = runSlice(() => (r.verb === "throw" ? throwIn(r.error) : generator!.next(r.value)), stepAnswers(r));
		if (sliced.kind === "errored") {
			return sliced;
		}
		return foldIteration(sliced.r);
	}

	function start(): IFiberSettleOutcome {
		if (position !== "created") {
			throw new Error(`[treflex] fiberMachine: start() called in position "${position}"`);
		}
		const sliced = runSlice(() => {
			if (!generator) {
				generator = (source as () => Generator<unknown, unknown, unknown>)();
			}
			return generator.next();
		});
		if (sliced.kind === "errored") {
			return sliced;
		}
		return foldIteration(sliced.r);
	}

	function advance(): IFiberAdvanceOutcome {
		if (position !== "running") {
			throw new Error(`[treflex] fiberMachine: advance() called in position "${position}"`);
		}

		const current = next;
		if (current.done) {
			position = "done";
			result = current.value;
			return {
				kind: "done",
				value: current.value
			};
		}
		const yielded = current.value;
		if (isRegainOp(yielded)) {
			opPending = true;
			position = "awaiting";
			return {
				kind: "regain"
			};
		}

		const effectStart = performance.now();
		const yieldedAsEffect = current.value as IEffect;
		const isReadYield = isRead(yieldedAsEffect?.Type);

		const aw: IAwaiting = {
			effect: yieldedAsEffect,
			redact: false,
			journalingEffect: journalsEffects(ctx) && !isReadYield,
			effectSeq: 0,
			effectStart,
			settled: false
		};
		if (!isReadYield) {
			try {
				aw.effect = copyYield(yieldedAsEffect);
				if (aw.journalingEffect) {
					recordEffect(ctx, aw);
				}
			} catch (refusal) {
				awaiting = aw;
				position = "awaiting";
				return settleInternal({
					verb: "throw",
					error: refusal
				});
			}
		}

		awaiting = aw;
		position = "awaiting";
		if (isReadYield) {
			return {
				kind: "read",
				yielded: current.value
			};
		}
		return {
			kind: "effect",
			effect: aw.effect
		};
	}

	function settle(input: IFiberSettleInput): IFiberSettleOutcome {
		if (position !== "awaiting") {
			throw new Error(`[treflex] fiberMachine: settle() called in position "${position}"`);
		}
		if (opPending) {
			opPending = false;
			if (ctx.fiber.stopped) {
				return cancel();
			}
			const sliced = runSlice(() => (input.verb === "throw" ? throwIn(input.error) : generator!.next(input.value)));
			return sliced.kind === "errored" ? sliced : foldIteration(sliced.r);
		}
		return settleInternal(input);
	}

	return {
		get position() {
			return position;
		},
		get result() {
			return result;
		},
		start,
		advance,
		settle,
		abort(): void {
			cancel();
		}
	};
}
