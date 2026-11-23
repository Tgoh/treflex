import type { ISnapshotHistory } from "../Resume/history";
import type { IDropReason as IKnownDropReason } from "../Resume/plan";
import type { IResourceRow } from "../Runtime/createResourceTable";
import type { IRuntimeStoreReader } from "../Runtime/processAction";
import type { IDiagEmitter } from "../Types/IRuntimeEvent";
import type { ISnapshot, ISnapshotInFlightEntry, ISnapshotInFlightEntryV7, ISnapshotInFlightState } from "./ISnapshot";
import { host } from "../Reactive/host";
import { copySeed } from "../Runtime/viewProxy";
import { errorClass } from "../Utility/errorClasses";
import { MAX_TREE_DEPTH, nestsDeeperThanBound } from "./depth";
import { PREVIOUS_SNAPSHOT_FORMAT_VERSION, SNAPSHOT_FORMAT_VERSION } from "./ISnapshot";

const UNRESOLVED_SAMPLE = 10;

export class SnapshotRejectedError extends Error {
	constructor(
		message: string,
		options?: {
			cause?: unknown;
		}
	) {
		super(message, options);
		this.name = "SnapshotRejectedError";
	}
}

errorClass("treflex/SnapshotRejectedError", SnapshotRejectedError);

/**
 * Why a restore dropped an action rather than resuming it: a key to match on. The set is open, and a
 * new reason can arrive in a minor version. See docs/reference/restart-and-records.md#what-a-restore-reports.
 *
 * @experimental
 */
export type IDropReason = IKnownDropReason | (string & {});

export interface IRestoreDrop {
	actionId: string;
	/** The action's durable name, or null. */
	name: string | null;
	/** The function's own name as the writing build spelled it, for display, or null. */
	label: string | null;
	/** Present for a delivery: its receiver's id. */
	receiver?: string;
	/** The entity the action was gated on. */
	entityId: string;
	/** What the action was doing at the cut. Absent on the entries of a format 7 envelope, or of one treflex 0.2.0 wrote. */
	state?: ISnapshotInFlightState;
	/** On `"queued"` and `"regaining"` entries only: the place in its entity's line, from 0. */
	place?: number;
	/**
	 * Why it was dropped: `"resume-off"` on a runtime without the `resume` option.
	 *
	 * @experimental
	 */
	reason: IDropReason;
	/**
	 * What caused the drop, as text for a log. Nothing should match on it.
	 *
	 * @experimental
	 */
	detail?: string;
	/**
	 * On `"not-idempotent"`: the `Type` of the wait the snapshot caught the action at.
	 *
	 * @experimental
	 */
	wait?: string;
}

/**
 * An in-flight action a restore brought back to the wait the snapshot caught it at, or put back in
 * its entity's line. See docs/reference/restart-and-records.md#what-a-restore-reports.
 *
 * @experimental
 */
export interface IRestoreResumed {
	/** Its id in the save. The restored runtime gives it a new one, which its `action:start` record pairs with this as `ResumedFrom`. */
	actionId: string;
	/** Its durable name. */
	name: string;
	entityId: string;
	/** The `Type` of the wait it is parked on, sent when the restore releases it. Absent for a queued action put back. */
	wait?: string;
	/** The resources with a delivery in flight on its entity, above it or below it when the save was written, each once: for a log. */
	resourceWork: {
		key: string;
		ownerId: string;
	}[];
}

export interface IRestoreUnresolvedRow {
	ownerId: string;
	// The timer or resource key. Null for a binding, whose topics are its receiver's, which isn't registered.
	key: string | null;
	receiverId: string;
}

export interface IRestoreResult {
	/**
	 * The in-flight actions that came back. Empty on a runtime without `resume`. An in-flight action is
	 * in exactly one of `resumed` and `dropped`.
	 *
	 * @experimental
	 */
	resumed: IRestoreResumed[];
	dropped: IRestoreDrop[];
	unresolved: IRestoreUnresolvedRow[];
	sweptOrphanedRows: number;
	/** The envelope's `Build`: the writing runtime's `build`, or null. */
	savedBuild: string | null;
	/** True only when `savedBuild` and this runtime's `build` are both strings and equal. */
	sameBuild: boolean;
}

function isResourceRow(row: unknown): row is IResourceRow {
	if (row === null || typeof row !== "object") {
		return false;
	}
	const r = row as Record<string, unknown>;
	const params = r.Params as Record<string, unknown> | null | undefined;
	return (
		typeof r.Key === "string" &&
		typeof r.OwnerId === "string" &&
		params !== null &&
		typeof params === "object" &&
		!Array.isArray(params) &&
		typeof params.Type === "string" &&
		(r.ReceiverId === null || typeof r.ReceiverId === "string") &&
		(r.ResumeFrom === null || typeof r.ResumeFrom === "string")
	);
}

