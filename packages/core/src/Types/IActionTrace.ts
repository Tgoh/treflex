import type { IRecordChange } from "./IRecord";

export type IStepEntry = {
	type: "step";
	branchId: string;
	// The step record's own change list — Path/Prev/Value, both sides
	// owned clones taken at write time, so trace consumers outlive the
	// underlying mutations.
	changes: IRecordChange[];
	/** The step record's `InFlightAnswers`. */
	inFlightAnswers?: boolean[];
};

export type IEffectEntry = {
	type: "effect";
	branchId: string;
	effect: Record<string, unknown>;
	// Exactly one of result / error / aborted per step:
	//   result  → the settlement's live extras carried the impl's value
	//   error   → the impl threw and the throw reached the action
	//   aborted → the action ended with the effect still unsettled
	//             (silent-cancel journals no response record); the
	//             aggregator synthesizes the entry at action:end so the
	//             trace still shows WHICH effect was in flight when
	//             cancellation arrived. Its duration is dispatch→terminal.
	result?: unknown;
	error?: unknown;
	aborted?: boolean;
	duration: number;
};

export type ITraceEntry = IStepEntry | IEffectEntry;

export type IActionTrace = {
	actionId: string;
	action: string;
	args: unknown[];
	entityId: string;
	entries: ITraceEntry[];
	duration: number;
	error?: unknown;
	cancelled?: true;
	dropped?: true;
};
