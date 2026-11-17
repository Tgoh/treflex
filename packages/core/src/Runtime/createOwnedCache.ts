import type { IOwnedMemo } from "../Solid/host";
import { host } from "../Solid/host";
import { callbackThrew, consoleDiag, type IDiagEmitter } from "../Types/IRuntimeEvent";

export type { IOwnedMemo };

export function createOwnedMemo<T>(compute: () => T): IOwnedMemo<T> {
	return host.createOwnedMemo(compute);
}

export interface IOwnedBucketCache<
	TKey,
	TEntry extends {
		dispose: () => void;
	}
> {
	get: (owner: string, key: TKey) => TEntry | undefined;
	set: (owner: string, key: TKey, entry: TEntry) => void;
	sweep: (owner: string) => void;
	disposeAll: () => void;
}

export function createOwnedBucketCache<
	TKey,
	TEntry extends {
		dispose: () => void;
	}
>(report: IDiagEmitter = consoleDiag): IOwnedBucketCache<TKey, TEntry> {
	const buckets = new Map<string, Map<TKey, TEntry>>();

	function disposeBucket(owner: string, bucket: Map<TKey, TEntry>): void {
		for (const entry of bucket.values()) {
			try {
				entry.dispose();
			} catch (error) {
				report(
					callbackThrew(`A cached read's dispose under "${owner}"`, error, {
						ownerId: owner
					})
				);
			}
		}
	}

	function sweep(owner: string): void {
		const bucket = buckets.get(owner);
		if (!bucket) {
			return;
		}
		disposeBucket(owner, bucket);
		buckets.delete(owner);
	}

	function get(owner: string, key: TKey): TEntry | undefined {
		return buckets.get(owner)?.get(key);
	}

	function set(owner: string, key: TKey, entry: TEntry): void {
		let bucket = buckets.get(owner);
		if (!bucket) {
			bucket = new Map();
			buckets.set(owner, bucket);
		}
		bucket.set(key, entry);
	}

	function disposeAll(): void {
		for (const [owner, bucket] of buckets) {
			disposeBucket(owner, bucket);
		}
		buckets.clear();
	}

	return {
		get,
		set,
		sweep,
		disposeAll
	};
}
