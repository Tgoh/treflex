import type { IRecord, IRecordExtras, IRecordRoot, IRecordTapListener } from "../Types/IRecord";
import { callbackThrew, consoleDiag, type IDiagEmitter } from "../Types/IRuntimeEvent";
import { syncCall } from "./effectDeclarations";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/journal": IJournal;
	}
}

// A plain Omit over the record union would collapse it to the shared keys
// (Seq, Kind) and lose every variant's own fields; the conditional type
// distributes so each variant keeps its shape minus Seq.
export type IJournalAppend<R = IRecord> = R extends IRecord ? Omit<R, "Seq"> : never;

type IActionJournalAppend<R = IRecord> = R extends IRecord ? Omit<R, "Seq" | "Root"> : never;

export type IRecordKind = IRecord["Kind"];

const ACTION_KINDS = [
	"action:start",
	"step",
	"effect",
	"response",
	"branch:start",
	"branch:end",
	"action:end"
] as const satisfies readonly IRecordKind[];

/** The kinds an action makes as it runs, which it samples once at its dispatch. */
export type IActionRecordKind = (typeof ACTION_KINDS)[number];

export type IJournalSample = Readonly<Record<IActionRecordKind, boolean>>;

export interface IActionJournal {
	append(record: IActionJournalAppend, live?: IRecordExtras): number;
}

export function withRoot(journal: IJournal, root: IRecordRoot): IActionJournal {
	return {
		append: (record, live) =>
			journal.append(
				{
					...record,
					Root: root
				} as IJournalAppend,
				live
			)
	};
}

export interface IJournal {
	/** Whether any tap is attached. */
	readonly enabled: boolean;
	/** Whether any tap takes `kind`. */
	wants(kind: IRecordKind): boolean;
	/** Which of an action's own kinds a tap takes, now. */
	sample(): IJournalSample;
	append(record: IJournalAppend, live?: IRecordExtras): number;
	/** Returns an unsubscribe function. With `kinds`, the tap hears only those. */
	tap(listener: IRecordTapListener, kinds?: readonly IRecordKind[]): () => void;
}

interface ITap {
	listener: IRecordTapListener;
	kinds: ReadonlySet<IRecordKind> | null;
}

function sampleOf(wants: (kind: IRecordKind) => boolean): IJournalSample {
	const sample = {} as Record<IActionRecordKind, boolean>;
	for (const kind of ACTION_KINDS) {
		sample[kind] = wants(kind);
	}
	return Object.freeze(sample);
}

const NONE = sampleOf(() => false);
const ALL = sampleOf(() => true);

/** `report` hears a tap's throw, which stops only that tap. */
export function createJournal(report: IDiagEmitter = consoleDiag): IJournal {
	// Copy-on-write, so an in-flight notification walks a stable array.
	let taps: ITap[] = [];
	let unfiltered = 0;
	const counts = new Map<IRecordKind, number>();
	let sample: IJournalSample = NONE;
	let seq = 0;

	function wants(kind: IRecordKind): boolean {
		return unfiltered > 0 || counts.has(kind);
	}

	function count(entry: ITap, by: 1 | -1): void {
		if (entry.kinds === null) {
			unfiltered += by;
		} else {
			for (const kind of entry.kinds) {
				const next = (counts.get(kind) ?? 0) + by;
				if (next === 0) {
					counts.delete(kind);
				} else {
					counts.set(kind, next);
				}
			}
		}
		sample = unfiltered > 0 ? ALL : counts.size === 0 ? NONE : sampleOf(wants);
	}

	function tap(listener: IRecordTapListener, kinds?: readonly IRecordKind[]): () => void {
		const entry: ITap = {
			listener,
			kinds: kinds === undefined ? null : new Set(kinds)
		};
		taps = [
			...taps,
			entry
		];
		count(entry, 1);
		return () => {
			const idx = taps.indexOf(entry);
			if (idx < 0) {
				return;
			}
			taps = taps.slice(0, idx).concat(taps.slice(idx + 1));
			count(entry, -1);
		};
	}

	function append(record: IJournalAppend, extras?: IRecordExtras): number {
		const stamped = record as IRecord;
		(
			stamped as {
				Seq: number;
			}
		).Seq = ++seq;
		// A sync effect's implementation can append, and a tap is not its work: a tap's
		// dispatch would otherwise fail the effect it is only watching.
		syncCall.outside(() => {
			for (const entry of taps) {
				if (entry.kinds !== null && !entry.kinds.has(stamped.Kind)) {
					continue;
				}
				try {
					entry.listener(stamped, extras);
				} catch (error) {
					report(
						callbackThrew("A record tap", error, {
							kind: stamped.Kind
						})
					);
				}
			}
		});
		return stamped.Seq;
	}

	return {
		get enabled() {
			return taps.length > 0;
		},
		wants,
		sample: () => sample,
		append,
		tap
	};
}
