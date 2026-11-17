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
			EntityId: string;
			Path: string[];
			Args: unknown[];
			StartedBy?: string;
			Origin?: IActionOrigin;
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
			// The answers of the `inFlight` reads this slice resumed from, nested selects' included, in order.
			InFlightAnswers?: boolean[];
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
