import type { Context } from "react";
import { createContext } from "react";
import { DEV } from "treflex/internal";

// The same rules as packages/solid/src/Context/hmrRegistry.ts; a change to
// either belongs in both.

export interface IFeatureEntry<V> {
	context: Context<V | null>;
	actions: {
		current: Record<string, Function>;
	};
	selectors: {
		current: Record<string, Function>;
	};
}

function isUrlShaped(id: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(id);
}

function normalise(id: string): string {
	const queryAt = id.indexOf("?");
	const hashAt = id.indexOf("#");
	let end = id.length;
	if (queryAt !== -1) {
		end = Math.min(end, queryAt);
	}
	if (hashAt !== -1) {
		end = Math.min(end, hashAt);
	}
	return id.slice(0, end);
}

function registryFor(kind: string): Map<string, IFeatureEntry<any>> {
	const g = globalThis as Record<string, unknown>;
	const name = `__treflex_react_${kind}_registry__`;
	let map = g[name] as Map<string, IFeatureEntry<any>> | undefined;
	if (!map) {
		map = new Map();
		g[name] = map;
	}
	return map;
}

// A URL-shaped id registers in development only:
// in a production build it is the chunk's URL, shared by every module in it.
export function resolveFeatureEntry<V>(
	kind: string,
	id: string | undefined,
	actions: Record<string, Function>,
	selectors: Record<string, Function>
): IFeatureEntry<V> {
	const registered = id && (DEV || !isUrlShaped(id)) ? normalise(id) : undefined;
	if (registered === undefined) {
		return {
			context: createContext<V | null>(null),
			actions: {
				current: actions
			},
			selectors: {
				current: selectors
			}
		};
	}
	const registry = registryFor(kind);
	const existing = registry.get(registered) as IFeatureEntry<V> | undefined;
	if (existing) {
		existing.actions.current = actions;
		existing.selectors.current = selectors;
		return existing;
	}
	const entry: IFeatureEntry<V> = {
		context: createContext<V | null>(null),
		actions: {
			current: actions
		},
		selectors: {
			current: selectors
		}
	};
	registry.set(registered, entry);
	return entry;
}
