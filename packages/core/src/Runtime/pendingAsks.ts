import type { IAskEntry } from "../Types/IAskEntry";
import type { IEntity } from "../Types/IEntity";
import type { IReadGenerator } from "../Types/ISelector";
import { globalWeakMap } from "../Utility/globalWeakMap";
import { DRAFT_SCOPE, type IDraftScope } from "./recordingProxy";
import { slotHomes } from "./transient";
import { rawOf } from "./viewProxy";

type IAskReader = (ownerId: string) => readonly IAskEntry[];

// On globalThis like slotHomes: a view carries no runtime, and a second evaluation of this module
// must find the readers the first one recorded.
const readers = globalWeakMap<object, IAskReader>("__treflex_ask_readers__");

export function shareAsks(homes: readonly object[], read: IAskReader): void {
	for (const home of homes) {
		readers.set(home, read);
	}
}

export const PENDING_ASKS_YIELD = "pendingAsks";

/**
 * The pending asks whose owners are at or below `owner`, in opening order. Each entry
 * is one frozen object for its ask's whole life, so a keyed list doesn't remount it. `yield*` it
 * with the draft an action or a selector was given, or an entity under it; a selector reacts, to
 * an ask opening or ending and to an owner moving, and a view reads it through a selector.
 */
export function* pendingAsks(owner: IEntity): IReadGenerator<readonly IAskEntry[]> {
	return yield {
		Type: PENDING_ASKS_YIELD,
		Owner: owner
	};
}

export function readPendingAsks(owner: IEntity): readonly IAskEntry[] {
	const raw = rawOf(owner);
	const scope = (owner as unknown as Record<symbol, IDraftScope | undefined>)[DRAFT_SCOPE];
	const home = scope ? (scope.ctx.gateway as object | undefined) : raw !== owner ? slotHomes.get(raw) : undefined;
	const read = home && readers.get(home);
	if (!read) {
		throw new Error(
			scope || raw !== owner
				? "[treflex] pendingAsks(): the owner is not on the state tree, and pendingAsks lists the asks on entities attached to it."
				: "[treflex] pendingAsks(): the owner is a plain object. A value snapshot or a React view reaches no runtime, so read it through a selector, on the draft it is given."
		);
	}
	const id = (
		raw as {
			$Id?: unknown;
		}
	).$Id;
	if (typeof id !== "string") {
		throw new TypeError("[treflex] pendingAsks(): the owner is not an entity, so no ask is owned by it.");
	}
	return read(id);
}
