import type { IEntity } from "../Types/IEntity";
import type { IReceiver } from "../Types/IReceiver";
import { mintedValues } from "../Effects/entity";
import { BIND_WRITE, isDraftNode } from "./draftNode";
import { TreflexRefusal } from "./refusal";
import { rawOf } from "./viewProxy";

/** `bind` or `unbind` on the value `entity()` returned, after it was written into the tree, which holds a copy of it. */
export class BindAfterWriteError extends TreflexRefusal {
	readonly id: string;
	constructor(verb: "bind" | "unbind", id: string) {
		super(
			`[treflex] ${verb}: this is the value entity() returned for "${id}", and it has been written into the tree, which holds a ` +
				`copy of it, so ${verb === "bind" ? "binding" : "unbinding"} the value changes nothing. ` +
				(verb === "bind"
					? "Put $Receiver: Receiver.Id on the value before it's written, or call bind on the draft node the tree holds."
					: "Leave $Receiver off the value before it's written, or call unbind on the draft node the tree holds.")
		);
		this.name = "BindAfterWriteError";
		this.id = id;
	}
}

function write(verb: "bind" | "unbind", node: unknown, receiverId: string | undefined): void {
	if (node === null || typeof node !== "object" || Array.isArray(node)) {
		throw new TypeError(`[treflex] ${verb}: only an entity is bound to a receiver, and this is not an object.`);
	}
	const id = (node as Partial<IEntity>).$Id;
	if (typeof id !== "string" || id === "") {
		throw new TypeError(`[treflex] ${verb}: only an entity is bound to a receiver, and this node has no $Id.`);
	}
	if (isDraftNode(node)) {
		(
			node as {
				[BIND_WRITE]: (receiverId: string | undefined) => void;
			}
		)[BIND_WRITE](receiverId);
		return;
	}
	if (rawOf(node) !== node) {
		throw new TypeError(
			`[treflex] ${verb}: this is a view of "${id}", which is read-only. Call ${verb} on the draft node in an action, ` +
				"or set $Receiver on the value entity() returned before it's written."
		);
	}
	if (Object.isFrozen(node)) {
		if (mintedValues.has(node)) {
			throw new BindAfterWriteError(verb, id);
		}
		throw new TypeError(
			`[treflex] ${verb}: "${id}" is a frozen value, so nothing can bind it. Call ${verb} on the draft node in an action.`
		);
	}
	const fields = node as {
		$Receiver?: string;
	};
	if (receiverId === undefined) {
		delete fields.$Receiver;
	} else {
		fields.$Receiver = receiverId;
	}
}

/**
 * Binds an entity to a receiver: it hears the topics the receiver has cases for, and
 * an `Action/Error` case makes it an error boundary. Takes a draft node, written as a step's write, or
 * the value `entity()` returned before it's written. Doesn't yield. See docs/reference/messaging.md#binding.
 */
export function bind<T extends IEntity>(node: T, receiver: IReceiver<T, never>): void {
	const receiverId = (receiver as Partial<IReceiver> | null | undefined)?.Id;
	if (typeof receiverId !== "string" || receiverId === "") {
		throw new TypeError("[treflex] bind: the second argument has to be a receiver, what receiver(id)(cases) returns.");
	}
	write("bind", node, receiverId);
}

/** Takes an entity's binding away, so it hears nothing. Takes what `bind` takes. Doesn't yield. */
export function unbind(node: IEntity): void {
	write("unbind", node, undefined);
}
