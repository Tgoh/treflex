import type { Json } from "./oracle";

type IObject = Record<string, Json>;

export class Rng {
	private s: number;
	constructor(seed: number) {
		this.s = seed >>> 0;
	}
	next(): number {
		this.s = (this.s + 0x6d2b79f5) >>> 0;
		let t = this.s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
	int(n: number): number {
		return Math.floor(this.next() * n);
	}
	chance(p: number): boolean {
		return this.next() < p;
	}
	pick<T>(xs: readonly T[]): T {
		return xs[this.int(xs.length)]!;
	}
	shuffle<T>(xs: readonly T[]): T[] {
		const out = xs.slice();
		for (let i = out.length - 1; i > 0; i--) {
			const j = this.int(i + 1);
			[out[i], out[j]] = [
				out[j]!,
				out[i]!
			];
		}
		return out;
	}
}

const SYM = /^(~?)@([PQ]\d+)$/;
const HAND = [
	"~seed-1",
	"~seed-2",
	"seed-3",
	"~stepX-1",
	"outbox",
	"~step9-9",
	"step-1"
];
const E_POOL = [
	"step3-1",
	"step3-2",
	"step4-1",
	"step4-2",
	"step5-1",
	"step5-2"
];
const A_POOL = [
	"step3-1",
	"step3-2",
	"step4-1",
	"restore-1",
	"restore-2",
	"step5-1",
	"step6-1"
];
const PRE = [
	"setup-1",
	"step1-1",
	"step2-1"
];

interface ISym {
	tree: Json;
	post: number;
	pre: number;
}

const idsOf = (post: number, pre: number): string[] => [
	...Array.from(
		{
			length: post
		},
		(_, i) => `P${i}`
	),
	...Array.from(
		{
			length: pre
		},
		(_, i) => `Q${i}`
	)
];

function symbolic(r: Rng): ISym {
	const post = r.int(6);
	const pre = r.int(3);
	const ids = idsOf(post, pre);
	const ref = (id: string): string => (r.chance(0.12) ? `@${id}` : `~@${id}`);
	const anyRef = (): Json => (ids.length === 0 || r.chance(0.12) ? (r.chance(0.5) ? null : r.pick(HAND)) : ref(r.pick(ids)));
	const asEntity = r.shuffle(ids).filter(() => r.chance(0.8));
	const nest = asEntity.splice(Math.ceil(asEntity.length * 0.7));
	const entity = (id: string, depth: number): IObject => {
		const o: IObject = {
			$Id: `~@${id}`
		};
		if (r.chance(0.8)) {
			o.n = r.int(3);
		}
		if (r.chance(0.4)) {
			o.name = r.pick([
				"a",
				"b",
				...HAND
			]);
		}
		if (r.chance(0.4)) {
			o.ref = anyRef();
		}
		if (r.chance(0.2)) {
			o.flag = r.chance(0.5);
		}
		if (depth === 0 && nest.length > 0 && r.chance(0.3)) {
			o.child = entity(nest.pop()!, 1);
		}
		return o;
	};
	const keyed = (value: (id: string) => Json, among: readonly string[], p: number): IObject => {
		const o: IObject = {};
		for (const id of r.shuffle(among)) {
			if (r.chance(p)) {
				o[ref(id)] = value(id);
			}
		}
		return o;
	};
	const root: IObject = {
		$Id: "app"
	};
	const sections = r.shuffle([
		"items",
		"sel",
		"idList",
		"byId",
		"keyedOnly",
		"links",
		"hand",
		"misc",
		"other",
		"nestedKeyed",
		"matrix"
	]);
	for (const s of sections) {
		if (!r.chance(0.6)) {
			continue;
		}
		switch (s) {
			case "items":
				root.items = asEntity.map((id) => entity(id, 0));
				break;
			case "other":
				if (nest.length > 0) {
					root.other = [
						entity(nest.pop()!, 0)
					];
				}
				break;
			case "sel":
				root.sel = anyRef();
				break;
			case "idList":
				root.idList = r
					.shuffle(ids)
					.filter(() => r.chance(0.6))
					.map(ref);
				break;
			case "byId":
				root.byId = keyed(
					() =>
						r.chance(0.5)
							? r.int(3)
							: {
									count: r.int(3)
								},
					asEntity,
					0.7
				);
				break;
			case "keyedOnly":
				root.keyedOnly = keyed(
					(id) =>
						r.chance(0.6)
							? r.int(3)
							: r.chance(0.5)
								? {
										$Id: `~@${id}`,
										n: r.int(3)
									}
								: anyRef(),
					ids,
					0.5
				);
				break;
			case "links":
				root.links = keyed(anyRef, ids, 0.5);
				break;
			case "nestedKeyed":
				root.nestedKeyed = keyed(() => keyed(anyRef, ids, 0.4), ids, 0.5);
				break;
			case "matrix":
				root.matrix = [
					r.shuffle(ids).slice(0, 2).map(ref),
					[
						anyRef()
					],
					[]
				];
				break;
			case "hand":
				root.hand = {
					[r.pick(HAND)]: r.pick(HAND),
					plain: r.pick(HAND),
					list: [
						r.pick(HAND),
						anyRef()
					]
				};
				break;
			case "misc":
				root.misc = {
					nothing: null,
					num: r.int(5),
					t: r.chance(0.5)
				};
				break;
		}
	}
	return {
		tree: root,
		post,
		pre
	};
}

function mapStrings(tree: Json, s: (x: string) => string): Json {
	const v = (x: Json): Json => {
		if (typeof x === "string") {
			return s(x);
		}
		if (Array.isArray(x)) {
			return x.map(v);
		}
		if (x !== null && typeof x === "object") {
			const o: IObject = {};
			for (const k of Object.keys(x)) {
				o[s(k)] = v(x[k]!);
			}
			return o;
		}
		return x;
	};
	return v(tree);
}

function realize(tree: Json, names: ReadonlyMap<string, string>): Json {
	return mapStrings(tree, (x) => {
		const m = SYM.exec(x);
		if (!m) {
			return x;
		}
		const name = names.get(m[2]!);
		if (name === undefined) {
			throw new Error(`no name for ${x}`);
		}
		return `${m[1]}${name}`;
	});
}

function replaceSym(tree: Json, from: ReadonlyMap<string, string>): Json {
	return mapStrings(tree, (x) => {
		const m = SYM.exec(x);
		const to = m ? from.get(m[2]!) : undefined;
		return to === undefined ? x : `${m![1]}@${to}`;
	});
}

export type IShuffle = "none" | "plain" | "all";

export function shuffleKeys(r: Rng, tree: Json, mode: IShuffle, ids: ReadonlySet<string>): Json {
	const isId = (k: string): boolean => ids.has(k.startsWith("~") ? k.slice(1) : k);
	const v = (x: Json): Json => {
		if (Array.isArray(x)) {
			return x.map(v);
		}
		if (x !== null && typeof x === "object") {
			let keys = Object.keys(x);
			if (mode === "all" || (mode === "plain" && !keys.some(isId))) {
				keys = r.shuffle(keys);
			}
			const o: IObject = {};
			for (const k of keys) {
				o[k] = v(x[k]!);
			}
			return o;
		}
		return x;
	};
	return v(tree);
}

interface ILoc {
	parent: any;
	key: string | number;
}

function locations(tree: Json, pred: (v: Json, key: string | number) => boolean): ILoc[] {
	const out: ILoc[] = [];
	const visit = (x: Json): void => {
		if (Array.isArray(x)) {
			x.forEach((c, i) => {
				if (pred(c, i)) {
					out.push({
						parent: x,
						key: i
					});
				}
				visit(c);
			});
		} else if (x !== null && typeof x === "object") {
			for (const k of Object.keys(x)) {
				if (pred(x[k]!, k)) {
					out.push({
						parent: x,
						key: k
					});
				}
				visit(x[k]!);
			}
		}
	};
	visit(tree);
	return out;
}

const isEntity = (v: Json): boolean =>
	v !== null && typeof v === "object" && !Array.isArray(v) && typeof v.$Id === "string" && SYM.test(v.$Id);

function mutate(r: Rng, sym: ISym): ISym | undefined {
	const tree: Json = JSON.parse(JSON.stringify(sym.tree));
	const all = locations(tree, (v) => typeof v === "string" && SYM.test(v));
	const same = (t: Json): ISym => ({
		tree: t,
		post: sym.post,
		pre: sym.pre
	});
	switch (r.int(8)) {
		case 0: {
			const parents = new Set(all.map((l) => l.parent));
			const places = [
				...parents
			]
				.map((p) => all.filter((l) => l.parent === p))
				.filter((ls) => ls.length >= 2);
			const pool = places.length === 0 || r.chance(0.3) ? all : r.pick(places);
			if (pool.length < 2) {
				return undefined;
			}
			const [x, y] = r.shuffle(pool);
			const vx = x!.parent[x!.key];
			const vy = y!.parent[y!.key];
			if (vx === vy) {
				return undefined;
			}
			x!.parent[x!.key] = vy;
			y!.parent[y!.key] = vx;
			return same(tree);
		}
		case 1: {
			const ls = locations(tree, (v, k) => typeof k === "number" && isEntity(v));
			if (ls.length === 0) {
				return undefined;
			}
			const l = r.pick(ls);
			l.parent.splice(l.key, 1);
			return same(tree);
		}
		case 2: {
			const ls = locations(tree, (v) => typeof v === "number");
			if (ls.length === 0) {
				return undefined;
			}
			const l = r.pick(ls);
			l.parent[l.key]++;
			return same(tree);
		}
		case 3: {
			const ls = locations(tree, (v, k) => typeof k === "number" && isEntity(v));
			if (ls.length === 0) {
				return undefined;
			}
			const l = r.pick(ls);
			const [moved] = l.parent.splice(l.key, 1);
			const arrays: Json[][] = locations(tree, (v) => Array.isArray(v)).map((a) => a.parent[a.key]);
			arrays.push(l.parent);
			const to = r.pick(arrays);
			to.splice(r.int(to.length + 1), 0, moved);
			return same(tree);
		}
		case 4: {
			const refs = all.filter((l) => l.key !== "$Id");
			if (refs.length === 0) {
				return undefined;
			}
			const l = r.pick(refs);
			const id = r.pick(idsOf(sym.post + 1, sym.pre));
			l.parent[l.key] = `~@${id}`;
			return {
				tree,
				post: id === `P${sym.post}` ? sym.post + 1 : sym.post,
				pre: sym.pre
			};
		}
		case 5: {
			if (sym.pre === 0) {
				return undefined;
			}
			return {
				tree: replaceSym(
					tree,
					new Map([
						[
							`Q${r.int(sym.pre)}`,
							`P${sym.post}`
						]
					])
				),
				post: sym.post + 1,
				pre: sym.pre
			};
		}
		case 6: {
			if (sym.pre < 2) {
				return undefined;
			}
			return same(
				replaceSym(
					tree,
					new Map([
						[
							"Q0",
							"Q1"
						],
						[
							"Q1",
							"Q0"
						]
					])
				)
			);
		}
		default: {
			const ls = locations(tree, (v, k) => typeof k === "string" && SYM.test(k));
			if (ls.length === 0 || sym.post === 0) {
				return undefined;
			}
			const l = r.pick(ls);
			const id = `P${r.int(sym.post)}`;
			const v = l.parent[l.key];
			delete l.parent[l.key];
			if (Object.hasOwn(l.parent, `@${id}`)) {
				return undefined;
			}
			l.parent[`~@${id}`] = v;
			return same(tree);
		}
	}
}

export interface IPair {
	e: Json;
	a: Json;
	postE: Set<string>;
	postA: Set<string>;
	existing: Set<string>;
	mutated: boolean;
}

export function pairOf(r: Rng, mutated: boolean): IPair | undefined {
	const sym = symbolic(r);
	const ep = r.shuffle(E_POOL);
	const ap = r.shuffle(A_POOL);
	const namesE = new Map<string, string>();
	const namesA = new Map<string, string>();
	for (let i = 0; i <= sym.post; i++) {
		namesE.set(`P${i}`, ep[i]!);
		namesA.set(`P${i}`, ap[i]!);
	}
	for (let i = 0; i < sym.pre; i++) {
		namesE.set(`Q${i}`, PRE[i]!);
		namesA.set(`Q${i}`, PRE[i]!);
	}
	const mode = r.pick<IShuffle>([
		"none",
		"plain",
		"all"
	]);
	const changed = mutated ? mutate(r, sym) : sym;
	if (!changed) {
		return undefined;
	}
	const postE = new Set([
		...idsOf(sym.post, 0).map((p) => namesE.get(p)!),
		"step7-1"
	]);
	const postA = new Set([
		...idsOf(changed.post, 0).map((p) => namesA.get(p)!),
		"step7-2"
	]);
	return {
		e: realize(sym.tree, namesE),
		a: shuffleKeys(r, realize(changed.tree, namesA), mode, postA),
		postE,
		postA,
		existing: new Set(PRE),
		mutated
	};
}
