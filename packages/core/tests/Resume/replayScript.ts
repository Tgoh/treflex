import type { IActionContext, IAskId, IEntity, IRuntime, IRuntimeEventOf } from "../../src/index";
import type { IResumeOption, IWithResume } from "../../src/Resume/createKeeper";
import type { IRuntimeOptions } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IInFlightAction } from "../../src/Runtime/processAction";
import type { IRecord } from "../../src/Types/IRecord";
import type { IEngineRun } from "./replayHarness";
import type { IWaiting } from "./resumeHarness";
import { expect } from "vitest";
import { answer } from "../../src/Effects/answer";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { rawOf } from "../../src/Runtime/viewProxy";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { settled } from "../../src/Testing/createTestRuntime";
import { pendingAsksOf } from "../testHelpers";
import { registerWaits, restoreWithResume, runEngine } from "./replayHarness";

/** What a script step drives: the same calls on the uninterrupted runtime and on a restored one. */
export interface IDriver {
	readonly runtime: IRuntime<any>;
	/** Answers the oldest wait with this name, if any waits. */
	release(name: string, value?: unknown): boolean;
	fail(name: string, error: unknown): boolean;
	/** Answers the open ask on the entity `owner` picks whose request has this `Path`, if one is open. */
	answer(owner: (state: any) => IEntity | undefined, path: string, value: unknown): Promise<boolean>;
	dispatch(action: Function, target: string, ...args: unknown[]): void;
}

export type IScriptStep = (driver: IDriver) => Promise<unknown> | unknown;

interface ITaps {
	waiting: IWaiting[];
	diags: IRuntimeEventOf<"diag">[];
	failures: IRuntimeEventOf<"failure">[];
	records: IRecord[];
	onError: unknown[];
}

function* answers(_owner: IEntity, id: IAskId<unknown>, value: unknown) {
	yield* answer(id, value as never);
}

export function driverOf(runtime: IRuntime<any>, waiting: IWaiting[]): IDriver {
	const take = (name: string): IWaiting | undefined => {
		const at = waiting.findIndex((wait) => wait.name === name);
		return at < 0 ? undefined : waiting.splice(at, 1)[0];
	};
	return {
		runtime,
		release(name, value) {
			const wait = take(name);
			wait?.resolve(value);
			return wait !== undefined;
		},
		fail(name, error) {
			const wait = take(name);
			wait?.reject(error);
			return wait !== undefined;
		},
		async answer(owner, path, value) {
			const node = owner(runtime.state);
			if (node === undefined) {
				return false;
			}
			const entry = pendingAsksOf(runtime, node).find(
				(ask) =>
					(
						ask.Request as {
							Path?: unknown;
						}
					)?.Path === path
			);
			if (!entry) {
				return false;
			}
			await runtime.dispatch(answers, entry.OwnerId, entry.Id as IAskId<unknown>, value);
			return true;
		},
		dispatch(action, target, ...args) {
			runtime.dispatch(action as never, target, ...(args as never[])).catch(() => {});
		}
	};
}

/** Ids counted per entity, so work that drops on one entity shifts no other entity's ids. */
export function guidsFrom(counts: Record<string, number>): (effect: unknown, action?: IActionContext) => string {
	return (_effect, action) => {
		const on = action?.entityId ?? "";
		counts[on] = (counts[on] ?? 0) + 1;
		return `g${counts[on]}_${on}`;
	};
}

function tapAll(runtime: IRuntime<any>, taps: ITaps): void {
	runtime.on("diag", (event) => {
		taps.diags.push(event);
	});
	runtime.on("failure", (event) => {
		taps.failures.push(event);
	});
	runtime.on("record", (record) => {
		taps.records.push(record);
	});
}

const IDS = /branch-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Records as text with Seq, T and ForSeq dropped, and action and ask ids named by first appearance. */
export function normalized(records: readonly IRecord[]): string[] {
	const ids = new Map<string, string>();
	return records.map((record) => {
		const { Seq: _seq, T: _t, ForSeq: _for, ...rest } = record as unknown as Record<string, unknown>;
		return JSON.stringify(rest).replace(IDS, (id) => {
			if (!ids.has(id)) {
				ids.set(id, `#${ids.size}`);
			}
			return ids.get(id)!;
		});
	});
}

