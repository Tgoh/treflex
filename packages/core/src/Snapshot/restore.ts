import type { IRuntime } from "../Runtime/createRuntime";
import type { IRuntimeInternal } from "../Runtime/internals";
import type { IDiagEmitter } from "../Types/IRuntimeEvent";
import type { IInFlightListing, IRestoreResult } from "./loadSnapshot";
import { host } from "../Reactive/host";
import { resumeAtRestore } from "../Resume/restoreStage";
import { errorClass } from "../Utility/errorClasses";
import {
	gateSnapshot,
	listedInFlight,
	loadTables,
	reportUnresolved,
	SnapshotRejectedError,
	savedBuildOf,
	unresolvedReceivers
} from "./loadSnapshot";

export interface IRestoreHooks<T extends object> {
	/** The `$Id` of the app's own root. A snapshot whose root differs rejects with `SnapshotRejectedError`. */
	rootId: string;
	/**
	 * Startup registration, the same function a fresh boot calls on the runtime it builds. Runs
	 * after the tables load and before anything connects. Synchronous: no other code may see the
	 * runtime before the call returns, and one that returns a promise rejects with
	 * `AsyncSetupError`. A throw rejects the restore with that error.
	 */
	setup?: (runtime: IRuntime<T>) => void;
	/**
	 * Runs after setup, with every resource paused until its promise settles. A throw does not
	 * reject the restore: it rides the result as `repairError`.
	 */
	repair?: (runtime: IRuntime<T>, result: IRestoreResult) => unknown;
}

export type IRestoreOutcome = IRestoreResult & {
	repairError?: unknown;
};

export interface IRestored<T extends object> {
	runtime: IRuntime<T>;
	result: IRestoreOutcome;
}

export class AsyncSetupError extends Error {
	constructor() {
		super(
			"[treflex] restore: setup returned a promise. It has to register synchronously, so load code-split " +
				"registration before restoring."
		);
		this.name = "AsyncSetupError";
	}
}

errorClass("treflex/AsyncSetupError", AsyncSetupError);

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
	typeof (value as PromiseLike<unknown> | null | undefined)?.then === "function";

const STILL_PAUSED_MS = 3000;

const rejected = (error: unknown) =>
	new SnapshotRejectedError(`[treflex] restore: the snapshot did not load — ${String(error)}. Discard it and boot fresh.`, {
		cause: error
	});

/** `build` is always treflex's own, `createRuntime` or `createTestRuntime`: no app code builds the runtime a restore loads into. */
export async function restoreWith<T extends object>(
	snapshotJson: string,
	build: (state: T) => IRuntime<T>,
	boot: IRestoreHooks<T>
): Promise<IRestored<T>> {
	if (typeof boot.rootId !== "string" || boot.rootId === "") {
		throw new TypeError(`[treflex] restore: rootId has to be the app's root $Id, a non-empty string, not ${String(boot.rootId)}.`);
	}
	if (typeof snapshotJson !== "string") {
		throw new TypeError(
			`[treflex] restore: the snapshot has to be the string createSnapshot returned, not ${snapshotJson === null ? "null" : typeof snapshotJson}.`
		);
	}
	const snapshot = gateSnapshot(snapshotJson);
	const rootId = (
		snapshot.AppState as {
			$Id: string;
		}
	).$Id;
	if (rootId !== boot.rootId) {
		throw new SnapshotRejectedError(
			`[treflex] restore: the snapshot's root is "${rootId}", and this app's is "${boot.rootId}". Discard the snapshot and boot fresh.`
		);
	}
	let runtime: IRuntimeInternal<T> | undefined;
	// Held back until setup has run, so a diag listener it attaches hears the load's.
	const loadDiags: Parameters<IDiagEmitter>[0][] = [];
	let emitted = false;
	const emitLoadDiags = () => {
		if (emitted) {
			return;
		}
		emitted = true;
		for (const event of loadDiags) {
			runtime!.emitDiag(event);
		}
	};
	let restored = false;
	try {
		const outcome = await host.untrack(() => {
			const built = build(snapshot.AppState as T) as IRuntimeInternal<T>;
			runtime = built;
			return restoreInto(built, snapshot, boot, loadDiags, emitLoadDiags);
		});
		restored = true;
		return outcome;
	} catch (error) {
		if (runtime !== undefined) {
			try {
				emitLoadDiags();
			} catch {}
		}
		throw error;
	} finally {
		if (!restored) {
			runtime?.dispose();
		}
	}
}

