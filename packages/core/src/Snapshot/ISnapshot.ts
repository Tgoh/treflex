import type { IDataSourceCell } from "../Runtime/createDataSourceMap";
import type { IResourceRow } from "../Runtime/createResourceTable";
import type { ITimerRow } from "../Runtime/createTimerTable";
import type { IInFlightState } from "../Runtime/processAction";

// The reader validates and consumes exactly the sections declared below and
// ignores anything else the envelope carries. It reads this version and
// PREVIOUS_SNAPSHOT_FORMAT_VERSION and refuses any other, so a field is added or a
// section dropped without a bump only when an older envelope loses nothing by it.
export const SNAPSHOT_FORMAT_VERSION = 8;

export const PREVIOUS_SNAPSHOT_FORMAT_VERSION = 7;

/**
 * What an in-flight action was doing at the cut: `"holding"` its entity, parked inside `open(...)`
 * with it let go (`"open"`), in the line to take its hold back (`"regaining"`), arrived and in the
 * line, not started (`"queued"`), or already stopped by the runtime with its close not yet ended
 * (`"stopping"`).
 */
export type ISnapshotInFlightState = IInFlightState;

export interface ISnapshotInFlightEntry {
	ActionId: string;
	Name: string | null;
	Label: string | null;
	Receiver?: string;
	/** The entity the action is gated on: for a form over part of an entity, the entity above it. */
	EntityId: string;
	/** What the action was doing at the cut. Absent on the entries of an envelope treflex 0.2.0 wrote. */
	State?: ISnapshotInFlightState;
	/** On `"queued"` and `"regaining"` entries only: the place in its entity's line among the listed entries, from 0. */
	Place?: number;
}

/** An in-flight entry of a version 7 envelope, whose `Name`, or older `Key`, is a label. */
export interface ISnapshotInFlightEntryV7 {
	ActionId: string;
	Name?: string | null;
	Key?: string | null;
	EntityId: string;
}

export interface ISnapshotTimerRow extends ITimerRow {
	NextDue?: number;
}

export interface ISnapshot {
	Version: number;
	/** The writing runtime's `build`, or null when it had none. */
	Build: string | null;
	AppState: unknown;
	DataSources: IDataSourceCell[];
	Timers: ISnapshotTimerRow[];
	Resources?: IResourceRow[];
	InFlight: ISnapshotInFlightEntry[];
}