export function gateSnapshot(snapshotJson: string): ISnapshot {
	let snapshot: ISnapshot;
	try {
		snapshot = JSON.parse(snapshotJson) as ISnapshot;
	} catch (e) {
		throw new SnapshotRejectedError(`[treflex] restore: the snapshot is not valid JSON — ${String(e)}`);
	}
	if (snapshot === null || typeof snapshot !== "object") {
		throw new SnapshotRejectedError("[treflex] restore: the snapshot is not an envelope object. Discard it and boot fresh.");
	}
	if (snapshot.Version !== SNAPSHOT_FORMAT_VERSION && snapshot.Version !== PREVIOUS_SNAPSHOT_FORMAT_VERSION) {
		throw new SnapshotRejectedError(
			`[treflex] restore: snapshot format v${snapshot.Version} is not one this treflex reads, ` +
				`v${PREVIOUS_SNAPSHOT_FORMAT_VERSION} or v${SNAPSHOT_FORMAT_VERSION} — ` +
				`the envelope cannot be read. Discard the snapshot and boot fresh.`
		);
	}
	if (
		snapshot.AppState === null ||
		typeof snapshot.AppState !== "object" ||
		!Array.isArray(snapshot.DataSources) ||
		!Array.isArray(snapshot.Timers) ||
		(snapshot.Resources !== undefined && !Array.isArray(snapshot.Resources)) ||
		!Array.isArray(snapshot.InFlight)
	) {
		throw new SnapshotRejectedError(
			"[treflex] restore: the envelope is structurally incomplete — a required section is missing or mis-shaped. " +
				"Discard the snapshot and boot fresh."
		);
	}
	const rootId = (
		snapshot.AppState as {
			$Id?: unknown;
		}
	).$Id;
	if (Array.isArray(snapshot.AppState) || typeof rootId !== "string" || rootId === "") {
		throw new SnapshotRejectedError(
			"[treflex] restore: the snapshot's root is not an entity with a non-empty string $Id. Discard the snapshot and boot fresh."
		);
	}
	for (const [section, value] of Object.entries({
		AppState: snapshot.AppState,
		DataSources: snapshot.DataSources,
		Timers: snapshot.Timers,
		Resources: snapshot.Resources,
		InFlight: snapshot.InFlight
	})) {
		if (nestsDeeperThanBound(value)) {
			throw new SnapshotRejectedError(
				`[treflex] restore: the snapshot's ${section} nests deeper than ${MAX_TREE_DEPTH} levels. Discard the snapshot and boot fresh.`
			);
		}
	}
	return {
		...snapshot,
		AppState: seedCopy(snapshot.AppState)
	};
}

function seedCopy(tree: unknown): unknown {
	try {
		return copySeed(tree, "the snapshot's tree");
	} catch (error) {
		throw new SnapshotRejectedError(
			`[treflex] restore: the snapshot's tree cannot seed a runtime — ${String(error)}. Discard it and boot fresh.`,
			{
				cause: error
			}
		);
	}
}

function isPlaced(row: ISnapshotInFlightEntry): boolean {
	switch (row.State as unknown) {
		case undefined:
			return row.Place === undefined;
		case "queued":
		case "regaining":
			return Number.isInteger(row.Place) && row.Place! >= 0;
		case "holding":
		case "open":
		case "stopping":
			return row.Place === undefined;
		default:
			return false;
	}
}

function sanitizeSnapshot(snapshot: ISnapshot, emitDiag: IDiagEmitter): void {
	let droppedRows = 0;
	const rowFilter = <T>(rows: T[]): T[] => {
		const kept = rows.filter((row) => row !== null && typeof row === "object");
		droppedRows += rows.length - kept.length;
		return kept;
	};
	snapshot.DataSources = rowFilter(snapshot.DataSources);
	snapshot.Timers = rowFilter(snapshot.Timers);
	const resources = snapshot.Resources ?? [];
	snapshot.Resources = resources.filter(isResourceRow);
	droppedRows += resources.length - snapshot.Resources.length;
	const inFlight = snapshot.InFlight;
	const placed = snapshot.Version === SNAPSHOT_FORMAT_VERSION;
	const ids = new Set<string>();
	snapshot.InFlight = inFlight.filter((row) => {
		const wellFormed =
			row !== null &&
			typeof row === "object" &&
			typeof row.ActionId === "string" &&
			typeof row.EntityId === "string" &&
			(!placed || isPlaced(row)) &&
			!ids.has(row.ActionId);
		if (wellFormed) {
			ids.add(row.ActionId);
		}
		return wellFormed;
	});
	droppedRows += inFlight.length - snapshot.InFlight.length;
	if (droppedRows > 0) {
		emitDiag({
			severity: "warn",
			code: "restore/malformed-rows",
			message: `[treflex] restore: dropped ${droppedRows} malformed snapshot row(s) — the rest of the envelope loads normally.`,
			data: {
				droppedRows
			}
		});
	}
}

