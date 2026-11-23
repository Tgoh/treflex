import type { IMirror, IOutsideGraph, IOwnedMemo, IReactiveHost, IVersion } from "./IReactiveHost";
import { DEV } from "../Utility/devMode";
import { batch, createComputation, isTracking, onCleanup, runUnowned, Signal, trackedReads, untrack } from "./engine";

export type { IMirror, IOutsideGraph, IOwnedMemo, IReactiveHost, IVersion } from "./IReactiveHost";

export interface ISharedHost extends IReactiveHost {
	readonly contract: number;
	registerOutsideGraph(graph: IOutsideGraph): boolean;
}

type IComputed<T> =
	| {
			failed?: undefined;
			value: T;
	  }
	| {
			failed: true;
			error: unknown;
	  };

const KEY = Symbol.for("treflex.host.v1");
const CONTRACT = 1;

let graph: IOutsideGraph | null = null;

class Version extends Signal<number> implements IVersion {
	mirror: IMirror | null = null;

	constructor() {
		super(0, false);
	}

	track(): void {
		this.read();
		if (graph?.isReading()) {
			if (this.mirror === null) {
				this.mirror = graph.createMirror();
			}
			this.mirror.track();
		}
	}

	bump(): void {
		this.write(0);
		if (this.mirror !== null) {
			this.mirror.write();
		}
	}
}

const sameComputed = <T>(a: IComputed<T>, b: IComputed<T>): boolean => !a.failed && !b.failed && a.value === b.value;

function computeBoxed<T>(compute: () => T): IComputed<T> {
	try {
		return {
			value: compute()
		};
	} catch (error) {
		return {
			failed: true,
			error
		};
	}
}

function isTrackingOrReading(): boolean {
	return isTracking() || graph!.isReading();
}

function untrackBoth<T>(fn: () => T): T {
	const outside = graph!;
	return untrack(() => outside.untrack(fn));
}

const own: ISharedHost = {
	contract: CONTRACT,
	createVersion: () => new Version(),
	isTracking,
	trackedReads,
	batch,
	untrack,
	createOwnedMemo<T>(compute: () => T): IOwnedMemo<T> {
		const node = createComputation<IComputed<T>>(
			() => (graph === null ? computeBoxed(compute) : graph.untrack(() => computeBoxed(compute))),
			sameComputed,
			true
		);
		let mirror: IMirror | null = null;
		return {
			read: () => {
				if (graph?.isReading()) {
					if (mirror === null) {
						const made = graph.createMirror();
						mirror = made;
						node.onChange = () => made.write();
					}
					mirror.track();
				}
				const computed = node.read();
				if (computed.failed) {
					throw computed.error;
				}
				return computed.value;
			},
			dispose: () => {
				node.onChange = null;
				node.dispose();
			}
		};
	},
	runUnowned,
	onCleanup,
	TRACK: Symbol("treflex-track"),
	// Swaps plain properties rather than deciding per call: the view proxy compares TRACK on every property read.
	registerOutsideGraph(next) {
		if (graph !== null) {
			return graph.TRACK === next.TRACK;
		}
		graph = next;
		own.isTracking = isTrackingOrReading;
		own.untrack = untrackBoth;
		own.TRACK = next.TRACK;
		return true;
	}
};

// Every copy of core runs on the host the first copy put here, engine included: with an engine each, a runtime made
// by one copy and read through another would hear none of its writes.
function shared(): ISharedHost {
	const slot = globalThis as unknown as Record<symbol, ISharedHost | undefined>;
	const existing = slot[KEY];
	if (existing === undefined) {
		slot[KEY] = own;
		return own;
	}
	if (existing.contract === CONTRACT) {
		return existing;
	}
	if (DEV) {
		console.warn(
			`[treflex] Another copy of treflex is loaded, on reactive contract ${existing.contract} where this copy is on ${CONTRACT}, so ` +
				"this copy runs an engine of its own: a runtime made by one copy and read through the other won't hear its writes. " +
				"Dedupe treflex so the app loads one copy."
		);
	}
	return own;
}

export const host: ISharedHost = shared();

/**
 * Bridges an outside graph's computations into the engine. Answers whether `graph` holds the seam after the call:
 * `true` for the first registration or a graph with the same `TRACK`, `false` when a graph with another holds it.
 */
export function registerOutsideGraph(graph: IOutsideGraph): boolean {
	return host.registerOutsideGraph(graph);
}
