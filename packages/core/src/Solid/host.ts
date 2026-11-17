import { $TRACK, batch, createMemo, createRoot, createSignal, getListener, onCleanup, runWithOwner, untrack } from "solid-js";

export interface IVersion {
	track(): void;
	bump(): void;
}

export interface IOwnedMemo<T> {
	read: () => T;
	dispose: () => void;
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

export interface IReactiveHost {
	createVersion(): IVersion;
	isTracking(): boolean;
	// What the listening scope has read so far this run, a repeat counting again.
	trackedReads(): number;
	batch<T>(fn: () => T): T;
	untrack<T>(fn: () => T): T;
	// A memo in its own detached root. The computation runs eagerly at
	// construction (Solid's memo contract), but the first `read` belongs to
	// the caller, AFTER this returns — reading inside the root would run
	// with Listener = null, so a consuming reactive scope would never
	// subscribe. A compute that throws is held and rethrown to each reader:
	// thrown in the flush, it would reach the error handler of whoever first
	// built the memo, not the reader's.
	createOwnedMemo<T>(compute: () => T): IOwnedMemo<T>;
	runUnowned<T>(fn: () => T): T;
	onCleanup(fn: () => void): void;
	// The symbol a read proxy answers by tracking its whole shape.
	TRACK: symbol;
}

export const host: IReactiveHost = {
	createVersion() {
		const [read, write] = createSignal(0, {
			equals: false
		});
		return {
			track: () => {
				read();
			},
			bump: () => {
				write(0);
			}
		};
	},
	isTracking: () => getListener() !== null,
	trackedReads: () => getListener()?.sources?.length ?? 0,
	// Solid's batch discards its whole update queue when the callback throws,
	// leaving every observer of the writes made before the throw marked stale
	// and never re-run, so the throw is held until the batch has flushed. A
	// flush that throws as well cannot replace the held error: the caller gets
	// the callback's, and the flush's surfaces on its own. A flush error the
	// caller's error boundary absorbs makes Solid's batch return nothing, so
	// the result travels boxed and a missing box throws.
	batch<T>(fn: () => T): T {
		let failed = false;
		let error: unknown;
		let box:
			| {
					value: T;
			  }
			| undefined;
		try {
			box = batch(() => {
				try {
					return {
						value: fn()
					};
				} catch (e) {
					failed = true;
					error = e;
					return undefined;
				}
			});
		} catch (flushError) {
			if (!failed) {
				throw flushError;
			}
			queueMicrotask(() => {
				throw flushError;
			});
		}
		if (failed) {
			throw error;
		}
		if (box === undefined) {
			throw new Error(
				"[treflex] a reactive update threw while flushing this batch and an error boundary absorbed it, so the batch has no result to return."
			);
		}
		return box.value;
	},
	untrack,
	createOwnedMemo<T>(compute: () => T): IOwnedMemo<T> {
		let read!: () => IComputed<T>;
		const dispose = createRoot((d) => {
			read = createMemo(
				(): IComputed<T> => {
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
				},
				undefined,
				{
					equals: (a, b) => !a.failed && !b.failed && a.value === b.value
				}
			);
			return d;
		});
		return {
			read: () => {
				const computed = read();
				if (computed.failed) {
					throw computed.error;
				}
				return computed.value;
			},
			dispose
		};
	},
	runUnowned<T>(fn: () => T): T {
		return runWithOwner(null, fn) as T;
	},
	onCleanup,
	TRACK: $TRACK
};
