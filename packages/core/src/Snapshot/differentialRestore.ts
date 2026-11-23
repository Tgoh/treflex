import type { IEffectCreator } from "../Effects/defineEffect";
import type { IRuntime } from "../Runtime/createRuntime";
import type { IRuntimeInternal } from "../Runtime/internals";
import type { IErrorContext, IInFlightAction } from "../Runtime/processAction";
import type { IEffectStub, ITestRuntimeOptions } from "../Testing/createTestRuntime";
import type { IAction } from "../Types/IAction";
import type { IActionContext } from "../Types/IActionContext";
import type { IEffect } from "../Types/IEffect";
import type { IFailureEvent, IRuntimeEventRegistry } from "../Types/IRuntimeEvent";
import type { ISnapshot, ISnapshotInFlightEntry } from "./ISnapshot";
import type { IRestoreResult } from "./loadSnapshot";
import type { IRestored, IRestoreOutcome } from "./restore";
import { settlesSync } from "../Runtime/effectDeclarations";
import { rawOf } from "../Runtime/viewProxy";
import { buildTestRuntime, settled, testRuntimeSite } from "../Testing/createTestRuntime";
import { errorClass } from "../Utility/errorClasses";
import { createSnapshot } from "./createSnapshot";
import { AsyncSetupError, restoreWith } from "./restore";

/** An entity's `$Id`, or a function that finds it in the runtime the step is played on. */
export type IDifferentialTarget<T extends object> = string | ((runtime: IRuntime<T>) => string);

/** A script step that dispatches `dispatch` on `on`. Built, with its arguments checked, by `dispatchStep`. */
export interface IDifferentialDispatch<T extends object> {
	readonly dispatch: IAction<any, any[], any>;
	readonly on: IDifferentialTarget<T>;
	/** The arguments, or a function that reads them from the runtime the step is played on. */
	readonly args?: readonly unknown[] | ((runtime: IRuntime<T>) => readonly unknown[]);
}

/**
 * A script step that settles one held effect of type `settle`, the one yielded on `on` that `where` accepts:
 * it resolves to `value`, or rejects with `error` when the step has an `error` field. Built, with its value
 * checked, by `settleStep`.
 */
export interface IDifferentialSettle<T extends object> {
	readonly settle: string;
	readonly on?: IDifferentialTarget<T> | undefined;
	readonly where?: ((effect: any) => boolean) | undefined;
	readonly value?: unknown;
	readonly error?: unknown;
}

export type IDifferentialStep<T extends object> = IDifferentialDispatch<T> | IDifferentialSettle<T>;

export interface IDifferentialOptions<T extends object> {
	/** The tree each run starts from, copied per run. Its `$Id` is the `rootId` each restore checks. */
	seed: T;
	/**
	 * The app's startup registration, called on every runtime the tool builds, and on each restore as its `setup`.
	 * Synchronous, as a restore's: one that returns a promise is refused with `AsyncSetupError`. In a restore the
	 * tool's rejection names the step, with the `AsyncSetupError` as its `cause`.
	 */
	setup?: ((runtime: IRuntime<T>) => void) | undefined;
	/** The app's repair, run by each restore. */
	repair?: ((runtime: IRuntime<T>, result: IRestoreResult) => unknown) | undefined;
	/**
	 * How long each restore, its `repair` included, may take before the tool rejects, in milliseconds: a positive
	 * finite number, 1000 by default.
	 */
	restoreTimeoutMs?: number | undefined;
	/**
	 * As `createTestRuntime`'s, shared by every run, so each must keep no state; or a function that returns fresh
	 * stubs, called once for the uninterrupted run and once for each restored run: one per point, or two with
	 * `compareDataOnly`. A restored run's stubs serve a run of the script up to its point and then the restore of it,
	 * so a stub that keeps state has seen that point's calls.
	 * A function that returns the same map, or the same stub, twice is refused, and so is a `generateGuid` stub, since
	 * the tool mints ids itself.
	 */
	effectStubs?: Record<string, IEffectStub> | (() => Record<string, IEffectStub>) | undefined;
	/**
	 * As `createTestRuntime`'s, shared by every run, resource stubs included, so it must keep no state. `allowDiags`
	 * and `allowFailures` apply to the uninterrupted run.
	 */
	options?: ITestRuntimeOptions | undefined;
	/** The effect types the tool holds open until a settle step answers them, given as their declarations or `Type`s. */
	hold?:
		| readonly (
				| string
				| {
						readonly Type: string;
				  }
		  )[]
		| undefined;
	/**
	 * Restores each point a second time as an app without `resume` does, and compares the resumed run with that
	 * data-only run: each point gains `dataOnly` and `comparison`, and the report `worse`. Needs `options.resume`
	 * and `options.build`. See docs/reference/testing.md#comparing-with-a-data-only-restore.
	 *
	 * @experimental
	 */
	compareDataOnly?: boolean | undefined;
}

export interface IDiagSummary {
	code: string;
	severity: IRuntimeEventRegistry["diag"]["severity"];
	message: string;
}

/** A failure event, its `Error` as `"name: message"` and without the `ActionId` each runtime numbers for itself. */
export interface IFailureSummary {
	Name: string | null;
	Label: string | null;
	EntityId: string;
	Status: IFailureEvent["Status"];
	Close: boolean;
	Taken: boolean;
	Error: string;
}

/** A call to the app's `onError`, its error as `"name: message"`, and what the app's `onError` threw, if it threw. */
export interface IOnErrorSummary {
	Name: string | null;
	Label: string | null;
	EntityId: string;
	Error: string;
	Threw?: string;
}

/** An action still running, without the `ActionId` each runtime numbers for itself. */
export type IInFlightSummary = Omit<ISnapshotInFlightEntry, "ActionId">;

/** An effect the tool still holds open, by its type and the entity of the action that yielded it. */
export interface IHeldSummary {
	Type: string;
	EntityId: string | null;
}

/** What a restored run left running after its last step, which the uninterrupted run never does. */
export interface IUnfinished {
	inFlight: IInFlightSummary[];
	held: IHeldSummary[];
}

/** What the uninterrupted run raised and the restored one didn't, and the other way round. */
export interface IEventDifference<E> {
	missing: E[];
	extra: E[];
}

/** One place where the final trees differ, `undefined` for a side that has nothing there. */
export interface IStateDifference {
	path: string;
	expected: unknown;
	actual: unknown;
}

/**
 * Only the kinds that differ are present, so `{}` is a point that ended as the uninterrupted run. The ids the tool
 * minted after the point are compared through a pairing of each run's ids with the other's, not by name, and those
 * that existed at the point by name; each side shows its own run's ids.
 */
