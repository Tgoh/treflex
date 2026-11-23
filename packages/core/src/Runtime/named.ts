import type { IRuntimeEventOf } from "../Types/IRuntimeEvent";
import type { IMarkable, IOnEntity } from "./arrivalPolicy";
import { DEV } from "../Utility/devMode";
import { errorClass } from "../Utility/errorClasses";
import { hasArrived } from "./workTag";

// Symbol.for by the cross-module tag-symbol rule (see REGION_OP in open.ts).
const ACTION_NAME = Symbol.for("treflex.actionName");
const RECEIVER_ID = Symbol.for("treflex.receiverId");

interface INameEntry {
	fn: object;
	module: string | null;
	ambiguous: boolean;
}

type IDiag = IRuntimeEventOf<"diag">;

interface INameState {
	byName: Map<string, INameEntry>;
	collisions: IDiag[];
	// Weak, so a runtime nobody disposed can still be collected.
	listeners: Set<WeakRef<(event: IDiag) => void>>;
}

// On globalThis, as effectDeclarations.ts keeps its declarations: two copies of treflex share one map.
const STATE_KEY = "__treflex_action_names__";

function state(): INameState {
	const g = globalThis as Record<string, unknown>;
	let held = g[STATE_KEY] as INameState | undefined;
	if (!held) {
		held = {
			byName: new Map(),
			collisions: [],
			listeners: new Set()
		};
		g[STATE_KEY] = held;
	}
	return held;
}

const shared = state();

/** The durable name `named` gave `fn`, or null. */
export function nameOf(fn: unknown): string | null {
	if (typeof fn !== "function") {
		return null;
	}
	const name = (fn as unknown as Record<symbol, unknown>)[ACTION_NAME];
	return typeof name === "string" ? name : null;
}

/** The function's own `name`, or null for an anonymous one. */
export function labelOf(fn: unknown): string | null {
	return typeof fn === "function" && typeof fn.name === "string" && fn.name !== "" ? fn.name : null;
}

/** For messages and diags: the durable name, else the label. */
export function displayName(fn: unknown): string {
	return nameOf(fn) ?? labelOf(fn) ?? "(anonymous)";
}

export function markReceiver(handle: Function, id: string): void {
	Object.defineProperty(handle, RECEIVER_ID, {
		value: id
	});
}

/** The receiver id of a receiver's `handle`, or undefined for any other function. */
export function receiverOf(fn: unknown): string | undefined {
	if (typeof fn !== "function") {
		return undefined;
	}
	const id = (fn as unknown as Record<symbol, unknown>)[RECEIVER_ID];
	return typeof id === "string" ? id : undefined;
}

/** A runtime with `requireNames` was given, in development, an action that would be saved and has no `named` mark. */
export class UnnamedActionError extends Error {
	/** The function's own name, or null for an anonymous one. */
	readonly label: string | null;
	constructor(label: string | null) {
		super(
			`[treflex] action "${label ?? "(anonymous)"}" has no durable name, and this runtime sets requireNames. Name it with ` +
				`named(action, "Feature/Action") in the module that defines it, straight after its declaration, or run ` +
				"`npx treflex-eslint name`, which names the unnamed actions it can find in the project."
		);
		this.name = "UnnamedActionError";
		this.label = label;
	}
}

errorClass("treflex/UnnamedActionError", UnnamedActionError);

/** The function a name resolves to on this page: undefined when no function or more than one claims it. */
export function actionNamed(name: string): Function | undefined {
	const entry = shared.byName.get(name);
	return entry === undefined || entry.ambiguous ? undefined : (entry.fn as Function);
}

function fileOf(frame: string): string | null {
	let location = frame.trim();
	if (location.endsWith(")") && location.includes("(")) {
		location = location.slice(location.lastIndexOf("(") + 1, -1);
	} else if (location.startsWith("at ")) {
		location = location.slice(3);
	} else if (location.includes("@")) {
		location = location.slice(location.indexOf("@") + 1);
	}
	const file = /^(.*?):\d+(?::\d+)?$/.exec(location)?.[1];
	return file ? file.replace(/[?#].*$/, "") : null;
}

/** The file of the first frame in `stack` outside the frame that took it, without its query string. Null when the stack can't be read. */
export function callerModule(stack: string | undefined): string | null {
	if (typeof stack !== "string") {
		return null;
	}
	const files = stack
		.split("\n")
		.map(fileOf)
		.filter((file): file is string => file !== null);
	const own = files[0];
	return own === undefined ? null : (files.find((file) => file !== own) ?? null);
}

/**
 * Hands each production name collision to `listener`, the ones already raised first, while something
 * else keeps `listener` alive. Returns the unsubscribe.
 */
export function hearCollisions(listener: (event: IDiag) => void): () => void {
	for (const event of shared.collisions) {
		listener(event);
	}
	for (const held of shared.listeners) {
		if (held.deref() === undefined) {
			shared.listeners.delete(held);
		}
	}
	const ref = new WeakRef(listener);
	shared.listeners.add(ref);
	return () => {
		shared.listeners.delete(ref);
	};
}

function collide(name: string): void {
	const event: IDiag = {
		severity: "warn",
		code: "action/name-collision",
		message:
			`[treflex] named(): two functions are named "${name}". Both keep recording the name, so their records can't be told ` +
			`apart by it, and it now resolves to neither. Two modules claim one name: give one of them another.`,
		data: {
			name
		}
	};
	shared.collisions.push(event);
	for (const ref of shared.listeners) {
		const listener = ref.deref();
		if (listener) {
			listener(event);
		} else {
			shared.listeners.delete(ref);
		}
	}
}

/**
 * Gives `action` its durable name, for every caller, and returns it. The name keys the action's
 * records, its snapshot entry and a restore's `dropped` entry in every build. Call it in the module
 * that defines the action, once. See docs/reference/actions.md#durable-names.
 */
export function named<F extends IMarkable>(action: F & IOnEntity<F>, name: string): F {
	if (typeof action !== "function") {
		throw new TypeError("[treflex] named(): pass the action function.");
	}
	if (typeof name !== "string" || name === "") {
		throw new TypeError(`[treflex] named(): the name is a non-empty string, not ${typeof name === "string" ? '""' : typeof name}.`);
	}
	const label = labelOf(action) ?? "(anonymous)";
	const already = nameOf(action);
	if (already !== null) {
		throw new Error(
			`[treflex] named(): action "${label}" is already named "${already}", and can't also be "${name}". ` +
				`A function takes one name, once, in the module that defines it.`
		);
	}
	if (DEV && hasArrived(action)) {
		throw new Error(
			`[treflex] named(): action "${label}" has already been dispatched or delivered, so the records made before this mark ` +
				`carry no name. Name it in the module that defines it, straight after its declaration.`
		);
	}
	const module = DEV ? callerModule(new Error().stack) : null;
	const taken = shared.byName.get(name);
	let ambiguous = false;
	if (taken !== undefined) {
		if (DEV) {
			if (taken.module !== null && module !== null && taken.module !== module) {
				throw new Error(
					`[treflex] named(): "${name}" already names action "${labelOf(taken.fn) ?? "(anonymous)"}" in ${taken.module}, ` +
						`and ${module} names "${label}" with it too. One action per name: give one of them another. If the action was ` +
						`moved to ${module} during this session, reload the page: the page keeps the names its modules have marked.`
				);
			}
		} else {
			ambiguous = true;
			collide(name);
		}
	}
	Object.defineProperty(action, ACTION_NAME, {
		value: name
	});
	shared.byName.set(name, {
		fn: action,
		module,
		ambiguous
	});
	return action;
}