export function loadTables(get: IRuntimeStoreReader, snapshot: ISnapshot, emitDiag: IDiagEmitter): number {
	sanitizeSnapshot(snapshot, emitDiag);
	const lookup = host.untrack(() => get("runtime/stateIdLookup")());
	let swept = 0;
	const owned = <R>(rows: R[], ownerOf: (row: R) => string): R[] => {
		const kept = rows.filter((row) => lookup[ownerOf(row)] !== undefined);
		swept += rows.length - kept.length;
		return kept;
	};
	get("runtime/dataSources").load(owned(snapshot.DataSources, (row) => row.OwnerId));
	get("runtime/timerSchedule").load(
		owned(snapshot.Timers, (row) => row.OwnerId).map(({ NextDue, ...row }) => ({
			row,
			nextDue: typeof NextDue === "number" && Number.isFinite(NextDue) ? NextDue : undefined
		}))
	);
	get("runtime/resources").load(owned(snapshot.Resources ?? [], (row) => row.OwnerId));
	if (swept > 0) {
		emitDiag({
			severity: "info",
			code: "restore/orphaned-rows",
			message: `[treflex] restore: left out ${swept} table row(s) whose owners are not in the restored tree — leftovers of the recording session.`,
			data: {
				count: swept
			}
		});
	}
	return swept;
}

export function unresolvedReceivers(get: IRuntimeStoreReader): IRestoreUnresolvedRow[] {
	const receivers = get("runtime/receivers");
	const rows: IRestoreUnresolvedRow[] = [];
	for (const binding of get("runtime/bindings").entries()) {
		if (!receivers.get(binding.ReceiverId)) {
			rows.push({
				ownerId: binding.OwnerId,
				key: null,
				receiverId: binding.ReceiverId
			});
		}
	}
	for (const row of get("runtime/timers").entries()) {
		if (!receivers.get(row.ReceiverId)) {
			rows.push({
				ownerId: row.OwnerId,
				key: row.Key,
				receiverId: row.ReceiverId
			});
		}
	}
	for (const row of get("runtime/resourceTable").entries()) {
		if (row.ReceiverId !== null && !receivers.get(row.ReceiverId)) {
			rows.push({
				ownerId: row.OwnerId,
				key: row.Key,
				receiverId: row.ReceiverId
			});
		}
	}
	return rows;
}

export function reportUnresolved(rows: readonly IRestoreUnresolvedRow[], emitDiag: IDiagEmitter): void {
	if (rows.length === 0) {
		return;
	}
	const receiverIds = [
		...new Set(rows.map((row) => row.receiverId))
	];
	const named = receiverIds.slice(0, UNRESOLVED_SAMPLE);
	emitDiag({
		severity: "warn",
		code: "restore/unresolved-receiver",
		message:
			`[treflex] restore: ${rows.length} restored binding(s) and row(s) name a receiver this build has not registered ` +
			`(${named.join(", ")}${receiverIds.length > named.length ? ", and others" : ""}). Those entities hear nothing, ` +
			`those timers deliver nothing, and those resources wait unconnected. Register the receivers, or unbind the ` +
			`entities and retract the rows.`,
		data: {
			count: rows.length,
			receiverIds: named,
			sample: rows.slice(0, UNRESOLVED_SAMPLE)
		}
	});
}

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** An in-flight row as the result lists it, before the restore says what became of it. */
export type IInFlightListing = Omit<IRestoreDrop, "reason" | "detail" | "wait">;

export function listedInFlight(snapshot: ISnapshot): IInFlightListing[] {
	if (snapshot.Version === PREVIOUS_SNAPSHOT_FORMAT_VERSION) {
		return (snapshot.InFlight as unknown as ISnapshotInFlightEntryV7[]).map((entry) => ({
			actionId: entry.ActionId,
			name: null,
			label: stringOrNull(entry.Name ?? entry.Key),
			entityId: entry.EntityId
		}));
	}
	return snapshot.InFlight.map((entry) => {
		const receiver = entry.Receiver;
		return {
			actionId: entry.ActionId,
			name: stringOrNull(entry.Name),
			label: stringOrNull(entry.Label),
			...(typeof receiver === "string"
				? {
						receiver
					}
				: {}),
			entityId: entry.EntityId,
			...(entry.State !== undefined
				? {
						state: entry.State
					}
				: {}),
			...(entry.Place !== undefined
				? {
						place: entry.Place
					}
				: {})
		};
	});
}