export interface IDifferences {
	state?: IStateDifference[];
	diags?: IEventDifference<IDiagSummary>;
	failures?: IEventDifference<IFailureSummary>;
	onError?: IEventDifference<IOnErrorSummary>;
	unfinished?: IUnfinished;
	/** What the repair threw, as `"name: message"`. */
	repairError?: string;
}

/** A step the restored run couldn't play, numbered from 1. */
export interface IDifferentialSkip {
	step: number;
	reason: string;
}

/**
 * A state path both restored runs differ at, with another value in each: `actual` is the resumed run's and
 * `dataOnly` the data-only run's.
 *
 * @experimental
 */
export interface IChangedState extends IStateDifference {
	dataOnly: unknown;
}

/**
 * The data-only run of a point: the script played to the point again and restored with `resume` left out.
 *
 * @experimental
 */
export interface IDataOnlyRun {
	result: IRestoreOutcome;
	skipped: IDifferentialSkip[];
	differences: IDifferences;
	same: boolean;
}

/**
 * The resumed run's differences set against the data-only run's.
 *
 * @experimental
 */
export interface IDataOnlyComparison {
	/** What the resumed run differs by that the data-only run doesn't and nothing excuses. `{}` where resume was never worse. */
	worse: IDifferences;
	/** What `worse` would hold but for a resumed action the restore reported as carrying on beside dropped work. Waived, not checked. */
	reported: IDifferences;
	/** The state paths both runs differ at, with different values in the two. */
	changed: IChangedState[];
	/** Each diag code raised after the point a different number of times by the three runs. For information: it is never an item. */
	diagCounts: IDiagCount[];
}

/**
 * How many times each run raised a diag code after the point.
 *
 * @experimental
 */
export interface IDiagCount {
	code: string;
	uninterrupted: number;
	dataOnly: number;
	resumed: number;
}

export interface IRestorePoint {
	/** How many steps ran before the snapshot. */
	after: number;
	/** The snapshot's in-flight list. It leaves out work on transient and component-state entities, so it can be empty. */
	inFlight: ISnapshotInFlightEntry[];
	/** The snapshot the point's restore read, as `createSnapshot` wrote it. */
	snapshot: string;
	/** What the restore resolved to. */
	result: IRestoreOutcome;
	skipped: IDifferentialSkip[];
	differences: IDifferences;
	same: boolean;
	/**
	 * With `compareDataOnly` only.
	 *
	 * @experimental
	 */
	dataOnly?: IDataOnlyRun;
	/**
	 * With `compareDataOnly` only.
	 *
	 * @experimental
	 */
	comparison?: IDataOnlyComparison;
}

export interface IDifferentialReport {
	steps: number;
	/** How many points between two steps had nothing running, so weren't restored. */
	quiet: number;
	/** Every point at which work was in flight, in script order. */
	points: IRestorePoint[];
	/** The points that didn't end as the uninterrupted run. */
	differing: IRestorePoint[];
	/**
	 * With `compareDataOnly` only: the points whose `comparison.worse` isn't `{}`.
	 *
	 * @experimental
	 */
	worse?: IRestorePoint[];
}

type IArgsOf<T extends object, A extends any[]> = A | ((runtime: IRuntime<T>) => A);

/** A dispatch step, its arguments checked against the action's. */
export function dispatchStep<T extends object, A extends any[]>(
	action: IAction<any, A, any>,
	on: IDifferentialTarget<T>,
	...args: [] extends A
		? [
				args?: IArgsOf<T, A>
			]
		: [
				args: IArgsOf<T, A>
			]
): IDifferentialDispatch<T> {
	return args[0] === undefined
		? {
				dispatch: action,
				on
			}
		: {
				dispatch: action,
				on,
				args: args[0] as NonNullable<IDifferentialDispatch<T>["args"]>
			};
}

export type ISettleOutcome<R> =
	| {
			value: R;
	  }
	| {
			error: unknown;
	  };

export interface ISettleMatch<T extends object, E> {
	on?: IDifferentialTarget<T>;
	where?: (effect: E) => boolean;
}

/** A settle step, its value checked against the declaration's result. */
export function settleStep<T extends object, E extends IEffect, R>(
	effect: IEffectCreator<E, R>,
	outcome: ISettleOutcome<R>,
	match?: ISettleMatch<T, E>
): IDifferentialSettle<T>;
export function settleStep<T extends object>(
	type: string,
	outcome: ISettleOutcome<unknown>,
	match?: ISettleMatch<T, IEffect>
): IDifferentialSettle<T>;
export function settleStep<T extends object>(
	effect: string | IEffectCreator<IEffect, unknown>,
	outcome: ISettleOutcome<unknown>,
	match: ISettleMatch<T, any> = {}
): IDifferentialSettle<T> {
	return {
		settle: typeof effect === "string" ? effect : effect.Type,
		...match,
		...outcome
	};
}

const PREFIX = "[treflex] differentialRestore:";

const said = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

const stepName = (step: IDifferentialStep<any>): string =>
	"dispatch" in step ? `dispatch ${step.dispatch.name || "(anonymous)"}` : `settle "${step.settle}"`;

