import type { IRecordRoot } from "../Types/IRecord";
import type { IJournal } from "./createJournal";
import { jsonEquals } from "../Utility/jsonEquals";
import { clone } from "../Utility/valueCodec";
import { createJournal } from "./createJournal";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/resourceTable": IResourceTable;
	}
}

// One row per (Key, OwnerId), recording intent: a reopen REPLACES the row.
// Every field is present, null rather than absent, because the row is
// snapshot data and must survive JSON field-for-field.
export interface IResourceRow {
	Key: string;
	OwnerId: string;
	Params: {
		Type: string;
	} & Record<string, unknown>;
	ReceiverId: string | null;
	ResumeFrom: string | null;
}

export type IResourceRowChangeCause = "write" | "owner";

export interface IResourceTable {
	open(row: IResourceRow): void;
	close(key: string, ownerId: string): void;
	get(key: string, ownerId: string): IResourceRow | undefined;
	entries(): IResourceRow[];
	ownerKeys(ownerId: string): string[];
	// Journal-silent and watch-silent: the manager's own load marks every row it loads.
	load(rows: IResourceRow[]): void;
	watch(listener: (key: string, ownerId: string, row: IResourceRow | null, cause: IResourceRowChangeCause) => void): void;
}

export function createResourceTable(deps: {
	onDispose: (callback: (id: string) => void) => void;
	journal?: IJournal;
	rootOf?: (ownerId: string) => IRecordRoot | undefined;
}): IResourceTable {
	// Prototype-less at both levels: keys and owner ids are application
	// strings, and "constructor" would otherwise resolve to an inherited
	// member.
	const keys: Record<string, Record<string, IResourceRow>> = Object.create(null);
	const byOwner = new Map<string, Set<string>>();
	const journal = deps.journal ?? createJournal();
	const listeners: ((key: string, ownerId: string, row: IResourceRow | null, cause: IResourceRowChangeCause) => void)[] = [];
	let loading = false;

	function emit(key: string, ownerId: string, prev: IResourceRow | null, value: IResourceRow | null, cause: IResourceRowChangeCause): void {
		if (loading) {
			return;
		}
		if (journal.wants("table")) {
			journal.append({
				T: performance.now(),
				Kind: "table",
				Table: "resources",
				Root: deps.rootOf?.(ownerId) ?? "AppState",
				Key: key,
				OwnerId: ownerId,
				Prev: prev ? copyRow(prev) : null,
				Value: value ? copyRow(value) : null
			});
		}
		for (const listener of listeners) {
			listener(key, ownerId, value, cause);
		}
	}

	function writeCell(row: IResourceRow): void {
		const bucket = keys[row.Key] || Object.create(null);
		const prev = bucket[row.OwnerId] ?? null;
		const next = copyRow(row);
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
		emit(row.Key, row.OwnerId, prev, next, "write");
	}

	function remove(key: string, ownerId: string, cause: IResourceRowChangeCause): void {
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
		emit(key, ownerId, prev, null, cause);
	}

	function close(key: string, ownerId: string): void {
		remove(key, ownerId, "write");
	}

	function get(key: string, ownerId: string): IResourceRow | undefined {
		const row = keys[key]?.[ownerId];
		return row ? copyRow(row) : undefined;
	}

	function entries(): IResourceRow[] {
		const out: IResourceRow[] = [];
		for (const bucket of Object.values(keys)) {
			for (const row of Object.values(bucket)) {
				out.push(copyRow(row));
			}
		}
		return out;
	}

	function load(rows: IResourceRow[]): void {
		loading = true;
		try {
			for (const key of Object.keys(keys)) {
				delete keys[key];
			}
			byOwner.clear();
			for (const row of rows) {
				writeCell(row);
			}
		} finally {
			loading = false;
		}
	}

	deps.onDispose((ownerId) => {
		const owned = byOwner.get(ownerId);
		if (!owned) {
			return;
		}
		for (const key of [
			...owned
		]) {
			remove(key, ownerId, "owner");
		}
	});

	return {
		open: writeCell,
		close,
		get,
		entries,
		ownerKeys: (ownerId) => [
			...(byOwner.get(ownerId) ?? [])
		],
		load,
		watch(listener) {
			listeners.push(listener);
		}
	};
}

function copyRow(row: IResourceRow): IResourceRow {
	return {
		Key: row.Key,
		OwnerId: row.OwnerId,
		Params: clone(row.Params) as IResourceRow["Params"],
		ReceiverId: row.ReceiverId,
		ResumeFrom: row.ResumeFrom
	};
}
