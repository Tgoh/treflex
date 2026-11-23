import type { IDiagEmitter } from "../Types/IRuntimeEvent";
import { host } from "../Reactive/host";
import { consoleDiag } from "../Types/IRuntimeEvent";
import { globalWeakMap } from "../Utility/globalWeakMap";
import { cloneStrict } from "../Utility/valueCodec";
import { receiverFault, refuseAnyId } from "./draftNode";
import { NonPlainDataError } from "./nonPlainDataError";
import { TreflexRefusal } from "./refusal";
import { tracking } from "./tracking";

// The cache is unconditional and never evicted: proxy identity per raw is what
// keyed <For> blocks, reference-keyed caches, and cycle guards in consuming code
// rely on.

// Answered by a view proxy with its raw target. Symbol.for by the
// cross-module tag-symbol rule (see REGION_OP in open.ts).
export const RAW = Symbol.for("treflex.viewRaw");

// The recording proxy's capture symbol, by registry name rather than
// import: recordingProxy.ts imports unwrapValue from here, so an import the
// other way would be a cycle.
const RECORDING_TARGET = Symbol.for("treflex.recordingTarget");

// On globalThis, like hmrRegistry's registry: two evaluations of this
// module must hand out the same proxy per raw, or reference-keyed For
// blocks and cycle guards in consuming code see two identities.
const views = globalWeakMap<object, object>("__treflex_views__");

