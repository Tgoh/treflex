import type { IEntity, ISelectorGenerator } from "treflex";
import { createMemo } from "solid-js";
import { inFlight } from "treflex";
import { rawOf } from "treflex/internal";
import { runtimeFor } from "../Context/TreflexContext";

/** A node is fixed. An accessor is followed: undefined is no owner. */
export type IUseInFlightOwner = IEntity | undefined | (() => IEntity | undefined);

/**
 * Whether work `inFlight` reads, an action, a work tag or a list of them, is in flight on `owner`,
 * as an accessor. For display: a repeat is dropped by `leading`, not by a check of this before
 * dispatching.
 */
export function useInFlight(reading: Parameters<typeof inFlight>[0], owner: IUseInFlightOwner): () => boolean {
	const runtime = runtimeFor("useInFlight");
	function* busy(draft: IEntity): ISelectorGenerator<boolean> {
		return yield* inFlight(reading, draft);
	}
	return createMemo(() => {
		const node = typeof owner === "function" ? owner() : owner;
		if (node === undefined) {
			return false;
		}
		if (rawOf(node) === node) {
			throw new Error(
				"[treflex] useInFlight(): the owner is a plain object, not a node of the state tree, so no runtime keeps a record of work on it. " +
					"Pass the live node the view holds, such as feature.state or a row of it, not a copy."
			);
		}
		return runtime.processSelector(busy, () => node);
	});
}
