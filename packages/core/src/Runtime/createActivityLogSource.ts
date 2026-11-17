import type { IExternalSource } from "../Types/IExternalSource";
import type { IRecord, IRecordTapListener } from "../Types/IRecord";
import type { IRecordKind } from "./createJournal";
import { createStore } from "solid-js/store";

declare module "../Registries/IDataSourceRegistry" {
	interface IDataSourceRegistry {
		ActivityLog: IActivityLog;
	}
}

// Never the tap extras: their live references don't belong in a reactive store.
export interface IActivityLogEntry {
	Seq: number;
	Kind: IRecord["Kind"];
	Time: number;
	Data: unknown;
}

export interface IActivityLog {
	Entries: readonly IActivityLogEntry[];
}

export const ACTIVITY_LOG_SOURCE_ID = "treflex/ActivityLog";
const ACTIVITY_LOG_KEY = "ActivityLog";
const DEFAULT_CAP = 200;

// Not step, effect or response: their per-write clones and settlement
// payloads, buffered in a reactive store, become retention.
const CAPTURED: readonly IRecordKind[] = [
	"action:start",
	"action:end",
	"branch:start",
	"branch:end",
	"entity:dispose",
	"message:deliver"
];

// A rejection's fields can hold what a redacted effect carried, and any
// selector can read this store.
function loggedForm(record: IRecord): unknown {
	if (record.Kind !== "branch:end" || record.Error === undefined) {
		return record;
	}
	const { Error: _withheld, ...kept } = record;
	return kept;
}

export function createActivityLogSource(
	tap: (listener: IRecordTapListener, kinds: readonly IRecordKind[]) => () => void,
	cap: number = DEFAULT_CAP
): IExternalSource {
	const [store, setStore] = createStore<IActivityLog>({
		Entries: []
	});
	// The log's own monotonic Seq — record Seqs restart across restore
	// generations, and the ring's row identity must not collide.
	let seq = 0;

	const off = tap((record) => {
		const entry: IActivityLogEntry = {
			Seq: ++seq,
			Kind: record.Kind,
			Time: Date.now(),
			Data: loggedForm(record)
		};
		// The functional form reads the ring untracked, so the log subscribes
		// no scope that happens to append.
		setStore("Entries", (entries) =>
			[
				entry,
				...entries
			].slice(0, cap)
		);
	}, CAPTURED);

	return {
		Id: ACTIVITY_LOG_SOURCE_ID,
		DataSourceKeys: [
			ACTIVITY_LOG_KEY
		],
		getData: () => store,
		dispose: off
	};
}
