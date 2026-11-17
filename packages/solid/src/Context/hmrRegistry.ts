import { createContext, useContext } from "solid-js";
import { DEV } from "treflex/internal";

export type IHmrRegistryEntry = {
	context: any;
	actionsRef: {
		current: any;
	};
	selectorsRef: {
		current: any;
	};
};

// import.meta.url in every host: a scheme followed by "://" (http, https,
// file). A hand-picked id has no scheme.
function isUrlShaped(id: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(id);
}

export function normaliseRegistryKey(id: string): string {
	const queryAt = id.indexOf("?");
	const hashAt = id.indexOf("#");
	let end = id.length;
	if (queryAt !== -1) end = Math.min(end, queryAt);
	if (hashAt !== -1) end = Math.min(end, hashAt);
	return end === id.length ? id : id.slice(0, end);
}

export interface IHmrRegistry {
	get(id: string): IHmrRegistryEntry | undefined;
	set(id: string, entry: IHmrRegistryEntry): void;
}

function getRegistry(globalKey: string): IHmrRegistry {
	const g = globalThis as Record<string, unknown>;
	let map = g[globalKey] as Map<string, IHmrRegistryEntry> | undefined;
	if (!map) {
		map = new Map<string, IHmrRegistryEntry>();
		g[globalKey] = map;
	}
	const storage = map;
	return {
		get(id) {
			return storage.get(normaliseRegistryKey(id));
		},
		set(id, entry) {
			storage.set(normaliseRegistryKey(id), entry);
		}
	};
}

export const entityFeatureRegistry = getRegistry("__treflex_entity_feature_registry__");
export const componentFeatureRegistry = getRegistry("__treflex_component_feature_registry__");

export function resolveFeatureEntry(
	registry: IHmrRegistry,
	id: string | undefined,
	actions: Record<string, any>,
	selectors: Record<string, any>
): IHmrRegistryEntry {
	const effectiveId = id !== undefined && !DEV && isUrlShaped(id) ? undefined : id;
	const existing = effectiveId ? registry.get(effectiveId) : undefined;
	if (existing) {
		existing.actionsRef.current = actions;
		existing.selectorsRef.current = selectors;
		return existing;
	}
	const entry: IHmrRegistryEntry = {
		context: createContext(),
		actionsRef: {
			current: actions
		},
		selectorsRef: {
			current: selectors
		}
	};
	if (effectiveId) {
		registry.set(effectiveId, entry);
	}
	return entry;
}

export function makeUse<V>(context: any, factoryName: string, id: string | undefined): () => V {
	return () => {
		const value = useContext(context);
		if (!value) {
			throw new Error(
				`[treflex] ${factoryName} use() called outside the matching provider${id ? ` (${id})` : ""}. ` +
					`Ensure the calling component is rendered inside the corresponding ${factoryName} provider.`
			);
		}
		return value as V;
	};
}
