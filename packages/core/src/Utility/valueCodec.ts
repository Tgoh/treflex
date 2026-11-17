const CYCLE = Symbol("treflex.codec.cycle");

const noChildren = (child: unknown): unknown => child;

export function cloneNode(value: unknown, cloneChild: (child: unknown) => unknown): unknown {
	if (value === null || typeof value !== "object") {
		const t = typeof value;
		if (t === "function" || t === "symbol" || t === "bigint") {
			return undefined;
		}
		return value;
	}
	if (Array.isArray(value)) {
		const arr = new Array(value.length);
		for (let i = 0; i < value.length; i++) {
			arr[i] = cloneChild(value[i]);
		}
		return arr;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) {
		return undefined;
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		// An own "__proto__", which a computed key or JSON.parse makes, would
		// assign to the clone's prototype instead of copying a key.
		if (key === "__proto__") {
			continue;
		}
		const cloned = cloneChild((value as Record<string, unknown>)[key]);
		if (cloned !== undefined) {
			out[key] = cloned;
		}
	}
	return out;
}

function walk(value: unknown, seen: Set<object>): unknown {
	if (value !== null && typeof value === "object") {
		if (seen.has(value)) {
			throw CYCLE;
		}
		seen.add(value);
		try {
			return cloneNode(value, (child) => walk(child, seen));
		} finally {
			// Path-based, not visited-based: a sibling re-reference (a DAG)
			// duplicates, only a genuine ancestor cycle aborts.
			seen.delete(value);
		}
	}
	return cloneNode(value, noChildren);
}

export function clone(value: unknown): unknown {
	try {
		return walk(value, new Set());
	} catch (e) {
		if (e === CYCLE) {
			return undefined;
		}
		throw e;
	}
}

export type IStrictClone =
	| {
			ok: true;
			value: unknown;
	  }
	| {
			ok: false;
			path: PropertyKey[];
			kind: string;
	  };

class StrictFailure {
	readonly path: PropertyKey[];
	readonly kind: string;
	constructor(path: PropertyKey[], kind: string) {
		this.path = path;
		this.kind = kind;
	}
}

// A member is frozen and plain at every node, so a further crossing can share it
// rather than copy it. An object copy's fields are members too.
const frozenCopies = new WeakSet<object>();

export interface ICopyOptions {
	unwrap?: (node: object) => object;
	live?: (node: object) => object;
	walked?: object[] | undefined;
	made?: Set<object> | undefined;
	copies?:
		| {
				count: number;
		  }
		| undefined;
}

interface IStrictWalk extends ICopyOptions {
	path: PropertyKey[];
	ancestors: object[];
	freeze: boolean;
}

function strictWalk(value: unknown, walk: IStrictWalk): unknown {
	if (value === null || value === undefined) {
		return value;
	}
	const type = typeof value;
	if (type === "string" || type === "boolean") {
		return value;
	}
	if (type === "number") {
		if (!Number.isFinite(value)) {
			throw new StrictFailure(walk.path, String(value));
		}
		return value;
	}
	if (type !== "object") {
		throw new StrictFailure(walk.path, type);
	}
	if (walk.live) {
		const kept = walk.live(value as object);
		if (kept !== value) {
			return kept;
		}
	}
	const node = walk.unwrap ? walk.unwrap(value as object) : (value as object);
	if (walk.freeze && frozenCopies.has(node)) {
		return node;
	}
	if (walk.ancestors.includes(node)) {
		throw new StrictFailure(walk.path, "cycle");
	}
	walk.ancestors.push(node);
	// What an unwrapped proxy leads to is another tree's, and `walked` is what gets frozen.
	const walked = walk.walked;
	if (node !== value) {
		walk.walked = undefined;
	}
	let out: unknown[] | Record<string, unknown>;
	if (Array.isArray(node)) {
		out = new Array(node.length);
		for (let i = 0; i < node.length; i++) {
			const element = node[i];
			walk.path.push(i);
			if (element === undefined) {
				throw new StrictFailure(walk.path, "undefined array element");
			}
			out[i] = strictWalk(element, walk);
			walk.path.pop();
		}
	} else {
		const proto = Object.getPrototypeOf(node);
		if (proto !== null && proto !== Object.prototype) {
			const name = (
				node as {
					constructor?: {
						name?: string;
					};
				}
			).constructor?.name;
			throw new StrictFailure(walk.path, name || Object.prototype.toString.call(node));
		}
		out = {};
		for (const key of Object.keys(node)) {
			if (key === "__proto__") {
				continue;
			}
			walk.path.push(key);
			const cloned = strictWalk((node as Record<string, unknown>)[key], walk);
			walk.path.pop();
			if (cloned !== undefined) {
				out[key] = cloned;
			}
		}
	}
	walk.ancestors.pop();
	walk.walked = walked;
	if (node === value) {
		walked?.push(node);
	}
	walk.made?.add(out);
	if (walk.copies) {
		walk.copies.count++;
	}
	return walk.freeze ? Object.freeze(out) : out;
}

function runStrict(value: unknown, walk: IStrictWalk): IStrictClone {
	try {
		return {
			ok: true,
			value: strictWalk(value, walk)
		};
	} catch (e) {
		if (e instanceof StrictFailure) {
			return {
				ok: false,
				path: e.path,
				kind: e.kind
			};
		}
		throw e;
	}
}

export function cloneStrict(value: unknown, options?: ICopyOptions): IStrictClone {
	return runStrict(value, {
		...options,
		path: [],
		ancestors: [],
		freeze: false
	});
}

export function isFrozenCopy(value: unknown): boolean {
	return value !== null && typeof value === "object" && frozenCopies.has(value);
}

export function copyFrozen(value: unknown, options?: ICopyOptions): IStrictClone {
	const copy = runStrict(value, {
		...options,
		path: [],
		ancestors: [],
		freeze: true
	});
	if (copy.ok && copy.value !== value && copy.value !== null && typeof copy.value === "object") {
		frozenCopies.add(copy.value);
		if (!Array.isArray(copy.value)) {
			for (const field of Object.values(copy.value)) {
				if (field !== null && typeof field === "object") {
					frozenCopies.add(field);
				}
			}
		}
	}
	return copy;
}

// Each element is a copy of its own, since an argument list is spread apart on the way
// to an action.
export function copyFrozenList(values: readonly unknown[], options?: ICopyOptions): IStrictClone {
	const list = trimTrailingUndefined(values);
	for (let i = 0; i < list.length; i++) {
		const copy = copyFrozen(list[i], options);
		if (!copy.ok) {
			return {
				ok: false,
				path: [
					i,
					...copy.path
				],
				kind: copy.kind
			};
		}
		list[i] = copy.value;
	}
	return {
		ok: true,
		value: Object.freeze(list)
	};
}

export function trimTrailingUndefined(args: readonly unknown[]): unknown[] {
	let end = args.length;
	while (end > 0 && args[end - 1] === undefined) {
		end--;
	}
	return args.slice(0, end);
}
