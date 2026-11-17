// Re-exports no declaration-merge target: application augmentations stay
// `declare module "treflex"` blocks, and nothing may write
// `declare module "treflex/snapshot"`.

import type { IRuntimeOptions } from "../Runtime/createRuntime";
import type { IEffectStub, ITestRuntimeOptions } from "../Testing/createTestRuntime";
import type { IRestored, IRestoreHooks } from "./restore";
import { createRuntime } from "../Runtime/createRuntime";
import { createTestRuntime } from "../Testing/createTestRuntime";
import { restoreWith } from "./restore";

export type { ISnapshot, ISnapshotInFlightEntry, ISnapshotTimerRow } from "./ISnapshot";
export type { IRestoreDrop, IRestoreResult, IRestoreUnresolvedRow } from "./loadSnapshot";
export type { IRestored, IRestoreHooks, IRestoreOutcome } from "./restore";
export { createSnapshot, SnapshotOfDisposedRuntimeError, SnapshotTooDeepError } from "./createSnapshot";
export { SNAPSHOT_FORMAT_VERSION } from "./ISnapshot";
export { SnapshotRejectedError } from "./loadSnapshot";
export { AsyncSetupError } from "./restore";

export interface IRestoreBoot<T extends object> extends IRestoreHooks<T> {
	/** The options a fresh boot passes `createRuntime`. The runtime is built from them over the snapshot's tree. */
	options: IRuntimeOptions;
}

/**
 * Builds a runtime from a createSnapshot envelope. Rejects with `SnapshotRejectedError` when the
 * envelope cannot become a runtime; the caller discards it and boots fresh.
 */
export function restoreRuntime<T extends object>(snapshotJson: string, boot: IRestoreBoot<T>): Promise<IRestored<T>> {
	return restoreWith(snapshotJson, (state: T) => createRuntime(state, boot.options), boot);
}

export interface ITestRestoreBoot<T extends object> extends IRestoreHooks<T> {
	/** The effect stubs a fresh test boot passes `createTestRuntime`. */
	effectStubs?: Record<string, IEffectStub> | undefined;
	/** The options a fresh test boot passes `createTestRuntime`, its other stubs included. */
	options?: ITestRuntimeOptions | undefined;
}

/** `restoreRuntime` for a test: builds what `createTestRuntime` does from the same stubs and options. */
export function restoreTestRuntime<T extends object>(snapshotJson: string, boot: ITestRestoreBoot<T>): Promise<IRestored<T>> {
	return restoreWith(snapshotJson, (state: T) => createTestRuntime(state, boot.effectStubs, boot.options), boot);
}
