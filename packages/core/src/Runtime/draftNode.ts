import { TreflexRefusal } from "./refusal";

// By registry name rather than import: recordingProxy.ts imports this module, so
// an import the other way would be a cycle.
const RECORDING_TARGET = Symbol.for("treflex.recordingTarget");

// Answered by the recording proxy's get trap without throwing. Symbol.for by the
// cross-module tag-symbol rule (see REGION_OP in open.ts).
export const DETACH_PROBE = Symbol.for("treflex.detachProbe");

export class DraftDetachedError extends Error {
	// Empty when the gateway never walked the node.
	readonly path: readonly string[];
	readonly reason: string;
	constructor(reason: string, path: readonly string[] = []) {
		const at = path.length > 0 ? ` at [${path.join(".")}]` : "";
		super(`[treflex] draft: the reference to the node${at} cannot be used: ${reason}`);
		this.name = "DraftDetachedError";
		this.path = path;
		this.reason = reason;
	}
}

export class DraftInsideOpenError extends TreflexRefusal {
	constructor(actionName: string) {
		super(
			`[treflex] draft: action "${actionName}" used its draft inside open(...) after a wait that let other work in, so what ` +
				`it holds may no longer be true. Read and write the entity outside open(...): wrap only the wait, as ` +
				`open(api.load(id)), and write what it returns after. A branch of open(parallel(...)) returns what it read, for ` +
				`the action to write.`
		);
		this.name = "DraftInsideOpenError";
	}
}

export class EntityReplacedError extends TreflexRefusal {
	readonly id: string;
	// As of the last reconciliation.
	readonly path: readonly string[];
	constructor(
		id: string,
		path: readonly string[],
		fromReconcileRowsAdd = false,
		duplicate?: {
			at: readonly string[];
			undone: string;
		}
	) {
		super(
			duplicate
				? `[treflex] draft: two nodes carrying the $Id "${id}" landed in state, at [${path.join(".")}] and [${duplicate.at.join(".")}]. ` +
						`An $Id names one node, and writing the same row twice copies it twice. ${duplicate.undone} Write the row once and store ` +
						`its $Id at the second place (docs/reference/state-tree.md#an-id-names-one-node).`
				: fromReconcileRowsAdd
					? `[treflex] reconcileRows(): add made a row carrying the $Id "${id}", which the node at [${path.join(".")}] holds, and nothing moved. ` +
						`A minted id collided with a live row, for example a stub reusing ids: a new guids() counts from 1, so on a second runtime give ` +
						`it a prefix of its own. A row add copied from a live one collides the same way, and entity() gives that copy an id of its own ` +
						`(docs/reference/state-tree.md#an-id-names-one-node).`
					: `[treflex] draft: this write would put a different node in state carrying the $Id "${id}", which the node at ` +
						`[${path.join(".")}] holds, and the write was refused. An $Id names one node. Write the new values into that node's ` +
						`fields, refresh a list with reconcileRows(), make a new entity with entity(), or move the node itself rather than a copy; ` +
						`a copy meant for elsewhere drops every $Id in it, which withoutIds() does ` +
						`(docs/reference/state-tree.md#an-id-names-one-node).`
		);
		this.name = "EntityReplacedError";
		this.id = id;
		this.path = path;
	}
}

export class HandWrittenIdError extends TreflexRefusal {
	readonly id: unknown;
	constructor(id: unknown, problem: string) {
		super(`[treflex] ${problem} (docs/reference/state-tree.md#making-an-entity).`);
		this.name = "HandWrittenIdError";
		this.id = id;
	}
}

// In the string because nothing on the object could last: a spread, an action argument, an
// effect's result and the write's own copy all keep the string and lose the object.
const MINT_MARK = "~";

export function mintedId(guid: string): string {
	return `${MINT_MARK}${guid}`;
}

export function isMintedId(id: unknown): boolean {
	return typeof id === "string" && id.startsWith(MINT_MARK);
}

export function refuseWrittenId(id: unknown): never {
	throw new HandWrittenIdError(
		id,
		`draft: this write carries the $Id ${JSON.stringify(id)}, which nothing issued, and the write was refused. An entity gets its $Id ` +
			`from yield* entity(...), or from the createRuntime seed`
	);
}

