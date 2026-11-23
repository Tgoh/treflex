import type { IWriteGateway } from "../Runtime/createWriteGateway";
import type { IRecordChange, IRecordLanding } from "../Types/IRecord";
import type { IHistoryEntry } from "./history";
import { entityIdOf, seat } from "../Runtime/draftNode";
import { wrapSetState } from "../Runtime/sliceSetState";
import { errorClass } from "../Utility/errorClasses";
import { jsonEquals } from "../Utility/jsonEquals";

/** A change that the rewind, or a forward application, can't make as the history recorded it. */
export class RewindRefusedError extends Error {
	constructor(reason: string) {
		super(`[treflex] resume: ${reason}`);
		this.name = "RewindRefusedError";
	}
}

errorClass("treflex/RewindRefusedError", RewindRefusedError);

/**
 * One entity's changes, undone and applied again through the write gateway. Each call is one frame; a call
 * that throws has undone its own writes, and leaves the session spent, so its caller unwinds the scope.
 */
export interface IEntityRewind {
	/** Undoes the entries' changes, newest first, in one rewind frame: the entity as it was before the first. */
	rewind(entries: readonly IHistoryEntry[]): void;
	/** Applies the changes as they were recorded, in order, in one exempt frame. */
	forward(changes: readonly IRecordChange[]): void;
}

type IPlace = {
	container: Record<string, unknown>;
	key: string;
};

function isNode(value: unknown): value is object {
	return value !== null && typeof value === "object";
}

function refuse(reason: string): never {
	throw new RewindRefusedError(reason);
}

