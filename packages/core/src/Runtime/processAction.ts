import type { IRuntimeServiceKey, IRuntimeServiceValue } from "../Registries/IRuntimeServiceRegistry";
import type { IVersion } from "../Solid/host";
import type { IAction } from "../Types/IAction";
import type { IActionContext } from "../Types/IActionContext";
import type { IEffect } from "../Types/IEffect";
import type { IActionOrigin, IRecordRoot } from "../Types/IRecord";
import type { IDiagEmitter, IFailureEmitter, IFailureEvent } from "../Types/IRuntimeEvent";
import type { IBranchEnd, IBranchGroup } from "./branches";
import type { IEffectImplementation } from "./createEffectRegistry";
import type { IExternalRead } from "./createExternalTable";
import type { IActionJournal, IJournal, IJournalSample } from "./createJournal";
import type { IWriteGateway } from "./createWriteGateway";
import type { IFiber, IFiberIdAllocator } from "./Fiber";
import type { IFiberMachine, IFiberSettleInput, IFiberSettleOutcome } from "./fiberMachine";
import type { IReadHandler } from "./processSelector";
import type { IRecordingContext } from "./recordingProxy";
import type { IActionHold, IStepAction } from "./runningStep";
import type { ISetState } from "./sliceSetState";
import { host } from "../Solid/host";
import { consoleDiag } from "../Types/IRuntimeEvent";
import { DEV } from "../Utility/devMode";
import { serializeThrow } from "../Utility/serializeThrow";
import { cloneStrict, copyFrozen } from "../Utility/valueCodec";
import { bumpLater, countsOf, type IWork, isInFlight, policyOf, shareWork, workOf } from "./arrivals";
import { resolveDiag } from "./createDiagService";
import { withRoot } from "./createJournal";
import { copyArguments, copyAtSender } from "./crossing";
import { DraftInsideOpenError } from "./draftNode";
import {
	declarationOf,
	isRedacted,
	recordCodeResult,
	refuseInSyncCall,
	SyncEffectPromiseError,
	settlesSync,
	syncCall,
	syncCallOpen
} from "./effectDeclarations";
import { createFiber, fiberSignal, stopFiber } from "./Fiber";
import { deliverFailure, errorBoundaryAbove, type IArrivals, type IErrorBoundary, type IFanOutContext } from "./fanOut";
import { answerInStep, createFiberMachine } from "./fiberMachine";
import { displayName, labelOf, nameOf, receiverOf, UnnamedActionError } from "./named";
import { NonPlainDataError } from "./nonPlainDataError";
import { type IOperationDriver, type IRuntimeOperation, operationOf } from "./operations";
import { PENDING_ASKS_YIELD } from "./pendingAsks";
import { caseOf } from "./receiver";
import { createRecordingProxy } from "./recordingProxy";
import { isRefusal } from "./refusal";
import { TRANSIENT_YIELD } from "./transient";
import { rawOf } from "./viewProxy";
import { noteArrival } from "./workTag";

const NOTHING_COUNTED: readonly object[] = Object.freeze([]);

/** What `onError` is told about a failure besides the error. */
export interface IErrorContext {
	/** The durable name of the action that failed, or null. */
	readonly Name: string | null;
	/** The function's own name, for display, or null. An error boundary's own failure carries its receiver's id. */
	readonly Label: string | null;
	/** The entity the action ran on. */
	readonly EntityId: string;
	/** On an error boundary's own failure, the failure it was handling. */
	readonly Cause?: unknown;
}

/** `createRuntime`'s `onError`: hears a failure no error boundary took. See docs/reference/failure.md#onerror. */
export type IErrorHandler = (error: unknown, context: IErrorContext) => void;

export type IRuntimeStoreReader = <K extends IRuntimeServiceKey>(key: K) => IRuntimeServiceValue<K>;

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/inFlightActions": () => IInFlightAction[];
	}
}

export interface IInFlightAction {
	ActionId: string;
	Name: string | null;
	Label: string | null;
	Receiver?: string;
	EntityId: string;
}

export type IProcessAction = <T, A extends any[], R>(
	action: IAction<T, A, R>,
	getState: () => T,
	setState: ISetState<T>,
	idAccessor: () => string,
	...args: A
) => Promise<R | undefined>;

export interface IProcessActionOptions {
	effectProcessor: IEffectImplementation;
	emitDiag?: IDiagEmitter;
	runtimeStoreReader: IRuntimeStoreReader;
	onDispose?: (callback: (id: string) => void) => void;
	processRead?: IReadHandler;
	onError?: IErrorHandler | undefined;
	allocateBranchId?: IFiberIdAllocator;
	resolvePath?: (entityId: string) => readonly string[];
	journal: IJournal;
	gateway?: IWriteGateway;
	emitFailure?: IFailureEmitter;
	requireNames?: boolean;
}

export interface IInternalDispatchOptions {
	origin?: IActionOrigin;
	/** The starting action's id, for the start record's StartedBy. */
	startedBy?: string;
	/** Arrives, and queues at the entity's gate until `beginArrivals(arrivals)`, even on a free entity. */
	arrivals?: IArrivals;
	signal?: AbortSignal;
	/** The caller holds the promise: called once the failure is on a route that has a taker, so the rejection isn't unhandled. */
	onTaken?: () => void;
	/** Runs as the action starts, after any wait in the queue. Returning false drops it unrun. */
	onStart?: () => boolean;
	/** The dispatcher routes the outcome itself, so the action's failure takes no route of its own. */
	settled?: (outcome: IActionOutcome, actionId: string) => void;
}

export type IInternalDispatch = <T, A extends any[], R>(
	action: IAction<T, A, R>,
	getState: () => T,
	setState: ISetState<T>,
	idAccessor: () => string,
	args: A,
	options: IInternalDispatchOptions
) => Promise<R | undefined>;

export interface IProcessActionResult {
	processAction: IProcessAction;
	dispatchInternal: IInternalDispatch;
	runningActions: (entityId: string) => readonly string[];
	inFlightActions: () => IInFlightAction[];
}

type IActiveAction = {
	// For messages and diags: the durable name, else the label.
	name: string;
	durableName: string | null;
	label: string | null;
	receiver: string | undefined;
	actionId: string;
	entityId: string;
	fn: object | null;
	counts: readonly object[];
	work: IWork<IActiveAction> | null;
	liveFibers: Set<IFiber>;
	stopped: boolean;
	onTaken: (() => void) | undefined;
	settled: ((outcome: IActionOutcome, actionId: string) => void) | undefined;
	// The first failure a stop kept from the action's own code, and the route waiting for one that
	// arrives after the action has settled.
	stopFailure: IKept | null;
	routeStopFailure: ((kept: IKept) => void) | null;
	// The entity a failure is routed from: the one the action holds, or for a form over part of an entity, its entity.
	routeId: string;
	outcome: IActionOutcome | null;
	finished: boolean;
	finish: () => void;
	// Throws with no route, reported once the action has ended and every fiber of it with it.
	unrouted: IKept[];
	// Refusals thrown into the action's code that haven't left it since.
	refusals: Set<unknown> | null;
	emitDiag: IDiagEmitter;
	resourceOrigin: boolean;
	// Sampled at dispatch, not read when a record is made: after the entity's removal its root no
	// longer resolves, and a late record would claim AppState.
	recordRoot: IRecordRoot;
	root: IFiber | null;
	gate: IGate | null;
	holding: boolean;
	waiter: IWaiter | null;
	ended: boolean;
	// Stopped by the signal its dispatcher linked, so a stop while still queued is a drop.
	unwanted: boolean;
};

interface IKept {
	error: unknown;
	close: boolean;
}

interface IWaiter {
	active: IActiveAction;
	name: string;
	begin: () => void;
	cancel?: () => void;
	arrivals?: IArrivals;
}

function isFree(gate: IGate): boolean {
	return gate.holder === null && gate.queue.length === 0;
}

