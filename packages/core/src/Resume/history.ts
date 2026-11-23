import type { IExternalAnswer, IRecordChange } from "../Types/IRecord";
import type { ISerializedThrow } from "../Utility/serializeThrow";

/**
 * One entry of a history, in the order the records came. `step`, `effect` and `response` are the
 * action's own, each as its record holds it; `other` is one change another writer landed in the
 * action's entity or below it.
 */
export type IHistoryEntry =
	| {
			Kind: "step";
			Changes: IRecordChange[];
			InFlightAnswers?: boolean[];
			ExternalAnswers?: IExternalAnswer[];
	  }
	| {
			Kind: "effect";
			Seq: number;
			Descriptor: unknown;
	  }
	| {
			Kind: "response";
			ForSeq: number;
			Value?: unknown;
			/** The answer came in the turn its yield was made, so the action didn't park on it. */
			Sync?: true;
	  }
	| {
			Kind: "response";
			ForSeq: number;
			Sync?: true;
			Error:
				| ISerializedThrow
				| {
						Thrown: "redacted";
				  };
	  }
	| {
			Kind: "other";
			Change: IRecordChange;
	  };

/** A kept history, for the in-flight row with this `ActionId`. */
export interface IHistory {
	ActionId: string;
	/** As the `action:start` record holds them. */
	Args: unknown[];
	/** False when the JSON form can't give the action back the values it was given: an `undefined` before a set argument. */
	ArgsExact: boolean;
	Entries: IHistoryEntry[];
	Unlisted: IUnlisted;
	UnlistedLineage: IUnlistedAt[];
	Deliveries: IDeliveryAt[];
}

/**
 * In-flight work the rows don't list and can't name, an action whose root has ended with a fiber
 * still live, on the action's entity at the snapshot: it holds the entity, it stands in the entity's
 * line, or there is none. A resource's delivery is in `Deliveries` instead.
 */
export type IUnlisted = "none" | "holding" | "in-line";

/** Work as `Unlisted` counts it, on an entity above or below the action's, at the snapshot. */
export interface IUnlistedAt {
	EntityId: string;
	Unlisted: "holding" | "in-line";
}

/**
 * A resource's delivery in flight on the action's entity, above it or below it, at the snapshot: it
 * holds `EntityId`, stands in its line, or is parked inside `open(...)` there.
 */
export interface IDeliveryAt {
	Key: string;
	OwnerId: string;
	EntityId: string;
	At: "holding" | "in-line" | "open";
}

/** An in-flight marked action whose history the snapshot doesn't carry, and why. */
export interface IUnusableHistory {
	ActionId: string;
	Unusable: "not-whole" | "over-budget" | "too-deep";
	Unlisted: IUnlisted;
	UnlistedLineage: IUnlistedAt[];
	Deliveries: IDeliveryAt[];
}

export type ISnapshotHistory = IHistory | IUnusableHistory;
