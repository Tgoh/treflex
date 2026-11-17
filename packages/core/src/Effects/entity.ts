import type { IActionGenerator } from "../Types/IAction";
import type { IEntity, IEntityId } from "../Types/IEntity";
import type { IReceiverId } from "../Types/IReceiver";
import { copyPlain } from "../Runtime/crossing";
import { mintedId } from "../Runtime/draftNode";
import { globalWeakMap } from "../Utility/globalWeakMap";
import { generateGuid } from "./generateGuid";

// What `entity()` returned, which a start takes as its target by the $Id: see createRuntime's refuseMismatch.
export const mintedValues = globalWeakMap<object, true>("__treflex_minted_values__");

/** `T` as `entity()` returns it: its own fields, and an `$Id` that was minted rather than `T`'s. */
export type IWithId<T> = {
	[K in keyof T as K extends "$Id" ? never : K]: T[K];
} & IEntity;

/** `T` with `$Id` and `$Receiver` gone at every depth, as `withoutIds()` returns it. */
export type IWithoutIds<T> = T extends string | number | boolean | null | undefined
	? T
	: T extends readonly unknown[]
		? {
				[K in keyof T]: IWithoutIds<T[K]>;
			}
		: T extends object
			? {
					[K in keyof T as K extends "$Id" | "$Receiver" ? never : K]: IWithoutIds<T[K]>;
				}
			: T;

type IReceiverCheck<T> = "$Receiver" extends keyof T
	? {
			readonly $Receiver: IReceiverId<IWithId<T>>;
		}
	: unknown;

/**
 * Makes an entity: a deep copy of `value` carrying a newly minted `$Id`. This, and the
 * `createRuntime` seed, are where an `$Id` comes from: a draft write carrying any other is
 * refused. The copy is the caller's to edit until it's written into the tree, and `value` is
 * left alone, so a frozen argument or a live node both work. An `$Id` on `value` itself is
 * replaced, which is how `entity({ ...row })` makes a new entity from an old one. An `$Id`
 * further down is kept, because that's how a nested entity minted a moment earlier stays the
 * same entity.
 *
 * Throws `NonPlainDataError` for what state can't hold, before minting. The mint is an effect,
 * so a test can stub it, and it ends the step: mint first, then edit the tree. A stub's answer
 * comes back marked, so `guids("row")` makes `~row-1`. See docs/reference/state-tree.md#making-an-entity.
 *
 * A `$Receiver: Receiver.Id` on the value binds the entity it makes, and `entity({ ...row })` keeps
 * the row's binding. See docs/reference/messaging.md#binding.
 */
export function entity<T extends object>(value: T & IReceiverCheck<T>): IActionGenerator<IWithId<T>>;
export function entity<T extends IEntity>(
	value: Omit<T, "$Id"> &
		object & {
			$Receiver?: IReceiverId<T>;
		}
): IActionGenerator<T>;
export function* entity(value: object): IActionGenerator<IEntity> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("[treflex] entity(): an entity is an object, so the value has to be one, and not an array.");
	}
	const { $Id: _replaced, ...fields } = copyPlain(value, "entity(): the value") as Partial<IEntity>;
	const made = {
		$Id: mintedId(yield* generateGuid()),
		...fields
	};
	mintedValues.set(made, true);
	return made;
}

/**
 * A deep copy of `value` with every `$Id` and `$Receiver` in it dropped, for state that holds what
 * an entity says rather than being it: component state editing a copy of a row, or a copy bound
 * for another slot. Keep the row's address in a field of its own to write the edit back. See
 * docs/reference/state-tree.md#an-id-names-one-node.
 */
export function withoutIds<T>(value: T): IWithoutIds<T> {
	const drop = (node: unknown): unknown => {
		if (node === null || typeof node !== "object") {
			return node;
		}
		if (Array.isArray(node)) {
			return node.map(drop);
		}
		const { $Id: _dropped, $Receiver: _unbound, ...fields } = node as Record<string, unknown>;
		for (const key of Object.keys(fields)) {
			fields[key] = drop(fields[key]);
		}
		return fields;
	};
	return drop(copyPlain(value, "withoutIds(): the value")) as IWithoutIds<T>;
}

/**
 * The address of an entity, to store in a field that refers to it. Works on a draft, a view,
 * or a value `entity()` returned.
 */
export function idOf(node: IEntity): IEntityId {
	const id = node?.$Id;
	if (typeof id !== "string" || id === "") {
		throw new TypeError("[treflex] idOf(): this isn't an entity, so it has no address.");
	}
	return id as IEntityId;
}