interface IGate {
	key: string;
	gates: Map<string, IGate>;
	holder: IActiveAction | null;
	queue: IWaiter[];
	pumping: boolean;
	warnTimer: ReturnType<typeof setTimeout> | null;
	warned: Set<string>;
	emitDiag: IDiagEmitter;
}

export const HOLD_WARN_MS = 1000;

const HOLD_WAIT: IEffect = {
	Type: "hold"
};

function dequeue(gate: IGate, waiter: IWaiter): void {
	const at = gate.queue.indexOf(waiter);
	if (at !== -1) {
		gate.queue.splice(at, 1);
		forgetGate(gate);
	}
}

function schedulePump(gate: IGate): void {
	if (!gate.pumping) {
		gate.pumping = true;
		queueMicrotask(() => pump(gate));
	}
}

function forgetGate(gate: IGate): void {
	if (gate.holder === null && gate.queue.length === 0 && !gate.pumping && gate.gates.get(gate.key) === gate) {
		gate.gates.delete(gate.key);
	}
}

function pump(gate: IGate): void {
	try {
		while (gate.holder === null) {
			const next = gate.queue[0];
			if (!next || (next.arrivals !== undefined && !next.arrivals.begun)) {
				break;
			}
			gate.queue.shift();
			next.begin();
		}
	} finally {
		gate.pumping = false;
	}
	armIfQueued(gate);
	forgetGate(gate);
}

function armIfQueued(gate: IGate): void {
	if (gate.holder !== null && gate.queue.length > 0 && gate.warnTimer === null) {
		armHoldWarning(gate, gate.holder);
	}
}

function armHoldWarning(gate: IGate, holder: IActiveAction): void {
	const timer = setTimeout(() => {
		gate.warnTimer = null;
		if (gate.holder !== holder || gate.queue.length === 0) {
			return;
		}
		armHoldWarning(gate, holder);
		const waitingOn = [
			...holder.liveFibers
		]
			.map((fiber) => fiber.waitingOn)
			.filter((type): type is string => type !== null);
		const signature = JSON.stringify(
			[
				...waitingOn
			].sort()
		);
		if (gate.warned.has(signature)) {
			return;
		}
		gate.warned.add(signature);
		const queued = gate.queue.map((entry) => entry.name);
		gate.emitDiag({
			severity: "warn",
			code: "action/long-hold",
			message:
				`[treflex] Action "${holder.name}" has held entity "${gate.key}" for over ${HOLD_WARN_MS}ms with work queued behind it ` +
				`(${queued.map((name) => `"${name}"`).join(", ")}), waiting on ${waitingOn.length > 0 ? waitingOn.map((type) => `"${type}"`).join(", ") : "nothing"}. ` +
				`If other work should run during that wait, write yield* open(...) around it, or move it to a child entity.`,
			data: {
				entityId: gate.key,
				holder: holder.name,
				holderId: holder.actionId,
				waitingOn,
				queued
			}
		});
	}, HOLD_WARN_MS);
	(
		timer as {
			unref?: () => void;
		}
	).unref?.();
	gate.warnTimer = timer;
}

function freeGate(gate: IGate): void {
	gate.holder = null;
	gate.warned.clear();
	if (gate.warnTimer !== null) {
		clearTimeout(gate.warnTimer);
		gate.warnTimer = null;
	}
	if (gate.queue.length > 0) {
		schedulePump(gate);
		return;
	}
	forgetGate(gate);
}

// A hold ends once the root has ended and no other fiber of the action is live, so a stopped
// branch's finally blocks still write under it.
function releaseIfDone(active: IActiveAction): void {
	const root = active.root;
	if (active.ended || root === null) {
		return;
	}
	const live = active.liveFibers;
	if (root.status === "running" || live.size > (live.has(root) ? 1 : 0)) {
		return;
	}
	active.ended = true;
	if (active.work) {
		bumpEnded(active.work, active.counts, active.emitDiag);
	}
	if (active.holding) {
		releaseHold(active);
	}
	active.finish();
}

function bumpEnded(work: IWork<IActiveAction>, counts: readonly object[], report: IDiagEmitter): void {
	for (const counted of counts) {
		const version = work.versions.get(counted);
		if (version && !isInFlight(work, counted)) {
			bumpLater(version, report);
		}
	}
}

function readNodeOf<T>(setState: ISetState<T>): object | undefined {
	let addressed: unknown;
	setState((s: T) => {
		addressed = s;
	});
	return rawOf(addressed) as object | undefined;
}

function releaseHold(active: IActiveAction): void {
	active.holding = false;
	const gate = active.gate!;
	if (gate.holder === active) {
		freeGate(gate);
	}
}

function letOthersIn(active: IActiveAction, fiber: IFiber): void {
	if (fiber.open && active.holding && active.gate!.holder === active) {
		freeGate(active.gate!);
	}
}

// The gate compared is the one the action took, which may since have been forgotten or replaced.
function letGo(active: IActiveAction): boolean {
	return active.holding && active.gate!.holder !== active;
}

function regrant(active: IActiveAction): void {
	active.gate!.holder = active;
}

function keptByStop(active: IActiveAction, fiber: IFiber, kept: IKept): void {
	if (fiber.stoppedBy === "action" && active.stopFailure === null) {
		active.stopFailure = kept;
		active.routeStopFailure?.(kept);
		return;
	}
	unrouted(active, kept);
}

function unrouted(active: IActiveAction, kept: IKept): void {
	active.unrouted.push(kept);
	active.finish();
}

const refusalOwners = new WeakMap<object, IActiveAction>();

function refusalIn(active: IActiveAction, error: unknown): void {
	if (!DEV || !isRefusal(error)) {
		return;
	}
	const owner = refusalOwners.get(error);
	if (owner !== undefined && owner !== active) {
		return;
	}
	refusalOwners.set(error, active);
	active.refusals ??= new Set();
	active.refusals.add(error);
}

/** What makes one of an action's fibers step, taken one at a time in the order they came. */
export interface IWakeQueue {
	readonly items: (() => void)[];
	draining: boolean;
	/** How many wakes have been taken, the one being taken included. */
	taken: number;
}

function createWakeQueue(): IWakeQueue {
	return {
		items: [],
		draining: false,
		taken: 0
	};
}

// A wake made during another waits for it, so a fiber never steps inside another fiber's step.
function takeWake(queue: IWakeQueue, then: () => void): void {
	queue.items.push(then);
	if (queue.draining) {
		return;
	}
	queue.draining = true;
	let failed = false;
	let failure: unknown;
	try {
		for (let next = queue.items.shift(); next !== undefined; next = queue.items.shift()) {
			queue.taken++;
			try {
				next();
			} catch (error) {
				if (!failed) {
					failed = true;
					failure = error;
				}
			}
		}
	} finally {
		queue.draining = false;
	}
	if (failed) {
		throw failure;
	}
}

// `journaling` is sampled at dispatch, not read live: a tap can come or go mid-action, and an
// action makes each of its kinds all-or-nothing.
export interface IActionEnv<T> {
	actionId: string;
	actionName: string;
	entityId: string;
	hold: IActionHold | null;
	getState: () => T;
	runtimeStoreReader: IRuntimeStoreReader;
	processActionPublic: IProcessAction;
	dispatchInternal: IInternalDispatch;
	effectProcessor: IEffectImplementation;
	processRead?: IReadHandler | undefined;
	emitDiag: IDiagEmitter;
	recording: IRecordingContext;
	journal: IActionJournal;
	journaling: IJournalSample;
	// Past the argument copy: an action:end before it would read as an end with no action.
	started: boolean;
	retakeHold: (active: IActiveAction) => boolean;
	regainHold: (active: IActiveAction) => {
		granted: Promise<void>;
		cancel: () => void;
	} | null;
	gateway?: IWriteGateway | undefined;
	allocateBranchId: IFiberIdAllocator;
	active: IActiveAction;
	origin: IActionOrigin | undefined;
	/** A branch failure that `fiber`, stopped, never received. */
	failedUnderStop: (fiber: IFiber, error: unknown) => void;
	/** A throw out of `fiber`'s close, `stopped` when a stop ran the close. */
	closeThrew: (fiber: IFiber, error: unknown, stopped: boolean) => void;
	/** The error is thrown into the action's code. */
	refusalIn: (error: unknown) => void;
	/** The error has left the action's code, as a failure the runtime caught. */
	refusalOut: (error: unknown) => void;
	wakes: IWakeQueue;
	/** Applies the runtime's `requireNames` to an action about to be started on `entityId`. */
	requireName: (action: object, entityId: string) => void;
}

