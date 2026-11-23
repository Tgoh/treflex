import type { IWriteGateway } from "../Runtime/createWriteGateway";
import type { IRuntimeInternal } from "../Runtime/internals";
import type { ISnapshotInFlightEntry } from "../Snapshot/ISnapshot";
import type { IHistory, ISnapshotHistory } from "./history";
import type { IDrop, IDropReason, IPlan, IResourceWork } from "./plan";
import type { IPrefixRun, IRecordGate } from "./prefix";
import { watchedWork } from "../Runtime/arrivals";
import { beginArrivals, createArrivals } from "../Runtime/fanOut";
import { isTracked } from "../Runtime/tracking";
import { rawOf } from "../Runtime/viewProxy";
import { nameOf, planResume } from "./plan";
import { createPrefix, holdRecords } from "./prefix";
import { entityRewind } from "./rewind";

export interface IResumed {
	/** The snapshot's id for the action. */
	actionId: string;
	name: string;
	entityId: string;
	/** The `Type` of the wait it is parked on; absent for a queued action put back, which has run nothing. */
	wait?: string;
	/** The rows that dropped on its entity, above it or below it: work the resumed action carries on beside, for the repair to act on. */
	beside: IBeside[];
	/** The resources with a delivery in flight on its entity, above it or below it when the snapshot was written, each once. */
	resourceWork: IResourceWork[];
	/** For a replayed action that holds its entity: its id in this runtime, the one its entity's gate holder carries. */
	holderId?: string;
}

export interface IBeside {
	/** The snapshot's id for the action. */
	actionId: string;
	name: string | null;
	entityId: string;
	/** Its row's `State`, absent where the envelope's row has none. */
	state: ISnapshotInFlightEntry["State"];
}

export interface IResumeDrop {
	/** The snapshot's id for the action. */
	actionId: string;
	name: string | null;
	label: string | null;
	receiver?: string;
	entityId: string;
	reason: IDropReason;
	detail?: string;
	/** On `not-idempotent`: the `Type` of the wait the snapshot caught. */
	wait?: string;
	/** The drop is for what the action itself does: what its history holds, its arguments, or the wait it was caught at. */
	ownDoing?: true;
}

export interface IResumeOutcome {
	resumed: IResumed[];
	dropped: IResumeDrop[];
	/**
	 * Delivers the resumed actions' starts, the replayed ones' in row order and then the put-backs' in
	 * `Place` order, each followed by whatever its action recorded since. Until it is called nothing of
	 * the stage has reached a listener. Once.
	 */
	deliver(): void;
	/** Sends every held wait in row order, then lets every entity's line go. Once. */
	release(): void;
}

export interface IResumeInputs {
	readonly rows: readonly ISnapshotInFlightEntry[];
	readonly histories: readonly ISnapshotHistory[] | undefined;
	readonly sameBuild: boolean;
	readonly isIdempotent: (type: string) => boolean;
	/** Each in-flight row's entity as JSON, taken after the tables loaded and before `setup` ran. */
	readonly loaded?: ReadonlyMap<string, string>;
}

interface IHandedOver {
	readonly prefix: IPrefixRun;
	readonly row: ISnapshotInFlightEntry;
	readonly history: IHistory;
}

function watchedIn(root: object): string | null {
	let deepest: string[] | null = null;
	const pending: [
		object,
		string[]
	][] = [
		[
			root,
			[]
		]
	];
	const seen = new Set<object>();
	while (pending.length > 0) {
		const [node, path] = pending.pop()!;
		if (seen.has(node)) {
			continue;
		}
		seen.add(node);
		if (isTracked(node) && (deepest === null || path.length > deepest.length)) {
			deepest = path;
		}
		for (const [key, child] of Object.entries(node)) {
			if (child !== null && typeof child === "object") {
				pending.push([
					child,
					[
						...path,
						key
					]
				]);
			}
		}
	}
	return deepest === null ? null : deepest.length === 0 ? "the root" : deepest.join(".");
}