/** Where the taps stood at a cut: what a restore from there is compared from. */
interface ICut {
	readonly records: number;
	readonly diags: number;
	readonly failures: number;
	readonly onError: number;
}

export interface IPoint {
	/** The index of the step the point follows. */
	readonly at: number;
	readonly json: string;
	readonly cut: ICut;
	/** The ids minted on each entity before the snapshot. */
	readonly guids: Readonly<Record<string, number>>;
	readonly inFlight: IInFlightAction[];
	/** What the script's `note` read from the runtime at the snapshot. */
	readonly note?: unknown;
}

export interface IEnd {
	state: string;
	tables: string;
	cells: string[];
	records: string[];
	diags: string[];
	failures: string[];
	onError: string[];
	inFlight: string[];
	/** The waits still pending on the implementations, by name. */
	waiting: string[];
	/** The open asks, by owner and request. */
	asks: string[];
	/** The kinds of diag the runtime raised before the cut, each by `diagKey`. */
	raised: string[];
}

export interface IScriptRun {
	points: IPoint[];
	/** The uninterrupted run's end, with what the taps heard from the point's cut. */
	endFrom(point: IPoint): IEnd;
}

function inFlightOf(runtime: IRuntime<any>): IInFlightAction[] {
	return (runtime as IRuntimeInternal<any>).get("runtime/inFlightActions")();
}

export function tablesOf(runtime: IRuntime<any>): string {
	return JSON.stringify({
		timers: runtime.timers(),
		resources: runtime.resources(),
		dataSources: (runtime as IRuntimeInternal<any>).get("runtime/dataSources").entries()
	});
}

export function cellsOf(runtime: IRuntime<any>): string[] {
	return (runtime as IRuntimeInternal<any>).get("runtime/writeGateway").cellIds().sort();
}

function cutOf(taps: ITaps): ICut {
	return {
		records: taps.records.length,
		diags: taps.diags.length,
		failures: taps.failures.length,
		onError: taps.onError.length
	};
}

/** `@` and the entity a diag's data names, or nothing when it names none. */
function diagEntity(event: IRuntimeEventOf<"diag">): string {
	const entityId = (
		event.data as
			| {
					entityId?: unknown;
			  }
			| undefined
	)?.entityId;
	return typeof entityId === "string" ? `@${entityId}` : "";
}

/**
 * A diag's code, with what its once-memory keys on where that is narrower than the runtime: for
 * `entity/written-while-held`, the pair of actions, as `[writer>holder]`.
 */
export function diagKey(event: IRuntimeEventOf<"diag">): string {
	if (event.code !== "entity/written-while-held") {
		return event.code;
	}
	const { writer, holder } = (event.data ?? {}) as {
		writer?: unknown;
		holder?: unknown;
	};
	return `${event.code}[${String(writer)}>${String(holder)}]`;
}

function endOf(runtime: IRuntime<any>, taps: ITaps, cut: ICut, records: readonly IRecord[]): IEnd {
	return {
		state: JSON.stringify(rawOf(runtime.state)),
		tables: tablesOf(runtime),
		cells: cellsOf(runtime),
		records: normalized(records),
		diags: taps.diags.slice(cut.diags).map((event) => `${diagKey(event)}${diagEntity(event)}`),
		failures: taps.failures.slice(cut.failures).map((event) => `${event.Name ?? event.Label}:${event.Status}@${event.EntityId}`),
		onError: taps.onError.slice(cut.onError).map(String),
		inFlight: inFlightOf(runtime).map((row) => `${row.Name}:${row.State}@${row.EntityId}`),
		waiting: taps.waiting.map((wait) => wait.name).sort(),
		asks: pendingAsksOf(runtime, runtime.state)
			.map((ask) =>
				JSON.stringify({
					OwnerId: ask.OwnerId,
					Request: ask.Request
				})
			)
			.sort(),
		raised: [
			...new Set(taps.diags.slice(0, cut.diags).map(diagKey))
		].sort()
	};
}