export interface IFiberContext<T> {
	env: IActionEnv<T>;
	fiber: IFiber;
	origin: IActionOrigin | undefined;
	dispatchContext: IActionContext;
	onFailed?: ((error: unknown) => void) | undefined;
	step: IStepAction;
	closeStep: IStepAction;
}

function makeFiberContext<T>(
	env: IActionEnv<T>,
	fiber: IFiber,
	origin: IActionOrigin | undefined,
	onFailed?: (error: unknown) => void
): IFiberContext<T> {
	const ctx: IFiberContext<T> = {
		env,
		fiber,
		origin,
		onFailed,
		dispatchContext: null as unknown as IActionContext,
		step: {
			fiber,
			name: env.actionName,
			answer: (effect) => answerInStep(ctx, effect, (copied) => dispatchSync(ctx, copied)),
			retake: () => env.retakeHold(env.active),
			hold: env.hold ?? undefined,
			refused: env.refusalIn
		},
		closeStep: {
			fiber,
			name: env.actionName,
			refused: env.refusalIn
		}
	};
	ctx.dispatchContext = buildActionContext(ctx);
	return ctx;
}

export type IActionOutcome =
	| {
			status: "completed";
			result: unknown;
	  }
	| {
			status: "cancelled";
	  }
	| {
			status: "dropped";
	  }
	| {
			status: "errored";
			error: unknown;
	  };

interface IFailure {
	error: unknown;
	entityId: string;
	name: string | null;
	label: string | null;
	actionId: string;
	action: unknown;
	status: "errored" | "cancelled";
	close: boolean;
	cause?: IFailure;
}

export const FAILED_ACTION = Symbol("treflex.failedAction");

function withAction(event: IFailureEvent, action: unknown): IFailureEvent {
	Object.defineProperty(event, FAILED_ACTION, {
		value: action
	});
	return event;
}

function failureEvent(failure: IFailure, taken: boolean): IFailureEvent {
	return withAction(
		{
			Error: failure.error,
			ActionId: failure.actionId,
			Name: failure.name,
			Label: failure.label,
			EntityId: failure.entityId,
			Status: failure.status,
			Close: failure.close,
			Taken: taken,
			...(failure.cause
				? {
						Cause: failure.cause.error
					}
				: {})
		},
		failure.action
	);
}

function buildActionContext<T>(ctx: IFiberContext<T>): IActionContext {
	return {
		entityId: ctx.env.entityId,
		actionId: ctx.env.actionId,
		get signal() {
			return fiberSignal(ctx.fiber);
		},
		get: ctx.env.runtimeStoreReader,
		processAction: ctx.env.processActionPublic
	};
}

function startBranch<T>(
	parent: IFiberContext<T>,
	generator: Generator<unknown, unknown>,
	group: IBranchGroup,
	ended: (end: IBranchEnd) => void
): void {
	const branch = createFiber(parent.env.allocateBranchId(), true);
	parent.fiber.branches ??= new Set();
	parent.fiber.branches.add(branch);
	group.fibers.push(branch);
	if (group.failed) {
		stopFiber(branch, "group");
	}
	runBranch(generator, parent, branch, group.fail, ended);
}

function runBranch<T>(
	generator: Generator<unknown, unknown>,
	parent: IFiberContext<T>,
	childFiber: IFiber,
	onFailed: (error: unknown) => void,
	ended: (end: IBranchEnd) => void
): void {
	const env = parent.env;
	const childCtx = makeFiberContext(env, childFiber, parent.origin, onFailed);
	const childStart = performance.now();
	const journalingEnd = env.journaling["branch:end"];
	if (env.journaling["branch:start"]) {
		env.journal.append({
			T: childStart,
			Kind: "branch:start",
			ActionId: env.actionId,
			ParentBranchId: parent.fiber.id,
			BranchId: childFiber.id
		});
	}
	function endChild(error?: unknown): void {
		if (!journalingEnd) {
			return;
		}
		const at = performance.now();
		const status = childFiber.status as "completed" | "cancelled" | "errored";
		env.journal.append(
			status === "errored"
				? {
						T: at,
						Kind: "branch:end",
						ActionId: env.actionId,
						BranchId: childFiber.id,
						Status: status,
						Error: serializeThrow(error)
					}
				: {
						T: at,
						Kind: "branch:end",
						ActionId: env.actionId,
						BranchId: childFiber.id,
						Status: status
					},
			{
				duration: at - childStart
			}
		);
	}
	env.active.liveFibers.add(childFiber);
	if (parent.fiber.stopped || parent.fiber.status !== "running") {
		stopFiber(childFiber, parent.fiber.stoppedBy ?? "group");
	}
	const forget = (): void => {
		env.active.liveFibers.delete(childFiber);
		parent.fiber.branches?.delete(childFiber);
	};
	const close = (end: IBranchEnd): void => {
		endChild(end.ok ? undefined : end.error);
		forget();
		releaseIfDone(env.active);
		ended(end);
	};
	let machine: IFiberMachine;
	try {
		machine = createFiberMachine(childCtx, generator as Generator<unknown, unknown, unknown>);
		if (!childFiber.stopped) {
			const first = machine.start();
			if (first.kind === "errored") {
				endFiber(childCtx, "errored");
				childCtx.onFailed?.(first.error);
				close({
					ok: false,
					error: first.error
				});
				return;
			}
		}
	} catch (error) {
		forget();
		releaseIfDone(env.active);
		ended({
			ok: false,
			error
		});
		return;
	}
	runFiberLoop(childCtx, machine, close).catch(() => {});
}

// The status is stamped ahead of everything the terminal reaches: a sibling's
// failure in the same batch must not read a finished fiber as running and stop it.
function endFiber<T>(ctx: IFiberContext<T>, status: "completed" | "errored"): void {
	ctx.fiber.status = status;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		typeof (
			value as {
				then?: unknown;
			}
		).then === "function"
	);
}

// A returns: "module" result is recorded so the recording proxy's set trap can
// refuse it.
function settleResult(effect: IEffect, value: unknown): unknown {
	const operation = operationOf(effect);
	if (operation?.settle) {
		return operation.settle(value);
	}
	if (declarationOf(effect.Type)?.returns === "module") {
		recordCodeResult(value);
		return value;
	}
	const copy = cloneStrict(value);
	if (!copy.ok) {
		throw new NonPlainDataError(`effect "${effect.Type}": the result`, copy.kind, copy.path, "Convert at the implementation.");
	}
	return copy.value;
}

function reportSyncViolation<T>(ctx: IFiberContext<T>, effect: IEffect, thenable: PromiseLike<unknown>): SyncEffectPromiseError {
	const error = new SyncEffectPromiseError(effect.Type);
	const diag = resolveDiag(ctx.env.runtimeStoreReader);
	diag.emitOnce(
		JSON.stringify([
			"effect/sync-returned-promise",
			effect.Type
		]),
		{
			severity: "warn",
			code: "effect/sync-returned-promise",
			message: error.message,
			data: {
				effectType: effect.Type
			}
		}
	);
	const redact = isRedacted(effect.Type);
	try {
		thenable.then(undefined, (cause: unknown) => {
			diag.emit({
				severity: "warn",
				code: "effect/sync-promise-rejected",
				message: redact
					? `[treflex] the promise returned for settles: "sync" effect "${effect.Type}" rejected. The type is redacted, so its reason is withheld.`
					: `[treflex] the promise returned for settles: "sync" effect "${effect.Type}" rejected. Its reason is the cause.`,
				data: redact
					? {
							effectType: effect.Type
						}
					: {
							effectType: effect.Type,
							cause
						}
			});
		});
	} catch {
		// A thenable whose then throws has nothing more to report.
	}
	return error;
}