function watchedBy(gateway: IWriteGateway): string | null {
	const tree = watchedIn(gateway.rootNode());
	if (tree !== null) {
		return `the tree at ${tree}`;
	}
	const cells = rawOf(gateway.lookup()) as Record<
		string,
		{
			path?: unknown;
		}
	>;
	if (isTracked(cells)) {
		return "the index";
	}
	for (const [id, cell] of Object.entries(cells)) {
		if (isTracked(cell) || (cell.path !== null && typeof cell.path === "object" && isTracked(cell.path))) {
			return `the index's cell for "${id}"`;
		}
	}
	const work = watchedWork(gateway);
	return work === null ? null : `inFlight on "${work}"`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Plans and replays the in-flight actions of a snapshot just restored into `runtime`, synchronously:
 * each planned action is rewound and run again from its history, one at a time, in its own write
 * scope, and left parked at the wait the snapshot caught with the wait unsent, or dropped as a
 * data-only restore drops it, and each queued one is put back in its entity's line, held there until
 * the release. Nothing reaches a tap or the diag listeners until `deliver`.
 */
export function resumeInFlight<T extends object>(runtime: IRuntimeInternal<T>, inputs: IResumeInputs): IResumeOutcome {
	const get = runtime.get;
	const keeper = get("runtime/resume");
	const gateway = get("runtime/writeGateway");
	const support = get("runtime/prefixes");
	const lineOf = (id: string): readonly string[] | undefined =>
		gateway.rootNameOf(id) === "AppState" ? gateway.lookup()[id]?.path : undefined;
	const resumed: IResumed[] = [];
	const dropped: IResumeDrop[] = [];
	const handedOver: IHandedOver[] = [];
	const queued: Extract<
		IPlan,
		{
			kind: "queued";
		}
	>[] = [];
	const behind: Extract<
		IPlan,
		{
			kind: "behind";
		}
	>[] = [];
	const line = createArrivals();
	const back = new Set<ISnapshotInFlightEntry>();

	const dropWith = (row: ISnapshotInFlightEntry, given: IDrop): void => {
		dropped.push({
			actionId: row.ActionId,
			name: row.Name,
			label: row.Label,
			...(row.Receiver === undefined
				? {}
				: {
						receiver: row.Receiver
					}),
			entityId: row.EntityId,
			reason: given.reason,
			...(given.detail === undefined
				? {}
				: {
						detail: given.detail
					}),
			...(given.wait === undefined
				? {}
				: {
						wait: given.wait
					}),
			...(given.ownDoing
				? {
						ownDoing: true as const
					}
				: {})
		});
	};
	const drop = (row: ISnapshotInFlightEntry, reason: IDropReason, detail: string): void =>
		dropWith(row, {
			reason,
			detail
		});
	const resume = (row: ISnapshotInFlightEntry, resourceWork: readonly IResourceWork[], wait?: string, holderId?: string): void => {
		resumed.push({
			actionId: row.ActionId,
			name: row.Name!,
			entityId: row.EntityId,
			...(wait === undefined
				? {}
				: {
						wait
					}),
			beside: [],
			resourceWork: resourceWork.map((work) => ({
				...work
			})),
			...(holderId === undefined
				? {}
				: {
						holderId
					})
		});
	};

	function replay(
		plan: Extract<
			IPlan,
			{
				kind: "replay";
			}
		>
	): void {
		const { row, fn, history } = plan;
		const entityId = row.EntityId;
		const cell = runtime.resolveCell(entityId)!;
		const before = JSON.stringify(gateway.cellOf(entityId));
		const loaded = inputs.loaded?.get(entityId);
		if (loaded !== undefined && loaded !== before) {
			drop(row, "diverged", `the entity "${entityId}" changed between the load and the stage`);
			return;
		}
		const scope = gateway.openScope();
		const session = entityRewind(gateway, entityId);
		const prefix = createPrefix(history.Entries, session, row.ActionId);
		try {
			session.rewind(history.Entries);
			support!.during(prefix, () => {
				support!
					.dispatch(
						fn as never,
						() => runtime.resolveCell(entityId)?.state,
						cell.setState,
						() => entityId,
						[
							...history.Args
						],
						{
							prefix
						}
					)
					.catch(() => {});
			});
		} catch (error) {
			prefix.diverge(messageOf(error));
		}
		let detail = prefix.detail;
		if (prefix.outcome === "running") {
			prefix.diverge("the replay stopped short of the wait the snapshot caught");
			detail = prefix.detail;
		} else if (prefix.outcome === "handed-over" && JSON.stringify(gateway.cellOf(entityId)) !== before) {
			detail = "the entity at the hand-over is not the snapshot's";
		}
		if (detail === undefined) {
			try {
				scope.end();
			} catch (error) {
				prefix.drop();
				drop(row, "diverged", `the write scope's end was refused: ${messageOf(error)}`);
				return;
			}
			prefix.accept();
			handedOver.push({
				prefix,
				row,
				history
			});
			back.add(row);
			resume(row, plan.resourceWork, plan.wait, plan.state === "holding" ? prefix.actionId : undefined);
			return;
		}
		scope.unwind();
		prefix.drop();
		dropWith(row, {
			reason: "diverged",
			detail,
			...(prefix.ownDoing
				? {
						ownDoing: true as const
					}
				: {})
		});
	}

	const missing = (plan: { readonly on: readonly ISnapshotInFlightEntry[]; readonly waits: string }): string | undefined => {
		const first = plan.on.find((other) => !back.has(other));
		return first === undefined ? undefined : `${plan.waits} ${nameOf(first)}, which did not resume`;
	};

	type IQueuedPlan = Extract<
		IPlan,
		{
			kind: "queued";
		}
	>;

	const puts: {
		readonly gate: IRecordGate;
		readonly row: ISnapshotInFlightEntry;
		readonly history: IHistory;
	}[] = [];
	const livingBeside = new Set<ISnapshotInFlightEntry>();

	function putBack(plan: IQueuedPlan): void {
		const { row, fn, history } = plan;
		const detail = missing(plan);
		if (detail !== undefined) {
			drop(row, "behind", detail);
			return;
		}
		if (livingBeside.has(row)) {
			drop(row, "off-list", `live work of ${nameOf(row)} is on its entity, and a second run would do its work again`);
			return;
		}
		const cell = runtime.resolveCell(row.EntityId)!;
		const gate = holdRecords();
		puts.push({
			gate,
			row,
			history
		});
		back.add(row);
		resume(row, plan.resourceWork);
		support!
			.dispatch(
				fn as never,
				() => runtime.resolveCell(row.EntityId)?.state,
				cell.setState,
				() => row.EntityId,
				[
					...history.Args
				],
				{
					arrivals: line,
					resumedFrom: row.ActionId,
					journal: gate.wrap
				}
			)
			.catch(() => {});
	}

	const loud = support?.quiet();
	try {
		let watched: string | null | undefined;
		const plans = planResume({
			rows: inputs.rows,
			histories: inputs.histories,
			resume: keeper !== null && support !== null,
			sameBuild: inputs.sameBuild,
			isIdempotent: inputs.isIdempotent,
			lineOf,
			watched: () => {
				if (watched === undefined) {
					watched = watchedBy(gateway);
				}
				return watched;
			}
		});
		// Asked before the stage dispatches anything: the replays and earlier put-backs are runs of their functions too.
		for (const plan of plans) {
			if (plan.kind === "queued" && support!.liveRuns(plan.fn, plan.row.EntityId)) {
				livingBeside.add(plan.row);
			}
		}
		for (const plan of plans) {
			if (plan.kind === "drop") {
				dropWith(plan.row, plan);
			} else if (plan.kind === "queued") {
				queued.push(plan);
			} else if (plan.kind === "behind") {
				behind.push(plan);
			} else {
				replay(plan);
			}
		}
		queued.sort((a, b) => (a.row.Place ?? 0) - (b.row.Place ?? 0));
		for (const plan of queued) {
			putBack(plan);
		}
	} finally {
		loud?.();
	}
	for (const { prefix, row, history } of handedOver) {
		const actionId = prefix.actionId;
		if (actionId !== undefined) {
			keeper?.carry(actionId, row.Name!, row.EntityId, history);
		}
	}
	for (const { gate, row, history } of puts) {
		const actionId = gate.actionId;
		if (actionId !== undefined) {
			keeper?.carry(actionId, row.Name!, row.EntityId, history);
		}
	}
	for (const plan of behind) {
		if (plan.on.every((other) => back.has(other))) {
			drop(plan.row, "off-list", plan.ifResumed);
		} else {
			drop(plan.row, "behind", plan.ifNot);
		}
	}
	const stateOf = new Map(
		inputs.rows.map((row) => [
			row.ActionId,
			row.State
		])
	);
	const lineage = (a: string, b: string): boolean => a === b || lineOf(a)?.includes(b) === true || lineOf(b)?.includes(a) === true;
	for (const entry of resumed) {
		entry.beside = dropped
			.filter((drop) => lineage(drop.entityId, entry.entityId))
			.map((drop) => ({
				actionId: drop.actionId,
				name: drop.name,
				entityId: drop.entityId,
				state: stateOf.get(drop.actionId)
			}));
	}

	let delivered = false;
	let released = false;
	return {
		resumed,
		dropped,
		deliver() {
			if (delivered) {
				return;
			}
			delivered = true;
			for (const { prefix } of handedOver) {
				prefix.announce();
			}
			for (const { gate } of puts) {
				gate.deliver();
			}
		},
		release() {
			if (released) {
				return;
			}
			released = true;
			for (const { prefix } of handedOver) {
				prefix.release();
			}
			beginArrivals(line);
		}
	};
}