interface IHeld {
	type: string;
	entityId: string | undefined;
	effect: IEffect;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

interface ICut {
	diags: number;
	failures: number;
	onError: number;
}

interface IRun<T extends object> {
	runtime: IRuntime<T>;
	held: IHeld[];
	yielded: Set<string>;
	diags: IDiagSummary[];
	/** Each of `diags`' `data`, at its index. */
	diagData: unknown[];
	failures: IFailureSummary[];
	onError: IOnErrorSummary[];
	mintingFor: string;
	count: number;
	minted: Set<string>;
	recording: boolean;
}

function newRun<T extends object>(mintingFor: string, minted = new Set<string>()): IRun<T> {
	return {
		runtime: undefined as unknown as IRuntime<T>,
		held: [],
		yielded: new Set(),
		diags: [],
		diagData: [],
		failures: [],
		onError: [],
		mintingFor,
		count: 0,
		minted,
		recording: true
	};
}

function startStep(run: IRun<object>, index: number): void {
	run.mintingFor = `step${index + 1}`;
	run.count = 0;
}

const cutOf = (run: IRun<object>): ICut => ({
	diags: run.diags.length,
	failures: run.failures.length,
	onError: run.onError.length
});

function stubsOf(
	effectStubs: IDifferentialOptions<object>["effectStubs"],
	held: ReadonlySet<string>,
	issued: Set<unknown>
): Record<string, IEffectStub> {
	const stubs = (typeof effectStubs === "function" ? effectStubs() : effectStubs) ?? {};
	if ("generateGuid" in stubs) {
		throw new TypeError(`${PREFIX} the tool mints ids itself, named for the step that mints them; leave generateGuid out of effectStubs.`);
	}
	for (const type of held) {
		if (type in stubs) {
			throw new TypeError(`${PREFIX} "${type}" is both held and stubbed; a held type is answered only by settle steps.`);
		}
	}
	if (typeof effectStubs === "function") {
		const again = issued.has(stubs) ? "the same map" : Object.keys(stubs).find((type) => issued.has(stubs[type]));
		if (again !== undefined) {
			throw new TypeError(
				`${PREFIX} effectStubs returned ${again === "the same map" ? again : `the same stub for "${again}"`} on two calls, so runs would share it. ` +
					"A function must return fresh stubs each call; stubs every run shares, which must keep no state, are given as a map."
			);
		}
		issued.add(stubs);
		for (const stub of Object.values(stubs)) {
			issued.add(stub);
		}
	}
	return stubs;
}

function stubsFor<T extends object>(run: IRun<T>, effectStubs: Record<string, IEffectStub>): Record<string, IEffectStub> {
	return {
		...effectStubs,
		generateGuid: () => {
			const guid = `${run.mintingFor}-${++run.count}`;
			run.minted.add(guid);
			return guid;
		}
	};
}

function onErrorFor<T extends object>(run: IRun<T>, options: ITestRuntimeOptions | undefined, swallow: boolean) {
	const onError = options?.onError;
	if (!onError) {
		return undefined;
	}
	return (error: unknown, context: IErrorContext): void => {
		const call: IOnErrorSummary = {
			Name: context.Name,
			Label: context.Label,
			EntityId: context.EntityId,
			Error: said(error)
		};
		if (run.recording) {
			run.onError.push(call);
		}
		try {
			onError(error, context);
		} catch (thrown) {
			call.Threw = said(thrown);
			if (!swallow) {
				throw thrown;
			}
		}
	};
}

function listen<T extends object>(run: IRun<T>, runtime: IRuntime<T>): void {
	runtime.on("diag", (event) => {
		if (run.recording) {
			run.diags.push({
				code: event.code,
				severity: event.severity,
				message: event.message
			});
			run.diagData.push(event.data);
		}
	});
	runtime.on("failure", (event) => {
		if (run.recording) {
			run.failures.push({
				Name: event.Name,
				Label: event.Label,
				EntityId: event.EntityId,
				Status: event.Status,
				Close: event.Close,
				Taken: event.Taken,
				Error: said(event.Error)
			});
		}
	});
}

function holdOn<T extends object>(
	run: IRun<T>,
	runtime: IRuntime<T>,
	held: ReadonlySet<string>,
	setup: IDifferentialOptions<T>["setup"]
): void {
	const register = runtime.registerImplementation;
	for (const type of held) {
		register(type, (effect: IEffect, action?: IActionContext) => {
			run.yielded.add(type);
			return new Promise((resolve, reject) => {
				const entry: IHeld = {
					type,
					entityId: action?.entityId,
					effect,
					resolve,
					reject
				};
				run.held.push(entry);
				action?.signal.addEventListener(
					"abort",
					() => {
						const at = run.held.indexOf(entry);
						if (at !== -1) {
							run.held.splice(at, 1);
						}
					},
					{
						once: true
					}
				);
			});
		});
	}
	runtime.registerImplementation = ((
		nameOrTag:
			| string
			| {
					Type: string;
			  },
		impl?: unknown
	) => {
		if (held.has(typeof nameOrTag === "string" ? nameOrTag : nameOrTag.Type)) {
			return;
		}
		(register as (nameOrTag: unknown, impl?: unknown) => void)(nameOrTag, impl);
	}) as typeof register;
	let returned: unknown;
	try {
		returned = setup?.(runtime);
	} finally {
		runtime.registerImplementation = register;
	}
	if (typeof (returned as PromiseLike<unknown> | null | undefined)?.then === "function") {
		(returned as PromiseLike<unknown>).then(undefined, () => {});
		throw new AsyncSetupError();
	}
}

const runningIn = (runtime: IRuntime<object>): IInFlightAction[] => (runtime as IRuntimeInternal<object>).get("runtime/inFlightActions")();

const heldList = (held: readonly IHeld[]): string =>
	held.length === 0 ? "none" : held.map((h) => `"${h.type}" on "${h.entityId}" ${JSON.stringify(h.effect)}`).join(", ");

const inFlightList = (entries: readonly ISnapshotInFlightEntry[]): string =>
	entries.map((e) => `${e.Name ?? e.Label ?? e.Receiver ?? "(anonymous)"} on "${e.EntityId}"`).join(", ");

function unfinishedIn(run: IRun<object>): IUnfinished | undefined {
	const inFlight = runningIn(run.runtime).map(({ ActionId: _, ...entry }) => entry);
	if (inFlight.length === 0 && run.held.length === 0) {
		return undefined;
	}
	return {
		inFlight,
		held: run.held.map((h) => ({
			Type: h.type,
			EntityId: h.entityId ?? null
		}))
	};
}

class Skip extends Error {}

errorClass("treflex/DifferentialRestoreSkip", Skip);

function targetOf<T extends object>(on: IDifferentialTarget<T>, runtime: IRuntime<T>): string {
	if (typeof on === "string") {
		return on;
	}
	let id: unknown;
	try {
		id = on(runtime);
	} catch (error) {
		throw new Skip(`its on threw: ${said(error)}`, {
			cause: error
		});
	}
	if (typeof id !== "string") {
		throw new Skip(`its on returned ${String(id)}, not an $Id`);
	}
	return id;
}

function play<T extends object>(run: IRun<T>, step: IDifferentialStep<T>): void {
	const runtime = run.runtime;
	if ("dispatch" in step) {
		const target = targetOf(step.on, runtime);
		if ((runtime as IRuntimeInternal<T>).resolveCell(target) === undefined) {
			throw new Skip(`no entity "${target}" is in the tree`);
		}
		let args: readonly unknown[];
		try {
			args = typeof step.args === "function" ? step.args(runtime) : (step.args ?? []);
		} catch (error) {
			throw new Skip(`its args threw: ${said(error)}`, {
				cause: error
			});
		}
		runtime.dispatch(step.dispatch, target, ...args).catch(() => {});
		return;
	}
	const on = step.on === undefined ? undefined : targetOf(step.on, runtime);
	const accepts = (effect: IEffect): boolean => {
		try {
			return step.where?.(effect) ?? true;
		} catch (error) {
			throw new Skip(`its where threw: ${said(error)}`, {
				cause: error
			});
		}
	};
	const matches = run.held.filter((h) => h.type === step.settle && (on === undefined || h.entityId === on) && accepts(h.effect));
	const what = `"${step.settle}"${on === undefined ? "" : ` on "${on}"`}`;
	if (matches.length === 0) {
		throw new Skip(`no ${what} is held open; open: ${heldList(run.held)}`);
	}
	if (matches.length > 1) {
		throw new Skip(`${matches.length} ${what} are held open, so it is ambiguous: ${heldList(matches)}. Narrow it with on or where`);
	}
	const [match] = matches;
	run.held.splice(run.held.indexOf(match!), 1);
	if ("error" in step) {
		match!.reject(step.error);
	} else {
		match!.resolve(step.value);
	}
}

function stateOf(runtime: IRuntime<object>): unknown {
	return JSON.parse(JSON.stringify(rawOf(runtime.state)));
}

// NextDue is a clock reading, which two runs of one script don't share.
function standingOf(run: IRun<object>): string {
	const snapshot = JSON.parse(createSnapshot(run.runtime)) as ISnapshot;
	return JSON.stringify({
		...snapshot,
		Timers: snapshot.Timers.map(({ NextDue: _, ...row }) => row),
		Held: run.held.map((h) => ({
			Type: h.type,
			EntityId: h.entityId ?? null,
			Effect: h.effect
		}))
	});
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const NONE: ReadonlySet<string> = new Set();

/**
 * Ids minted in the uninterrupted run (0) and the restored run (1), and a one-to-one pairing between them, which
 * starts with each id that existed at the point paired with itself.
 */
interface IPairing {
	minted: readonly [
		ReadonlySet<string>,
		ReadonlySet<string>
	];
	forward: Map<string, string>;
	back: Map<string, string>;
	held: readonly [
		Set<string>,
		Set<string>
	];
}

export function pairingOf(
	expectedMinted: ReadonlySet<string>,
	actualMinted: ReadonlySet<string>,
	existing: ReadonlySet<string> = NONE
): IPairing {
	const p: IPairing = {
		minted: [
			new Set([
				...expectedMinted,
				...existing
			]),
			new Set([
				...actualMinted,
				...existing
			])
		],
		forward: new Map(),
		back: new Map(),
		held: [
			new Set(),
			new Set()
		]
	};
	for (const guid of existing) {
		p.forward.set(guid, guid);
		p.back.set(guid, guid);
	}
	return p;
}

function mintIn(value: string, minted: ReadonlySet<string>): string | undefined {
	const guid = value.startsWith("~") ? value.slice(1) : value;
	return minted.has(guid) ? guid : undefined;
}

function sameString(p: IPairing, e: string, a: string, pairNow: boolean): boolean {
	const ge = mintIn(e, p.minted[0]);
	const ga = mintIn(a, p.minted[1]);
	if (ge === undefined || ga === undefined) {
		return ge === ga && e === a;
	}
	if (e.length - ge.length !== a.length - ga.length) {
		return false;
	}
	if (p.forward.get(ge) === ga) {
		return true;
	}
	if (pairNow && !p.forward.has(ge) && !p.back.has(ga)) {
		p.forward.set(ge, ga);
		p.back.set(ga, ge);
		return true;
	}
	return false;
}

function matchKeys(
	p: IPairing,
	e: Record<string, unknown>,
	a: Record<string, unknown>
): [
	string | undefined,
	string | undefined
][] {
	const out: [
		string | undefined,
		string | undefined
	][] = [];
	const used = new Set<string>();
	const mintedInA: string[] = [];
	const byGuid = new Map<string, string>();
	for (const key of Object.keys(a)) {
		const guid = mintIn(key, p.minted[1]);
		if (guid !== undefined) {
			mintedInA.push(key);
			byGuid.set(guid, key);
		}
	}
	let next = 0;
	for (const key of Object.keys(e)) {
		const guid = mintIn(key, p.minted[0]);
		let match: string | undefined;
		if (guid === undefined) {
			match = Object.hasOwn(a, key) && mintIn(key, p.minted[1]) === undefined ? key : undefined;
		} else if (p.forward.has(guid)) {
			const partner = byGuid.get(p.forward.get(guid)!);
			match = partner !== undefined && sameString(p, key, partner, false) ? partner : undefined;
		} else {
			while (next < mintedInA.length && match === undefined) {
				const candidate = mintedInA[next++]!;
				if (!used.has(candidate) && sameString(p, key, candidate, true)) {
					match = candidate;
				}
			}
		}
		if (match !== undefined) {
			used.add(match);
		}
		out.push([
			key,
			match
		]);
	}
	for (const key of Object.keys(a)) {
		if (!used.has(key)) {
			out.push([
				undefined,
				key
			]);
		}
	}
	return out;
}

type IWalk = "ids" | "values" | "keys";

function pairPlaces(p: IPairing, e: unknown, a: unknown, walk: IWalk): void {
	if (walk === "values" && typeof e === "string" && typeof a === "string") {
		sameString(p, e, a, true);
		return;
	}
	if (!isRecord(e) || !isRecord(a) || Array.isArray(e) !== Array.isArray(a)) {
		return;
	}
	if (Array.isArray(e) && Array.isArray(a)) {
		for (let i = 0; i < Math.min(e.length, a.length); i++) {
			pairPlaces(p, e[i], a[i], walk);
		}
		return;
	}
	if (typeof e.$Id === "string" && typeof a.$Id === "string") {
		sameString(p, e.$Id, a.$Id, true);
	}
	if (walk === "keys") {
		for (const [ke, ka] of matchKeys(p, e, a)) {
			if (ke !== undefined && ka !== undefined) {
				pairPlaces(p, e[ke], a[ka], walk);
			}
		}
		return;
	}
	for (const key of Object.keys(e)) {
		if (mintIn(key, p.minted[0]) === undefined && Object.hasOwn(a, key) && mintIn(key, p.minted[1]) === undefined) {
			pairPlaces(p, e[key], a[key], walk);
		}
	}
}

function holds(value: unknown, minted: ReadonlySet<string>, into: Set<string>): void {
	if (typeof value === "string") {
		const guid = mintIn(value, minted);
		if (guid !== undefined) {
			into.add(guid);
		}
	} else if (isRecord(value)) {
		for (const [key, item] of Object.entries(value)) {
			holds(key, minted, into);
			holds(item, minted, into);
		}
	}
}

/** A path segment: an array index, or a key of the uninterrupted run's tree (0) or of the restored run's alone (1). */
export type ISegment =
	| number
	| readonly [
			0 | 1,
			string
	  ];

/**
 * The comparison's walk kept as segments, so a restored run's ids in it can be read through the pairing once the
 * walk has finished pairing them.
 */
export interface ITrace {
	/** One per difference, at its index. */
	diffs: {
		segments: ISegment[];
		actual: unknown;
	}[];
	/** Every entity of either final tree. */
	places: {
		side: 0 | 1;
		id: string;
		segments: ISegment[];
	}[];
}

function noteEntity(trace: ITrace, side: 0 | 1, value: unknown, segments: ISegment[]): void {
	if (isRecord(value) && typeof value.$Id === "string") {
		trace.places.push({
			side,
			id: value.$Id,
			segments
		});
	}
}

function noteBelow(trace: ITrace, side: 0 | 1, value: unknown, segments: ISegment[]): void {
	if (!isRecord(value)) {
		return;
	}
	const children: [
		ISegment,
		unknown
	][] = Array.isArray(value)
		? value.map((item, i) => [
				i,
				item
			])
		: Object.entries(value).map(([key, item]) => [
				[
					side,
					key
				],
				item
			]);
	for (const [segment, item] of children) {
		const below = [
			...segments,
			segment
		];
		noteEntity(trace, side, item, below);
		noteBelow(trace, side, item, below);
	}
}

function compareTrees(
	p: IPairing,
	e: unknown,
	a: unknown,
	path: string,
	out: IStateDifference[],
	trace?: ITrace,
	segments: ISegment[] = []
): void {
	if (trace) {
		noteEntity(trace, 0, e, segments);
		noteEntity(trace, 1, a, segments);
	}
	const below = (segment: ISegment): ISegment[] =>
		trace
			? [
					...segments,
					segment
				]
			: segments;
	if (isRecord(e) && isRecord(a) && Array.isArray(e) === Array.isArray(a)) {
		if (Array.isArray(e) && Array.isArray(a)) {
			for (let i = 0; i < Math.max(e.length, a.length); i++) {
				compareTrees(p, e[i], a[i], `${path}[${i}]`, out, trace, below(i));
			}
			return;
		}
		for (const [ke, ka] of matchKeys(p, e, a)) {
			const shown = (ke ?? ka)!;
			compareTrees(
				p,
				ke === undefined ? undefined : e[ke],
				ka === undefined ? undefined : a[ka],
				path === "" ? shown : `${path}.${shown}`,
				out,
				trace,
				below(
					ke === undefined
						? [
								1,
								ka!
							]
						: [
								0,
								ke
							]
				)
			);
		}
		return;
	}
	if (trace) {
		noteBelow(trace, 0, e, segments);
		noteBelow(trace, 1, a, segments);
	}
	const equal = typeof e === "string" && typeof a === "string" ? sameString(p, e, a, true) : !isRecord(e) && !isRecord(a) && e === a;
	if (!equal) {
		out.push({
			path,
			expected: e,
			actual: a
		});
		trace?.diffs.push({
			segments,
			actual: a
		});
	}
}

export function stateDifferences(p: IPairing, expected: unknown, actual: unknown, trace?: ITrace): IStateDifference[] {
	holds(expected, p.minted[0], p.held[0]);
	holds(actual, p.minted[1], p.held[1]);
	// The order decides which id wins a contested partner: an entity's place first, so a moved selection shows at the
	// selection; then ids at the same plain place, so a list of ids beats an id-keyed object's key order.
	pairPlaces(p, expected, actual, "ids");
	pairPlaces(p, expected, actual, "values");
	pairPlaces(p, expected, actual, "keys");
	const out: IStateDifference[] = [];
	compareTrees(p, expected, actual, "", out, trace);
	return out;
}

/**
 * A restored run's string as both restored runs can be compared by: an id it minted after the point as its partner
 * in the uninterrupted run, or, with none, as the step that minted it.
 */
function canonId(p: IPairing, value: string): string {
	const guid = mintIn(value, p.minted[1]);
	if (guid === undefined) {
		return value;
	}
	const partner = p.back.get(guid);
	return value.slice(0, value.length - guid.length) + (partner ?? `${guid.slice(0, guid.lastIndexOf("-"))}-*`);
}

function canonValue(p: IPairing, value: unknown): unknown {
	if (typeof value === "string") {
		return canonId(p, value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => canonValue(p, item));
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				canonId(p, key),
				canonValue(p, item)
			])
		);
	}
	return value;
}