/** Opens a session on the entity with this `$Id`, inside a write scope the caller holds. */
export function entityRewind(gateway: IWriteGateway, entityId: string): IEntityRewind {
	const write = wrapSetState(gateway.rootNode(), gateway);
	// One that has gone back keeps its entry: the tree is searched first.
	const loose = new Map<string, object>();
	const takenBy = new WeakMap<IRecordChange, object>();

	function inTree(root: object, id: string): object | undefined {
		let found: object | undefined;
		const visit = (node: object): void => {
			if (entityIdOf(node) === id) {
				if (found !== undefined && found !== node) {
					refuse(`two nodes below "${entityId}" carry the $Id "${id}"`);
				}
				found = node;
			}
			for (const child of Object.values(node)) {
				if (isNode(child)) {
					visit(child);
				}
			}
		};
		visit(root);
		return found;
	}

	function placeOf(
		root: object,
		change: IRecordChange & {
			Landing: IRecordLanding;
		}
	): IPlace | null {
		const { EntityId, Path } = change.Landing;
		if (Path.length === 0) {
			refuse(`a change in "${EntityId}" names no place`);
		}
		let node: object | undefined = EntityId === entityId ? root : (inTree(root, EntityId) ?? loose.get(EntityId));
		if (node === undefined) {
			if (gateway.rootNameOf(EntityId) === "AppState") {
				refuse(`a change lands in "${EntityId}", which the tree holds outside "${entityId}"`);
			}
			// In a transient, which the rewind leaves alone, or in no place, which the change that put it back has copied.
			return null;
		}
		for (let at = 0; at < Path.length - 1; at++) {
			const next: unknown = (node as Record<string, unknown>)[String(Path[at])];
			if (!isNode(next) || entityIdOf(next) !== null) {
				refuse(`a change in "${EntityId}" at [${Path.join(".")}] doesn't find the place the history names`);
			}
			node = next;
		}
		const key = String(Path[Path.length - 1]);
		if (key === "$Id" || key === "$Receiver" || key === "__proto__") {
			refuse(`a change of "${key}" can't be made again exactly`);
		}
		return {
			container: node as Record<string, unknown>,
			key
		};
	}

	function build(root: object, value: unknown): unknown {
		if (!isNode(value)) {
			return value;
		}
		if (Object.hasOwn(value, "$Receiver")) {
			refuse("a bound node's copy can't be put back exactly");
		}
		const id = entityIdOf(value);
		if (id !== null) {
			if (id === entityId) {
				refuse(`a change would put "${entityId}" inside itself`);
			}
			const node = inTree(root, id) ?? loose.get(id);
			if (node !== undefined) {
				if (!jsonEquals(node, value)) {
					refuse(`"${id}" is not as the history's copy of it`);
				}
				return node;
			}
			const where = gateway.rootNameOf(id);
			if (where !== undefined) {
				refuse(`"${id}" would be put back in "${entityId}" while it lives in ${where} outside it`);
			}
		}
		if (Array.isArray(value)) {
			return value.map((child) => build(root, child));
		}
		const made: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			made[key] = build(root, (value as Record<string, unknown>)[key]);
		}
		return made;
	}

	function takeOut(old: unknown, change?: IRecordChange): void {
		if (!isNode(old)) {
			return;
		}
		if (change) {
			takenBy.set(change, old);
		}
		const visit = (node: object): void => {
			const id = entityIdOf(node);
			if (id !== null) {
				loose.set(id, node);
			}
			for (const child of Object.values(node)) {
				if (isNode(child)) {
					visit(child);
				}
			}
		};
		visit(old);
	}

	function put({ container, key }: IPlace, value: unknown): void {
		write.at(container, [], (draft: Record<string, unknown>) => {
			if (isNode(value)) {
				seat(draft, key, value, true);
			} else {
				draft[key] = value;
			}
		});
	}

	function remove({ container, key }: IPlace): void {
		write.at(container, [], (draft: Record<string, unknown>) => {
			delete draft[key];
		});
	}

	function setLength({ container }: IPlace, length: unknown): void {
		if (typeof length !== "number") {
			refuse("an array's length in the history is not a number");
		}
		write.at(container as unknown as unknown[], [], (draft: unknown[]) => {
			draft.length = length;
		});
	}

	function mismatch(
		change: IRecordChange & {
			Landing: IRecordLanding;
		}
	): never {
		return refuse(
			`a change in "${change.Landing.EntityId}" at [${change.Landing.Path.join(".")}] doesn't find what the history says is there`
		);
	}

	function backward(root: object, change: IRecordChange): void {
		if (!change.Landing) {
			return;
		}
		const landed = change as IRecordChange & {
			Landing: IRecordLanding;
		};
		const place = placeOf(root, landed);
		if (place === null) {
			return;
		}
		const { container, key } = place;
		if (Array.isArray(container) && key === "length") {
			if (container.length !== change.Value) {
				mismatch(landed);
			}
			setLength(place, change.Prev);
			return;
		}
		const has = Object.hasOwn(container, key);
		const now = container[key];
		if (change.Deleted ? has : !has || !jsonEquals(now, change.Value)) {
			mismatch(landed);
		}
		if (change.Created && change.GrewFrom !== undefined) {
			if (!Array.isArray(container) || container.length !== Number(key) + 1) {
				mismatch(landed);
			}
			setLength(place, change.GrewFrom);
		} else if (change.Created) {
			remove(place);
		} else {
			put(place, build(root, change.Prev));
		}
		takeOut(has ? now : undefined, change);
	}

	function forward(root: object, change: IRecordChange): void {
		if (!change.Landing) {
			return;
		}
		const landed = change as IRecordChange & {
			Landing: IRecordLanding;
		};
		const place = placeOf(root, landed);
		if (place === null) {
			return;
		}
		const { container, key } = place;
		if (Array.isArray(container) && key === "length") {
			if (container.length !== change.Prev) {
				mismatch(landed);
			}
			setLength(place, change.Value);
			return;
		}
		const has = Object.hasOwn(container, key);
		const now = container[key];
		const expected = change.Created
			? !has && (change.GrewFrom === undefined || (Array.isArray(container) && container.length === change.GrewFrom))
			: has && jsonEquals(now, change.Prev);
		if (!expected) {
			mismatch(landed);
		}
		if (change.Deleted) {
			remove(place);
		} else {
			const held = takenBy.get(change);
			const placed = held !== undefined && jsonEquals(held, change.Value) ? held : build(root, change.Value);
			refuseReturned(placed);
			put(place, placed);
		}
		takeOut(has ? now : undefined);
	}

	// Within a session only a forward frame marks a node detached: one it took out of the entity, by a move out or a
	// delete, so a detached node here left the entity in an earlier frame.
	function refuseReturned(value: unknown): void {
		if (!isNode(value)) {
			return;
		}
		if (gateway.isDetached(value)) {
			const id = entityIdOf(value);
			refuse(`${id === null ? "a node" : `"${id}"`} left "${entityId}" and would be put back in it`);
		}
		for (const child of Object.values(value)) {
			refuseReturned(child);
		}
	}

	function inFrame(frame: (fn: () => void) => void, run: (root: object) => void): void {
		frame(() => {
			const root = gateway.cellOf(entityId) ?? refuse(`"${entityId}" is not in the tree`);
			const mark = gateway.logMark();
			try {
				run(root);
			} catch (error) {
				gateway.unwindTo(mark);
				throw error;
			} finally {
				gateway.releaseMark();
			}
		});
	}

	return {
		rewind(entries) {
			inFrame(
				(fn) => gateway.rewindFrame(fn),
				(root) => {
					for (let at = entries.length - 1; at >= 0; at--) {
						const entry = entries[at]!;
						if (entry.Kind === "step") {
							for (let c = entry.Changes.length - 1; c >= 0; c--) {
								backward(root, entry.Changes[c]!);
							}
						} else if (entry.Kind === "other") {
							backward(root, entry.Change);
						}
					}
				}
			);
		},
		forward(changes) {
			inFrame(
				(fn) => gateway.exemptFrame(fn),
				(root) => {
					for (const change of changes) {
						forward(root, change);
					}
				}
			);
		}
	};
}
