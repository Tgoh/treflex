import type { IRecordRoot } from "../Types/IRecord";
import type { IJournal } from "./createJournal";
import { jsonEquals } from "../Utility/jsonEquals";
import { clone } from "../Utility/valueCodec";
import { createJournal } from "./createJournal";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/timers": ITimerTable;
	}
}

// One row per (Key, OwnerId); a re-registration replaces the row. (Model: docs/reference/live-sources.md#timers.)
export interface ITimerRow {
	Key: string;
	OwnerId: string;
	ReceiverId: string;
	IntervalMs: number;
	// null (not an absent key) when the timer key declares no payload — the
	// row is snapshot data and must survive JSON field-for-field.
	Payload: Record<string, unknown> | null;
}

export interface ITimerTable {
	start(row: ITimerRow): void;
	stop(key: string, ownerId: string): void;
	get(key: string, ownerId: string): ITimerRow | undefined;
	entries(): ITimerRow[];
	ownerCount(ownerId: string): number;
	// Journal-silent, and watchers hear every row, which is what arms a loaded one.
	load(rows: ITimerRow[]): void;
	watch(listener: (key: string, ownerId: string, row: ITimerRow | null) => void): void;
}

export function createTimerTable(deps: {
	onDispose: (callback: (id: string) => void) => void;
	journal?: IJournal;
	rootOf?: (ownerId: string) => IRecordRoot | undefined;
}): ITimerTable {
	const keys: Record<string, Record<string, ITimerRow>> = Object.create(null);
	const byOwner = new Map<string, Set<string>>();
	const rootOf = (ownerId: string): IRecordRoot => deps.rootOf?.(ownerId) ?? "AppState";
	const journal = deps.journal ?? createJournal();
	const listeners: ((key: string, ownerId: string, row: ITimerRow | null) => void)[] = [];
	let loading = false;

	function emit(key: string, ownerId: string, prev: ITimerRow | null, value: ITimerRow | null): void {
		if (journal.wants("table") && !loading) {
			journal.append({
				T: performance.now(),
				Kind: "table",
				Table: "timers",
				Root: rootOf(ownerId),
				Key: key,
				OwnerId: ownerId,
				Prev: prev
					? {
							...prev
						}
					: null,
				Value: value
					? {
							...value
						}
					: null
			});
		}
		for (const listener of listeners) {
			listener(key, ownerId, value);
		}
	}

	function writeCell(row: ITimerRow): void {
		const bucket = keys[row.Key] || Object.create(null);
		const prev = bucket[row.OwnerId] ?? null;
		const next: ITimerRow = {
			...row
		};
		if (prev && jsonEquals(prev, next)) {
			return;
		}
		bucket[row.OwnerId] = next;
		keys[row.Key] = bucket;
		const owned = byOwner.get(row.OwnerId);
		if (owned) {
			owned.add(row.Key);
		} else {
			byOwner.set(
				row.OwnerId,
				new Set([
					row.Key
				])
			);
		}
		emit(row.Key, row.OwnerId, prev, next);
	}

	function start(row: ITimerRow): void {
		writeCell(row);
	}

	function stop(key: string, ownerId: string): void {
		const bucket = keys[key];
		if (!bucket) return;
		const prev = bucket[ownerId];
		if (!prev) return;
		delete bucket[ownerId];
		if (Object.keys(bucket).length === 0) {
			delete keys[key];
		}
		const owned = byOwner.get(ownerId);
		if (owned) {
			owned.delete(key);
			if (owned.size === 0) {
				byOwner.delete(ownerId);
			}
		}
		emit(key, ownerId, prev, null);
	}

	function stopByOwner(ownerId: string): void {
		const owned = byOwner.get(ownerId);
		if (!owned) {
			return;
		}
		for (const key of [
			...owned
		]) {
			stop(key, ownerId);
		}
	}

	function get(key: string, ownerId: string): ITimerRow | undefined {
		const row = keys[key]?.[ownerId];
		return row
			? {
					...row
				}
			: undefined;
	}

	function entries(): ITimerRow[] {
		const out: ITimerRow[] = [];
		for (const bucket of Object.values(keys)) {
			for (const row of Object.values(bucket)) {
				out.push({
					...row,
					Payload: clone(row.Payload) as ITimerRow["Payload"]
				});
			}
		}
		return out;
	}

	function load(rows: ITimerRow[]): void {
		loading = true;
		try {
			for (const row of entries()) {
				stop(row.Key, row.OwnerId);
			}
			for (const row of rows) {
				writeCell(row);
			}
		} finally {
			loading = false;
		}
	}

	function watch(listener: (key: string, ownerId: string, row: ITimerRow | null) => void): void {
		listeners.push(listener);
	}

	deps.onDispose(stopByOwner);

	return {
		start,
		stop,
		get,
		entries,
		ownerCount: (ownerId) => byOwner.get(ownerId)?.size ?? 0,
		load,
		watch
	};
}