async function restoreInto<T extends object>(
	runtime: IRuntimeInternal<T>,
	snapshot: ReturnType<typeof gateSnapshot>,
	boot: IRestoreHooks<T>,
	loadDiags: Parameters<IDiagEmitter>[0][],
	emitLoadDiags: () => void
): Promise<IRestored<T>> {
	let sweptOrphanedRows: number;
	try {
		if (boot.repair) {
			runtime.get("runtime/resources").pause();
		}
		sweptOrphanedRows = loadTables(runtime.get, snapshot, (event) => loadDiags.push(event));
	} catch (error) {
		throw rejected(error);
	}
	const resuming = runtime.get("runtime/resume") !== null;
	const loaded = new Map<string, string>();
	if (resuming) {
		const gateway = runtime.get("runtime/writeGateway");
		for (const row of snapshot.InFlight) {
			if (!loaded.has(row.EntityId)) {
				loaded.set(row.EntityId, JSON.stringify(gateway.cellOf(row.EntityId)));
			}
		}
	}
	const returned: unknown = boot.setup?.(runtime);
	if (isThenable(returned)) {
		returned.then(undefined, () => {});
		throw new AsyncSetupError();
	}
	emitLoadDiags();
	let listed: IInFlightListing[];
	let base: Omit<IRestoreResult, "resumed" | "dropped">;
	try {
		const savedBuild = savedBuildOf(snapshot);
		const runtimeBuild = runtime.get("runtime/build");
		listed = listedInFlight(snapshot);
		base = {
			unresolved: unresolvedReceivers(runtime.get),
			sweptOrphanedRows,
			savedBuild,
			sameBuild: savedBuild !== null && runtimeBuild !== null && savedBuild === runtimeBuild
		};
	} catch (error) {
		throw rejected(error);
	}
	reportUnresolved(base.unresolved, runtime.emitDiag);
	const stage = resuming ? resumeAtRestore(runtime, snapshot, listed, base.sameBuild, loaded) : null;
	const result: IRestoreResult = {
		resumed: stage?.resumed ?? [],
		dropped:
			stage?.dropped ??
			listed.map((row) => ({
				...row,
				reason: "resume-off"
			})),
		...base
	};
	const repair = boot.repair;
	if (!repair) {
		stage?.release();
		return {
			runtime,
			result
		};
	}
	const resources = runtime.get("runtime/resources");
	// A cell's status lags its row by a manager drain, and the repair reads the rows as paused.
	await resources.drained();
	const stillPaused = resources.permanentlyPaused
		? undefined
		: setTimeout(() => {
				runtime.emitDiag({
					severity: "warn",
					code: "resource/still-paused",
					message:
						`[treflex] restore: the repair "${repair.name || "(anonymous)"}" has not settled ${STILL_PAUSED_MS}ms after ` +
						`the load, and every resource stays paused until it does.`,
					data: {
						repair: repair.name || null
					}
				});
			}, STILL_PAUSED_MS);
	let repairError: unknown;
	let repairFailed = false;
	try {
		await repair(runtime, result);
	} catch (error) {
		repairFailed = true;
		repairError = error;
	} finally {
		clearTimeout(stillPaused);
	}
	stage?.release();
	resources.resume();
	await resources.drained();
	return {
		runtime,
		result: repairFailed
			? {
					...result,
					repairError
				}
			: result
	};
}
