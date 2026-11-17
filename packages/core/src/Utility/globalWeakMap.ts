// A WeakMap held on globalThis under a fixed key, so a second evaluation
// of the importing module (a Vite duplicate load, an HMR re-evaluation)
// finds the same map. The same shape as hmrRegistry's getRegistry.
export function globalWeakMap<K extends object, V>(globalKey: string): WeakMap<K, V> {
	const g = globalThis as Record<string, unknown>;
	let map = g[globalKey] as WeakMap<K, V> | undefined;
	if (!map) {
		map = new WeakMap<K, V>();
		g[globalKey] = map;
	}
	return map;
}
