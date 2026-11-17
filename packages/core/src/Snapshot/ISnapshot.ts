import type { IDataSourceCell } from "../Runtime/createDataSourceMap";
import type { IResourceRow } from "../Runtime/createResourceTable";
import type { ITimerRow } from "../Runtime/createTimerTable";

// The reader validates and consumes exactly the sections declared below and
// ignores anything else the envelope carries. It reads this version and
// PREVIOUS_SNAPSHOT_FORMAT_VERSION and refuses any other, so a section is dropped
// without a bump only when ignoring it in an older envelope loses nothing.
export const SNAPSHOT_FORMAT_VERSION = 8;

export const PREVIOUS_SNAPSHOT_FORMAT_VERSION = 7;

export interface ISnapshotInFlightEntry {
	ActionId: string;
	Name: string | null;
	Label: string | null;
	Receiver?: string;
	EntityId: string;
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
	// Optional: an envelope written before resources existed reads as having none.
	Resources?: IResourceRow[];
	InFlight: ISnapshotInFlightEntry[];
}