function dispatchSync<T>(ctx: IFiberContext<T>, effect: IEffect): IFiberSettleInput {
	const call = syncCall.enter(effect.Type);
	let value: unknown;
	try {
		value = ctx.env.effectProcessor(effect, ctx.dispatchContext);
	} catch (error) {
		return {
			verb: "throw",
			error: call.violation ?? error
		};
	} finally {
		syncCall.exit(call);
	}
	if (isThenable(value)) {
		const error = reportSyncViolation(ctx, effect, value);
		return {
			verb: "throw",
			error: call.violation ?? error
		};
	}
	if (call.violation) {
		return {
			verb: "throw",
			error: call.violation
		};
	}
	return {
		verb: "next",
		value: settleResult(effect, value)
	};
}

const LARGE_READ_COPY = 10_000;

function snapshotReadResult<T>(ctx: IFiberContext<T>, yielded: unknown, value: unknown): unknown {
	if (value === undefined) {
		return undefined;
	}
	const type = String(
		(
			yielded as {
				Type?: unknown;
			}
		)?.Type
	);
	// An ask entry is frozen already, and keeps its identity for the ask's whole life. An external
	// value is the copy its step record holds, made by the read.
	if (type === TRANSIENT_YIELD || type === PENDING_ASKS_YIELD || type === "external") {
		return value;
	}
	return copyForAction(ctx, value, type, `${type} in an action: the result`);
}

function copyForAction<T>(ctx: IFiberContext<T>, value: unknown, type: string, what: string, externalKey?: string): unknown {
	const copies = DEV
		? {
				count: 0
			}
		: undefined;
	const copy = copyFrozen(value, {
		unwrap: rawOf,
		copies
	});
	if (!copy.ok) {
		throw new NonPlainDataError(what, copy.kind, copy.path);
	}
	if (copies && copies.count > LARGE_READ_COPY) {
		const actionName = ctx.env.actionName;
		const diag = resolveDiag(ctx.env.runtimeStoreReader);
		if (externalKey === undefined) {
			diag.emitOnce(
				JSON.stringify([
					"action/large-read-copy",
					actionName
				]),
				{
					severity: "warn",
					code: "action/large-read-copy",
					message:
						`[treflex] Action "${actionName}" copied ${copies.count} objects and arrays out of state in one ${type}. An action-side read is a frozen ` +
						`copy of everything it returns, so read only what the action needs, with a narrow select.`,
					data: {
						actionName,
						type,
						copied: copies.count
					}
				}
			);
		} else {
			diag.emitOnce(
				JSON.stringify([
					"action/large-read-copy",
					actionName,
					externalKey
				]),
				{
					severity: "warn",
					code: "action/large-read-copy",
					message:
						`[treflex] Action "${actionName}" copied ${copies.count} objects and arrays reading external("${externalKey}"). An action's read of an ` +
						"outside value copies the whole value, inside a select too, so provide what the action needs under a narrower key.",
					data: {
						actionName,
						type,
						key: externalKey,
						copied: copies.count
					}
				}
			);
		}
	}
	return copy.value;
}

