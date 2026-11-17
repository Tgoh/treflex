import type { IDataSourceCell } from "../Runtime/createDataSourceMap";
import type { IResourceRow } from "../Runtime/createResourceTable";
import type { ITimerRow } from "../Runtime/createTimerTable";

// The reader validates and consumes exactly the sections declared below and
// ignores anything else the envelope carries. A bump means older envelopes are
// refused and the caller discards them and boots fresh, so a section is dropped
// without one only when ignoring it in an older envelope loses nothing.
export const SNAPSHOT_FORMAT_VERSION = 7;

export interface ISnapshotInFlightEntry {
	ActionId: string;
	// Best-effort and build-dependent: the writing build's minifier decides
	// what a name looks like, so a reader must treat it as a label, never as
	// a key it can resolve.
	Name: string | null;
	EntityId: string;
	// Older envelopes spelled Name this way. The reader falls back to it, and
	// nothing writes it.
	Key?: string | null;
}

export interface ISnapshotTimerRow extends ITimerRow {
	NextDue?: number;
}

export interface ISnapshot {
	Version: number;
	AppState: unknown;
	DataSources: IDataSourceCell[];
	Timers: ISnapshotTimerRow[];
	// Optional: an envelope written before resources existed reads as having none.
	Resources?: IResourceRow[];
	InFlight: ISnapshotInFlightEntry[];
}
