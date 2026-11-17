import type { IRecord } from "../Types/IRecord";
import type { IRecordKind } from "./createJournal";
import type { IRuntime } from "./createRuntime";
import type { IRuntimeInternal } from "./internals";

declare module "../Registries/IExternalRegistry" {
	interface IExternalRegistry {
		ActivityLog: readonly IActivityLogEntry[];
	}
}

/** One record the activity log kept. See docs/reference/restart-and-records.md#the-activity-log. */
export interface IActivityLogEntry {
	/** The log's own count, from 1. */
	readonly Seq: number;
	readonly Kind: IRecord["Kind"];
	/** Epoch milliseconds when the log took the record. */
	readonly Time: number;
	/** The record, with a `branch:end`'s `Error` left out and an `undefined` argument given as `null`. */
	readonly Data: unknown;
}

export interface IActivityLogOptions {
	/** How many entries the log keeps. 200 by default. */
	cap?: number;
}

const DEFAULT_CAP = 200;

// Never step: an action's read of the log lands the log on its step record, so
// a log of steps would hold itself.
const CAPTURED: readonly IRecordKind[] = [
	"action:start",
	"action:end",
	"branch:start",
	"branch:end",
	"entity:dispose",
	"message:deliver"
];

// A rejection's fields can hold what a redacted effect carried, and any
// selector can read the log. An undefined array element isn't plain data,
// so an action's copy of the log would refuse it.
function loggedForm(record: IRecord): unknown {
	if (record.Kind === "branch:end" && record.Error !== undefined) {
		const { Error: _withheld, ...kept } = record;
		return kept;
	}
	if (record.Kind === "action:start" && record.Args.includes(undefined)) {
		return {
			...record,
			Args: record.Args.map((arg) => (arg === undefined ? null : arg))
		};
	}
	return record;
}

/**
 * Taps `runtime`'s records and provides them under the key `ActivityLog`, newest first. Returns the
 * function that stops the tap, after which the key keeps its last value. See
 * docs/reference/restart-and-records.md#the-activity-log.
 */
export function createActivityLog<T extends object>(runtime: IRuntime<T>, options?: IActivityLogOptions): () => void {
	const cap = options?.cap ?? DEFAULT_CAP;
	let entries: readonly IActivityLogEntry[] = Object.freeze([]);
	let seq = 0;
	let stop = (): void => {};
	// The table's own provide: the development plain-data check would walk the whole log on each append.
	const externals = (runtime as IRuntimeInternal<T>).get("runtime/externals");
	externals.provide(
		"ActivityLog",
		{
			read: () => entries,
			// The tap starts here, so a provider replacing this one or the runtime's dispose stops it.
			subscribe: (changed) => {
				stop = runtime.on(
					"record",
					(record) => {
						const entry: IActivityLogEntry = Object.freeze({
							Seq: ++seq,
							Kind: record.Kind,
							Time: Date.now(),
							Data: loggedForm(record)
						});
						entries = Object.freeze(
							[
								entry,
								...entries
							].slice(0, cap)
						);
						changed();
					},
					{
						kinds: CAPTURED
					}
				);
				return stop;
			}
		},
		{
			plainByConstruction: true
		}
	);
	return () => stop();
}