function canonPath(p: IPairing | null, segments: readonly ISegment[]): string {
	let path = "";
	for (const segment of segments) {
		if (typeof segment === "number") {
			path += `[${segment}]`;
		} else {
			const key = segment[0] === 1 && p ? canonId(p, segment[1]) : segment[1];
			path = path === "" ? key : `${path}.${key}`;
		}
	}
	return path;
}

const atOrUnder = (path: string, place: string): boolean =>
	place === "" || path === place || path.startsWith(`${place}.`) || path.startsWith(`${place}[`);

function firstDifference(expected: string, actual: string): string {
	const [first] = stateDifferences(pairingOf(NONE, NONE), JSON.parse(expected), JSON.parse(actual));
	return first === undefined
		? ""
		: `at ${first.path}: ${JSON.stringify(first.expected) ?? "nothing"} uninterrupted, ${JSON.stringify(first.actual) ?? "nothing"} in this run`;
}

// Two ids neither final tree holds, and without partners, are equal: the trees can't say which removed entity is
// which. An id that existed at the point is its own partner, so it still compares by name.
function sameEvent(p: IPairing, e: unknown, a: unknown): boolean {
	if (typeof e === "string" && typeof a === "string") {
		const ge = mintIn(e, p.minted[0]);
		const ga = mintIn(a, p.minted[1]);
		if (ge !== undefined && ga !== undefined && !p.held[0].has(ge) && !p.held[1].has(ga) && !p.forward.has(ge) && !p.back.has(ga)) {
			return e.length - ge.length === a.length - ga.length;
		}
		return sameString(p, e, a, false);
	}
	if (isRecord(e) && isRecord(a) && Array.isArray(e) === Array.isArray(a)) {
		const keys = Object.keys(e);
		return keys.length === Object.keys(a).length && keys.every((k) => Object.hasOwn(a, k) && sameEvent(p, e[k], a[k]));
	}
	return e === a;
}

