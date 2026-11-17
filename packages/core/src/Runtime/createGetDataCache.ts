import type { IDiagEmitter } from "../Types/IRuntimeEvent";
import type { IOwnedMemo } from "./createOwnedCache";
import { createOwnedBucketCache, createOwnedMemo } from "./createOwnedCache";

export interface IGetDataCache {
	resolve(key: string, fromId: string | undefined): unknown;
	resolveGlobal(key: string): unknown;
	dispose(): void;
}

export function createGetDataCache(deps: {
	onDispose: (callback: (id: string) => void) => void;
	resolveData: (key: string, fromId: string | undefined) => unknown;
	resolveGlobalData: (key: string) => unknown;
	report?: IDiagEmitter;
}): IGetDataCache {
	const scoped = createOwnedBucketCache<string, IOwnedMemo<unknown>>(deps.report);
	// A separate store, not a sentinel owner inside `scoped`: an anchor with no
	// id already occupies the empty-string owner there, and the two populations
	// must not share a slot.
	const global = createOwnedBucketCache<string, IOwnedMemo<unknown>>(deps.report);

	function resolve(key: string, fromId: string | undefined): unknown {
		const owner = fromId ?? "";
		let memo = scoped.get(owner, key);
		if (!memo) {
			memo = createOwnedMemo(() => deps.resolveData(key, fromId));
			scoped.set(owner, key, memo);
		}
		return memo.read();
	}

	function resolveGlobal(key: string): unknown {
		let memo = global.get("", key);
		if (!memo) {
			memo = createOwnedMemo(() => deps.resolveGlobalData(key));
			global.set("", key, memo);
		}
		return memo.read();
	}

	deps.onDispose((id) => scoped.sweep(id));

	function dispose() {
		scoped.disposeAll();
		global.disposeAll();
	}

	return {
		resolve,
		resolveGlobal,
		dispose
	};
}
