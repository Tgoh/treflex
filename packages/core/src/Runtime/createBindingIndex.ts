import type { IDiagEmitter } from "../Types/IRuntimeEvent";
import type { IReceiverRegistry } from "./createReceiverRegistry";
import type { IWriteGateway } from "./createWriteGateway";
import { boundReceiverOf } from "./draftNode";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/bindings": IBindingIndex;
	}
}

export interface IBinding {
	OwnerId: string;
	ReceiverId: string;
}

/** Which entities are bound to which receiver, derived from each entity's `$Receiver`. */
export interface IBindingIndex {
	// Read off the node itself, so it is current inside a frame too.
	receiverOf(entityId: string): string | undefined;
	// In tree order: pre-order, an array's elements by index and an object's keys in their order.
	boundTo(receiverId: string): readonly string[];
	// Every entity bound to a receiver that isn't registered, in tree order.
	boundToUnregistered(): readonly string[];
	entries(): IBinding[];
}

const UNRESOLVED_SAMPLE = 10;

export function createBindingIndex(deps: {
	gateway: Pick<IWriteGateway, "cellOf" | "cellIds" | "onCell" | "onDrained" | "pathFrom" | "rootNode">;
	receivers: IReceiverRegistry;
	emitDiag: IDiagEmitter;
}): IBindingIndex {
	const { gateway, receivers, emitDiag } = deps;
	const byEntity = new Map<string, string>();
	const byReceiver = new Map<string, Set<string>>();
	// Dropped at every cell change and drain, since a move reorders entities without touching a binding.
	const ordered = new Map<string, readonly string[]>();
	const dirty = new Set<string>();
	let rebuild = false;
	const reported = new Set<string>();
	const landed = new Set<string>();
	let checkQueued = false;

	function unset(entityId: string): void {
		const receiverId = byEntity.get(entityId);
		if (receiverId === undefined) {
			return;
		}
		byEntity.delete(entityId);
		const owners = byReceiver.get(receiverId)!;
		owners.delete(entityId);
		if (owners.size === 0) {
			byReceiver.delete(receiverId);
		}
	}

	function refresh(entityId: string): void {
		const receiverId = boundReceiverOf(gateway.cellOf(entityId));
		if (byEntity.get(entityId) === receiverId) {
			return;
		}
		unset(entityId);
		if (receiverId === undefined) {
			return;
		}
		byEntity.set(entityId, receiverId);
		const owners = byReceiver.get(receiverId);
		if (owners) {
			owners.add(entityId);
		} else {
			byReceiver.set(
				receiverId,
				new Set([
					entityId
				])
			);
		}
		if (!receivers.get(receiverId)) {
			landed.add(receiverId);
		}
	}

	function flush(): void {
		if (rebuild) {
			rebuild = false;
			dirty.clear();
			const before = new Set(byEntity.keys());
			for (const entityId of gateway.cellIds()) {
				before.delete(entityId);
				refresh(entityId);
			}
			for (const entityId of before) {
				unset(entityId);
			}
		} else if (dirty.size > 0) {
			const ids = [
				...dirty
			];
			dirty.clear();
			for (const entityId of ids) {
				refresh(entityId);
			}
		}
		if (landed.size > 0 && !checkQueued) {
			checkQueued = true;
			// A microtask later, so the registration a startup makes straight after
			// createRuntime is in before a seeded binding is judged.
			queueMicrotask(reportUnresolved);
		}
	}

	function positionOf(root: object, entityId: string): number[] | null {
		const node = gateway.cellOf(entityId);
		const keys = node && gateway.pathFrom(root, node);
		if (!keys) {
			return null;
		}
		const position: number[] = [];
		let parent = root as Record<string, unknown>;
		for (const key of keys) {
			position.push(Array.isArray(parent) ? Number(key) : Object.keys(parent).indexOf(String(key)));
			parent = parent[key as string] as Record<string, unknown>;
		}
		return position;
	}

	function inTreeOrder(owners: ReadonlySet<string>): readonly string[] {
		if (owners.size < 2) {
			return [
				...owners
			];
		}
		const root = gateway.rootNode();
		const placed = [
			...owners
		].map((entityId) => ({
			entityId,
			position: positionOf(root, entityId)
		}));
		placed.sort((a, b) => {
			if (!a.position || !b.position) {
				return a.position ? -1 : b.position ? 1 : a.entityId < b.entityId ? -1 : 1;
			}
			const depth = Math.min(a.position.length, b.position.length);
			for (let i = 0; i < depth; i++) {
				if (a.position[i] !== b.position[i]) {
					return a.position[i]! - b.position[i]!;
				}
			}
			return a.position.length - b.position.length;
		});
		return placed.map((entry) => entry.entityId);
	}

	function reportUnresolved(): void {
		flush();
		checkQueued = false;
		const ids = [
			...landed
		];
		landed.clear();
		for (const receiverId of ids) {
			const owners = byReceiver.get(receiverId);
			if (!owners || reported.has(receiverId) || receivers.get(receiverId)) {
				continue;
			}
			reported.add(receiverId);
			const ownerIds = [
				...owners
			].slice(0, UNRESOLVED_SAMPLE);
			emitDiag({
				severity: "warn",
				code: "receiver/unresolved",
				message:
					`[treflex] ${owners.size} entit${owners.size === 1 ? "y is" : "ies are"} bound to receiver "${receiverId}" ` +
					`(${ownerIds.join(", ")}${owners.size > ownerIds.length ? ", and others" : ""}), which isn't registered, so ` +
					"they hear nothing, and a publishToNearest walk stops at them. Register the receiver at startup with " +
					"runtime.registerReceiver(Receiver).",
				data: {
					receiverId,
					ownerIds,
					count: owners.size,
					kind: "binding"
				}
			});
		}
	}

	gateway.onCell((entityId) => {
		ordered.clear();
		if (!rebuild) {
			dirty.add(entityId);
		}
	});
	gateway.onDrained((touched) => {
		ordered.clear();
		if (touched === null) {
			rebuild = true;
		} else {
			for (const container of touched) {
				const entityId = (
					container as {
						$Id?: unknown;
					}
				).$Id;
				if (typeof entityId === "string" && gateway.cellOf(entityId) === container) {
					dirty.add(entityId);
				}
			}
		}
		flush();
	});
	receivers.onRegister((receiverId) => {
		reported.delete(receiverId);
	});

	return {
		receiverOf: (entityId) => boundReceiverOf(gateway.cellOf(entityId)),
		boundTo(receiverId) {
			flush();
			const owners = byReceiver.get(receiverId);
			if (!owners) {
				return [];
			}
			let order = ordered.get(receiverId);
			if (!order) {
				order = inTreeOrder(owners);
				ordered.set(receiverId, order);
			}
			return order;
		},
		boundToUnregistered() {
			flush();
			const owners = new Set<string>();
			for (const [receiverId, bound] of byReceiver) {
				if (!receivers.get(receiverId)) {
					for (const ownerId of bound) {
						owners.add(ownerId);
					}
				}
			}
			return inTreeOrder(owners);
		},
		entries() {
			flush();
			return [
				...byEntity
			].map(([OwnerId, ReceiverId]) => ({
				OwnerId,
				ReceiverId
			}));
		}
	};
}
