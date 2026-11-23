import type { IActionGenerator, IEffect, IEntity, IOpenGenerator, IRuntime } from "../../src/index";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IDifferences, IDifferentialStep, IRestoreResult, ISnapshot } from "../../src/Snapshot/index";
import { writeSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	answer,
	ask,
	createTestRuntime,
	defineEffect,
	external,
	generateGuid,
	guids,
	inFlight,
	named,
	open,
	resumable,
	settled,
	transient
} from "../../src/index";
import { pendingAsks } from "../../src/Runtime/pendingAsks";
import { createSnapshot, differentialRestore, dispatchStep, SnapshotOfDisposedRuntimeError, settleStep } from "../../src/Snapshot/index";
import { drainReports } from "../../src/Testing/reports";
import { pendingAsksOf } from "../testHelpers";

const RUNS = Number(process.env.TREFLEX_DIFFERENTIAL_RUNS ?? 20);
const SEED = process.env.TREFLEX_DIFFERENTIAL_SEED === undefined ? undefined : Number(process.env.TREFLEX_DIFFERENTIAL_SEED);

interface INode extends IEntity {
	Note: string;
	Qty: number;
	Key: string;
	Memo: string;
	Tag: string;
	Boot: number;
	/** Written only by the listener, so left out of the comparison. */
	Heard: number;
}

interface IOrder extends INode {
	Lines: Record<string, INode>;
}

interface IShop extends INode {
	Orders: Record<string, IOrder>;
}

const ORDERS = [
	"o1",
	"o2",
	"o3"
] as const;

/** The order no job is dispatched on, which the listener writes to in its "aside" mode. */
const ASIDE = "oL";

const node = (id: string): INode => ({
	$Id: id,
	Note: "",
	Qty: 0,
	Key: "",
	Memo: "",
	Tag: "",
	Boot: 0,
	Heard: 0
});

const lineOf = (orderId: string): string => `${orderId}-l1`;

function seed(): IShop {
	const orders: Record<string, IOrder> = {};
	for (const id of [
		...ORDERS,
		ASIDE
	]) {
		orders[id] = {
			...node(id),
			Lines: {
				[lineOf(id)]: node(lineOf(id))
			}
		};
	}
	return {
		...node("shop"),
		Orders: orders
	};
}

const parentOf = (id: string): string | null => (id === "shop" ? null : id.endsWith("-l1") ? id.slice(0, -"-l1".length) : "shop");

function lineage(id: string): string[] {
	const out: string[] = [];
	for (let at: string | null = id; at !== null; at = parentOf(at)) {
		out.push(at);
	}
	return out;
}

const related = (a: string, b: string): boolean => lineage(a).includes(b) || lineage(b).includes(a);

interface IWaitEffect extends IEffect {
	Tag: string;
	Catch: boolean;
}

const idem = defineEffect<
	IWaitEffect & {
		Type: "Gen/Idem";
	},
	string
>("Gen/Idem", {
	idempotent: true
});
const once = defineEffect<
	IWaitEffect & {
		Type: "Gen/Once";
	},
	string
>("Gen/Once");
const echo = defineEffect<
	{
		Type: "Gen/Echo";
		Tag: string;
	},
	string
>("Gen/Echo");

type IOp =
	| {
			Op: "wait";
			Idem: boolean;
			Open: boolean;
			Catch: boolean;
	  }
	| {
			Op: "ask" | "guid" | "ext" | "busy" | "write" | "line" | "echo";
	  };

function* run(d: INode & Partial<IOrder>, tag: string, ops: readonly IOp[]): IOpenGenerator {
	for (const [k, op] of ops.entries()) {
		const at = `${tag}w${k}`;
		switch (op.Op) {
			case "wait": {
				const effect = (op.Idem ? idem : once)({
					Tag: at,
					Catch: op.Catch
				});
				try {
					d.Note += `${op.Open ? yield* open(effect) : yield* effect};`;
				} catch (error) {
					if (!op.Catch) {
						throw error;
					}
					d.Note += "x;";
				}
				break;
			}
			case "ask":
				d.Note += `${yield* open(
					ask<string>(d, {
						Path: at
					})
				)};`;
				break;
			case "guid":
				d.Key = yield* generateGuid();
				break;
			case "ext":
				d.Memo += String(yield* external("Gen/Ext" as never));
				break;
			case "busy":
				d.Tag += (yield* inFlight(plain, d)) ? "b" : "n";
				break;
			case "write":
				d.Qty++;
				break;
			case "line": {
				const line = d.Lines?.[lineOf(d.$Id)];
				if (line) {
					line.Qty++;
				} else {
					d.Qty++;
				}
				break;
			}
			case "echo":
				d.Memo += yield* echo({
					Tag: at
				});
				break;
		}
	}
}

