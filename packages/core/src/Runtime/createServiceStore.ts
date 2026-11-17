import type { IRuntimeServiceKey, IRuntimeServiceValue } from "../Registries/IRuntimeServiceRegistry";

export interface IServiceStore {
	set: <K extends IRuntimeServiceKey>(key: K, value: IRuntimeServiceValue<K>) => void;
	get: <K extends IRuntimeServiceKey>(key: K) => IRuntimeServiceValue<K>;
}

// Per-runtime store for typed values registered via runtime.set. Missing
// keys throw at the read site — loud failure for unregistered keys rather
// than silent undefined.
export function createServiceStore(): IServiceStore {
	const store = new Map<string, unknown>();

	function set<K extends IRuntimeServiceKey>(key: K, value: IRuntimeServiceValue<K>): void {
		store.set(key, value);
	}

	function get<K extends IRuntimeServiceKey>(key: K): IRuntimeServiceValue<K> {
		if (!store.has(key)) {
			throw new Error(
				`[treflex] No runtime value registered for key "${String(key)}". Did you forget to call runtime.set("${String(key)}", ...) at startup?`
			);
		}
		return store.get(key) as IRuntimeServiceValue<K>;
	}

	return {
		set,
		get
	};
}
