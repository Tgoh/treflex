import type { IRecordRoot } from "../Types/IRecord";
import type { IJournal } from "./createJournal";
import type { IStateIdLookup } from "./createWriteGateway";
import { createJournal } from "./createJournal";
import { notifyWrite } from "./tracking";
import { view } from "./viewProxy";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/dataSources": IDataSourceMap;
	}
}

export interface IDataSourceMap {
	add(key: string, ownerId: string, dataId: string): void;
	remove(key: string, ownerId: string): void;
	// Read raw: snapshotting must not subscribe anything.
	entries(): IDataSourceCell[];
	load(cells: IDataSourceCell[]): void;
	resolve(key: string, fromId: string | undefined, lookup: IStateIdLookup): unknown;
	resolveGlobal(key: string, lookup: IStateIdLookup): unknown;
	resolveWithPath(
		key: string,
		fromId: string,
		lookup: IStateIdLookup
	): {
		value: unknown;
		ancestors: string[];
	};
}

export interface IDataSourceCell {
	Key: string;
	OwnerId: string;
	DataId: string;
}

type ISourceStore = Record<string, Record<string, string>>;

export function createDataSourceMap(deps: {
	onDispose: (callback: (id: string) => void) => void;
	journal?: IJournal;
	rootOf?: (ownerId: string) => IRecordRoot | undefined;
}): IDataSourceMap {
	// Prototype-less at both levels: data-source keys and owner $Ids are
	// arbitrary application strings, and over object literals a key named
	// "constructor" resolves to an inherited member that reads as a live
	// bucket.
	const raw: ISourceStore = Object.create(null);
	const sources = view(raw);

	// The mutation paths below — add, remove, removeByOwner — read it raw, so
	// they never subscribe a caller. That matters for removeByOwner in
	// particular: it is wired into the dispose cascade and so runs inside a
	// reactive computation.

	const journal = deps.journal ?? createJournal();
	const byOwner = new Map<string, Set<string>>();
	const rootOf = (ownerId: string): IRecordRoot => deps.rootOf?.(ownerId) ?? "AppState";
	let loading = false;

	function emit(key: string, ownerId: string, prev: string | null, value: string | null): void {
		if (!journal.wants("table") || loading) {
			return;
		}
		journal.append({
			T: performance.now(),
			Kind: "table",
			Table: "dataSources",
			Root: rootOf(ownerId),
			Key: key,
			OwnerId: ownerId,
			Prev: prev,
			Value: value
		});
	}

	function writeCell(key: string, ownerId: string, dataId: string) {
		const bucket = raw[key];
		const prev = bucket?.[ownerId];
		if (bucket === undefined) {
			raw[key] = Object.assign(Object.create(null), {
				[ownerId]: dataId
			});
			notifyWrite(raw, key, true, true, false);
		} else if (prev !== dataId) {
			bucket[ownerId] = dataId;
			notifyWrite(bucket, ownerId, true, prev === undefined, false);
		}
		const owned = byOwner.get(ownerId);
		if (owned) {
			owned.add(key);
		} else {
			byOwner.set(
				ownerId,
				new Set([
					key
				])
			);
		}
		if (prev !== dataId) {
			emit(key, ownerId, prev ?? null, dataId);
		}
	}

	function add(key: string, ownerId: string, dataId: string) {
		if (raw[key]?.[ownerId] !== undefined) {
			console.warn(
				`[treflex] registerDataSource("${key}", ...) — owner "${ownerId}" already owns "${key}". ` +
					`The previous registration is replaced (typically HMR with dispose lag, or a deliberate re-point).`
			);
		}
		writeCell(key, ownerId, dataId);
	}

	function remove(key: string, ownerId: string) {
		const bucket = raw[key];
		const prev = bucket?.[ownerId];
		if (bucket === undefined || prev === undefined) return;

		// An emptied bucket is left in place; buckets are keyed by data-source
		// key, a small fixed set.
		delete bucket[ownerId];
		notifyWrite(bucket, ownerId, true, true, false);
		const owned = byOwner.get(ownerId);
		if (owned) {
			owned.delete(key);
			if (owned.size === 0) {
				byOwner.delete(ownerId);
			}
		}
		emit(key, ownerId, prev, null);
	}

	function removeByOwner(ownerId: string) {
		const owned = byOwner.get(ownerId);
		if (!owned) {
			return;
		}
		for (const key of [
			...owned
		]) {
			remove(key, ownerId);
		}
	}

	function walkScoped(bucket: Record<string, string>, path: readonly string[], lookup: IStateIdLookup, collect?: string[]): unknown {
		for (const ancestorId of [
			...path
		].reverse()) {
			collect?.push(ancestorId);
			const dataId = bucket[ancestorId];
			if (dataId !== undefined) {
				return lookup[dataId]?.state;
			}
		}
		return undefined;
	}

	// The anchor obligation holds whether or not the key has any registration
	// yet, so the check sits above the bucket read.
	function checkAnchor(caller: string, key: string, fromId: string | undefined, lookup: IStateIdLookup): IStateIdLookup[string] | null {
		const fromState = fromId ? lookup[fromId] : undefined;
		if (fromState) {
			return fromState;
		}
		console.warn(
			`[treflex] ${caller}("${key}", ${fromId ? `<$Id "${fromId}">` : "<an entity with no $Id>"}) called from an entity not in ` +
				`the state tree — the from entity must be a state node in the tree for ancestry routing to work.`
		);
		return null;
	}

	function resolve(key: string, fromId: string | undefined, lookup: IStateIdLookup): unknown {
		const fromState = checkAnchor("getData", key, fromId, lookup);
		if (!fromState) return undefined;

		// Reading sources[key] subscribes the calling getData memo to this
		// key's bucket — so the memo re-runs when the key gains its first
		// registration (the bucket appears) and on every later cell change.
		const bucket = sources[key];
		if (bucket === undefined) return undefined;

		return walkScoped(bucket, fromState.path, lookup);
	}

	function resolveGlobal(key: string, lookup: IStateIdLookup): unknown {
		const bucket = sources[key];
		if (bucket === undefined) return undefined;

		let bestDataId: string | undefined;
		let bestDepth = Number.POSITIVE_INFINITY;
		for (const ownerId of Object.keys(bucket)) {
			const dataId = bucket[ownerId];
			if (dataId === undefined) continue;
			const ownerState = lookup[ownerId];
			if (!ownerState) continue;
			if (ownerState.path.length < bestDepth) {
				bestDepth = ownerState.path.length;
				bestDataId = dataId;
			}
		}
		return bestDataId !== undefined ? lookup[bestDataId]?.state : undefined;
	}

	function resolveWithPath(
		key: string,
		fromId: string,
		lookup: IStateIdLookup
	): {
		value: unknown;
		ancestors: string[];
	} {
		const fromState = checkAnchor("getDataPath", key, fromId, lookup);
		if (!fromState) {
			return {
				value: undefined,
				ancestors: []
			};
		}
		const bucket = sources[key];
		if (bucket === undefined) {
			return {
				value: undefined,
				ancestors: [
					...fromState.path
				].reverse()
			};
		}
		const ancestors: string[] = [];
		const value = walkScoped(bucket, fromState.path, lookup, ancestors);
		return {
			value,
			ancestors
		};
	}

	function entries(): IDataSourceCell[] {
		const out: IDataSourceCell[] = [];
		for (const [key, bucket] of Object.entries(raw)) {
			for (const [ownerId, dataId] of Object.entries(bucket)) {
				out.push({
					Key: key,
					OwnerId: ownerId,
					DataId: dataId
				});
			}
		}
		return out;
	}

	function load(cells: IDataSourceCell[]): void {
		loading = true;
		try {
			for (const key of Object.keys(raw)) {
				delete raw[key];
				notifyWrite(raw, key, true, true, false);
			}
			byOwner.clear();
			for (const entry of cells) {
				writeCell(entry.Key, entry.OwnerId, entry.DataId);
			}
		} finally {
			loading = false;
		}
	}

	deps.onDispose(removeByOwner);

	return {
		add,
		remove,
		entries,
		load,
		resolve,
		resolveGlobal,
		resolveWithPath
	};
}