export function refuseIdChange(id: unknown, next: unknown): never {
	throw new HandWrittenIdError(
		next,
		`draft: this write would change the $Id ${JSON.stringify(id)}, and the write was refused. An $Id is permanent, and timers, ` +
			`resources and running work are all keyed on it. Make a new entity with yield* entity(...), and keep a server's id in a field of its own`
	);
}

/** The receiver a node is bound to: its own `$Receiver`, when that's a string. */
export function boundReceiverOf(node: unknown): string | undefined {
	if (node === null || typeof node !== "object" || !Object.hasOwn(node, "$Receiver")) {
		return undefined;
	}
	const receiverId = (
		node as {
			$Receiver: unknown;
		}
	).$Receiver;
	return typeof receiverId === "string" ? receiverId : undefined;
}

export function receiverFault(
	node: object,
	rootHasId = false
): {
	problem: string;
	rule: string;
} | null {
	if (!Object.hasOwn(node, "$Receiver")) {
		return null;
	}
	const fields = node as {
		$Id?: unknown;
		$Receiver: unknown;
	};
	const receiverId = fields.$Receiver;
	if (receiverId === undefined) {
		return null;
	}
	if (typeof receiverId !== "string" || receiverId === "") {
		return {
			problem: receiverId === "" ? "an empty $Receiver" : `a $Receiver of type "${receiverId === null ? "null" : typeof receiverId}"`,
			rule: "A $Receiver is a receiver's Id, a non-empty string."
		};
	}
	if (!rootHasId && (typeof fields.$Id !== "string" || fields.$Id === "")) {
		return {
			problem: `the $Receiver ${JSON.stringify(receiverId)} on a node with no $Id`,
			rule: "Only an entity is bound to a receiver."
		};
	}
	return null;
}

export function refuseReceiverWrite(target: object, next: unknown): never {
	const fields = target as {
		$Id?: unknown;
		$Receiver?: unknown;
	};
	if (typeof fields.$Id !== "string") {
		throw new TypeError(
			"[treflex] draft: this write puts a $Receiver on a node with no $Id, and the write was refused. Only an entity is bound to a receiver."
		);
	}
	throw new TypeError(
		`[treflex] draft: this write would change entity ${JSON.stringify(fields.$Id)}'s $Receiver from ${JSON.stringify(fields.$Receiver ?? null)} ` +
			`to ${JSON.stringify(next ?? null)}, and the write was refused. An entity's binding changes through bind(draft, Receiver) or ` +
			"unbind(draft), so a copy of a row or a server item can't rebind it."
	);
}

export function refuseAnyId(value: unknown, where: string, why: string): void {
	const seen = new Set<object>();
	const visit = (node: unknown, path: readonly string[]): void => {
		if (node === null || typeof node !== "object" || seen.has(node)) {
			return;
		}
		seen.add(node);
		for (const key of Object.keys(node)) {
			const child = (node as Record<string, unknown>)[key];
			if (key === "$Id" && child !== undefined) {
				const at = path.length > 0 ? ` at [${path.join(".")}]` : "";
				throw new HandWrittenIdError(child, `${where} holds the $Id ${JSON.stringify(child)}${at}, and it was refused. ${why}`);
			}
			visit(child, [
				...path,
				key
			]);
		}
	};
	visit(value, []);
}

// Read off a recording proxy, answers a write that skips the replacement refusal.
// Symbol.for by the cross-module tag-symbol rule (see REGION_OP in open.ts).
export const SEAT_WRITE = Symbol.for("treflex.seatWrite");

// Read off a recording proxy, answers a write of $Receiver that skips the binding refusal.
// Symbol.for by the cross-module tag-symbol rule (see REGION_OP in open.ts).
export const BIND_WRITE = Symbol.for("treflex.bindWrite");

export function seat(live: object, key: string | number, value: unknown, owned = false): void {
	(
		live as {
			[SEAT_WRITE]: (key: string | number, value: unknown, owned: boolean) => void;
		}
	)[SEAT_WRITE](key, value, owned);
}

export function isDraftNode(target: object): boolean {
	return (target as Record<symbol, unknown>)[RECORDING_TARGET] !== undefined;
}

export function isAttached(ref: unknown): boolean {
	if (ref === null || typeof ref !== "object") {
		return true;
	}
	const probe = (ref as Record<symbol, unknown>)[DETACH_PROBE];
	return probe === undefined ? true : (probe as boolean);
}