function runFiberLoop<T>(ctx: IFiberContext<T>, machine: IFiberMachine, onEnd?: (end: IBranchEnd) => void): Promise<any> {
	return new Promise((resolveLoop, rejectLoop) => {
		const fiber = ctx.fiber;
		const active = ctx.env.active;
		const isRoot = fiber === active.root;
		// A throw out of `onEnd` from `resolve` reaches `fail`, which must not end the fiber twice.
		let over = false;
		const end = (outcome: IBranchEnd): void => {
			if (!over) {
				over = true;
				onEnd?.(outcome);
			}
		};
		// Ahead of the promise, so a finished action holds for no microtask.
		const resolve = (value: unknown): void => {
			if (isRoot) {
				releaseIfDone(active);
			}
			end({
				ok: true,
				value
			});
			resolveLoop(value);
		};
		const reject = (error: unknown): void => {
			if (isRoot) {
				releaseIfDone(active);
			}
			end({
				ok: false,
				error
			});
			rejectLoop(error);
		};
		const wakes = ctx.env.wakes;
		let parkedOn: IEffect | null = null;
		let afterResume: (() => void)[] = [];
		let parkedAfterResume: (() => void)[] = [];
		const driverFor = (effect: IEffect): IOperationDriver => {
			const startedIn = wakes.taken;
			return {
				startBranch: (generator, group, ended) => startBranch(ctx, generator, group, ended),
				afterResume: (then) => {
					afterResume.push(then);
				},
				settle: (end) => {
					const wake = (): void => settleByDriver(effect, end);
					// Ended inside the wake that started it: a fan-out still gives up a turn.
					if (wakes.taken === startedIn) {
						queueMicrotask(() => takeWake(wakes, wake));
					} else {
						takeWake(wakes, wake);
					}
				}
			};
		};

		const unpark = (): (() => void)[] => {
			parkedOn = null;
			fiber.endWait = null;
			fiber.waitingOn = null;
			const due = parkedAfterResume;
			parkedAfterResume = [];
			return due;
		};
		const runAll = (due: readonly (() => void)[]): void => {
			for (const then of due) {
				then();
			}
		};
		const fail = (error: unknown): void => {
			if (fiber.status === "running") {
				endFiber(ctx, "errored");
			}
			reject(error);
		};

		const onValue = (value: unknown): void => {
			if (parkedOn === null) {
				return;
			}
			const effect = parkedOn;
			const due = unpark();
			let input: IFiberSettleInput;
			try {
				input = {
					verb: "next",
					value: settleResult(effect, value)
				};
			} catch (effectError) {
				input = {
					verb: "throw",
					error: effectError
				};
			}
			run(input);
			runAll(due);
		};
		const onError = (error: unknown): void => {
			if (parkedOn === null) {
				return;
			}
			const due = unpark();
			run({
				verb: "throw",
				error
			});
			runAll(due);
		};
		const onEnded = (): void => {
			if (parkedOn === null) {
				return;
			}
			const due = unpark();
			try {
				machine.abort();
				resolve(undefined);
			} catch (error) {
				fail(error);
			}
			runAll(due);
		};
		// A microtask behind the call: the call comes from the frame that ended the
		// fiber, and a framework park's listener has queued its abandonment first.
		const endWait = (): void => {
			queueMicrotask(() => takeWake(wakes, onEnded));
		};

		const park = (effect: IEffect, dispatched: unknown): void => {
			parkedOn = effect;
			fiber.waitingOn = effect.Type;
			parkedAfterResume = afterResume;
			afterResume = [];
			const ownFailure = operationOf(effect)?.rejectsWithOwnFailure === true;
			if (fiber.stopped) {
				Promise.resolve(dispatched).then(undefined, (error: unknown) => {
					if (ownFailure) {
						ctx.env.failedUnderStop(fiber, error);
					}
				});
				endWait();
				return;
			}
			letOthersIn(active, fiber);
			Promise.resolve(dispatched).then(
				(value: unknown) => takeWake(wakes, () => onValue(value)),
				(error: unknown) => {
					// A stopped fiber's machine drops the rejection rather than throw it in.
					if (ownFailure && fiber.stopped) {
						ctx.env.failedUnderStop(fiber, error);
					}
					takeWake(wakes, () => onError(error));
				}
			);
			fiber.endWait = endWait;
		};

		const parkOnDriver = (effect: IEffect): void => {
			parkedOn = effect;
			fiber.waitingOn = effect.Type;
			parkedAfterResume = afterResume;
			afterResume = [];
			if (fiber.stopped) {
				endWait();
				return;
			}
			letOthersIn(active, fiber);
			fiber.endWait = endWait;
		};

		// A fan-out's end never reaches a stopped fiber: it closes on its own wake from endWait.
		const settleByDriver = (effect: IEffect, end: IBranchEnd): void => {
			if (!end.ok && fiber.stopped && operationOf(effect)?.rejectsWithOwnFailure === true) {
				ctx.env.failedUnderStop(fiber, end.error);
			}
			if (parkedOn !== effect || fiber.stopped) {
				return;
			}
			if (end.ok) {
				onValue(end.value);
			} else {
				onError(end.error);
			}
		};

		const parkOnHold = (granted: Promise<void>, cancel: () => void, resumeWith: IFiberSettleInput): void => {
			parkedOn = HOLD_WAIT;
			fiber.waitingOn = HOLD_WAIT.Type;
			parkedAfterResume = afterResume;
			afterResume = [];
			const stopWaiting = (): void => {
				cancel();
				endWait();
			};
			if (fiber.stopped) {
				stopWaiting();
				return;
			}
			void granted.then(() =>
				takeWake(wakes, () => {
					if (parkedOn !== null) {
						const due = unpark();
						run(resumeWith);
						runAll(due);
					}
				})
			);
			fiber.endWait = stopWaiting;
		};

		// A cancelled run resolves undefined; callers tell it apart by machine.position.
		const run = (resumeWith?: IFiberSettleInput): void => {
			try {
				let settled: IFiberSettleOutcome | null = resumeWith ? machine.settle(resumeWith) : null;
				while (true) {
					if (settled) {
						if (settled.kind === "cancelled") {
							resolve(undefined);
							return;
						}
						if (settled.kind === "errored") {
							endFiber(ctx, "errored");
							ctx.onFailed?.(settled.error);
							throw settled.error;
						}
					}
					if (machine.position === "done") {
						endFiber(ctx, "completed");
						resolve(machine.result);
						return;
					}
					if (fiber.stopped) {
						machine.abort();
						resolve(undefined);
						return;
					}
					const outcome = machine.advance();
					switch (outcome.kind) {
						case "effect": {
							const effect = outcome.effect;
							const operation = operationOf(effect);
							if (operation) {
								let parkOn: unknown;
								try {
									parkOn = operation.run(effect as IRuntimeOperation, ctx as IFiberContext<unknown>, driverFor(effect));
								} catch (operationError) {
									if (!fiber.stopped) {
										settled = machine.settle({
											verb: "throw",
											error: operationError
										});
										break;
									}
								}
								if (operation.settledByDriver) {
									parkOnDriver(effect);
									return;
								}
								if (operation.settles !== "sync") {
									park(effect, parkOn);
									return;
								}
								if (fiber.stopped) {
									machine.abort();
									resolve(undefined);
									return;
								}
								settled = machine.settle({
									verb: "next",
									value: settleResult(effect, parkOn)
								});
								break;
							}
							if (settlesSync(effect.Type)) {
								// A throw from the generator body happens inside settle's resume
								// slice, outside this try, so it is never mistaken for an effect failure.
								let input: IFiberSettleInput;
								try {
									input = dispatchSync(ctx, effect);
								} catch (effectError) {
									input = {
										verb: "throw",
										error: effectError
									};
								}
								if (fiber.stopped) {
									machine.abort();
									resolve(undefined);
									return;
								}
								settled = machine.settle(input);
								break;
							}
							let dispatched: unknown;
							try {
								dispatched = ctx.env.effectProcessor(effect, ctx.dispatchContext);
							} catch (effectError) {
								if (!fiber.stopped) {
									settled = machine.settle({
										verb: "throw",
										error: effectError
									});
									break;
								}
							}
							park(effect, dispatched);
							return;
						}
						case "regain": {
							const regained: IFiberSettleInput = {
								verb: "next",
								value: undefined
							};
							const waiting = ctx.env.regainHold(active);
							if (waiting !== null) {
								parkOnHold(waiting.granted, waiting.cancel, regained);
								return;
							}
							settled = machine.settle(regained);
							break;
						}
						case "read": {
							let input: IFiberSettleInput;
							const inFlightAnswers: boolean[] = [];
							const externalAnswers: IExternalRead[] = [];
							try {
								const value = ctx.env.processRead!(outcome.yielded, {
									getState: ctx.env.getState,
									inFlightAnswers,
									externalReads: {
										answers: externalAnswers,
										copy: (read, key) => copyForAction(ctx, read, "external", `external "${key}" in an action: the value`, key)
									}
								});
								input = {
									verb: "next",
									value: snapshotReadResult(ctx, outcome.yielded, value),
									inFlightAnswers,
									externalAnswers
								};
							} catch (readError) {
								input = {
									verb: "throw",
									error: readError,
									inFlightAnswers,
									externalAnswers
								};
							}
							settled = machine.settle(input);
							break;
						}
						default:
							settled = outcome;
					}
				}
			} catch (error) {
				fail(error);
			}
		};

		// A branch's loop runs at once, inside its parent's wake, so its first effect is
		// dispatched before the next sibling starts.
		if (wakes.draining) {
			run();
		} else {
			takeWake(wakes, () => run());
		}
	});
}