function freshTaps(): ITaps {
	return {
		waiting: [],
		diags: [],
		failures: [],
		records: [],
		onError: []
	};
}

export interface IScriptOptions {
	resume?: IResumeOption;
	/** Runs on the uninterrupted runtime before the first step, and on each restored one in its `setup`. */
	setup?: (runtime: IRuntime<any>) => void;
	/** Read from the uninterrupted runtime at each snapshot, and kept on the point. */
	note?: (runtime: IRuntime<any>) => unknown;
}

/** Plays `steps` on an uninterrupted runtime over `seed`, snapshotting after each step that leaves a marked action in flight. */
export async function playScript(
	seed: object,
	steps: readonly IScriptStep[],
	marked: readonly string[],
	options: IScriptOptions = {}
): Promise<IScriptRun> {
	const taps = freshTaps();
	const guids: Record<string, number> = {};
	const runtime = createRuntime<any>(seed, {
		verifyIndex: "always",
		build: "test",
		resume: options.resume ?? true,
		implementations: {
			generateGuid: guidsFrom(guids)
		},
		onError: (error: unknown) => {
			taps.onError.push(error);
		}
	} as IRuntimeOptions & IWithResume);
	tapAll(runtime, taps);
	registerWaits(runtime, taps.waiting);
	options.setup?.(runtime);
	const driver = driverOf(runtime, taps.waiting);
	const points: IPoint[] = [];
	for (let at = 0; at < steps.length; at++) {
		await steps[at]!(driver);
		await settled();
		const inFlight = inFlightOf(runtime);
		if (inFlight.some((row) => row.Name !== null && marked.includes(row.Name))) {
			points.push({
				at,
				json: createSnapshot(runtime),
				cut: cutOf(taps),
				guids: {
					...guids
				},
				inFlight,
				...(options.note
					? {
							note: options.note(runtime)
						}
					: {})
			});
		}
	}
	await settled();
	const end = taps.records.length;
	const ends = new Map<IPoint, IEnd>(
		points.map((point) => [
			point,
			endOf(runtime, taps, point.cut, taps.records.slice(point.cut.records, end))
		])
	);
	runtime.dispose();
	return {
		points,
		endFrom: (point) => ends.get(point)!
	};
}

export interface IGlance {
	tree: string;
	tables: string;
	cells: string[];
}

export interface IRestoredEnd {
	end: IEnd;
	engine: IEngineRun | null;
	/** Right after the engine ran, before the release. */
	treeAfterEngine: string;
	inFlightAfterEngine: IInFlightAction[];
	beforeEngine: IGlance;
	afterEngine: IGlance;
	/** The point `beforeRelease` returned a snapshot for. */
	between?: IPoint;
}

export interface IRestoreAt {
	engine: boolean;
	idempotent?: readonly string[];
	sameBuild?: boolean;
	resume?: boolean;
	setup?: (runtime: IRuntime<any>) => void;
	/** Runs after the restore and before the engine. */
	before?: (runtime: IRuntime<any>) => void;
	/** Runs between the engine's return and the release; with true returned, a snapshot is taken there. */
	beforeRelease?: (runtime: IRuntime<any>) => boolean;
}

/**
 * Restores `point`, runs the engine unless `engine` is false, releases, and plays the steps after the
 * point. What is compared is what the taps heard from the release on, without what only a resume
 * delivers there: each caught wait sent again, with its ask's row.
 */