export function savedBuildOf(snapshot: ISnapshot): string | null {
	return snapshot.Version === PREVIOUS_SNAPSHOT_FORMAT_VERSION ? null : stringOrNull(snapshot.Build);
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const isKey = (value: unknown): boolean =>
	typeof value === "string" || (typeof value === "number" && Number.isInteger(value) && value >= 0);

const isPath = (value: unknown): boolean => Array.isArray(value) && value.every(isKey);

const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);

const isTrue = (value: unknown): boolean => value === true;

function isChange(value: unknown): boolean {
	return (
		isObject(value) &&
		isPath(value.Path) &&
		optional(value.Deleted, isTrue) &&
		optional(value.Created, isTrue) &&
		optional(value.GrewFrom, (n) => typeof n === "number" && Number.isInteger(n) && n >= 0) &&
		optional(value.Landing, (landing) => isObject(landing) && typeof landing.EntityId === "string" && isPath(landing.Path))
	);
}

function isThrowForm(value: unknown): boolean {
	if (!isObject(value)) {
		return false;
	}
	switch (value.Thrown) {
		case "value":
			return true;
		case "error":
			return (
				typeof value.Name === "string" &&
				typeof value.Message === "string" &&
				optional(value.Stack, (s) => typeof s === "string") &&
				optional(value.Fields, isObject) &&
				optional(value.Native, (s) => typeof s === "string") &&
				optional(value.Class, (s) => typeof s === "string") &&
				optional(value.Cause, isThrowForm) &&
				optional(value.Error, isThrowForm) &&
				optional(value.Suppressed, isThrowForm) &&
				optional(value.Errors, (errors) => Array.isArray(errors) && errors.every(isThrowForm))
			);
		default:
			return false;
	}
}

function isEntry(value: unknown): boolean {
	if (!isObject(value)) {
		return false;
	}
	const seq = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n);
	switch (value.Kind) {
		case "step":
			return (
				Array.isArray(value.Changes) &&
				value.Changes.every(isChange) &&
				optional(value.InFlightAnswers, (answers) => Array.isArray(answers) && answers.every((a) => typeof a === "boolean")) &&
				optional(
					value.ExternalAnswers,
					(answers) =>
						Array.isArray(answers) && answers.every((a) => isObject(a) && typeof a.Key === "string" && optional(a.Redacted, isTrue))
				)
			);
		case "effect":
			return seq(value.Seq) && Object.hasOwn(value, "Descriptor");
		case "response":
			return (
				seq(value.ForSeq) &&
				optional(value.Sync, isTrue) &&
				optional(value.Error, (error) => (isObject(error) && error.Thrown === "redacted") || isThrowForm(error))
			);
		case "other":
			return isChange(value.Change);
		default:
			return false;
	}
}

const UNUSABLE = new Set([
	"not-whole",
	"over-budget",
	"too-deep"
]);

function isHistory(value: Record<string, unknown>): boolean {
	if (Object.hasOwn(value, "Unusable")) {
		return typeof value.Unusable === "string" && UNUSABLE.has(value.Unusable);
	}
	return Array.isArray(value.Args) && typeof value.ArgsExact === "boolean" && Array.isArray(value.Entries) && value.Entries.every(isEntry);
}

/**
 * The envelope's `Histories`, without the entries that can't be trusted. A kept entry's `Unlisted`,
 * `UnlistedLineage` and `Deliveries` are not checked here: `planResume` in `Resume/plan.ts` reads a
 * malformed one as work it can't name.
 */
export function historiesOf(snapshot: ISnapshot): {
	histories: ISnapshotHistory[];
	/** The `ActionId`s of the entries left out. */
	malformed: ReadonlySet<string>;
	/** The section is there and was left out whole. */
	unreadable: boolean;
} {
	const section: unknown = (
		snapshot as {
			Histories?: unknown;
		}
	).Histories;
	const malformed = new Set<string>();
	const unreadable = section !== undefined && (!Array.isArray(section) || nestsDeeperThanBound(section));
	const entries = section === undefined || unreadable ? [] : (section as unknown[]);
	const seen = new Map<string, number>();
	for (const entry of entries) {
		if (isObject(entry) && typeof entry.ActionId === "string") {
			seen.set(entry.ActionId, (seen.get(entry.ActionId) ?? 0) + 1);
		}
	}
	const histories: ISnapshotHistory[] = [];
	for (const entry of entries) {
		if (!isObject(entry) || typeof entry.ActionId !== "string") {
			continue;
		}
		if (seen.get(entry.ActionId) === 1 && isHistory(entry)) {
			histories.push(entry as unknown as ISnapshotHistory);
		} else {
			malformed.add(entry.ActionId);
		}
	}
	return {
		histories,
		malformed,
		unreadable
	};
}