function* marked(d: INode, tag: string, ops: readonly IOp[]): IOpenGenerator {
	yield* run(d, tag, ops);
}
named(marked, "Gen/Marked");
resumable(marked);

function* plain(d: INode, tag: string, ops: readonly IOp[]): IOpenGenerator {
	yield* run(d, tag, ops);
}
named(plain, "Gen/Plain");

function* poke(d: IShop, orderId: string): IActionGenerator {
	d.Orders[orderId]!.Qty += 10;
}
named(poke, "Gen/Poke");

function* bump(d: INode): IActionGenerator {
	d.Boot++;
}
named(bump, "Gen/Bump");

function* answerAsk(d: INode, path: string, value: string): IActionGenerator {
	const entry = (yield* pendingAsks(d)).find(
		(asked) =>
			(
				asked.Request as {
					Path?: unknown;
				}
			).Path === path
	);
	if (entry) {
		yield* answer(entry.Id as never, value as never);
	}
}
named(answerAsk, "Gen/AnswerAsk");

function* heard(d: INode): IActionGenerator {
	const count = yield* transient(d, "Gen/Heard", {
		N: 0
	});
	count.N++;
	d.Heard++;
}
named(heard, "Gen/Heard");

interface IJob {
	kind: "marked" | "plain" | "poke";
	on: string;
	tag: string;
	ops: IOp[];
}

interface IConfig {
	/** The entity setup writes on every runtime, which ruling 30 drops a flow on, or below which it does. */
	writes: string | null;
	/** The order setup dispatches a waiting action on, and that action's function. */
	dispatches: string | null;
	dispatchesKind: "plain" | "marked";
	listen: "aside" | "onto";
	repair: boolean;
}

const SETUP_OPS: IOp[] = [
	{
		Op: "write"
	},
	{
		Op: "wait",
		Idem: true,
		Open: false,
		Catch: false
	}
];

interface IHearing {
	from: string;
	inFlight: number;
	histories: string[];
}

interface IListenLog {
	hearings: IHearing[];
	outcomes: {
		target: string;
		outcome: string;
	}[];
	/** For each listener write that landed in the entity of an action that had begun, whether its history kept it. */
	carried: {
		actionId: string;
		target: string;
		kept: boolean;
	}[];
	/** The ids the restored runtime gave the actions it resumed. */
	starts: string[];
	resumed?: IRestoreResult["resumed"];
}

