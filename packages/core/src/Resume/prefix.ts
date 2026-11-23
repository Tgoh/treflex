import type { IActionJournal } from "../Runtime/createJournal";
import type { IFiberSettleInput } from "../Runtime/fiberMachine";
import type { IInternalDispatch } from "../Runtime/processAction";
import type { IEffect } from "../Types/IEffect";
import type { IExternalAnswer, IRecord, IRecordChange, IRecordExtras } from "../Types/IRecord";
import type { IHistoryEntry } from "./history";
import type { IPrefix, IPrefixBinding, IReleaseWindow, ISettle } from "./IPrefix";
import type { IEntityRewind } from "./rewind";
import { isRedacted } from "../Runtime/effectDeclarations";
import { journalDescriptor } from "../Runtime/operations";
import { rebuildThrow } from "../Runtime/rebuildThrow";
import { jsonEquals } from "../Utility/jsonEquals";

// Kept out of `IPrefix.ts`, which `processAction.ts` imports: a module the entry points' declarations
// reach would make "runtime/prefixes" a service key to every consumer.
declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/prefixes": IPrefixSupport | null;
	}
}

/** What `createRuntime` gives the engine that runs prefixes. */
export interface IPrefixSupport {
	readonly dispatch: IInternalDispatch;
	/** Runs `dispatch`, during which a dispatch on this runtime from step code diverges `prefix` and starts nothing. */
	during(prefix: IPrefix, dispatch: () => void): void;
	/** Mutes the journal's append and the runtime's diag emitter until the returned function is called. */
	quiet(): () => void;
	/** `liveRuns` in `processAction.ts`. */
	liveRuns(action: Function, key: string): boolean;
	/** Sets what the public dispatch asks until the restore releases the held waits, or clears it with null. */
	window(given: IReleaseWindow | null): void;
}

/** A prefix as the engine drives it. */
export interface IPrefixRun extends IPrefix {
	readonly outcome: "running" | "handed-over" | "diverged";
	readonly detail: string | undefined;
	/** The divergence is for what the action itself does off the list, not for a step that differs from its record. */
	readonly ownDoing: boolean;
	/** The replayed action's own id, from its start. */
	readonly actionId: string | undefined;
	/** Takes the action out of the runtime after a divergence. */
	drop(): void;
	/** The engine has accepted the hand-over. */
	accept(): void;
	/** Delivers the action's start, with `ResumedFrom`, its id in the snapshot, then whatever it recorded since its hand-over. */
	announce(): void;
	/** Sends the held wait. */
	release(): void;
}

type IAppend = Parameters<IActionJournal["append"]>[0];

type IStepRecord = Extract<
	IRecord,
	{
		Kind: "step";
	}
>;

interface IHeldRecord {
	readonly record: IAppend;
	readonly live: IRecordExtras | undefined;
	readonly seq: number;
}

// Above any Seq a journal reaches, so a real ForSeq is never taken for a provisional one, and above 0,
// which the fiber machine reads as no effect record.
const PROVISIONAL = Number.MAX_SAFE_INTEGER - 2 ** 32;
const GATED = Number.MAX_SAFE_INTEGER - 2 ** 33;

/** An action's records, held from its arrival until `deliver`, which the stage calls once its start may be heard. */
export interface IRecordGate {
	wrap(inner: IActionJournal): IActionJournal;
	/** The id on the held `action:start`, once the action has arrived. */
	readonly actionId: string | undefined;
	/** Appends `first`, then every held record in order, those appended while it delivers included; from then on records pass straight through. Once. */
	deliver(first?: IAppend): void;
}

export function holdRecords(): IRecordGate {
	let inner: IActionJournal | null = null;
	let held: IHeldRecord[] | null = [];
	let delivered = false;
	let provisional = GATED;
	const real = new Map<number, number>();
	const mapped = (record: IAppend): IAppend => {
		const forSeq = (
			record as {
				ForSeq?: number;
			}
		).ForSeq;
		const to = forSeq === undefined ? undefined : real.get(forSeq);
		return to === undefined
			? record
			: ({
					...record,
					ForSeq: to
				} as IAppend);
	};
	return {
		get actionId() {
			const start = held?.find((entry) => entry.record.Kind === "action:start")?.record as
				| {
						ActionId?: string;
				  }
				| undefined;
			return start?.ActionId;
		},
		wrap(given) {
			inner = given;
			return {
				get asking() {
					return given.asking;
				},
				append(record, live) {
					if (held === null) {
						return given.append(mapped(record), live);
					}
					const seq = ++provisional;
					held.push({
						record,
						live,
						seq
					});
					return seq;
				}
			};
		},
		deliver(first) {
			if (delivered) {
				return;
			}
			delivered = true;
			const queued = held!;
			if (inner !== null) {
				if (first !== undefined) {
					inner.append(first);
				}
				// By index: a listener a delivered record reaches can make the action append again, and that record
				// joins the queue behind the ones still held.
				for (let at = 0; at < queued.length; at++) {
					const { record, live, seq } = queued[at]!;
					real.set(seq, inner.append(mapped(record), live));
				}
			}
			held = null;
		}
	};
}

