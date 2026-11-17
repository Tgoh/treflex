import type { IEntity } from "../Types/IEntity";
import type { IReadGenerator } from "../Types/ISelector";
import type { IWriteGateway } from "./createWriteGateway";
import { globalWeakMap } from "../Utility/globalWeakMap";
import { cloneStrict, copyFrozen, type ICopyOptions, type IStrictClone } from "../Utility/valueCodec";
import { refuseAnyId } from "./draftNode";
import { NonPlainDataError } from "./nonPlainDataError";
import { createRecordingProxy, DRAFT_SCOPE, type IDraftScope } from "./recordingProxy";
import { TreflexRefusal } from "./refusal";
import { runningStep } from "./runningStep";
import { rawOf } from "./viewProxy";

export class MoveBetweenRootsError extends TreflexRefusal {
	readonly from: readonly string[];
	readonly to: readonly string[];
	constructor(from: readonly string[], to: readonly string[]) {
		super(
			`[treflex] the node at [${from.join(".")}] cannot be written at [${to.join(".")}]: that moves a live node between ` +
				`${from[0]} and ${to[0]}, and each root lives and is saved differently. Write a copy instead: withoutIds(node), ` +
				`with idOf(node) kept in a field to reach the original (docs/reference/state-tree.md#a-live-node-stays-in-its-root).`
		);
		this.name = "MoveBetweenRootsError";
		this.from = from;
		this.to = to;
	}
}

export const TRANSIENT_YIELD = "transient";

export interface ISlotHome {
	readSlot(ownerId: string, name: string): object | undefined;
}

// On globalThis, like the view cache: a view carries no runtime, and a second
// evaluation of this module must find the homes the first one recorded.
export const slotHomes = globalWeakMap<object, ISlotHome>("__treflex_slot_homes__");

function copied<S extends object>(copy: (options: ICopyOptions) => IStrictClone, name: string, made?: Set<object>): S {
	const what = `transient("${name}"): the default`;
	const result = copy({
		made,
		live: (node) => {
			if (rawOf(node) !== node) {
				throw new NonPlainDataError(what, "a live node", []);
			}
			return node;
		}
	});
	if (!result.ok) {
		throw new NonPlainDataError(what, result.kind, result.path);
	}
	refuseAnyId(
		result.value,
		what,
		"A default is copied for each owner, so they'd all share it. Start without it, and have an action add the entity with yield* entity(...)"
	);
	return result.value as S;
}

function draftSlot(scope: IDraftScope, owner: object, name: string, fresh: () => object): object {
	const gateway = scope.ctx.gateway as IWriteGateway;
	const root = gateway.slotRoot(owner, name, fresh);
	if (root === null) {
		return createRecordingProxy(
			fresh(),
			{
				currentJournalChanges: null
			},
			new WeakMap()
		);
	}
	return createRecordingProxy(
		root,
		scope.ctx,
		scope.cache,
		[
			"TransientState",
			(owner as IEntity).$Id,
			name
		],
		gateway.rootNode(),
		scope.lease
	);
}

export function slotOf<S extends object>(owner: IEntity, name: string, initial: S): S {
	const raw = rawOf(owner);
	const scope =
		raw === null || typeof raw !== "object" ? undefined : (owner as unknown as Record<symbol, IDraftScope | undefined>)[DRAFT_SCOPE];
	if (scope) {
		return draftSlot(scope, raw, name, () => copied<S>((options) => cloneStrict(initial, options), name)) as S;
	}
	const home = raw !== owner ? slotHomes.get(raw) : undefined;
	if (!home) {
		throw new Error(
			`[treflex] transient("${name}"): the owner has to be a draft, or a view of an entity on the state tree. A value snapshot or a React ` +
				`view reaches no transient, so read it through a selector, on the draft it is given.`
		);
	}
	const held = home.readSlot(raw.$Id, name) as S | undefined;
	if (held) {
		return held;
	}
	const made = new Set<object>();
	const fallback = copied<S>((options) => copyFrozen(initial, options), name, made);
	for (const node of made) {
		unwrittenSlots.set(node, name);
	}
	return fallback;
}

// The default copies a read of an unwritten slot answers, by slot name, for `locate`'s refusal.
export const unwrittenSlots = globalWeakMap<object, string>("__treflex_unwritten_slots__");

/**
 * A named place for data about running work on an entity, never saved. `yield*` it with the
 * draft an action or a selector was given. An action gets the slot's draft, which is live, and
 * a selector gets a read-only view it reacts to. The name is its identity, so namespace it as a
 * message topic is. `initial` is plain data, copied for each owner the first time, and a read doesn't
 * write. Holding an `$Id` it throws `HandWrittenIdError`, since each owner's copy would share it.
 * See docs/reference/state-tree.md#transients.
 */
export function* transient<S extends object>(owner: IEntity, name: string, initial: S): IReadGenerator<S> {
	if (typeof name !== "string" || name === "") {
		throw new TypeError("[treflex] transient(): a transient needs a non-empty name.");
	}
	if (initial === null || typeof initial !== "object") {
		throw new TypeError(`[treflex] transient("${name}"): the default has to be a plain object or array.`);
	}
	// No yield during a close.
	if (runningStep.closing()) {
		return slotOf(owner, name, initial);
	}
	return yield {
		Type: TRANSIENT_YIELD,
		Owner: owner,
		Name: name,
		Initial: initial
	};
}
