import type { ISelector } from "../Types/ISelector";
import type { IDiagService } from "./createDiagService";
import type { IOwnedMemo } from "./createOwnedCache";
import type { IReadHandler } from "./processSelector";
import { host } from "../Reactive/host";
import { DEV } from "../Utility/devMode";
import { createOwnedBucketCache, createOwnedMemo } from "./createOwnedCache";
import { processSelector } from "./processSelector";

const MANY_TRACKED_READS = 50_000;

export interface ISelectorCache {
	// `view` caches an untracked read too: a binding reads in render and wants the
	// memo's stable reference, not a fresh result.
	runSelector(
		selector: ISelector<any, any>,
		getState: () => unknown,
		accessor: ((s: unknown) => unknown) | undefined,
		view: boolean
	): unknown;
}

export function createSelectorCache(deps: {
	onDispose: (callback: (id: string) => void) => void;
	processRead: IReadHandler;
	diag: IDiagService;
	// The entity's present state, read tracked, or undefined for an id nothing serves.
	stateOf: (entityId: string) => unknown;
}): ISelectorCache {
	const { processRead, diag, stateOf } = deps;
	const cache = createOwnedBucketCache<ISelector<any, any>, IOwnedMemo<unknown>>(diag.emit);
	deps.onDispose((id) => cache.sweep(id));
	const reported = new WeakSet<ISelector<any, any>>();

	function reportTrackedReads(selector: ISelector<any, any>): void {
		const trackedReads = host.trackedReads();
		if (trackedReads <= MANY_TRACKED_READS || reported.has(selector)) {
			return;
		}
		reported.add(selector);
		const label = selector.name || "(anonymous)";
		// The memo is still listening, and a diag subscriber's reads aren't the selector's.
		host.untrack(() =>
			diag.emit({
				severity: "warn",
				code: "selector/many-tracked-reads",
				message:
					`[treflex] Selector "${label}" tracked ${trackedReads} reads in one run, so a change to any of them re-runs the whole of it. ` +
					`Read less per run, or derive per row with a selector on each row, which is memoized per entity.`,
				data: {
					selector: label,
					trackedReads
				}
			})
		);
	}

	function buildMemo(
		selector: ISelector<any, any>,
		entityId: string,
		getState: () => unknown,
		accessor: ((s: unknown) => unknown) | undefined
	): IOwnedMemo<unknown> {
		// By id, not through the creating caller's path: the memo is shared by every
		// reader of the entity, and that caller's path can come to lead to another one.
		// The path serves only an id the runtime does not index.
		const slice = () => stateOf(entityId) ?? (accessor ? accessor(getState()) : getState());
		return createOwnedMemo(() => {
			const value = processSelector(selector, slice, undefined, processRead);
			if (DEV) {
				reportTrackedReads(selector);
			}
			return value;
		});
	}

	function runSelector(
		selector: ISelector<any, any>,
		getState: () => unknown,
		accessor: ((s: unknown) => unknown) | undefined,
		view: boolean
	): unknown {
		const state = getState();
		const slice = accessor ? accessor(state) : state;
		const entityId = (
			slice as
				| {
						$Id?: string;
				  }
				| undefined
		)?.$Id;

		if (!entityId) {
			return processSelector(selector, getState, accessor, processRead);
		}

		let memo = cache.get(entityId, selector);
		if (!view && !host.isTracking()) {
			return memo ? memo.read() : processSelector(selector, getState, accessor, processRead);
		}
		if (!memo) {
			memo = buildMemo(selector, entityId, getState, accessor);
			cache.set(entityId, selector, memo);
		}
		return memo.read();
	}

	return {
		runSelector
	};
}
