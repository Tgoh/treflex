import type { IAskId } from "./IAskId";

/** A pending ask as `pendingAsks(owner)` lists it: one frozen object for the ask's whole life. */
export interface IAskEntry {
	/** Narrow it to the answer's type by the request's shape, with a cast. */
	readonly Id: IAskId<unknown>;
	readonly OwnerId: string;
	/** The asker's request: a frozen copy taken at the yield. */
	readonly Request: unknown;
}