function describe(entry: IHistoryEntry | undefined): string {
	if (entry === undefined) {
		return "its end";
	}
	if (entry.Kind === "effect") {
		const type = (
			entry.Descriptor as {
				Type?: unknown;
			} | null
		)?.Type;
		return `a yield of "${String(type)}"`;
	}
	return entry.Kind === "other" ? "another writer's change" : `a ${entry.Kind}`;
}

function sameStep(
	entry: IHistoryEntry & {
		Kind: "step";
	},
	record: IStepRecord
): boolean {
	return (
		jsonEquals(entry.Changes, record.Changes) &&
		jsonEquals(entry.InFlightAnswers, record.InFlightAnswers) &&
		jsonEquals(entry.ExternalAnswers, record.ExternalAnswers)
	);
}

function thrown(error: unknown): IFiberSettleInput {
	return {
		verb: "throw",
		error
	};
}

/**
 * The prefix of one action: its history, read in order as the replayed generator yields, with the
 * other writers' changes applied through `session` at the waits they were recorded in. `from` is the
 * action's id in the snapshot.
 */
export function createPrefix(entries: readonly IHistoryEntry[], session: IEntityRewind, from: string): IPrefixRun {
	let at = 0;
	let outcome: IPrefixRun["outcome"] = "running";
	let detail: string | undefined;
	let own = false;
	let binding: IPrefixBinding | null = null;
	const gate = holdRecords();
	let inner: IActionJournal | null = null;
	let provisional = PROVISIONAL;
	let start: IHeldRecord | null = null;
	let lastEffect: IHeldRecord | null = null;
	let heldEffect: IHeldRecord | null = null;
	let send: (() => void) | null = null;
	let answering: {
		provisional: number;
		real: number;
	} | null = null;

	function diverge(why: string, ownDoing = false): void {
		if (outcome === "running") {
			outcome = "diverged";
			detail = why;
			own = ownDoing;
		}
	}

	function othersAhead(): IRecordChange[] {
		const changes: IRecordChange[] = [];
		for (let entry = entries[at]; entry?.Kind === "other"; entry = entries[++at]) {
			changes.push(entry.Change);
		}
		return changes;
	}

	function forward(changes: readonly IRecordChange[]): boolean {
		if (changes.length === 0) {
			return true;
		}
		try {
			session.forward(changes);
			return true;
		} catch (error) {
			diverge(`another writer's change could not be applied again: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	function handOver(): void {
		outcome = "handed-over";
		binding?.live();
	}

	function stepMade(record: IStepRecord): void {
		const entry = entries[at];
		if (entry?.Kind !== "step") {
			diverge(`the replay made a step where the history has ${describe(entry)}`);
			return;
		}
		if (!sameStep(entry, record)) {
			diverge("a replayed step's changes or read answers differ from the history's");
			return;
		}
		at++;
	}

	type IRecorded =
		| {
				readonly answer: Extract<
					IHistoryEntry,
					{
						Kind: "response";
					}
				>;
				readonly others: IRecordChange[];
		  }
		| "held"
		| null;

	function recorded(effect: IEffect, inStep: boolean): IRecorded {
		if (outcome !== "running") {
			return null;
		}
		const entry = entries[at];
		if (entry?.Kind !== "effect") {
			diverge(`the replay yielded "${effect.Type}" where the history has ${describe(entry)}`);
			return null;
		}
		if (!jsonEquals(entry.Descriptor, journalDescriptor(effect, isRedacted(effect.Type)))) {
			diverge(`the replay yielded "${effect.Type}" with another descriptor than the history's`);
			return null;
		}
		at++;
		const during = othersAhead();
		const answer = entries[at];
		if (answer === undefined) {
			if (inStep) {
				diverge(`the history ends at a "${effect.Type}" it has no answer to`);
				return null;
			}
			if (!forward(during)) {
				return null;
			}
			heldEffect = lastEffect;
			handOver();
			return "held";
		}
		if (answer.Kind !== "response" || answer.ForSeq !== entry.Seq) {
			diverge(`the history has ${describe(answer)} where "${effect.Type}" was answered`);
			return null;
		}
		at++;
		const others = [
			...during,
			...othersAhead()
		];
		if (inStep && others.length > 0) {
			diverge(`another writer's change is recorded inside the step that answered "${effect.Type}"`);
			return null;
		}
		if ("Error" in answer && answer.Error.Thrown === "redacted") {
			diverge(`"${effect.Type}" rejected with a redacted error, which the history holds none of`);
			return null;
		}
		return forward(others)
			? {
					answer,
					others
				}
			: null;
	}

	function inputOf(
		effect: IEffect,
		answer: Extract<
			IHistoryEntry,
			{
				Kind: "response";
			}
		>,
		settle: ISettle
	): IFiberSettleInput {
		if ("Error" in answer) {
			return thrown(rebuildThrow(answer.Error as Parameters<typeof rebuildThrow>[0]));
		}
		try {
			return {
				verb: "next",
				value: settle(effect, answer.Value)
			};
		} catch (error) {
			return thrown(error);
		}
	}

	function stamp(record: IAppend): IAppend {
		const forSeq = (
			record as {
				ForSeq?: number;
			}
		).ForSeq;
		if (answering === null || forSeq !== answering.provisional) {
			return record;
		}
		return {
			...record,
			ForSeq: answering.real
		} as IAppend;
	}

	const journal: IActionJournal = {
		get asking() {
			return inner!.asking;
		},
		append(record, live) {
			if (outcome === "handed-over") {
				const stamped = stamp(record);
				const seq = inner!.append(stamped, live);
				if (stamped !== record) {
					binding?.ordinary();
				}
				return seq;
			}
			const seq = ++provisional;
			if (outcome !== "running") {
				return seq;
			}
			const held = {
				record,
				live,
				seq
			};
			switch (record.Kind) {
				case "action:start":
					start = held;
					break;
				case "effect":
					lastEffect = held;
					break;
				case "step":
					stepMade(record as unknown as IStepRecord);
					break;
			}
			return seq;
		}
	};

	const run: IPrefixRun = {
		get outcome() {
			return outcome;
		},
		get detail() {
			return detail;
		},
		get ownDoing() {
			return own;
		},
		get actionId() {
			return (
				start?.record as
					| {
							ActionId?: string;
					  }
					| undefined
			)?.ActionId;
		},
		journal(given) {
			inner = gate.wrap(given);
			return journal;
		},
		bind(given) {
			binding = given;
		},
		answer(effect, settle) {
			const found = recorded(effect, false);
			if (found === null || found === "held") {
				return found;
			}
			return {
				input: inputOf(effect, found.answer, settle),
				parks: found.answer.Sync !== true
			};
		},
		answerInStep(effect, settle) {
			const found = recorded(effect, true);
			// Undefined, so the step code runs on to its next yield with nothing thrown into it.
			return found !== null && found !== "held"
				? inputOf(effect, found.answer, settle)
				: {
						verb: "next",
						value: undefined
					};
		},
		held(given) {
			send = given;
		},
		sent() {
			const held = heldEffect;
			heldEffect = null;
			if (held !== null && inner !== null) {
				answering = {
					provisional: held.seq,
					real: inner.append(held.record, held.live)
				};
			}
		},
		read(yielded, copy) {
			if (outcome !== "running") {
				return null;
			}
			const read = yielded as {
				Type?: unknown;
				Key?: unknown;
			};
			const entry = entries[at];
			if (read.Type === "inFlight") {
				const answers = entry?.Kind === "step" ? entry.InFlightAnswers : undefined;
				if (answers?.length !== 1 || entry?.Kind !== "step" || entry.ExternalAnswers !== undefined) {
					diverge("the replay read inFlight where the history's step holds no single inFlight answer");
					return null;
				}
				return {
					verb: "next",
					value: answers[0],
					inFlightAnswers: [
						answers[0]!
					]
				};
			}
			if (read.Type === "external") {
				const answers: IExternalAnswer[] | undefined = entry?.Kind === "step" ? entry.ExternalAnswers : undefined;
				const found = answers?.length === 1 && entry?.Kind === "step" && entry.InFlightAnswers === undefined ? answers[0]! : undefined;
				if (found === undefined || found.Key !== read.Key) {
					diverge(`the replay read external "${String(read.Key)}" where the history's step holds no single answer for it`);
					return null;
				}
				if (found.Redacted) {
					diverge(`external "${found.Key}" is redacted, so the history holds none of its answer`);
					return null;
				}
				try {
					const value = found.Value === undefined ? undefined : copy(found.Value, found.Key);
					return {
						verb: "next",
						value,
						externalAnswers: [
							{
								key: found.Key,
								provided: Object.hasOwn(found, "Value"),
								redacted: false,
								value
							}
						]
					};
				} catch (error) {
					return thrown(error);
				}
			}
			diverge(`the replay read "${String(read.Type)}", whose answer the history doesn't hold`, true);
			return null;
		},
		halted(settled, position) {
			if (outcome === "running" && (settled?.kind === "errored" || settled?.kind === "cancelled" || position === "done")) {
				diverge("the action ended where the history holds it in flight");
			}
			return outcome === "diverged";
		},
		diverge,
		drop() {
			binding?.drop();
		},
		accept() {
			binding?.arrived();
		},
		announce() {
			gate.deliver(
				start === null
					? undefined
					: ({
							...start.record,
							ResumedFrom: from
						} as IAppend)
			);
		},
		release() {
			if (send !== null) {
				const sending = send;
				send = null;
				sending();
			}
			if (heldEffect !== null) {
				heldEffect = null;
				binding?.ordinary();
			}
		}
	};
	return run;
}
