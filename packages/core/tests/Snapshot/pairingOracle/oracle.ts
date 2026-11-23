export type Json =
	| null
	| number
	| string
	| boolean
	| Json[]
	| {
			[key: string]: Json;
	  };

export const guidOf = (s: string): string => (s.startsWith("~") ? s.slice(1) : s);

function occurring(tree: Json, post: ReadonlySet<string>): string[] {
	const out = new Set<string>();
	const visit = (v: Json): void => {
		if (typeof v === "string") {
			if (post.has(guidOf(v))) {
				out.add(guidOf(v));
			}
		} else if (Array.isArray(v)) {
			v.forEach(visit);
		} else if (v !== null && typeof v === "object") {
			for (const k of Object.keys(v)) {
				if (post.has(guidOf(k))) {
					out.add(guidOf(k));
				}
				visit(v[k]!);
			}
		}
	};
	visit(tree);
	return [
		...out
	];
}

export function rename(tree: Json, map: ReadonlyMap<string, string>): Json {
	const s = (x: string): string => {
		const to = map.get(guidOf(x));
		return to === undefined ? x : x.startsWith("~") ? `~${to}` : to;
	};
	const visit = (v: Json): Json => {
		if (typeof v === "string") {
			return s(v);
		}
		if (Array.isArray(v)) {
			return v.map(visit);
		}
		if (v !== null && typeof v === "object") {
			const o: Record<string, Json> = {};
			for (const k of Object.keys(v)) {
				o[s(k)] = visit(v[k]!);
			}
			return o;
		}
		return v;
	};
	return visit(tree);
}

export function deepEqual(a: Json, b: Json): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]!));
	}
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
		return false;
	}
	const ka = Object.keys(a);
	return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k]!, b[k]!));
}

/**
 * A one-to-one mapping of the post-point ids the uninterrupted tree holds onto those the restored tree holds, under
 * which the two trees are deeply equal, or undefined when there is none. Every other string compares as written.
 */
export function oracleMapping(e: Json, a: Json, postE: ReadonlySet<string>, postA: ReadonlySet<string>): Map<string, string> | undefined {
	const inE = occurring(e, postE);
	const inA = occurring(a, postA);
	if (inE.length !== inA.length) {
		return undefined;
	}
	const m = new Map<string, string>();
	const taken = new Set<string>();
	const extend = (i: number): boolean => {
		if (i === inE.length) {
			return deepEqual(rename(e, m), a);
		}
		for (const to of inA) {
			if (!taken.has(to)) {
				m.set(inE[i]!, to);
				taken.add(to);
				if (extend(i + 1)) {
					return true;
				}
				taken.delete(to);
			}
		}
		return false;
	};
	return extend(0) ? m : undefined;
}
