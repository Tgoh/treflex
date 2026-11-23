import type { IAskAbandonReason, IAskRow } from "../Runtime/createAskTable";
import type { IResourceRow } from "../Runtime/createResourceTable";
import type { ITimerRow } from "../Runtime/createTimerTable";
import type { ISerializedThrow } from "../Utility/serializeThrow";

// `Deleted` and `Created` are flags, not read off absent keys: JSON drops an
// undefined-valued `Value` or `Prev`, so absence can't survive a round-trip.
export type IRecordChange = {
	Path: PropertyKey[];
	Prev: unknown;
	Value?: unknown;
	Deleted?: true;
	Created?: true;
	// The array's length before a created index write at or past its end,
	// present exactly when the write grew an array.
	GrewFrom?: number;
	/**
	 * The entity the write landed in, as the tree stood when it was made: `Path` counts from the acting
	 * entity and can name a position another node holds by then. Present on a change of a step that began
	 * while a tap asked with `landing: true`, when an entity holds the written place, so a change without
	 * one reads the same whether no entity holds the place or no tap asked. See
	 * docs/reference/restart-and-records.md#where-a-write-landed.
	 */
	Landing?: IRecordLanding;
};

/** The nearest entity at or above a written place, and the keys from that entity down to it. */
export type IRecordLanding = {
	EntityId: string;
	Path: PropertyKey[];
};

/**
 * An action's read of an external value, on its `step` record. `Value` is the frozen copy the action
 * received, absent when that was `undefined`, nothing provided the key, or its provider redacts. See
 * docs/reference/derived-reads.md#an-actions-read.
 */
export type IExternalAnswer = {
	Key: string;
	Value?: unknown;
	Redacted?: true;
};

export type IActionOrigin = {
	Kind: "resource:deliver" | "resource:run";
	Key: string;
	OwnerId: string;
};

export type IRecordRoot = "AppState" | "TransientState" | "ComponentState";

// Every variant is JSON-serializable. What each kind means:
// docs/reference/restart-and-records.md#record-kinds.
export type IRecord =
	| {
			Seq: number;
			T: number;
			Kind: "action:start";
			Root: IRecordRoot;
			ActionId: string;
			Name: string | null;
			Label: string | null;
			Receiver?: string;
			EntityId: string;
			Path: string[];
			Args: unknown[];
			/** On an action marked `redactArgs`: `Args` is empty because its arguments were withheld. */
			ArgsRedacted?: true;
			StartedBy?: string;
			Origin?: IActionOrigin;
			/**
			 * On an action a restore resumed: its `ActionId` in the snapshot, which `result.resumed` names
			 * it by. See docs/reference/restart-and-records.md#what-a-restore-reports.
			 *
			 * @experimental
			 */
			ResumedFrom?: string;
	  }
	| {
			Seq: number;
			T: number;
			Kind: "step";
			Root: IRecordRoot;
			ActionId: string;
			BranchId: string;
			Changes: IRecordChange[];
			Cancelling?: true;
			/** The answers of the `inFlight` reads this slice resumed from, nested selects' included, in order. */
			InFlightAnswers?: boolean[];
			/** The answers of the `external` reads this slice resumed from, nested selects' included, in order. */
			ExternalAnswers?: IExternalAnswer[];
	  }
	| {
			Seq: number;
			T: number;
			Kind: "effect";
			Root: IRecordRoot;
			ActionId: string;
			BranchId: string;
			Type: string;
			Descriptor: unknown;
	  }
	| {
			Seq: number;
			T: number;
			Kind: "table";
			Table: "dataSources";
			Root: IRecordRoot;
			Key: string;
			OwnerId: string;
			Prev: string | null;
			Value: string | null;
	  }
	| {
			Seq: number;
			T: number;
			Kind: "table";
			Table: "timers";
			Root: IRecordRoot;
			Key: string;
			OwnerId: string;
			Prev: ITimerRow | null;
			Value: ITimerRow | null;
	  }
	| {
			Seq: number;
			T: number;
			Kind: "table";
			Table: "resources";
			Root: IRecordRoot;
			Key: string;
			OwnerId: string;
			Prev: IResourceRow | null;
			Value: IResourceRow | null;
	  }
	| {
			Seq: number;
			T: number;
			Kind: "resource:supply";
			Root: IRecordRoot;
			Key: string;
			OwnerId: string;
	  }
	| {
			Seq: number;
			T: number;
			Kind: "table";
			Table: "asks";
			AskId: string;
			Prev: IAskRow | null;
			Value: IAskRow | null;
	  }
	| {
			Seq: number;
			T: number;
			Kind: "response";
			Root: IRecordRoot;
			ForSeq: number;
			Value?: unknown;
	  }
	| {
			Seq: number;
			T: number;
			Kind: "response";
			Root: IRecordRoot;
			ForSeq: number;
			Error:
				| ISerializedThrow
				| {
						Thrown: "redacted";
				  };
	  }
	| {
			Seq: number;
			T: number;
			Kind: "branch:start";
			Root: IRecordRoot;
			ActionId: string;
			ParentBranchId: string;
			BranchId: string;
	  }
	| {
			Seq: number;
			T: number;
			Kind: "branch:end";
			Root: IRecordRoot;
			ActionId: string;
			BranchId: string;
			Status: "completed" | "cancelled" | "errored";
			// Only on "errored".
			Error?: ISerializedThrow;
	  }
	| {
			Seq: number;
			T: number;
			Kind: "message:deliver";
			Topic: string;
			PublisherId: string;
			RecipientIds: string[];
			// Absent, never [], when there are none.
			UnresolvedIds?: string[];
	  }
	| {
			Seq: number;
			T: number;
			Kind: "receiver:error";
			Topic: string;
			RecipientId: string;
			PublisherId: string;
	  }
	| {
			Seq: number;
			T: number;
			Kind: "entity:dispose";
			Root: IRecordRoot;
			EntityId: string;
			Path: string[];
	  }
	| {
			Seq: number;
			T: number;
			Kind: "ask:answer";
			AskId: string;
			OwnerId: string;
	  }
	| {
			Seq: number;
			T: number;
			Kind: "ask:abandon";
			AskId: string;
			OwnerId: string;
			Reason: IAskAbandonReason;
	  }
	| {
			Seq: number;
			T: number;
			Kind: "action:end";
			Root: IRecordRoot;
			ActionId: string;
			Status: "completed" | "cancelled" | "dropped" | "errored";
	  };

// Display-only and never load-bearing.
export type IRecordExtras = {
	result?: unknown;
	error?: unknown;
	duration?: number;
};

export type IRecordTapListener = (record: IRecord, live?: IRecordExtras) => void;
