import type { IRuntime, IRuntimeEventOf } from "../../src/index";
import type { IWithResume } from "../../src/Resume/createKeeper";
import type { ISnapshotHistory } from "../../src/Resume/history";
import type { IResumeOutcome } from "../../src/Resume/resume";
import type { IRuntimeOptions } from "../../src/Runtime/createRuntime";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { ISnapshotInFlightEntry } from "../../src/Snapshot/ISnapshot";
import type { IRecord } from "../../src/Types/IRecord";
import type { IWaiting } from "./resumeHarness";
import { resumeInFlight } from "../../src/Resume/resume";
import { restoreRuntime } from "../../src/Snapshot/index";

/** An effect type the tests never declare idempotent, with the same implementation as `Resume/Wait`. */
export const PAY = "Resume/Pay";

/** An effect type whose implementation throws its `Name` synchronously. */
export const BOOM = "Resume/Boom";

/** Registers `Resume/Wait` and `Resume/Pay`, each a wait the test answers by its `Name`, and `Resume/Boom`. */
export function registerWaits(runtime: IRuntime<any>, waiting: IWaiting[]): void {
	runtime.registerImplementation(BOOM, (effect) => {
		throw new Error(
			(
				effect as unknown as {
					Name: string;
				}
			).Name
		);
	});
	for (const type of [
		"Resume/Wait",
		PAY
	]) {
		runtime.registerImplementation(
			type,
			(effect) =>
				new Promise((resolve, reject) => {
					waiting.push({
						name: (
							effect as unknown as {
								Name: string;
							}
						).Name,
						resolve,
						reject
					});
				})
		);
	}
}

export interface IEnvelope {
	Build: string | null;
	AppState: unknown;
	InFlight: ISnapshotInFlightEntry[];
	Histories?: ISnapshotHistory[];
}

export interface IRestoredRun<T extends object> {
	runtime: IRuntime<T>;
	internal: IRuntimeInternal<T>;
	envelope: IEnvelope;
	waiting: IWaiting[];
	diags: IRuntimeEventOf<"diag">[];
	failures: IRuntimeEventOf<"failure">[];
	records: IRecord[];
	onError: unknown[];
	release(name: string, value?: unknown): void;
	fail(name: string, error: unknown): void;
}

export interface IRestoreOptions {
	resume?: boolean;
	build?: string;
	implementations?: IRuntimeOptions["implementations"];
	setup?: (runtime: IRuntime<any>) => void;
}

/**
 * Restores `json` into a runtime with `resume` on and the harness's `Resume/Wait` effect, and starts
 * recording what it delivers. The restore is given the envelope without its in-flight rows and
 * histories, so its own resume stage finds nothing and the test runs the engine on `envelope`.
 */
export async function restoreWithResume<T extends object>(
	json: string,
	rootId: string,
	options: IRestoreOptions = {}
): Promise<IRestoredRun<T>> {
	const waiting: IWaiting[] = [];
	const diags: IRuntimeEventOf<"diag">[] = [];
	const failures: IRuntimeEventOf<"failure">[] = [];
	const records: IRecord[] = [];
	const onError: unknown[] = [];
	const { Histories: _histories, ...rest } = JSON.parse(json) as IEnvelope;
	const { runtime } = await restoreRuntime<T>(
		JSON.stringify({
			...rest,
			InFlight: []
		}),
		{
			rootId,
			options: {
				verifyIndex: "always",
				build: options.build ?? "test",
				...(options.resume === false
					? {}
					: {
							resume: true
						}),
				implementations: options.implementations,
				onError: (error: unknown) => {
					onError.push(error);
				}
			} as IRuntimeOptions & IWithResume,
			setup: (restored) => {
				restored.on("diag", (event) => {
					diags.push(event);
				});
				restored.on("failure", (event) => {
					failures.push(event);
				});
				restored.on("record", (record) => {
					records.push(record);
				});
				registerWaits(restored, waiting);
				options.setup?.(restored);
			}
		}
	);
	const take = (name: string): IWaiting => {
		const at = waiting.findIndex((wait) => wait.name === name);
		if (at < 0) {
			throw new Error(`nothing waits on ${name}: ${waiting.map((wait) => wait.name).join(", ")}`);
		}
		return waiting.splice(at, 1)[0]!;
	};
	return {
		runtime,
		internal: runtime as IRuntimeInternal<T>,
		envelope: JSON.parse(json) as IEnvelope,
		waiting,
		diags,
		failures,
		records,
		onError,
		release: (name, value) => take(name).resolve(value),
		fail: (name, error) => take(name).reject(error)
	};
}

export interface IEngineRun extends IResumeOutcome {
	/** What reached a tap while the engine ran. */
	during: IRecord[];
	diagsDuring: number;
}

/** Runs the engine on a restored run, with `isIdempotent` true for the types given. */
export function runEngine<T extends object>(
	run: IRestoredRun<T>,
	idempotent: readonly string[] = [
		"Resume/Wait"
	],
	sameBuild = true
): IEngineRun {
	const from = run.records.length;
	const diagsFrom = run.diags.length;
	const outcome = resumeInFlight(run.internal, {
		rows: run.envelope.InFlight,
		histories: run.envelope.Histories,
		sameBuild,
		isIdempotent: (type) => idempotent.includes(type)
	});
	outcome.deliver();
	return {
		...outcome,
		during: run.records.slice(from),
		diagsDuring: run.diags.length - diagsFrom
	};
}
