import type { IStateDifference } from "../../../src/Snapshot/index";
import type { IPair } from "./generate";
import { pairingOf, stateDifferences } from "../../../src/Snapshot/differentialRestore";
import { pairOf, Rng, shuffleKeys } from "./generate";
import { deepEqual, guidOf, type Json, oracleMapping, rename } from "./oracle";

type IPairing = ReturnType<typeof pairingOf>;

interface IVerdict {
	toolSame: boolean;
	diffs: IStateDifference[];
	p: IPairing;
	mapping: Map<string, string> | undefined;
}

function verdict(pair: IPair): IVerdict {
	const p = pairingOf(pair.postE, pair.postA, pair.existing);
	const diffs = stateDifferences(p, pair.e, pair.a);
	return {
		toolSame: diffs.length === 0,
		diffs,
		p,
		mapping: oracleMapping(pair.e, pair.a, pair.postE, pair.postA)
	};
}

function segments(path: string): (string | number)[] {
	const out: (string | number)[] = [];
	if (path === "") {
		return out;
	}
	for (const part of path.split(".")) {
		const m = /^([^[]*)((?:\[\d+\])*)$/.exec(part)!;
		if (m[1] !== "") {
			out.push(m[1]!);
		}
		for (const index of m[2]!.matchAll(/\[(\d+)\]/g)) {
			out.push(Number(index[1]));
		}
	}
	return out;
}

const step = (v: unknown, k: string | number | undefined): unknown =>
	k === undefined || v === null || typeof v !== "object" || !Object.hasOwn(v, k) ? undefined : (v as any)[k];

const sameValue = (x: unknown, y: unknown): boolean => x === y || (x !== undefined && y !== undefined && deepEqual(x as Json, y as Json));

function translate(seg: string | number, from: ReadonlySet<string>, map: ReadonlyMap<string, string>): string | number | undefined {
	if (typeof seg === "number" || !from.has(guidOf(seg))) {
		return seg;
	}
	const to = map.get(guidOf(seg));
	return to === undefined ? undefined : seg.startsWith("~") ? `~${to}` : to;
}

/**
 * True when the entry's `expected` and `actual` are what its path holds in the two trees: read as written in each, or
 * read through the pairing, each minted key taken from the uninterrupted tree except a last key the restored tree alone has.
 */
function truthful(d: IStateDifference, pair: IPair, p: IPairing): boolean {
	const segs = segments(d.path);
	const read = (lastFromA: boolean, paired: boolean): boolean => {
		let e: unknown = pair.e;
		let a: unknown = pair.a;
		segs.forEach((s, i) => {
			if (!paired) {
				e = step(e, s);
				a = step(a, s);
			} else if (lastFromA && i === segs.length - 1) {
				e = step(e, translate(s, p.minted[1], p.back));
				a = step(a, s);
			} else {
				e = step(e, s);
				a = step(a, translate(s, p.minted[0], p.forward));
			}
		});
		return sameValue(e, d.expected) && sameValue(a, d.actual);
	};
	return read(false, false) || read(false, true) || read(true, true);
}

/**
 * True when, under the oracle's mapping, some object holds keys whose ids appear nowhere but as keys of objects keyed by
 * id and in what sits under those keys, and holds them in another order in the restored tree: the limit the reference
 * states.
 */
function withinLimit(pair: IPair, mapping: ReadonlyMap<string, string>): boolean {
	const e = rename(pair.e, mapping);
	const isId = (k: string): boolean => pair.postA.has(guidOf(k)) || pair.existing.has(guidOf(k));
	const elsewhere = new Set<string>();
	const visit = (v: Json, underKey: boolean): void => {
		if (typeof v === "string") {
			if (!underKey) {
				elsewhere.add(guidOf(v));
			}
		} else if (Array.isArray(v)) {
			for (const item of v) {
				visit(item, underKey);
			}
		} else if (v !== null && typeof v === "object") {
			for (const k of Object.keys(v)) {
				visit(v[k]!, underKey || isId(k));
			}
		}
	};
	visit(e, false);
	const keyedOnly = (k: string): boolean => pair.postA.has(guidOf(k)) && !elsewhere.has(guidOf(k));
	let found = false;
	const walk = (x: Json, y: Json): void => {
		if (Array.isArray(x) && Array.isArray(y)) {
			x.forEach((c, i) => {
				walk(c, y[i]!);
			});
		} else if (x !== null && typeof x === "object" && !Array.isArray(x) && y !== null && typeof y === "object" && !Array.isArray(y)) {
			if (Object.keys(x).filter(keyedOnly).join("|") !== Object.keys(y).filter(keyedOnly).join("|")) {
				found = true;
			}
			for (const k of Object.keys(x)) {
				walk(x[k]!, y[k]!);
			}
		}
	};
	walk(e, pair.a);
	return found;
}

function keysBothWays(tree: Json): boolean {
	if (Array.isArray(tree)) {
		return tree.some(keysBothWays);
	}
	if (tree === null || typeof tree !== "object") {
		return false;
	}
	const keys = Object.keys(tree);
	return keys.some((k) => Object.hasOwn(tree, `~${k}`)) || keys.some((k) => keysBothWays(tree[k]!));
}

export interface ISurvey {
	pairs: number;
	keyedBothWays: IPair[];
	unchanged: number;
	unchangedOracleUnequal: IPair[];
	mutatedOracleEqual: number;
	mutatedOracleUnequal: number;
	toolSame: number;
	unsound: IPair[];
	entries: number;
	untruthful: {
		pair: IPair;
		difference: IStateDifference;
	}[];
	misses: number;
	missesOutsideLimit: IPair[];
	reorderFlips: number;
	reorderFlipsOutsideLimit: IPair[];
}

export function survey(count: number): ISurvey {
	const s: ISurvey = {
		pairs: 0,
		keyedBothWays: [],
		unchanged: 0,
		unchangedOracleUnequal: [],
		mutatedOracleEqual: 0,
		mutatedOracleUnequal: 0,
		toolSame: 0,
		unsound: [],
		entries: 0,
		untruthful: [],
		misses: 0,
		missesOutsideLimit: [],
		reorderFlips: 0,
		reorderFlipsOutsideLimit: []
	};
	for (let i = 0; i < count; i++) {
		const pair = pairOf(new Rng(1000 + i), i % 2 === 1);
		if (!pair) {
			continue;
		}
		s.pairs++;
		if (keysBothWays(pair.e) || keysBothWays(pair.a)) {
			s.keyedBothWays.push(pair);
		}
		const v = verdict(pair);
		if (!pair.mutated) {
			s.unchanged++;
			if (!v.mapping) {
				s.unchangedOracleUnequal.push(pair);
			}
		} else if (v.mapping) {
			s.mutatedOracleEqual++;
		} else {
			s.mutatedOracleUnequal++;
		}
		if (v.toolSame) {
			s.toolSame++;
			if (!v.mapping) {
				s.unsound.push(pair);
			}
		}
		for (const d of v.diffs) {
			s.entries++;
			if (!truthful(d, pair, v.p)) {
				s.untruthful.push({
					pair,
					difference: d
				});
			}
		}
		if (!v.toolSame && v.mapping) {
			s.misses++;
			if (!withinLimit(pair, v.mapping)) {
				s.missesOutsideLimit.push(pair);
			}
		}
		const reordered: IPair = {
			...pair,
			e: shuffleKeys(new Rng(7 + i), pair.e, "all", pair.postE)
		};
		const v2 = verdict(reordered);
		if (v2.toolSame !== v.toolSame) {
			s.reorderFlips++;
			if (!v.mapping || !v2.mapping || (!withinLimit(pair, v.mapping) && !withinLimit(reordered, v2.mapping))) {
				s.reorderFlipsOutsideLimit.push(reordered);
			}
		}
	}
	return s;
}