function eventDifference<E>(p: IPairing, expected: readonly E[], actual: readonly E[]): IEventDifference<E> | undefined {
	const extra: E[] = [];
	const unmatched = expected.map(() => true);
	for (const event of actual) {
		const at = expected.findIndex((e, i) => unmatched[i] && sameEvent(p, e, event));
		if (at === -1) {
			extra.push(event);
		} else {
			unmatched[at] = false;
		}
	}
	const missing = expected.filter((_, i) => unmatched[i]);
	return missing.length === 0 && extra.length === 0
		? undefined
		: {
				missing,
				extra
			};
}

export interface ISide {
	differences: IDifferences;
	pairing: IPairing;
	trace: ITrace;
	diags: readonly IDiagSummary[];
	diagData: readonly unknown[];
}

export interface IUninterruptedCut {
	diags: readonly IDiagSummary[];
	diagData: readonly unknown[];
	/** The codes it raised before the point. */
	raisedBefore: ReadonlySet<string>;
}

/** Ids by side, the uninterrupted run's (0) and the resumed run's (1), and the places as the comparison writes them. */
export interface IRegion {
	ids: readonly [
		Set<string>,
		Set<string>
	];
	places: string[];
}

const jsonOf = (value: unknown): string => JSON.stringify(value) ?? "undefined";

