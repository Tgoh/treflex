import type { IAction, ISelector } from "treflex";
import type { IFeature } from "./createEntityFeature";
import { untrack } from "solid-js";

interface IDispatchSlice {
	dispatch: (action: any, target: any, ...args: any[]) => Promise<any>;
	runSelector: (selector: any, getState: () => any) => any;
}

// Only the `get` trap is implemented: `in` checks, spread, and Object.keys see an
// empty object. `state` comes first so an action or selector export cannot shadow it.
export function buildContextProxy<T, A extends Record<string, Function>, S extends Record<string, Function>>(
	stateAccessor: () => T,
	actionsRef: {
		current: A;
	},
	selectorsRef: {
		current: S;
	},
	treflex: IDispatchSlice
): IFeature<T, A, S> {
	const actionCache = new Map<string, Function>();
	const selectorCache = new Map<string, Function>();

	function getAction(prop: string): Function {
		const cached = actionCache.get(prop);
		if (cached) {
			return cached;
		}
		// Reads the ref at call time, so an edited action applies on the next call.
		const fn = (...args: any[]) => {
			const action = (actionsRef.current as Record<string, Function>)[prop];
			if (typeof action !== "function") {
				throw new Error(`[treflex] No action named "${prop}" — was it removed from the feature module, or is "${prop}" reserved?`);
			}
			return treflex.dispatch(action as IAction<T>, untrack(stateAccessor), ...args);
		};
		actionCache.set(prop, fn);
		return fn;
	}

	function getSelector(prop: string): Function {
		const cached = selectorCache.get(prop);
		if (cached) {
			return cached;
		}
		const fn = () => {
			const selector = (selectorsRef.current as Record<string, Function>)[prop];
			if (typeof selector !== "function") {
				throw new Error(`[treflex] No selector named "${prop}" — was it removed from the feature module?`);
			}
			return treflex.runSelector(selector as ISelector<T>, stateAccessor);
		};
		selectorCache.set(prop, fn);
		return fn;
	}

	function hasAction(prop: string): boolean {
		return Object.hasOwn(actionsRef.current, prop) && typeof (actionsRef.current as Record<string, unknown>)[prop] === "function";
	}

	function hasSelector(prop: string): boolean {
		return Object.hasOwn(selectorsRef.current, prop) && typeof (selectorsRef.current as Record<string, unknown>)[prop] === "function";
	}

	return new Proxy({} as IFeature<T, A, S>, {
		get(_target, prop) {
			if (prop === "state") {
				return stateAccessor();
			}
			if (typeof prop !== "string") {
				return undefined;
			}
			if (hasAction(prop)) {
				return getAction(prop);
			}
			if (hasSelector(prop)) {
				return getSelector(prop);
			}
			return undefined;
		}
	});
}
