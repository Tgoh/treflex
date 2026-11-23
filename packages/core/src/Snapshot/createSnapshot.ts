import type { ISnapshotHistory } from "../Resume/history";
import type { IRuntime } from "../Runtime/createRuntime";
import type { IRuntimeInternal } from "../Runtime/internals";
import type { ISnapshot } from "./ISnapshot";
import { rawOf } from "../Runtime/viewProxy";
import { errorClass } from "../Utility/errorClasses";
import { MAX_TREE_DEPTH, nestsDeeperThanBound } from "./depth";
import { SNAPSHOT_FORMAT_VERSION } from "./ISnapshot";

export class SnapshotTooDeepError extends Error {
	constructor(section: string) {
		super(
			`[treflex] createSnapshot: the runtime's ${section} nests deeper than ${MAX_TREE_DEPTH} levels, which no restore ` +
				`accepts, so no snapshot is written.`
		);
		this.name = "SnapshotTooDeepError";
	}
}

export class SnapshotOfDisposedRuntimeError extends Error {
	constructor() {
		super(
			"[treflex] createSnapshot: the runtime has been disposed, and its tables with it, so no snapshot is written. " +
				"Snapshot the runtime that replaced it."
		);
		this.name = "SnapshotOfDisposedRuntimeError";
	}
}

errorClass("treflex/SnapshotTooDeepError", SnapshotTooDeepError);
errorClass("treflex/SnapshotOfDisposedRuntimeError", SnapshotOfDisposedRuntimeError);

export function createSnapshot<T extends object>(runtime: IRuntime<T>): string {
	const internal = runtime as IRuntimeInternal<T>;
	if (internal.disposed()) {
		throw new SnapshotOfDisposedRuntimeError();
	}
	const get = internal.get;
	const gateway = get("runtime/writeGateway");
	const unsaved = (id: string) => {
		const root = gateway.rootNameOf(id);
		return root === "TransientState" || root === "ComponentState";
	};
	const schedule = get("runtime/timerSchedule");
	const envelope: ISnapshot & {
		Histories?: ISnapshotHistory[];
	} = {
		Version: SNAPSHOT_FORMAT_VERSION,
		Build: get("runtime/build"),
		// Raw, so snapshotting from inside a reactive computation subscribes it to nothing.
		AppState: rawOf(runtime.state),
		DataSources: get("runtime/dataSources")
			.entries()
			.filter((row) => !unsaved(row.OwnerId)),
		Timers: get("runtime/timers")
			.entries()
			.filter((row) => !unsaved(row.OwnerId))
			.map((row) => {
				const nextDue = schedule.nextDue(row.Key, row.OwnerId);
				return nextDue === undefined
					? row
					: {
							...row,
							NextDue: nextDue
						};
			}),
		Resources: get("runtime/resourceTable")
			.entries()
			.filter((row) => !unsaved(row.OwnerId)),
		InFlight: get("runtime/inFlightActions")().filter((row) => !unsaved(row.EntityId))
	};
	const histories = get("runtime/resume")?.section(
		envelope.InFlight.map((row) => row.ActionId),
		nestsDeeperThanBound
	);
	if (histories !== undefined) {
		envelope.Histories = histories;
	}
	for (const [section, value] of Object.entries(envelope)) {
		if (nestsDeeperThanBound(value)) {
			throw new SnapshotTooDeepError(section);
		}
	}
	return JSON.stringify(envelope);
}