function leftOver<E>(mine: readonly E[], theirs: readonly E[], keyOfMine: (e: E) => string, keyOfTheirs: (e: E) => string): E[] {
	const counts = new Map<string, number>();
	for (const e of theirs) {
		const key = keyOfTheirs(e);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return mine.filter((e) => {
		const key = keyOfMine(e);
		const n = counts.get(key) ?? 0;
		if (n === 0) {
			return true;
		}
		counts.set(key, n - 1);
		return false;
	});
}

function names(value: unknown, ids: ReadonlySet<string>): boolean {
	if (typeof value === "string") {
		return ids.has(value);
	}
	return isRecord(value) && Object.entries(value).some(([key, item]) => ids.has(key) || names(item, ids));
}

export function regionOf(restoredTree: unknown, result: IRestoreResult, resumed: Pick<ISide, "pairing" | "trace">): IRegion {
	const restored: ITrace = {
		diffs: [],
		places: []
	};
	noteEntity(restored, 0, restoredTree, []);
	noteBelow(restored, 0, restoredTree, []);
	const at = new Map<string, string>();
	for (const place of restored.places) {
		if (!at.has(place.id)) {
			at.set(place.id, canonPath(null, place.segments));
		}
	}
	const finals = resumed.trace.places.map((place) => ({
		side: place.side,
		id: place.id,
		path: canonPath(place.side === 1 ? resumed.pairing : null, place.segments)
	}));
	const region: IRegion = {
		ids: [
			new Set(),
			new Set()
		],
		places: []
	};
	for (const action of result.resumed) {
		const mine = at.get(action.entityId);
		const beside =
			action.resourceWork.length > 0 ||
			result.dropped.some((drop) => {
				const theirs = at.get(drop.entityId);
				return (
					drop.entityId === action.entityId ||
					(mine !== undefined && theirs !== undefined && (atOrUnder(theirs, mine) || atOrUnder(mine, theirs)))
				);
			});
		if (!beside) {
			continue;
		}
		for (const top of finals.filter((place) => place.id === action.entityId)) {
			for (const place of finals) {
				if (place.side === top.side && atOrUnder(place.path, top.path)) {
					region.ids[place.side].add(place.id);
					region.places.push(place.path);
				}
			}
		}
	}
	return region;
}

function addEvent<E>(into: IDifferences, kind: "diags" | "failures" | "onError", side: "missing" | "extra", event: E): void {
	into[kind] ??= {
		missing: [],
		extra: []
	};
	(into[kind] as IEventDifference<E>)[side].push(event);
}

export function compareSides(resumed: ISide, dataOnly: ISide, was: IUninterruptedCut, region: IRegion): IDataOnlyComparison {
	const worse: IDifferences = {};
	const reported: IDifferences = {};
	const changed: IChangedState[] = [];
	const theirs = new Map<string, number[]>();
	for (const [i, diff] of dataOnly.trace.diffs.entries()) {
		const path = canonPath(dataOnly.pairing, diff.segments);
		theirs.set(path, [
			...(theirs.get(path) ?? []),
			i
		]);
	}
	for (const [i, difference] of (resumed.differences.state ?? []).entries()) {
		const diff = resumed.trace.diffs[i]!;
		const path = canonPath(resumed.pairing, diff.segments);
		const there = theirs.get(path) ?? [];
		if (there.length > 0) {
			const value = jsonOf(canonValue(resumed.pairing, diff.actual));
			if (!there.some((j) => jsonOf(canonValue(dataOnly.pairing, dataOnly.trace.diffs[j]!.actual)) === value)) {
				changed.push({
					...difference,
					dataOnly: dataOnly.differences.state![there[0]!]!.actual
				});
			}
			continue;
		}
		if (
			[
				...theirs.keys()
			].some((above) => atOrUnder(path, above))
		) {
			continue;
		}
		const into = region.places.some((place) => atOrUnder(path, place)) ? reported : worse;
		into.state ??= [];
		into.state.push(difference);
	}

	const mine = (e: unknown): string => jsonOf(canonValue(resumed.pairing, e));
	const other = (e: unknown): string => jsonOf(canonValue(dataOnly.pairing, e));
	for (const kind of [
		"failures",
		"onError"
	] as const) {
		const events = resumed.differences[kind] as IEventDifference<IFailureSummary | IOnErrorSummary> | undefined;
		const against = dataOnly.differences[kind] as IEventDifference<IFailureSummary | IOnErrorSummary> | undefined;
		if (!events) {
			continue;
		}
		for (const event of leftOver(events.missing, against?.missing ?? [], jsonOf, jsonOf)) {
			addEvent(region.ids[0].has(event.EntityId) ? reported : worse, kind, "missing", event);
		}
		for (const event of leftOver(events.extra, against?.extra ?? [], mine, other)) {
			addEvent(region.ids[1].has(event.EntityId) ? reported : worse, kind, "extra", event);
		}
	}

	const unfinished = resumed.differences.unfinished;
	if (unfinished) {
		const left = (into: IDifferences): IUnfinished => {
			into.unfinished ??= {
				inFlight: [],
				held: []
			};
			return into.unfinished;
		};
		for (const entry of leftOver(unfinished.inFlight, dataOnly.differences.unfinished?.inFlight ?? [], mine, other)) {
			left(region.ids[1].has(entry.EntityId) ? reported : worse).inFlight.push(entry);
		}
		for (const entry of leftOver(unfinished.held, dataOnly.differences.unfinished?.held ?? [], mine, other)) {
			left(entry.EntityId !== null && region.ids[1].has(entry.EntityId) ? reported : worse).held.push(entry);
		}
	}

	const counted = (diags: readonly IDiagSummary[], data: readonly unknown[]) =>
		diags
			.map((summary, i) => ({
				summary,
				data: data[i] ?? null
			}))
			.filter((seen) => !seen.summary.code.startsWith("resume/"));
	const before = counted(was.diags, was.diagData);
	const after = counted(resumed.diags, resumed.diagData);
	const alongside = counted(dataOnly.diags, dataOnly.diagData);
	const record = (
		side: "missing" | "extra",
		occurrences: {
			summary: IDiagSummary;
			data: unknown;
		}[],
		ids: ReadonlySet<string>
	) => {
		const into = occurrences.every((seen) => names(seen.data, ids)) ? reported : worse;
		for (const seen of occurrences) {
			addEvent(into, "diags", side, seen.summary);
		}
	};
	const diagCounts: IDiagCount[] = [];
	for (const code of new Set(
		[
			...before,
			...after,
			...alongside
		].map((seen) => seen.summary.code)
	)) {
		const ofCode = (seen: { summary: IDiagSummary }) => seen.summary.code === code;
		const u = before.filter(ofCode);
		const r = after.filter(ofCode);
		const d = alongside.filter(ofCode);
		if (r.length > 0 && d.length === 0 && u.length === 0 && !was.raisedBefore.has(code)) {
			record("extra", r, region.ids[1]);
		}
		if (u.length > 0 && r.length === 0 && d.length > 0) {
			record("missing", u, region.ids[0]);
		}
		if (u.length !== r.length || u.length !== d.length) {
			diagCounts.push({
				code,
				uninterrupted: u.length,
				dataOnly: d.length,
				resumed: r.length
			});
		}
	}

	const repairError = resumed.differences.repairError;
	if (repairError !== undefined && dataOnly.differences.repairError !== repairError) {
		worse.repairError = repairError;
	}
	return {
		worse,
		reported,
		changed,
		diagCounts
	};
}

const TIMED_OUT = Symbol("timed out");

// Taken at load, so a test's fake timers can't keep the restore limit from firing.
const setTimer = globalThis.setTimeout.bind(globalThis);
const clearTimer = globalThis.clearTimeout.bind(globalThis);

/**
 * Runs `script` once uninterrupted, then, for each point between two steps at which work is in flight, runs a
 * restore of a snapshot of that point with the app's `setup` and `repair`, plays the rest of the script on it,
 * and compares how it ends with the uninterrupted run. See docs/reference/testing.md#testing-every-restore-point.
 */
export async function differentialRestore<T extends object>(
	app: IDifferentialOptions<T>,
	script: readonly IDifferentialStep<T>[]
): Promise<IDifferentialReport> {
	const site = testRuntimeSite("differentialRestore", differentialRestore);
	const limit = app.restoreTimeoutMs ?? 1000;
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
		throw new TypeError(`${PREFIX} restoreTimeoutMs is ${String(limit)}; it takes a positive finite number of milliseconds.`);
	}
	const rootId = (
		app.seed as {
			$Id?: unknown;
		}
	).$Id;
	if (typeof rootId !== "string" || rootId === "") {
		throw new TypeError(`${PREFIX} the seed's root needs a $Id, the rootId each restore checks.`);
	}
	const held = new Set((app.hold ?? []).map((h) => (typeof h === "string" ? h : h.Type)));
	for (const type of held) {
		if (settlesSync(type)) {
			throw new TypeError(`${PREFIX} "${type}" is declared settles: "sync", so it can't be held open; take it out of hold.`);
		}
	}
	if (app.compareDataOnly) {
		for (const needed of [
			"resume",
			"build"
		] as const) {
			const given = app.options?.[needed];
			if (given === undefined || given === false) {
				throw new TypeError(
					`${PREFIX} compareDataOnly needs options.${needed}: without resume and a build nothing resumes, so the resumed run and the data-only run would be one.`
				);
			}
		}
	}

	const issued = new Set<unknown>();
	const baseline = newRun<T>("setup");
	baseline.runtime = buildTestRuntime(
		structuredClone(app.seed),
		stubsFor(baseline, stubsOf(app.effectStubs, held, issued)),
		{
			...app.options,
			onError: onErrorFor(baseline, app.options, false)
		},
		site
	);
	listen(baseline, baseline.runtime);
	let booted = "";
	const points: {
		standing: string;
		inFlight: ISnapshotInFlightEntry[];
		running: boolean;
		cut: ICut;
	}[] = [];
	let expected: unknown;
	try {
		holdOn(baseline, baseline.runtime, held, app.setup);
		await settled();
		booted = standingOf(baseline);
		for (const [index, step] of script.entries()) {
			startStep(baseline, index);
			try {
				play(baseline, step);
			} catch (error) {
				if (!(error instanceof Skip)) {
					throw error;
				}
				throw new Error(`${PREFIX} step ${index + 1}, ${stepName(step)}, can't run uninterrupted: ${error.message}.`, {
					cause: error.cause
				});
			}
			await settled();
			const standing = standingOf(baseline);
			points.push({
				standing,
				inFlight: (JSON.parse(standing) as ISnapshot).InFlight,
				running: runningIn(baseline.runtime).length > 0,
				cut: cutOf(baseline)
			});
		}
		const left = runningIn(baseline.runtime);
		if (left.length > 0 || baseline.held.length > 0) {
			throw new Error(
				`${PREFIX} the script ends with work in flight, so the uninterrupted run has no outcome to compare with. ` +
					`In flight: ${left.length === 0 ? "none" : inFlightList(left)}. Held open: ${heldList(baseline.held)}. ` +
					"Add the steps that finish it."
			);
		}
		for (const type of held) {
			if (!baseline.yielded.has(type)) {
				throw new Error(
					`${PREFIX} "${type}" is in hold, and the uninterrupted run never yields it: either hold misnames the type or the script doesn't reach it.`
				);
			}
		}
		expected = stateOf(baseline.runtime);
	} finally {
		baseline.recording = false;
		baseline.runtime.dispose();
	}

	const runTo = async (run: IRun<T>, after: number): Promise<string> => {
		const diverged = (what: string): Error =>
			new Error(
				`${PREFIX} the run to the point after step ${after} ${what}. The script, a stub that keeps state across runs, or the app's setup ` +
					"does something different each time it runs; the tool runs the script again from the seed to each point and needs it to reach the same state each time."
			);
		try {
			holdOn(run, run.runtime, held, app.setup);
		} catch (error) {
			throw new Error(`${PREFIX} the run to the point after step ${after} threw in setup: ${said(error)}`, {
				cause: error
			});
		}
		await settled();
		let standing = standingOf(run);
		if (standing !== booted) {
			throw diverged(`differs from the uninterrupted run once setup has run, ${firstDifference(booted, standing)}`);
		}
		for (let index = 0; index < after; index++) {
			const step = script[index]!;
			startStep(run, index);
			try {
				play(run, step);
			} catch (error) {
				if (!(error instanceof Skip)) {
					throw error;
				}
				throw diverged(`couldn't play step ${index + 1}, ${stepName(step)}, which the uninterrupted run played: ${error.message}`);
			}
			await settled();
			standing = standingOf(run);
			if (standing !== points[index]!.standing) {
				throw diverged(
					`differs from the uninterrupted run once both have played step ${index + 1}, ${stepName(step)}, ${firstDifference(points[index]!.standing, standing)}`
				);
			}
		}
		return createSnapshot(run.runtime);
	};

	const restoreAt = async (after: number, given: ITestRuntimeOptions | undefined) => {
		const point = points[after - 1]!;
		const stubs = stubsOf(app.effectStubs, held, issued);
		const before = newRun<T>("setup");
		before.recording = false;
		before.runtime = buildTestRuntime(
			structuredClone(app.seed),
			stubsFor(before, stubs),
			{
				...app.options,
				allowDiags: true,
				allowFailures: true,
				onError: onErrorFor(before, app.options, true)
			},
			site
		);
		let json: string;
		let existing: ReadonlySet<string>;
		try {
			json = await runTo(before, after);
			existing = new Set(before.minted);
		} finally {
			before.runtime.dispose();
		}
		await settled();
		const run = newRun<T>("restore", before.minted);
		const options: ITestRuntimeOptions = {
			...given,
			allowDiags: true,
			allowFailures: true,
			onError: onErrorFor(run, given, true)
		};
		// Builds as restoreTestRuntime in index.ts does, which this module can't import without a cycle.
		const restoring = restoreWith<T>(json, (state) => buildTestRuntime(state, stubsFor(run, stubs), options, site), {
			rootId,
			setup: (runtime) => {
				run.runtime = runtime;
				listen(run, runtime);
				holdOn(run, runtime, held, app.setup);
			},
			...(app.repair
				? {
						repair: app.repair
					}
				: {})
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const limited = new Promise<typeof TIMED_OUT>((resolve) => {
			timer = setTimer(() => resolve(TIMED_OUT), limit);
		});
		let outcome: IRestored<T> | typeof TIMED_OUT;
		try {
			outcome = await Promise.race([
				restoring,
				limited
			]);
		} catch (error) {
			throw new Error(`${PREFIX} the restore of the snapshot after step ${after} rejected: ${said(error)}`, {
				cause: error
			});
		} finally {
			clearTimer(timer);
		}
		if (outcome === TIMED_OUT) {
			const open =
				run.held.length === 0
					? ""
					: ` Effects held open then: ${heldList(run.held)}. Only a settle step answers a held effect, so a repair must not ` +
						"await work that waits on one; have it start that work without awaiting it.";
			run.recording = false;
			run.runtime.dispose();
			throw new Error(
				`${PREFIX} the restore of the snapshot after step ${after} hadn't finished in ${limit}ms, its restoreTimeoutMs.${open}`
			);
		}
		const restored = outcome;
		const skipped: IDifferentialSkip[] = [];
		let actual: unknown;
		let unfinished: IUnfinished | undefined;
		try {
			await settled();
			for (let index = after; index < script.length; index++) {
				startStep(run, index);
				try {
					play(run, script[index]!);
				} catch (error) {
					if (!(error instanceof Skip)) {
						throw error;
					}
					skipped.push({
						step: index + 1,
						reason: error.message
					});
				}
				await settled();
			}
			actual = stateOf(run.runtime);
			unfinished = unfinishedIn(run);
		} finally {
			run.recording = false;
			run.runtime.dispose();
		}
		const was = {
			diags: baseline.diags.slice(point.cut.diags),
			failures: baseline.failures.slice(point.cut.failures),
			onError: baseline.onError.slice(point.cut.onError)
		};
		const pairing = pairingOf(baseline.minted, run.minted, existing);
		const differences: IDifferences = {};
		const trace: ITrace | undefined = app.compareDataOnly
			? {
					diffs: [],
					places: []
				}
			: undefined;
		const state = stateDifferences(pairing, expected, actual, trace);
		if (state.length > 0) {
			differences.state = state;
		}
		const diags = eventDifference(pairing, was.diags, run.diags);
		if (diags) {
			differences.diags = diags;
		}
		const failures = eventDifference(pairing, was.failures, run.failures);
		if (failures) {
			differences.failures = failures;
		}
		const onError = eventDifference(pairing, was.onError, run.onError);
		if (onError) {
			differences.onError = onError;
		}
		if (unfinished) {
			differences.unfinished = unfinished;
		}
		if ("repairError" in restored.result) {
			differences.repairError = said(restored.result.repairError);
		}
		const side: ISide | undefined = trace && {
			differences,
			pairing,
			trace,
			diags: run.diags,
			diagData: run.diagData
		};
		return {
			snapshot: json,
			result: restored.result,
			skipped,
			differences,
			same: Object.keys(differences).length === 0,
			side
		};
	};

	const { resume: _, ...withoutResume } = app.options ?? {};
	const report: IDifferentialReport = {
		steps: script.length,
		quiet: 0,
		points: [],
		differing: [],
		...(app.compareDataOnly
			? {
					worse: []
				}
			: {})
	};
	for (let after = 1; after < script.length; after++) {
		const point = points[after - 1]!;
		if (!point.running) {
			report.quiet++;
			continue;
		}
		const { side, ...resumed } = await restoreAt(after, app.options);
		const restorePoint: IRestorePoint = {
			after,
			inFlight: point.inFlight,
			...resumed
		};
		if (app.compareDataOnly) {
			const { side: alongside, snapshot: __, ...dataOnly } = await restoreAt(after, withoutResume);
			const was: IUninterruptedCut = {
				diags: baseline.diags.slice(point.cut.diags),
				diagData: baseline.diagData.slice(point.cut.diags),
				raisedBefore: new Set(baseline.diags.slice(0, point.cut.diags).map((diag) => diag.code))
			};
			const region = regionOf((JSON.parse(resumed.snapshot) as ISnapshot).AppState, resumed.result, side!);
			restorePoint.dataOnly = dataOnly;
			restorePoint.comparison = compareSides(side!, alongside!, was, region);
			if (Object.keys(restorePoint.comparison.worse).length > 0) {
				report.worse!.push(restorePoint);
			}
		}
		report.points.push(restorePoint);
		if (!restorePoint.same) {
			report.differing.push(restorePoint);
		}
	}
	return report;
}