function rng(seedValue: number): () => number {
	let a = seedValue >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const inFlightOf = (runtime: IRuntime<object>) => (runtime as IRuntimeInternal<object>).get("runtime/inFlightActions")();

function setupFor(config: IConfig, logs: IListenLog[]) {
	return (runtime: IRuntime<IShop>): void => {
		runtime.registerImplementation(
			"Gen/Echo",
			(effect) =>
				`e${
					(
						effect as IEffect & {
							Tag: string;
						}
					).Tag
				}`
		);
		runtime.provideExternal("Gen/Ext" as never, {
			read: () => "x" as never
		});
		if (config.writes !== null) {
			void runtime.dispatch(bump, config.writes).catch(() => {});
		}
		if (config.dispatches !== null) {
			void runtime.dispatch(config.dispatchesKind === "marked" ? marked : plain, config.dispatches, "s", SETUP_OPS).catch(() => {});
		}
		const log: IListenLog = {
			hearings: [],
			outcomes: [],
			carried: [],
			starts: []
		};
		logs.push(log);
		runtime.on(
			"record",
			(record) => {
				if (record.ResumedFrom === undefined) {
					return;
				}
				const snapshot = JSON.parse(createSnapshot(runtime)) as {
					Histories?: {
						ActionId: string;
					}[];
				};
				log.hearings.push({
					from: record.ResumedFrom,
					inFlight: inFlightOf(runtime).length,
					histories: (snapshot.Histories ?? []).map((history) => history.ActionId)
				});
				log.starts.push(record.ActionId);
				const others = ORDERS.filter((id) => id !== record.EntityId);
				const target = config.listen === "aside" ? ASIDE : others[log.hearings.length % others.length]!;
				const outcome = (said: string) =>
					log.outcomes.push({
						target,
						outcome: said
					});
				runtime.dispatch(heard, target).then(
					() => {
						outcome("done");
						let json: string;
						try {
							json = createSnapshot(runtime);
						} catch (error) {
							if (error instanceof SnapshotOfDisposedRuntimeError) {
								return;
							}
							throw error;
						}
						const after = JSON.parse(json) as {
							InFlight: {
								ActionId: string;
								EntityId: string;
							}[];
							Histories?: {
								ActionId: string;
								Entries?: {
									Kind: string;
									Change?: {
										Path: unknown[];
									};
								}[];
							}[];
						};
						for (const row of after.InFlight) {
							const history = after.Histories?.find((entry) => entry.ActionId === row.ActionId);
							if (!lineage(target).includes(row.EntityId) || !history?.Entries?.some((entry) => entry.Kind !== "other")) {
								continue;
							}
							log.carried.push({
								actionId: row.ActionId,
								target,
								kept: history.Entries.some((entry) => entry.Kind === "other" && entry.Change?.Path.at(-1) === "Heard")
							});
						}
					},
					(error: unknown) => outcome(error instanceof Error ? error.name : String(error))
				);
			},
			{
				kinds: [
					"action:start"
				]
			}
		);
	};
}

function repairFor(config: IConfig, jobs: readonly IJob[], logs: IListenLog[]) {
	return (runtime: IRuntime<IShop>, result: IRestoreResult): void => {
		logs[logs.length - 1]!.resumed = result.resumed;
		if (!config.repair) {
			return;
		}
		for (const drop of result.dropped) {
			const kind = drop.name === "Gen/Marked" ? "marked" : drop.name === "Gen/Plain" ? "plain" : undefined;
			const job = jobs.find((j) => j.kind === kind && j.on === drop.entityId);
			if (job) {
				void runtime.dispatch(job.kind === "marked" ? marked : plain, job.on, job.tag, job.ops).catch(() => {});
			}
		}
	};
}

function opsFor(pick: () => number): IOp[] {
	const ops: IOp[] = [];
	const n = 1 + Math.floor(pick() * 3);
	for (let i = 0; i < n; i++) {
		const r = pick();
		if (r < 0.45) {
			ops.push({
				Op: "wait",
				Idem: pick() < 0.8,
				Open: pick() < 0.5,
				Catch: pick() < 0.3
			});
		} else if (r < 0.55) {
			ops.push({
				Op: "ask"
			});
		} else {
			const others = [
				"guid",
				"ext",
				"busy",
				"write",
				"line",
				"echo"
			] as const;
			ops.push({
				Op: others[Math.floor(pick() * others.length)]!
			});
		}
	}
	if (!ops.some((op) => op.Op === "wait" || op.Op === "ask")) {
		ops.splice(Math.floor(pick() * (ops.length + 1)), 0, {
			Op: "wait",
			Idem: true,
			Open: pick() < 0.5,
			Catch: false
		});
	}
	return ops;
}

function jobsFor(pick: () => number): IJob[] {
	const targets = [
		"shop",
		...ORDERS,
		...ORDERS,
		...ORDERS.map(lineOf)
	];
	const jobs: IJob[] = [];
	const n = 2 + Math.floor(pick() * 3);
	for (let i = 0; i < n; i++) {
		if (pick() < 0.2) {
			jobs.push({
				kind: "poke",
				on: "shop",
				tag: ORDERS[Math.floor(pick() * ORDERS.length)]!,
				ops: []
			});
			continue;
		}
		const job: IJob = {
			kind: pick() < 0.7 ? "marked" : "plain",
			on: targets[Math.floor(pick() * targets.length)]!,
			tag: `j${i}`,
			ops: opsFor(pick)
		};
		jobs.push(job);
		if (job.kind === "marked" && pick() < 0.5) {
			const near = targets.filter((id) => id !== job.on && related(id, job.on));
			jobs.push({
				kind: "plain",
				on: near[Math.floor(pick() * near.length)]!,
				tag: `j${i}b`,
				ops: [
					{
						Op: "write"
					},
					{
						Op: "wait",
						Idem: true,
						Open: true,
						Catch: false
					}
				]
			});
		}
	}
	return jobs;
}

interface IPending {
	type: string;
	effect: IWaitEffect;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

const REFUSED = Object.assign(new RangeError("refused"), {
	Code: "refused"
});

function dispatchOf(job: IJob): IDifferentialStep<IShop> {
	if (job.kind === "poke") {
		return dispatchStep(poke, "shop", [
			job.tag
		]);
	}
	return dispatchStep(job.kind === "marked" ? marked : plain, job.on, [
		job.tag,
		job.ops
	]);
}

const OPTIONS = {
	build: "gen",
	resume: true,
	allowDiags: [
		"entity/written-while-held"
	]
} as const;

/**
 * Plays the jobs on a probe runtime, choosing at each step among what can happen next, so the script is one the
 * uninterrupted run can play. Null when the jobs end with work still running.
 */
async function scriptFor(
	pick: () => number,
	config: IConfig,
	jobs: readonly IJob[]
): Promise<{
	script: IDifferentialStep<IShop>[];
	hold: string[];
} | null> {
	const pending: IPending[] = [];
	const yielded = new Set<string>();
	const probe = createTestRuntime<IShop>(
		seed(),
		{
			generateGuid: guids("probe")
		},
		OPTIONS
	);
	for (const type of [
		"Gen/Idem",
		"Gen/Once"
	]) {
		probe.registerImplementation(
			type,
			(effect: IWaitEffect) =>
				new Promise((resolve, reject) => {
					yielded.add(type);
					pending.push({
						type,
						effect,
						resolve,
						reject
					});
				})
		);
	}
	const logs: IListenLog[] = [];
	setupFor(config, logs)(probe);
	await settled();
	const script: IDifferentialStep<IShop>[] = [];
	const answered = new Set<string>();
	let next = 0;
	try {
		for (let guard = 0; guard < 60; guard++) {
			const asks = [
				probe.state,
				...Object.values(probe.state.Orders),
				...Object.values(probe.state.Orders).flatMap((order) => Object.values(order.Lines))
			]
				.flatMap((owner) => pendingAsksOf(probe, owner))
				.filter(
					(entry) =>
						!answered.has(
							String(
								(
									entry.Request as {
										Path: string;
									}
								).Path
							)
						)
				);
			const choices = pending.length + asks.length + (next < jobs.length ? 1 : 0);
			if (choices === 0) {
				break;
			}
			let choice = Math.floor(pick() * choices);
			if (next < jobs.length && (choice === 0 || pending.length + asks.length === 0)) {
				const job = jobs[next++]!;
				script.push(dispatchOf(job));
				const dispatched =
					job.kind === "poke"
						? probe.dispatch(poke, "shop", job.tag)
						: probe.dispatch(job.kind === "marked" ? marked : plain, job.on, job.tag, job.ops);
				void dispatched.catch(() => {});
			} else {
				choice -= next < jobs.length ? 1 : 0;
				if (choice < pending.length) {
					const [held] = pending.splice(choice, 1);
					const tag = held!.effect.Tag;
					const where = (effect: IEffect) => (effect as IWaitEffect).Tag === tag;
					if (held!.effect.Catch && pick() < 0.5) {
						script.push(
							settleStep(
								held!.type,
								{
									error: REFUSED
								},
								{
									where
								}
							)
						);
						held!.reject(REFUSED);
					} else {
						script.push(
							settleStep(
								held!.type,
								{
									value: `v${tag}`
								},
								{
									where
								}
							)
						);
						held!.resolve(`v${tag}`);
					}
				} else {
					const entry = asks[choice - pending.length]!;
					const path = String(
						(
							entry.Request as {
								Path: string;
							}
						).Path
					);
					answered.add(path);
					script.push(
						dispatchStep(answerAsk, entry.OwnerId, [
							path,
							`a${path}`
						])
					);
					void probe.dispatch(answerAsk, entry.OwnerId, path, `a${path}`).catch(() => {});
				}
			}
			await settled();
		}
		return inFlightOf(probe).length === 0 && pending.length === 0 && next === jobs.length
			? {
					script,
					hold: [
						...yielded
					]
				}
			: null;
	} finally {
		probe.dispose();
	}
}

/** The reasons a marked row on `entityId` can drop with, given what was generated around it. */
function allowedFor(entityId: string, config: IConfig, jobs: readonly IJob[]): Set<string> {
	const allowed = new Set<string>();
	const mine = jobs.filter((job) => job.kind === "marked" && job.on === entityId);
	if (mine.some((job) => job.ops.some((op) => op.Op === "wait" && !op.Idem))) {
		allowed.add("not-idempotent");
	}
	const sharing = jobs.filter((job) => job.kind !== "poke" && job.on === entityId).length > 1 || config.dispatches === entityId;
	if (sharing) {
		allowed.add("behind");
		allowed.add("off-list");
	}
	if (jobs.some((job) => job.kind === "marked" && job.on !== entityId && related(job.on, entityId))) {
		allowed.add("off-list");
	}
	const touched = [
		config.writes,
		config.dispatches
	].filter((id): id is string => id !== null);
	if (touched.some((id) => related(id, entityId))) {
		allowed.add("diverged");
		allowed.add("behind");
		allowed.add("off-list");
	}
	return allowed;
}

/**
 * `worse` without the listener's own work: its queued `heard` dispatches, and the place in an entity's line each
 * pushed back an entry the data-only run also left there.
 */
const withoutListener = (worse: IDifferences, resumed: IDifferences, dataOnly: IDifferences): IDifferences => {
	const kept: IDifferences = {
		...worse
	};
	const state = kept.state?.filter((difference) => !difference.path.endsWith(".Heard"));
	if (state?.length === 0) {
		delete kept.state;
	} else if (state) {
		kept.state = state;
	}
	const extra = kept.diags?.extra.filter((diag) => !diag.message.includes('"Gen/Heard"'));
	if (kept.diags && extra?.length === 0 && kept.diags.missing.length === 0) {
		delete kept.diags;
	} else if (kept.diags) {
		kept.diags = {
			...kept.diags,
			extra: extra!
		};
	}
	if (kept.unfinished) {
		const heardAhead = (entityId: string, place: number) =>
			(resumed.unfinished?.inFlight ?? []).filter(
				(entry) => entry.Name === "Gen/Heard" && entry.EntityId === entityId && (entry.Place ?? 0) < place
			).length;
		const inFlight = kept.unfinished.inFlight.filter((entry) => {
			if (entry.Name === "Gen/Heard") {
				return false;
			}
			const pushed = entry.Place === undefined ? 0 : heardAhead(entry.EntityId, entry.Place);
			return !(
				pushed > 0 &&
				(dataOnly.unfinished?.inFlight ?? []).some(
					(other) =>
						JSON.stringify({
							...other,
							Place: undefined
						}) ===
							JSON.stringify({
								...entry,
								Place: undefined
							}) && other.Place === entry.Place! - pushed
				)
			);
		});
		if (inFlight.length === 0 && kept.unfinished.held.length === 0) {
			delete kept.unfinished;
		} else {
			kept.unfinished = {
				...kept.unfinished,
				inFlight
			};
		}
	}
	return kept;
};

/** The waits the list says a resumed action may be caught at: an `ask`, or a plain effect declared idempotent. */
const RESUMABLE_WAITS = [
	"ask",
	"Gen/Idem"
];

/** Whether the planner drops a saved row before the engine meets live work of its function on its entity. */
function plannerDrops(saved: ISnapshot, actionId: string): boolean {
	const caught = caughtWait(saved, actionId);
	const at = saved.InFlight.findIndex((row) => row.ActionId === actionId);
	const mine = saved.InFlight[at]!;
	const replayAhead = saved.InFlight.some(
		(row, i) => i < at && row.Name === "Gen/Marked" && row.State !== "queued" && related(row.EntityId, mine.EntityId)
	);
	const heldOpen = mine.State === "open" && saved.InFlight.some((row) => row.EntityId === mine.EntityId && row.State === "holding");
	return mine.State === "regaining" || replayAhead || heldOpen || (caught !== null && !RESUMABLE_WAITS.includes(caught));
}

/** The `Type` of the wait a saved history ends parked on, or null. */
function caughtWait(saved: ISnapshot, actionId: string): string | null {
	const history = (
		saved as ISnapshot & {
			Histories?: {
				ActionId: string;
				Entries?: {
					Kind: string;
					Seq?: number;
					ForSeq?: number;
					Descriptor?: {
						Type?: string;
					};
				}[];
			}[];
		}
	).Histories?.find((entry) => entry.ActionId === actionId);
	const entries = history?.Entries ?? [];
	const answered = new Set(entries.filter((entry) => entry.Kind === "response").map((entry) => entry.ForSeq));
	const open = entries.filter((entry) => entry.Kind === "effect" && !answered.has(entry.Seq));
	return open.at(-1)?.Descriptor?.Type ?? null;
}

interface ITally {
	scripts: number;
	unplayable: number;
	points: number;
	changedPoints: number;
	changedPaths: number;
	reportedPoints: number;
	resumed: number;
	drops: Record<string, number>;
	hearings: number;
	listenerOnly: number;
	regionPoints: number;
	carried: number;
}

async function check(seedValue: number, tally: ITally): Promise<void> {
	const pick = rng(seedValue);
	const config: IConfig = {
		writes:
			pick() < 0.25
				? [
						...ORDERS,
						...ORDERS.map(lineOf)
					][Math.floor(pick() * 6)]!
				: null,
		dispatches: pick() < 0.25 ? ORDERS[Math.floor(pick() * ORDERS.length)]! : null,
		dispatchesKind: pick() < 0.5 ? "marked" : "plain",
		listen: pick() < 0.5 ? "aside" : "onto",
		repair: pick() < 0.5
	};
	const jobs = jobsFor(pick);
	const played = await scriptFor(pick, config, jobs);
	if (played === null || played.script.length < 2) {
		tally.unplayable++;
		return;
	}
	const { script, hold } = played;
	const logs: IListenLog[] = [];
	const report = await differentialRestore(
		{
			seed: seed(),
			hold,
			setup: setupFor(config, logs),
			repair: repairFor(config, jobs, logs),
			options: OPTIONS,
			compareDataOnly: true,
			restoreTimeoutMs: 5000
		},
		script
	);
	tally.scripts++;
	const where = `seed ${seedValue}, ${JSON.stringify(config)}, jobs ${JSON.stringify(jobs)}`;
	for (const point of report.points) {
		tally.points++;
		const comparison = point.comparison!;
		const worse = withoutListener(comparison.worse, point.differences, point.dataOnly!.differences);
		if (worse.unfinished === undefined && comparison.worse.unfinished !== undefined) {
			tally.listenerOnly++;
		}
		expect(worse, `${where}, the point after step ${point.after}`).toEqual({});
		if (comparison.changed.length > 0) {
			tally.changedPoints++;
			tally.changedPaths += comparison.changed.length;
		}
		if (Object.keys(comparison.reported).length > 0) {
			tally.reportedPoints++;
		}
		if (
			point.result.resumed.some(
				(entry) => entry.resourceWork.length > 0 || point.result.dropped.some((drop) => related(drop.entityId, entry.entityId))
			)
		) {
			tally.regionPoints++;
		}
		tally.resumed += point.result.resumed.length;
		const saved = JSON.parse(point.snapshot) as ISnapshot;
		for (const entry of point.result.resumed) {
			const row = saved.InFlight.find((inFlight) => inFlight.ActionId === entry.actionId)!;
			const caught = caughtWait(saved, entry.actionId);
			expect(
				{
					state: row.State,
					caught,
					wait: entry.wait ?? null
				},
				`${where}, the point after step ${point.after}: ${entry.name} on ${entry.entityId} resumed`
			).toEqual(
				row.State === "queued"
					? {
							state: "queued",
							caught: null,
							wait: null
						}
					: {
							state: expect.toBeOneOf([
								"holding",
								"open"
							]),
							caught: expect.toBeOneOf(RESUMABLE_WAITS),
							wait: caught
						}
			);
		}
		for (const drop of point.result.dropped) {
			tally.drops[drop.reason] = (tally.drops[drop.reason] ?? 0) + 1;
			const allowed =
				drop.name === "Gen/Marked"
					? allowedFor(drop.entityId, config, jobs)
					: new Set([
							"not-marked"
						]);
			const said = `${where}, the point after step ${point.after}: ${drop.name} on ${drop.entityId} dropped ${drop.reason}, ${drop.detail}`;
			expect(allowed, said).toContain(drop.reason);
			if (
				drop.name === "Gen/Marked" &&
				config.dispatchesKind === "marked" &&
				config.dispatches === drop.entityId &&
				!plannerDrops(saved, drop.actionId)
			) {
				const holderAhead = saved.InFlight.some((row) => row.EntityId === drop.entityId && row.State !== "queued");
				expect(drop.reason, said).toBe(
					drop.state === "queued" ? (drop.reason === "behind" && holderAhead ? "behind" : "off-list") : "diverged"
				);
			}
		}
		for (const drop of point.dataOnly!.result.dropped) {
			expect(drop.reason).toBe("resume-off");
		}
		expect(point.dataOnly!.result.resumed).toEqual([]);
	}
	for (const log of logs) {
		if (log.resumed === undefined) {
			expect(log.hearings, where).toEqual([]);
			continue;
		}
		tally.hearings += log.hearings.length;
		const resumed = log.resumed;
		expect(log.hearings.map((hearing) => hearing.from).sort(), where).toEqual(resumed.map((entry) => entry.actionId).sort());
		for (const hearing of log.hearings) {
			expect(hearing.inFlight, where).toBeGreaterThanOrEqual(resumed.length);
			expect(hearing.histories, where).toEqual(expect.arrayContaining(log.starts));
		}
		for (const carried of log.carried.filter((entry) => log.starts.includes(entry.actionId))) {
			tally.carried++;
			expect(carried.kept, `${where}: the listener's write on ${carried.target} isn't in ${carried.actionId}'s history`).toBe(true);
		}
		const refusable = (target: string) => resumed.some((entry) => related(entry.entityId, target));
		expect(
			log.outcomes.filter(({ target, outcome }) => outcome !== "done" && !(outcome === "UnreleasedResumeError" && refusable(target))),
			where
		).toEqual([]);
	}
}

describe("differentialRestore with compareDataOnly on generated scripts", () => {
	it("never finds a resumed run worse than the data-only one, nor a drop its inputs don't allow", async () => {
		for (const method of [
			"info",
			"log",
			"warn",
			"error"
		] as const) {
			vi.spyOn(console, method).mockImplementation(() => {});
		}
		const started = performance.now();
		const tally: ITally = {
			scripts: 0,
			unplayable: 0,
			points: 0,
			changedPoints: 0,
			changedPaths: 0,
			reportedPoints: 0,
			resumed: 0,
			drops: {},
			hearings: 0,
			listenerOnly: 0,
			regionPoints: 0,
			carried: 0
		};
		try {
			for (let seedValue = SEED ?? 1; seedValue <= (SEED ?? RUNS); seedValue++) {
				await check(seedValue, tally);
			}
		} finally {
			vi.restoreAllMocks();
			writeSync(2, `[differential generated] ${JSON.stringify(tally)} in ${Math.round(performance.now() - started)}ms\n`);
		}
		expect(drainReports()).toEqual([]);
		if (SEED !== undefined) {
			return;
		}
		expect({
			points: tally.points,
			resumed: tally.resumed,
			notIdempotent: tally.drops["not-idempotent"] ?? 0,
			diverged: tally.drops.diverged ?? 0,
			regionPoints: tally.regionPoints
		}).toEqual({
			points: expect.toSatisfy((n: number) => n > 0),
			resumed: expect.toSatisfy((n: number) => n > 0),
			notIdempotent: expect.toSatisfy((n: number) => n > 0),
			diverged: expect.toSatisfy((n: number) => n > 0),
			regionPoints: expect.toSatisfy((n: number) => n > 0)
		});
	}, 3_600_000);
});
