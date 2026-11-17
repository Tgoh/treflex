import type { IResourceRow } from "../Runtime/createResourceTable";
import type { IRuntimeStoreReader } from "../Runtime/processAction";
import type { IDiagEmitter } from "../Types/IRuntimeEvent";
import type { ISnapshot, ISnapshotInFlightEntryV7 } from "./ISnapshot";
import { copySeed } from "../Runtime/viewProxy";
import { host } from "../Solid/host";
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

export interface IRestoreDrop {
	actionId: string;
	/** The action's durable name, or null. */
	name: string | null;
	/** The function's own name as the writing build spelled it, for display, or null. */
	label: string | null;
	/** Present for a delivery: its receiver's id. */
	receiver?: string;
	entityId: string;
}

export interface IRestoreUnresolvedRow {
	ownerId: string;
	// The timer or resource key. Null for a binding, whose topics are its receiver's, which isn't registered.
	key: string | null;
	receiverId: string;
}

export interface IRestoreResult {
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
	snapshot.InFlight = inFlight.filter(
		(row) => row !== null && typeof row === "object" && typeof row.ActionId === "string" && typeof row.EntityId === "string"
	);
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

export function droppedActions(snapshot: ISnapshot): IRestoreDrop[] {
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
			entityId: entry.EntityId
		};
	});
}

export function savedBuildOf(snapshot: ISnapshot): string | null {
	return snapshot.Version === PREVIOUS_SNAPSHOT_FORMAT_VERSION ? null : stringOrNull(snapshot.Build);
}