export function createProcessAction(options: IProcessActionOptions): IProcessActionResult {
	const effectProcessor = options.effectProcessor;
	const processRead = options.processRead;
	const onError = options.onError;
	const runtimeStoreReader = options.runtimeStoreReader;
	let fallbackBranchN = 0;
	const allocateBranchId = options.allocateBranchId ?? (() => `branch-${++fallbackBranchN}`);
	const resolvePath = options.resolvePath;
	const journal = options.journal;
	const emitDiag: IDiagEmitter = options.emitDiag ?? consoleDiag;
	const emitFailure: IFailureEmitter = options.emitFailure ?? (() => {});

	const works = new Map<string, IWork<IActiveAction>>();
	shareWork(
		options.gateway
			? [
					options.gateway,
					options.gateway.slotHome
				]
			: [],
		works
	);
	const gates = new Map<string, IGate>();

	const unnamedReported = new WeakSet<object>();

	function requireName(action: object, root: IRecordRoot, origin: IActionOrigin | undefined): void {
		if (
			!options.requireNames ||
			origin !== undefined ||
			root !== "AppState" ||
			receiverOf(action) !== undefined ||
			nameOf(action) !== null
		) {
			return;
		}
		const label = labelOf(action);
		if (DEV) {
			throw new UnnamedActionError(label);
		}
		if (unnamedReported.has(action)) {
			return;
		}
		unnamedReported.add(action);
		emitDiag({
			severity: "warn",
			code: "action/unnamed",
			message:
				`[treflex] action "${label ?? "(anonymous)"}" has no durable name, and this runtime sets requireNames. It runs, and ` +
				`its records and any snapshot entry carry Name: null, so a later restore can't say what it was. Name it with named(), ` +
				"or run `npx treflex-eslint name`, which names the unnamed actions it can find in the project.",
			data: {
				label
			}
		});
	}

	const heldWritesReported = new WeakMap<object, WeakSet<object>>();

	function reportHeldWrite(writer: IActiveAction, writerFn: object, target: object, key: string): void {
		const place = options.gateway!.placeOf(target);
		if (place.kind !== "at") {
			return;
		}
		const holder = gates.get(place.entityId)?.holder;
		if (!holder || holder === writer) {
			return;
		}
		const holderFn = holder.fn ?? holder;
		let reported = heldWritesReported.get(writerFn);
		if (!reported) {
			reported = new WeakSet();
			heldWritesReported.set(writerFn, reported);
		}
		if (reported.has(holderFn)) {
			return;
		}
		reported.add(holderFn);
		const path = [
			...place.path,
			key
		];
		const at = place.slot === undefined ? path.join(".") : `transient "${place.slot}" ${path.join(".")}`;
		emitDiag({
			severity: "info",
			code: "entity/written-while-held",
			message:
				`[treflex] Action "${writer.name}" wrote ${at} on entity "${place.entityId}" while action "${holder.name}" holds it, ` +
				`so "${holder.name}" can find it changed after its wait. Send the write to the entity as work, with yield* start(...). ` +
				`Reported once per pair of actions.`,
			data: {
				writer: writer.name,
				holder: holder.name,
				entityId: place.entityId,
				...(place.slot === undefined
					? {}
					: {
							slot: place.slot
						}),
				path
			}
		});
	}

	function enter(key: string, active: IActiveAction): void {
		const work = workOf(works, key);
		const firsts: IVersion[] = [];
		for (const counted of active.counts) {
			const version = work.versions.get(counted);
			if (version && !isInFlight(work, counted)) {
				firsts.push(version);
			}
		}
		active.work = work;
		work.entries.push(active);
		noteArrival(active.counts);
		for (const version of firsts) {
			bumpLater(version, emitDiag);
		}
	}

	// From the record the action entered, which cancelByEntityId may have taken off the map.
	function leave(active: IActiveAction): void {
		const work = active.work;
		if (work) {
			active.work = null;
			const at = work.entries.indexOf(active);
			if (at !== -1) {
				work.entries.splice(at, 1);
			}
			if (!active.ended) {
				bumpEnded(work, active.counts, emitDiag);
			}
		}
	}

	// The id accessor of a form over part of an entity gives undefined, whatever its type says.
	function gateKeyOf(entityId: string, node: object | undefined, isRun: boolean): string | null {
		if (isRun) {
			return null;
		}
		if (typeof entityId === "string") {
			return entityId;
		}
		if (!options.gateway || node === null || typeof node !== "object") {
			return null;
		}
		return options.gateway.entityOf(node) ?? null;
	}

	function gateFor(key: string): IGate {
		let gate = gates.get(key);
		if (!gate) {
			gate = {
				key,
				gates,
				holder: null,
				queue: [],
				pumping: false,
				warnTimer: null,
				warned: new Set(),
				emitDiag
			};
			gates.set(key, gate);
		}
		return gate;
	}

	function enqueue(gate: IGate, waiter: IWaiter): void {
		gate.queue.push(waiter);
		armIfQueued(gate);
		if (gate.holder === null) {
			schedulePump(gate);
		}
	}

	function retakeHold(active: IActiveAction): boolean {
		if (!letGo(active)) {
			return true;
		}
		// A free gate with nothing queued is forgotten, so the one held before may no longer be the live one.
		const gate = gateFor(active.gate!.key);
		active.gate = gate;
		if (!isFree(gate)) {
			return false;
		}
		regrant(active);
		return true;
	}

	function regainHold(active: IActiveAction): {
		granted: Promise<void>;
		cancel: () => void;
	} | null {
		if (retakeHold(active)) {
			return null;
		}
		const gate = active.gate!;
		let resolve!: () => void;
		const granted = new Promise<void>((r) => {
			resolve = r;
		});
		const waiter: IWaiter = {
			active,
			name: `${active.name} (open)`,
			begin: () => {
				regrant(active);
				resolve();
			}
		};
		enqueue(gate, waiter);
		return {
			granted,
			cancel: () => dequeue(gate, waiter)
		};
	}

	function stopAction(active: IActiveAction): void {
		active.stopped = true;
		const waiter = active.waiter;
		if (waiter) {
			active.waiter = null;
			dequeue(active.gate!, waiter);
			// Off the frame that stopped it: a record tap writing through the gateway would
			// re-enter the cascade.
			queueMicrotask(waiter.cancel!);
		}
		for (const fiber of active.liveFibers) {
			stopFiber(fiber, "action");
		}
	}

	function runningActions(entityId: string): readonly string[] {
		const names: string[] = [];
		for (const active of works.get(entityId)?.entries ?? []) {
			if (!active.stopped) {
				names.push(active.name);
			}
		}
		return names;
	}

	function inFlightActions(): IInFlightAction[] {
		const inFlight: IInFlightAction[] = [];
		for (const work of works.values()) {
			for (const active of work.entries) {
				if (!active.resourceOrigin) {
					inFlight.push({
						ActionId: active.actionId,
						Name: active.durableName,
						Label: active.label,
						...(active.receiver !== undefined
							? {
									Receiver: active.receiver
								}
							: {}),
						EntityId: active.entityId
					});
				}
			}
		}
		return inFlight;
	}

	function cancelByEntityId(id: string): void {
		const gate = gates.get(id);
		if (gate) {
			for (const waiter of [
				...gate.queue
			]) {
				stopAction(waiter.active);
			}
		}
		const work = works.get(id);
		if (!work) {
			return;
		}
		works.delete(id);
		for (const version of work.versions.values()) {
			bumpLater(version, emitDiag);
		}
		for (const active of [
			...work.entries
		]) {
			stopAction(active);
		}
	}

	const routeContext: IFanOutContext = {
		get: runtimeStoreReader,
		dispatch: dispatchInternal
	};

	function inTree(entityId: string): boolean {
		return runtimeStoreReader("runtime/stateIdLookup")()[entityId] !== undefined;
	}

	function raise(error: unknown): void {
		void Promise.reject(error);
	}

	// `rejection` is the caller's hold on a promise rejecting with this failure: with no taker in reach
	// that promise is the uncaught report, and with one it is marked handled here.
	function route(failure: IFailure, rejection: (() => void) | undefined): void {
		const ended = (taken: boolean): void => emitFailure(failureEvent(failure, taken));
		const errorBoundary = errorBoundaryAbove(routeContext, failure.entityId);
		if (errorBoundary === null && !onError) {
			if (!rejection) {
				raise(failure.error);
			}
			ended(false);
			return;
		}
		rejection?.();
		hand(failure, errorBoundary, ended);
	}

	function hand(failure: IFailure, errorBoundary: IErrorBoundary | null, ended: (taken: boolean) => void): void {
		if (errorBoundary === null) {
			top(failure, ended);
			return;
		}
		const payload = copyAtSender(
			{
				Type: "Action/Error",
				Error: serializeThrow(failure.error),
				Name: failure.name,
				Label: failure.label,
				...(failure.cause
					? {
							Cause: serializeThrow(failure.cause.error)
						}
					: {})
			},
			"Action/Error: the payload"
		) as Record<string, unknown>;
		deliverFailure(routeContext, errorBoundary, failure.entityId, payload, (outcome, actionId) => {
			if (outcome.status === "completed") {
				ended(true);
				return;
			}
			const above = errorBoundaryAbove(routeContext, errorBoundary.ownerId);
			if (outcome.status !== "errored" || outcome.error === payload) {
				hand(failure, above, ended);
				return;
			}
			const own: IFailure = {
				error: outcome.error,
				entityId: errorBoundary.ownerId,
				name: null,
				label: labelOf(errorBoundary.handle),
				actionId,
				action: errorBoundary.handle,
				status: "errored",
				close: false,
				cause: failure
			};
			hand(own, above, (taken) => {
				ended(taken);
				emitFailure(failureEvent(own, taken));
			});
		});
	}

	function top(failure: IFailure, ended: (taken: boolean) => void): void {
		if (!onError) {
			raise(failure.error);
			ended(false);
			return;
		}
		try {
			onError(failure.error, {
				Name: failure.name,
				Label: failure.label,
				EntityId: failure.entityId,
				...(failure.cause
					? {
							Cause: failure.cause.error
						}
					: {})
			});
		} catch (handlerError) {
			raise(handlerError);
			ended(false);
			return;
		}
		ended(true);
	}

	options.onDispose?.(cancelByEntityId);

	// Dispatch must not subscribe the caller to anything reactive. An async
	// function runs synchronously up to its first await, so this untrack
	// covers everything before the first park: the copy of a view passed as an
	// argument, the id read, record appends and every tap they reach, and, on a
	// free entity, the first slice.
	//
	// The sync-call refusal sits here and in dispatchInternal, ahead of the
	// async dispatchAction, so it throws at the call instead of rejecting.
	function processAction<T, A extends any[], R>(
		action: IAction<T, A, R>,
		getState: () => T,
		setState: ISetState<T>,
		idAccessor: () => string,
		...args: A
	): Promise<R | undefined> {
		if (syncCallOpen()) {
			refuseInSyncCall(`tried to dispatch action "${displayName(action)}"`);
		}
		// A first-slice throw is taken before the promise exists.
		let running: Promise<R | undefined> | undefined;
		let taken = false;
		const onTaken = () => {
			taken = true;
			running?.catch(() => {});
		};
		running = afterFrame(action, args, idAccessor, (copies) =>
			dispatchAction(action, getState, setState, idAccessor, copies, {
				onTaken
			})
		);
		if (taken) {
			running.catch(() => {});
		}
		return running;
	}

	// A dispatch from inside an open frame starts once the frame has passed its check, so a
	// rollback of the caller's slice can't strand a child that ran inside it. It settles
	// cancelled, unrun, when the frame is refused or took the entity it was dispatched on.
	function afterFrame<A extends any[], R>(
		action: IAction<any, A, R>,
		args: A,
		idAccessor: () => string,
		dispatch: (args: A) => Promise<R | undefined>
	): Promise<R | undefined> {
		const gateway = options.gateway;
		let copies: A | undefined;
		if (gateway?.frameOpen()) {
			// A refused argument fails the action without a slice, so it needn't wait.
			try {
				copies = copyArguments(displayName(action), args);
			} catch {
				copies = undefined;
			}
		}
		if (!gateway || copies === undefined) {
			return host.untrack(() => dispatch(args));
		}
		const held = copies;
		let id: unknown;
		try {
			id = idAccessor();
		} catch {
			id = undefined;
		}
		const addressed = typeof id === "string" && gateway.addressLive(id);
		return new Promise<R | undefined>((resolve, reject) => {
			gateway.afterFrame(
				() => {
					if (addressed && !gateway.addressLive(id as string)) {
						resolve(undefined);
						return;
					}
					host.untrack(() => dispatch(held)).then(resolve, reject);
				},
				() => resolve(undefined)
			);
		});
	}

	function dispatchInternal<T, A extends any[], R>(
		action: IAction<T, A, R>,
		getState: () => T,
		setState: ISetState<T>,
		idAccessor: () => string,
		args: A,
		dispatchOptions: IInternalDispatchOptions
	): Promise<R | undefined> {
		if (syncCallOpen()) {
			refuseInSyncCall(`tried to dispatch action "${displayName(action)}"`);
		}
		return afterFrame(action, args, idAccessor, (copies) =>
			dispatchAction(action, getState, setState, idAccessor, copies, dispatchOptions)
		);
	}

	async function dispatchAction<T, A extends any[], R>(
		action: IAction<T, A, R>,
		getState: () => T,
		setState: ISetState<T>,
		idAccessor: () => string,
		args: A,
		dispatchOptions: IInternalDispatchOptions | undefined
	): Promise<R | undefined> {
		const entityId = idAccessor();
		const origin = dispatchOptions?.origin;
		const isRun = origin?.Kind === "resource:run";
		const node = readNodeOf(setState);
		const key = gateKeyOf(entityId, node, isRun);
		const recordRoot = options.gateway?.rootNameOf(key ?? entityId) ?? "AppState";
		requireName(action, recordRoot, origin);
		const receiver = receiverOf(action);
		const active: IActiveAction = {
			name: displayName(action),
			durableName: receiver === undefined ? nameOf(action) : null,
			label: labelOf(action),
			receiver,
			actionId: "",
			entityId,
			fn: isRun ? null : action,
			counts: isRun ? NOTHING_COUNTED : countsOf(action, caseOf(action, args[0])),
			work: null,
			liveFibers: new Set(),
			stopped: false,
			onTaken: dispatchOptions?.onTaken,
			settled: dispatchOptions?.settled,
			stopFailure: null,
			routeStopFailure: null,
			routeId: key ?? entityId,
			outcome: null,
			finished: false,
			finish: () => finish(active),
			unrouted: [],
			refusals: null,
			emitDiag,
			resourceOrigin: origin !== undefined,
			recordRoot,
			root: null,
			gate: null,
			holding: false,
			waiter: null,
			ended: false,
			unwanted: false
		};
		enter(key ?? entityId, active);
		const linked = dispatchOptions?.signal;
		const stopLinked = () => {
			active.unwanted = true;
			stopAction(active);
		};
		if (linked?.aborted) {
			active.stopped = true;
		} else {
			linked?.addEventListener("abort", stopLinked);
		}
		try {
			return await arrive(action, getState, setState, active, entityId, args, origin, dispatchOptions, node, key);
		} finally {
			linked?.removeEventListener("abort", stopLinked);
			leave(active);
		}
	}

	function arrive<T, A extends any[], R>(
		action: IAction<T, A, R>,
		getState: () => T,
		setState: ISetState<T>,
		active: IActiveAction,
		entityId: string,
		args: A,
		origin: IActionOrigin | undefined,
		dispatchOptions: IInternalDispatchOptions | undefined,
		dispatchedNode: object | undefined,
		key: string | null
	): Promise<R | undefined> {
		const onStart = dispatchOptions?.onStart;
		const startedBy = dispatchOptions?.startedBy;
		const isRun = active.fn === null;
		const journaling = journal.sample();
		const actionJournal = withRoot(journal, active.recordRoot);
		const actionStart = performance.now();

		const rootFiber = createFiber(allocateBranchId());
		const actionId = rootFiber.id;
		const actionName = active.name;
		active.root = rootFiber;
		active.actionId = actionId;
		let node = dispatchedNode;

		const recording: IRecordingContext = {
			currentJournalChanges: null,
			isDraft: true,
			checkPaths: journal.enabled,
			gateway: options.gateway,
			wrote: DEV && options.gateway ? (target, written) => reportHeldWrite(active, action, target, written) : undefined
		};

		const env: IActionEnv<T> = {
			actionId,
			actionName,
			entityId,
			hold:
				key === null
					? null
					: {
							actionName,
							entityId: key
						},
			getState,
			runtimeStoreReader,
			processActionPublic: processAction,
			dispatchInternal,
			effectProcessor,
			processRead,
			emitDiag,
			recording,
			journal: actionJournal,
			journaling,
			started: false,
			gateway: options.gateway,
			allocateBranchId,
			active,
			origin,
			retakeHold,
			regainHold,
			failedUnderStop: (fiber, error) =>
				keptByStop(active, fiber, {
					error,
					close: false
				}),
			closeThrew: (fiber, error, stopped) => {
				const kept = {
					error,
					close: true
				};
				if (stopped) {
					keptByStop(active, fiber, kept);
				} else {
					unrouted(active, kept);
				}
			},
			refusalIn: (error) => refusalIn(active, error),
			refusalOut: (error) => {
				active.refusals?.delete(error);
			},
			wakes: createWakeQueue(),
			requireName: (started, startedOn) => requireName(started, options.gateway?.rootNameOf(startedOn) ?? "AppState", undefined)
		};
		const ctx = makeFiberContext(env, rootFiber, origin);

		let copies: A;
		try {
			// Inside the try, so a refused argument fails the action through the
			// ordinary error path rather than as a bare rejection.
			copies = copyArguments(actionName, args);
			if (journaling["action:start"]) {
				actionJournal.append({
					T: actionStart,
					Kind: "action:start",
					ActionId: actionId,
					Name: active.durableName,
					Label: active.label,
					...(active.receiver !== undefined
						? {
								Receiver: active.receiver
							}
						: {}),
					EntityId: entityId,
					Path: [
						...(resolvePath ? resolvePath(entityId) : [])
					],
					Args: copies as unknown as unknown[],
					...(startedBy !== undefined
						? {
								StartedBy: startedBy
							}
						: {}),
					...(origin !== undefined
						? {
								Origin: {
									...origin
								}
							}
						: {})
				});
			}
			env.started = true;
		} catch (initError) {
			settleAction(ctx, actionStart, {
				status: "errored",
				error: initError
			});
			return Promise.reject(initError);
		}

		const start = async (queued: boolean): Promise<R | undefined> => {
			if (onStart && !onStart()) {
				settleAction(ctx, actionStart, {
					status: "dropped"
				});
				return undefined;
			}
			let machine: IFiberMachine;
			try {
				if (queued) {
					node = readNodeOf(setState);
				}
				const draft = createRecordingProxy(node as T, recording, new WeakMap(), [], undefined, {
					check: () => {
						if (letGo(active)) {
							throw new DraftInsideOpenError(actionName);
						}
					}
				});
				active.liveFibers.add(rootFiber);
				if (active.stopped) {
					stopFiber(rootFiber, "action");
				}
				machine = createFiberMachine(ctx, () => action(draft, ...copies) as Generator<unknown, unknown, unknown>);
				const first = machine.start();
				if (first.kind === "errored") {
					throw first.error;
				}
			} catch (initError) {
				settleAction(ctx, actionStart, {
					status: "errored",
					error: initError
				});
				throw initError;
			}
			return (await runToCompletion(ctx, machine, actionStart)) as R | undefined;
		};

		const policy = isRun ? null : policyOf(action);
		if (policy) {
			const entries = active.work?.entries ?? [];
			// By `fn`, not `counts`: a delivery of a marked case is never stopped by the case's mark.
			const ahead = entries.slice(0, entries.indexOf(active)).filter((entry) => entry.fn === action && !entry.ended && !entry.stopped);
			if (policy.kind === "leading" && ahead.length > 0) {
				settleAction(ctx, actionStart, {
					status: "dropped"
				});
				return Promise.resolve(undefined);
			}
			if (policy.kind === "latest") {
				for (const replaced of ahead) {
					stopAction(replaced);
				}
			}
		}

		if (key === null) {
			return start(false);
		}
		const gate = gateFor(key);
		const hold = (): void => {
			gate.holder = active;
			active.gate = gate;
			active.holding = true;
		};
		const held = dispatchOptions?.arrivals;
		const holdBack = held !== undefined && !held.begun;
		if (isFree(gate) && !holdBack) {
			hold();
			return start(false);
		}
		return new Promise<R | undefined>((resolve, reject) => {
			const waiter: IWaiter = {
				active,
				name: actionName,
				begin: () => {
					active.waiter = null;
					hold();
					start(true).then(resolve, reject);
				},
				cancel: () => {
					settleAction(ctx, actionStart, {
						status: active.unwanted ? "dropped" : "cancelled"
					});
					resolve(undefined);
				}
			};
			active.gate = gate;
			active.waiter = waiter;
			if (!holdBack) {
				enqueue(gate, waiter);
				return;
			}
			waiter.arrivals = held;
			gate.queue.push(waiter);
			armIfQueued(gate);
			held.starts.push(() => {
				if (gate.holder === null) {
					pump(gate);
				}
			});
		});
	}

	function settleAction<T>(ctx: IFiberContext<T>, actionStart: number, outcome: IActionOutcome): void {
		const active = ctx.env.active;
		if (outcome.status === "errored") {
			ctx.env.refusalOut(outcome.error);
		}
		ctx.fiber.status = outcome.status === "dropped" ? "cancelled" : outcome.status;
		active.liveFibers.delete(ctx.fiber);
		releaseIfDone(active);
		leave(active);
		// An r.run's result can carry a streaming type's auth headers, so it
		// is withheld from the tap like a redacted settlement.
		const runOrigin = ctx.env.origin?.Kind === "resource:run";
		if (ctx.env.started && ctx.env.journaling["action:end"]) {
			const endT = performance.now();
			ctx.env.journal.append(
				{
					T: endT,
					Kind: "action:end",
					ActionId: ctx.env.actionId,
					Status: outcome.status
				},
				outcome.status === "completed"
					? runOrigin
						? {
								duration: endT - actionStart
							}
						: {
								result: outcome.result,
								duration: endT - actionStart
							}
					: outcome.status === "errored"
						? {
								error: outcome.error,
								duration: endT - actionStart
							}
						: {
								duration: endT - actionStart
							}
			);
		}
		active.outcome = outcome;
		const ownRoute = !runOrigin && !active.settled;
		const failureOf = (status: "errored" | "cancelled", kept: IKept): IFailure => ({
			error: kept.error,
			entityId: active.routeId,
			name: active.durableName,
			label: active.label,
			actionId: active.actionId,
			action: active.fn,
			status,
			close: kept.close
		});
		// An errored r.run's rejection is its route: the resource holds that promise, and an action it reaches reports it.
		if (outcome.status === "errored" && ownRoute) {
			route(
				failureOf("errored", {
					error: outcome.error,
					close: false
				}),
				active.onTaken
			);
		}
		// A removed entity's work was stopped by its owner, and what it throws on the way out isn't routed.
		const routeStop =
			outcome.status === "cancelled" && ownRoute
				? (kept: IKept): void => {
						if (inTree(active.routeId)) {
							route(failureOf("cancelled", kept), undefined);
						} else {
							unrouted(active, kept);
						}
					}
				: (kept: IKept): void => unrouted(active, kept);
		if (active.stopFailure) {
			routeStop(active.stopFailure);
		} else {
			active.routeStopFailure = routeStop;
		}
		if (active.settled && !runOrigin) {
			active.settled(outcome, active.actionId);
		}
		active.finish();
	}

	function finish(active: IActiveAction): void {
		const outcome = active.outcome;
		if (!active.ended || outcome === null) {
			return;
		}
		const status = outcome.status === "dropped" ? "cancelled" : outcome.status;
		const due = active.unrouted;
		active.unrouted = [];
		for (const kept of due) {
			emitDiag({
				severity: "warn",
				code: "action/unrouted-throw",
				message:
					`[treflex] Action "${active.name}" on "${active.routeId}" threw${kept.close ? " in its close" : ""}, and nothing routes the throw. ` +
					`It ended ${status}. The error is in the data.`,
				data: {
					actionName: active.name,
					entityId: active.routeId,
					close: kept.close,
					error: serializeThrow(kept.error)
				}
			});
			emitFailure(
				withAction(
					{
						Error: kept.error,
						ActionId: active.actionId,
						Name: active.durableName,
						Label: active.label,
						EntityId: active.routeId,
						Status: status,
						Close: kept.close,
						Taken: false
					},
					active.fn
				)
			);
		}
		if (active.finished) {
			return;
		}
		active.finished = true;
		const swallowed = active.refusals;
		if (swallowed === null || swallowed.size === 0) {
			return;
		}
		const [first] = swallowed as Set<Error>;
		emitDiag({
			severity: "warn",
			code: "action/refusal-swallowed",
			message:
				`[treflex] Action "${active.name}" caught the ${first!.name} it was refused with and ended ${status} without rethrowing it, ` +
				`so the broken rule went unheard: ${first!.message} A catch that can meet a refusal rethrows it: if (isRefusal(error)) throw error;`,
			data: {
				actionName: active.name,
				actionId: active.actionId,
				entityId: active.routeId,
				refusal: serializeThrow(first),
				count: swallowed.size
			}
		});
	}

	async function runToCompletion<T>(ctx: IFiberContext<T>, machine: IFiberMachine, actionStart: number): Promise<unknown> {
		try {
			const result = await runFiberLoop(ctx, machine);

			if (machine.position === "cancelled") {
				settleAction(ctx, actionStart, {
					status: "cancelled"
				});
				return undefined;
			}

			settleAction(ctx, actionStart, {
				status: "completed",
				result
			});
			return result;
		} catch (error) {
			settleAction(ctx, actionStart, {
				status: "errored",
				error
			});
			throw error;
		}
	}

	return {
		processAction,
		dispatchInternal,
		runningActions,
		inFlightActions
	};
}