export async function restoreAt(point: IPoint, steps: readonly IScriptStep[], options: IRestoreAt): Promise<IRestoredEnd> {
	const guids = {
		...point.guids
	};
	const run = await restoreWithResume<any>(point.json, "shop", {
		resume: options.resume,
		implementations: {
			generateGuid: guidsFrom(guids)
		},
		setup: options.setup
	});
	options.before?.(run.runtime);
	const look = () => ({
		tree: JSON.stringify(rawOf(run.runtime.state)),
		tables: tablesOf(run.runtime),
		cells: cellsOf(run.runtime)
	});
	const beforeEngine = look();
	const engine = options.engine
		? runEngine(
				run,
				options.idempotent ?? [
					"Resume/Wait"
				],
				options.sameBuild ?? true
			)
		: null;
	const afterEngine = look();
	const inFlightAfterEngine = inFlightOf(run.runtime);
	let between: IPoint | undefined;
	if (options.beforeRelease?.(run.runtime)) {
		await settled();
		between = {
			at: point.at,
			json: createSnapshot(run.runtime),
			cut: cutOf(run),
			guids: {
				...guids
			},
			inFlight: inFlightOf(run.runtime)
		};
	}
	const cut = cutOf(run);
	engine?.release();
	const released = run.records.slice(cut.records);
	const resumedIds = new Set(
		(engine?.during ?? []).map(
			(record) =>
				(
					record as {
						ActionId?: string;
					}
				).ActionId
		)
	);
	const extras = new Set<IRecord>();
	for (const record of released) {
		if (record.Kind === "effect" && resumedIds.has(record.ActionId)) {
			extras.add(record);
		}
		if (record.Kind === "table" && record.Table === "asks" && record.Prev === null) {
			extras.add(record);
		}
	}
	await settled();
	const driver = driverOf(run.runtime, run.waiting);
	for (const step of steps.slice(point.at + 1)) {
		await step(driver);
		await settled();
	}
	await settled();
	const end = endOf(
		run.runtime,
		run,
		cut,
		run.records.slice(cut.records).filter((record) => !extras.has(record))
	);
	run.runtime.dispose();
	return {
		end,
		engine,
		treeAfterEngine: afterEngine.tree,
		inFlightAfterEngine,
		beforeEngine,
		afterEngine,
		...(between === undefined
			? {}
			: {
					between
				})
	};
}

/**
 * Restores `point`, resumes, releases, plays the steps after it up to step `at`, and snapshots the
 * restored runtime there: a point for a second restore.
 */
export async function resnapshot(
	point: IPoint,
	steps: readonly IScriptStep[],
	at: number
): Promise<
	IPoint & {
		firstEngine: IEngineRun;
	}
> {
	const guids = {
		...point.guids
	};
	const run = await restoreWithResume<any>(point.json, "shop", {
		implementations: {
			generateGuid: guidsFrom(guids)
		}
	});
	const engine = runEngine(run);
	engine.release();
	await settled();
	const driver = driverOf(run.runtime, run.waiting);
	for (const step of steps.slice(point.at + 1, at + 1)) {
		await step(driver);
		await settled();
	}
	const resnapped = {
		at,
		json: createSnapshot(run.runtime),
		cut: cutOf(run),
		guids: {
			...guids
		},
		inFlight: inFlightOf(run.runtime),
		firstEngine: engine
	};
	run.runtime.dispose();
	return resnapped;
}

/**
 * The engine's own facts where it ran: nothing delivered but a start for each resumed action, in
 * order, carrying its snapshot id as `ResumedFrom`, the tree as restored, and each resumed action in
 * its row's state, at its row's place when nothing on its entity dropped.
 */
export function expectEngineFacts(point: IPoint, restored: IRestoredEnd): void {
	const engine = restored.engine!;
	expect(engine.diagsDuring).toBe(0);
	expect(engine.during.map((record) => (record.Kind === "action:start" ? record.ResumedFrom : record.Kind))).toEqual(
		engine.resumed.map((resumed) => resumed.actionId)
	);
	expect(restored.treeAfterEngine).toBe(
		JSON.stringify(
			(
				JSON.parse(point.json) as {
					AppState: unknown;
				}
			).AppState
		)
	);
	for (const resumed of engine.resumed) {
		const row = point.inFlight.find((entry) => entry.ActionId === resumed.actionId)!;
		const now = restored.inFlightAfterEngine.filter(
			(entry) => entry.Name === row.Name && entry.EntityId === row.EntityId && entry.State === row.State
		);
		expect(now.length).toBeGreaterThan(0);
		if (!engine.dropped.some((drop) => drop.entityId === row.EntityId) && row.Place !== undefined) {
			expect(now.map((entry) => entry.Place)).toContain(row.Place);
		}
	}
	expect(restored.inFlightAfterEngine).toHaveLength(engine.resumed.length);
	expect(engine.resumed.length + engine.dropped.length).toBe(point.inFlight.length);
}
