import type { IEntity, IRuntime } from "treflex";
import type { IRuntimeInternal, IWriteGateway } from "treflex/internal";
import { callbackThrew, rawOf } from "treflex/internal";

export interface IFrames {
	root(): unknown;
	entity(id: string): unknown;
	node(id: string): unknown;
	select(result: unknown): unknown;
	subscribe(listener: () => void): () => void;
}

const instances = new WeakMap<object, IFrames>();

// Every runtime's frames and stubs, so a handle from another runtime still reaches its node and
// core refuses it as that runtime's.
const nodeOfHandle = new WeakMap<object, object>();

/** The tree node a frame or stub was built from, if any frames instance built it. */
export function nodeOf(handle: unknown): object | undefined {
	return typeof handle === "object" && handle !== null ? nodeOfHandle.get(handle) : undefined;
}

export function getFrames(runtime: IRuntime<any>): IFrames {
	let frames = instances.get(runtime);
	if (!frames) {
		frames = createFrames(runtime);
		instances.set(runtime, frames);
	}
	return frames;
}

function isEntity(node: object): boolean {
	return typeof (node as Partial<IEntity>).$Id === "string";
}

function createFrames(runtime: IRuntime<any>): IFrames {
	const get = (runtime as IRuntimeInternal<any>).get;
	const gateway = get("runtime/writeGateway") as IWriteGateway;
	const lookup = get("runtime/stateIdLookup");
	const listeners = new Set<() => void>();
	let cache = new WeakMap<object, unknown>();
	// Invariant: a clean node's cached frame is current. A write marks its
	// container and every ancestor up to the nearest one its parent holds as a
	// stub.
	let dirty = new WeakSet<object>();
	// Keyed by raw node. A stub is current while its $Id matches the node's.
	let stubs = new WeakMap<object, IEntity>();
	const selected = new WeakMap<
		object,
		{
			version: number;
			value: unknown;
		}
	>();
	let version = 0;

	function isTreeNode(node: object): boolean {
		return gateway.nodeUpLink(node) !== undefined;
	}

	function upLink(node: object): object | null {
		return gateway.nodeUpLink(node)?.parent ?? null;
	}

	function markStale(container: object): void {
		let node: object | null = container;
		while (node) {
			const wasDirty = dirty.has(node);
			dirty.add(node);
			const stub = stubs.get(node);
			if (stub) {
				if (stub.$Id === (node as IEntity).$Id) {
					return;
				}
				stubs.delete(node);
			} else if (wasDirty) {
				return;
			}
			node = upLink(node);
		}
	}

	gateway.onDrained((touched) => {
		if (touched === null) {
			cache = new WeakMap();
			dirty = new WeakSet();
			stubs = new WeakMap();
		} else {
			for (const container of touched) {
				markStale(container);
			}
		}
		version++;
		for (const listener of [
			...listeners
		]) {
			try {
				listener();
			} catch (error) {
				get("runtime/diag").emit(callbackThrew("A React view's store listener", error));
			}
		}
	});

	function stubOf(raw: object): IEntity {
		const id = (raw as IEntity).$Id;
		let stub = stubs.get(raw);
		if (!stub || stub.$Id !== id) {
			stub = {
				$Id: id
			};
			Object.freeze(stub);
			stubs.set(raw, stub);
			nodeOfHandle.set(stub, raw);
		}
		return stub;
	}

	function childFrame(value: unknown): unknown {
		if (typeof value !== "object" || value === null) {
			return value;
		}
		const raw = rawOf(value) as object;
		if (isTreeNode(raw) && isEntity(raw)) {
			return stubOf(raw);
		}
		return frameOf(raw);
	}

	function frameOf(raw: object): unknown {
		if (!dirty.has(raw) && cache.has(raw)) {
			return cache.get(raw);
		}
		let frame: unknown;
		if (Array.isArray(raw)) {
			frame = raw.map((value) => childFrame(value));
		} else {
			const copy: Record<string, unknown> = {};
			for (const key of Object.keys(raw)) {
				copy[key] = childFrame((raw as Record<string, unknown>)[key]);
			}
			frame = copy;
		}
		Object.freeze(frame);
		cache.set(raw, frame);
		nodeOfHandle.set(frame as object, raw);
		dirty.delete(raw);
		return frame;
	}

	// Inside an entity, the frame rules apply: a nested entity is a stub and a
	// nested container is its frame.
	function convert(value: unknown, prev: unknown, inEntity: boolean): unknown {
		if (typeof value !== "object" || value === null) {
			return value;
		}
		const raw = rawOf(value) as object;
		const tree = isTreeNode(raw);
		if (isEntity(raw)) {
			if (inEntity && tree) {
				return stubOf(raw);
			}
			if (tree) {
				return frameOf(raw);
			}
			return walk(raw, value, prev, true);
		}
		if (inEntity && tree) {
			return frameOf(raw);
		}
		const walked = walk(raw, value, prev, inEntity);
		if (tree && typeof walked === "object" && walked !== null) {
			nodeOfHandle.set(walked, raw);
		}
		return walked;
	}

	// A selector's result is any value, and one can hold a cycle, which a frame can't: the slot
	// that closes it reads as absent. Armed by the first closing slot a select meets. Past it a
	// revisit keeps its first walk: on a dense loop, walking per slot enumerates every simple path.
	const onPath = new Set<object>();
	let walkedPastLoop: Map<object, unknown> | null = null;

	function walk(raw: object, value: object, prev: unknown, inEntity: boolean): unknown {
		if (onPath.has(raw)) {
			walkedPastLoop ??= new Map();
			return undefined;
		}
		if (walkedPastLoop?.has(raw)) {
			return walkedPastLoop.get(raw);
		}
		onPath.add(raw);
		try {
			const result = walkChildren(raw, value, prev, inEntity);
			walkedPastLoop?.set(raw, result);
			return result;
		} finally {
			onPath.delete(raw);
		}
	}

	function walkChildren(raw: object, value: object, prev: unknown, inEntity: boolean): unknown {
		const isArray = Array.isArray(raw);
		const previous =
			typeof prev === "object" && prev !== null && Array.isArray(prev) === isArray ? (prev as Record<string, unknown>) : undefined;
		const keys = Object.keys(raw);
		const out: Record<string, unknown> = isArray ? (new Array(keys.length) as unknown as Record<string, unknown>) : {};
		let samePrevious = previous !== undefined && Object.keys(previous).length === keys.length;
		let sameValue = raw === value;
		for (const key of keys) {
			const original = (raw as Record<string, unknown>)[key];
			const next = convert(original, previous?.[key], inEntity);
			out[key] = next;
			if (!previous || !Object.hasOwn(previous, key) || previous[key] !== next) {
				samePrevious = false;
			}
			if (next !== original) {
				sameValue = false;
			}
		}
		if (samePrevious) {
			return previous;
		}
		if (sameValue) {
			return value;
		}
		Object.freeze(out);
		return out;
	}

	return {
		root: () => frameOf(rawOf(runtime.state) as object),
		entity(id) {
			const node = lookup()[id]?.state;
			return node === undefined ? undefined : frameOf(rawOf(node) as object);
		},
		node: (id) => lookup()[id]?.state,
		select(result) {
			if (typeof result !== "object" || result === null) {
				return result;
			}
			const held = selected.get(result);
			if (held?.version === version) {
				return held.value;
			}
			walkedPastLoop = null;
			const value = convert(result, held?.value, false);
			selected.set(result, {
				version,
				value
			});
			return value;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}
