import type { IExternalAnswer, IRecordChange } from "./IRecord";

export type IStepEntry = {
	type: "step";
	branchId: string;
	/** The step record's `Changes`, both sides copies taken at the write. */
	changes: IRecordChange[];
	/** The step record's `InFlightAnswers`. */
	inFlightAnswers?: boolean[];
	/** The step record's `ExternalAnswers`. */
	externalAnswers?: IExternalAnswer[];
};

export type IEffectEntry = {
	type: "effect";
	branchId: string;
	effect: Record<string, unknown>;
	/** The implementation's value, from the settlement's live extras. One of `result`, `error` and `aborted` is set. */
	result?: unknown;
	/** What the action was thrown for the effect: for an implementation's throw, the copy rebuilt from it. */
	error?: unknown;
	/** The action ended with the effect unsettled. The entry is appended at `action:end`, its duration to then. */
	aborted?: boolean;
	duration: number;
};

export type ITraceEntry = IStepEntry | IEffectEntry;

export type IActionTrace = {
	actionId: string;
	/** The action:start record's `Name`. */
	name: string | null;
	/** The action:start record's `Label`. */
	label: string | null;
	args: unknown[];
	/** The action:start record's `ArgsRedacted`. */
	argsRedacted?: true;
	entityId: string;
	entries: ITraceEntry[];
	duration: number;
	error?: unknown;
	cancelled?: true;
	dropped?: true;
};
