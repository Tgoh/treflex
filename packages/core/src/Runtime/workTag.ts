import type { IMarkable, IOnEntity } from "./arrivalPolicy";
import { DEV } from "../Utility/devMode";

// Symbol.for by the cross-module tag-symbol rule (see REGION_OP in open.ts).
const WORK_TAG = Symbol.for("treflex.workTag");
const WORK_TAGS = Symbol.for("treflex.workTags");

/**
 * A category of work an app defines once and marks actions with. `inFlight(tag, owner)` is true
 * while work carrying it has arrived on the owner and not ended. See docs/reference/actions.md#work-tags.
 */
export interface IWorkTag {
	/** For errors. Two tags with one name are two tags. */
	readonly name: string;
	/** Tags each function, for every caller of it. Call it in the module that defines the function. */
	mark<const F extends readonly IMarkable[]>(...actions: { [K in keyof F]: F[K] & IOnEntity<F[K]> }): void;
}

const NO_TAGS: readonly IWorkTag[] = Object.freeze([]);

const arrived = new WeakSet<object>();

export function isWorkTag(value: unknown): value is IWorkTag {
	return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[WORK_TAG] === true;
}

export function tagsOf(fn: unknown): readonly IWorkTag[] {
	if (typeof fn !== "function") {
		return NO_TAGS;
	}
	return ((fn as unknown as Record<symbol, unknown>)[WORK_TAGS] as readonly IWorkTag[] | undefined) ?? NO_TAGS;
}

export function noteArrival(fns: readonly object[]): void {
	if (DEV) {
		for (const fn of fns) {
			if (typeof fn === "function") {
				arrived.add(fn);
			}
		}
	}
}

/**
 * Defines a work tag. Identity is the object returned, so define it once, in a module every
 * marking module and every reader imports.
 */
export function workTag(name: string): IWorkTag {
	if (typeof name !== "string" || name === "") {
		throw new TypeError("[treflex] workTag(): pass a name.");
	}
	const tag: IWorkTag = Object.freeze({
		[WORK_TAG]: true,
		name,
		mark(...actions: readonly IMarkable[]): void {
			actions.forEach((action, at) => {
				if (typeof action !== "function") {
					throw new TypeError(`[treflex] work tag "${name}": mark() takes action functions.`);
				}
				const label = action.name || "(anonymous)";
				if (tagsOf(action).includes(tag) || actions.indexOf(action) !== at) {
					throw new Error(
						`[treflex] work tag "${name}": action "${label}" is already marked with it. ` +
							`A function takes each tag once, in the module that defines it.`
					);
				}
				if (DEV && arrived.has(action)) {
					throw new Error(
						`[treflex] work tag "${name}": action "${label}" has already been dispatched or delivered, so the work that arrived before ` +
							`this mark isn't counted under the tag. Mark it in the module that defines it, straight after its declaration.`
					);
				}
			});
			for (const action of actions) {
				Object.defineProperty(action, WORK_TAGS, {
					value: Object.freeze([
						...tagsOf(action),
						tag
					]),
					configurable: true
				});
			}
		}
	});
	return tag;
}