// Plain objects and arrays get a view; Dates, Maps, class instances, and
// everything else pass through raw, because a Proxy over an exotic object
// breaks its internal-slot methods.
export function isWrappable(value: unknown): value is object {
	if (value === null || typeof value !== "object") {
		return false;
	}
	if (Array.isArray(value)) {
		return true;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === null || proto === Object.prototype;
}

// Total: gateway sites depend on a bare raw falling through unchanged.
export function rawOf<T>(value: T): T {
	if (value === null || typeof value !== "object") {
		return value;
	}
	const raw = (value as Record<symbol, unknown>)[RAW];
	if (raw !== undefined) {
		return raw as T;
	}
	const recorded = (value as Record<symbol, unknown>)[RECORDING_TARGET];
	if (recorded !== undefined) {
		return rawOf(recorded as T);
	}
	return value;
}

export function refuseNonPlain(at: readonly PropertyKey[], kind: string): never {
	throw new NonPlainDataError("a write to state", kind, at, "Nothing was written.");
}

export function unwrapValue<T>(
	item: T,
	path: readonly PropertyKey[] = [],
	key?: PropertyKey,
	walked?: object[],
	made?: Set<object>,
	onLive?: (node: object) => void
): T {
	const type = typeof item;
	if (item === null || type === "string" || type === "boolean" || type === "undefined" || (type === "number" && Number.isFinite(item))) {
		return item;
	}
	const copy = cloneStrict(item, {
		live: onLive
			? (node) => {
					const raw = rawOf(node);
					if (raw !== node) {
						onLive(raw);
					}
					return raw;
				}
			: rawOf,
		walked,
		made
	});
	if (!copy.ok) {
		return refuseNonPlain(
			[
				...path,
				...(key === undefined
					? []
					: [
							key
						]),
				...copy.path
			],
			copy.kind
		);
	}
	return copy.value as T;
}

export function freezeAll(containers: readonly object[]): void {
	for (const container of containers) {
		Object.freeze(container);
	}
}

// A seed starts a new tree, so a proxy in one is copied too rather than staying its node.
// `stampedRoot`: the caller gives the copy's root its $Id.
export function copySeed<T>(seed: T, what: string, stampedRoot = false): T {
	const walked: object[] = [];
	const copy = cloneStrict(seed, {
		unwrap: rawOf,
		walked
	});
	if (!copy.ok) {
		throw new NonPlainDataError(what, copy.kind, copy.path);
	}
	refuseIdShape(copy.value, what, stampedRoot);
	freezeAll(walked);
	return copy.value as T;
}

// The copy has no alias or loop left, so what a seed can still break is an $Id: one that isn't a
// non-empty string, or one on two nodes, which is also what an entity at two keys copies into.
// And a $Receiver that isn't a string, or sits on a node with no $Id.
function refuseIdShape(tree: unknown, what: string, stampedRoot: boolean): void {
	const at = new Map<string, string>();
	const path: string[] = [];
	const visit = (node: unknown): void => {
		if (node === null || typeof node !== "object") {
			return;
		}
		const fault = receiverFault(node, stampedRoot && node === tree);
		if (fault) {
			throw new TypeError(`[treflex] ${what} holds ${fault.problem} at [${path.length > 0 ? path.join(".") : "(root)"}]. ${fault.rule}`);
		}
		if (Object.hasOwn(node, "$Id")) {
			const id = (
				node as {
					$Id: unknown;
				}
			).$Id;
			const where = path.length > 0 ? path.join(".") : "(root)";
			if (id !== undefined && id !== null && (typeof id !== "string" || id === "")) {
				throw new TypeError(
					`[treflex] ${what} holds ${id === "" ? "an empty $Id" : `a $Id of type "${typeof id}"`} at [${where}]. An $Id is a non-empty string.`
				);
			}
			if (typeof id === "string") {
				const first = at.get(id);
				if (first !== undefined) {
					throw new Error(
						`[treflex] ${what} holds the $Id "${id}" at [${first}] and [${where}]. An $Id names one node, so an entity sits at one key: ` +
							"store its $Id at the other."
					);
				}
				at.set(id, where);
			}
		}
		for (const key of Object.keys(node)) {
			path.push(key);
			visit((node as Record<string, unknown>)[key]);
			path.pop();
		}
	};
	visit(tree);
}

export function copyComponentSeed(seed: unknown, id: string, where: string): object {
	if (!isWrappable(seed) || Array.isArray(seed)) {
		throw new TypeError(`[treflex] ${where}: the factory has to return an object, which the framework stamps with the root's $Id.`);
	}
	const what = `${where}: the factory's result`;
	const copy = copySeed(seed, what, true);
	refuseAnyId(
		copy,
		what,
		"A factory runs once per mount, so two mounts would share it. The framework stamps the root's $Id, and the component's own action makes a " +
			"nested entity with yield* entity(...). To edit a copy of a row, seed from withoutIds(row)"
	);
	return {
		$Id: id,
		...copy
	};
}

// Each runtime registers its bus half at construction and unregisters at dispose. Held
// weakly, so a runtime nobody disposed is not kept alive by this module.
const emitters = new Set<WeakRef<IDiagEmitter>>();
export function setViewDiagEmitter(emit: IDiagEmitter): () => void {
	const ref = new WeakRef(emit);
	emitters.add(ref);
	return () => {
		emitters.delete(ref);
	};
}
function emitDiag(event: Parameters<IDiagEmitter>[0]): void {
	consoleDiag(event);
	for (const ref of emitters) {
		const emit = ref.deref();
		if (emit) {
			emit(event);
		} else {
			emitters.delete(ref);
		}
	}
}

function refuseWrite(key: PropertyKey, verb: string): never {
	const message = `[treflex] state is read-only outside a dispatch — this ${verb} of "${String(key)}" went through a state view. Dispatch an action.`;
	emitDiag({
		severity: "warn",
		code: "state/view-write",
		message,
		data: {
			key: String(key),
			verb
		}
	});
	throw new TreflexRefusal(message);
}

function wrap(value: unknown): unknown {
	return isWrappable(value) ? view(value) : value;
}

const traps: ProxyHandler<any> = {
	get(target, key, receiver) {
		if (key === RAW) {
			return target;
		}
		if (key === host.TRACK) {
			tracking.trackShape(target);
			return receiver;
		}
		if (typeof key === "symbol" || key === "__proto__") {
			return target[key];
		}
		const value = target[key];
		// Inherited functions (array methods) are not tracked and never
		// wrapped: `view.map(fn)` is an ordinary call with the view as
		// receiver, so the reads inside it track per key.
		if (typeof value === "function" && !Object.hasOwn(target, key)) {
			return value;
		}
		tracking.trackKey(target, key);
		return wrap(value);
	},
	has(target, key) {
		if (typeof key !== "symbol") {
			tracking.trackHas(target, key);
		}
		return key in target;
	},
	ownKeys(target) {
		tracking.trackShape(target);
		return Reflect.ownKeys(target);
	},
	getOwnPropertyDescriptor(target, key) {
		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
		// A non-configurable property (an array's length) must be reported
		// as the target holds it, or the proxy invariant throws.
		if (!descriptor || descriptor.get || !descriptor.configurable || typeof key === "symbol") {
			return descriptor;
		}
		return {
			...descriptor,
			value: wrap(target[key])
		};
	},
	set(_target, key) {
		return refuseWrite(key, "write");
	},
	deleteProperty(_target, key) {
		return refuseWrite(key, "delete");
	},
	defineProperty(_target, key) {
		return refuseWrite(key, "define");
	}
};

export function view<T>(raw: T): T {
	if (!isWrappable(raw)) {
		return raw;
	}
	// Any proxy flavour resolves to its raw first, so the cache is keyed
	// by raw alone and view(view(x)) is view(x).
	const target: object = rawOf(raw);
	const cached = views.get(target);
	if (cached) {
		return cached as T;
	}
	const proxy: object = new Proxy(target, traps);
	views.set(target, proxy);
	return proxy as T;
}
