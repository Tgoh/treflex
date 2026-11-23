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
	readonly asking: boolean;
	append(record: IActionJournalAppend, live?: IRecordExtras): number;
}

export function withRoot(journal: IJournal, root: IRecordRoot): IActionJournal {
	return {
		get asking() {
			return journal.asking;
		},
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
	/** Whether a tap that takes `step` asks for `Landing`, now. */
	readonly asking: boolean;
	append(record: IJournalAppend, live?: IRecordExtras): number;
	/**
	 * Returns an unsubscribe function. With `kinds`, the tap hears only those. With `landing`, a tap that
	 * takes `step` asks for `Landing`.
	 */
	tap(listener: IRecordTapListener, kinds?: readonly IRecordKind[], landing?: boolean): () => void;
}

interface ITap {
	listener: IRecordTapListener;
	kinds: ReadonlySet<IRecordKind> | null;
	landing: boolean;
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

/** The runtime's own journal, with the switch resume's engine mutes it with. Not exported from the package. */
export interface IMutableJournal extends IJournal {
	/** Makes `append` deliver nothing, stamp no `Seq` and return 0, until the returned function is called. */
	mute(): () => void;
}

/** `report` hears a tap's throw, which stops only that tap. */
export function createJournal(report: IDiagEmitter = consoleDiag): IMutableJournal {
	// Copy-on-write, so an in-flight notification walks a stable array.
	let taps: ITap[] = [];
	let unfiltered = 0;
	let asking = 0;
	const counts = new Map<IRecordKind, number>();
	let sample: IJournalSample = NONE;
	let seq = 0;
	let muted = 0;

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
		if (entry.landing) {
			asking += by;
		}
		sample = unfiltered > 0 ? ALL : counts.size === 0 ? NONE : sampleOf(wants);
	}

	function tap(listener: IRecordTapListener, kinds?: readonly IRecordKind[], landing = false): () => void {
		const taken = kinds === undefined ? null : new Set(kinds);
		const entry: ITap = {
			listener,
			kinds: taken,
			landing: landing && (taken === null || taken.has("step"))
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
		if (muted > 0) {
			return 0;
		}
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
		get asking() {
			return asking > 0;
		},
		wants,
		sample: () => sample,
		append,
		mute() {
			muted++;
			let lifted = false;
			return () => {
				if (!lifted) {
					lifted = true;
					muted--;
				}
			};
		},
		tap
	};
}
