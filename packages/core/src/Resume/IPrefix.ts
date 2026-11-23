import type { IActionJournal } from "../Runtime/createJournal";
import type { IFiberPosition, IFiberSettleInput, IFiberSettleOutcome } from "../Runtime/fiberMachine";
import type { IEffect } from "../Types/IEffect";

/** What a live yield's answer goes through before the generator is given it: `settleResult` in `processAction.ts`. */
export type ISettle = (effect: IEffect, value: unknown) => unknown;

/** The copy a live `external` read makes of its value. */
export type ICopyExternal = (value: unknown, key: string) => unknown;

/** What the dispatch that runs a prefix hands back to it. */
export interface IPrefixBinding {
	/** The action runs live from here: its yields are sent and its reads answered as any action's. */
	live(): void;
	/** Notes the action's arrival for work tags, once the engine has accepted the hand-over. */
	arrived(): void;
	/** The action's records go to its own journal from here. */
	ordinary(): void;
	/** Takes the action out of the runtime as if it had never been dispatched: no end, no failure, no record. */
	drop(): void;
}

/** What a public dispatch and a `start` meet after a restore has resumed work and before it releases the held waits. */
export interface IReleaseWindow {
	/** The error a public dispatch of `action` on the entity `key` rejects with, or null. `holderId` is the id of the action holding `key`. */
	refuse(action: Function, key: string, holderId: string | null): Error | null;
	/** The error a `start` of `action` onto the entity `key` throws into its starter, or null. */
	refuseStart(action: Function, key: string): Error | null;
}

/** A replayed action's prefix, as the runtime's guarded sites see it. */
export interface IPrefix {
	journal(inner: IActionJournal): IActionJournal;
	bind(binding: IPrefixBinding): void;
	/**
	 * A yield's recorded answer and whether the live run parked on it, `"held"` for the wait the
	 * snapshot caught, or null once the prefix has diverged.
	 */
	answer(
		effect: IEffect,
		settle: ISettle
	):
		| {
				input: IFiberSettleInput;
				parks: boolean;
		  }
		| "held"
		| null;
	/** An in-step effect's recorded answer, or undefined once the prefix has diverged. */
	answerInStep(effect: IEffect, settle: ISettle): IFiberSettleInput;
	/** The caught wait's send, which `release` calls. */
	held(send: () => void): void;
	/** Delivers the caught wait's effect record, just before it is sent. */
	sent(): void;
	/** A read's recorded answer, or null once the prefix has diverged. */
	read(yielded: unknown, copy: ICopyExternal): IFiberSettleInput | null;
	/** Whether the run stops here: it has diverged, or the action ended where the history holds it in flight. */
	halted(settled: IFiberSettleOutcome | null, position: IFiberPosition): boolean;
	/** `ownDoing` when the action itself did something off the list, which `resume/never-resumes` reports. */
	diverge(detail: string, ownDoing?: boolean): void;
}
