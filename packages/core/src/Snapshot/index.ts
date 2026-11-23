// Re-exports no declaration-merge target: application augmentations stay
// `declare module "treflex"` blocks, and nothing may write
// `declare module "treflex/snapshot"`.

import type { IRuntimeOptions } from "../Runtime/createRuntime";
import type { IEffectStub, ITestRuntimeOptions } from "../Testing/createTestRuntime";
import type { IRestored, IRestoreHooks } from "./restore";
import { createRuntime } from "../Runtime/createRuntime";
import { buildTestRuntime, testRuntimeSite } from "../Testing/createTestRuntime";
import { restoreWith } from "./restore";

export type {
	IChangedState,
	IDataOnlyComparison,
	IDataOnlyRun,
	IDiagCount,
	IDiagSummary,
	IDifferences,
	IDifferentialDispatch,
	IDifferentialOptions,
	IDifferentialReport,
	IDifferentialSettle,
	IDifferentialSkip,
	IDifferentialStep,
	IDifferentialTarget,
	IEventDifference,
	IFailureSummary,
	IHeldSummary,
	IInFlightSummary,
	IOnErrorSummary,
	IRestorePoint,
	ISettleMatch,
	ISettleOutcome,
	IStateDifference,
	IUnfinished
} from "./differentialRestore";
export type { ISnapshot, ISnapshotInFlightEntry, ISnapshotInFlightState, ISnapshotTimerRow } from "./ISnapshot";
export type { IDropReason, IRestoreDrop, IRestoreResult, IRestoreResumed, IRestoreUnresolvedRow } from "./loadSnapshot";
export type { IRestored, IRestoreHooks, IRestoreOutcome } from "./restore";
export { createSnapshot, SnapshotOfDisposedRuntimeError, SnapshotTooDeepError } from "./createSnapshot";
export { differentialRestore, dispatchStep, settleStep } from "./differentialRestore";
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
	const site = testRuntimeSite("restoreTestRuntime", restoreTestRuntime);
	return restoreWith(snapshotJson, (state: T) => buildTestRuntime(state, boot.effectStubs ?? {}, boot.options, site), boot);
}
