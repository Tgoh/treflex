import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { StateAliasError } from "../../src/Runtime/stateAlias";
import { rawOf } from "../../src/Runtime/viewProxy";
import { captureSurfaced } from "../testHelpers";

export const row = (i: number, extra: object = {}) => ({
	$Id: `r${i}`,
	Name: `n${i}`,
	...extra
});

export const rows = (n: number) =>
	Array.from(
		{
			length: n
		},
		(_, i) => row(i)
	);

export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function world(seed: object) {
	const surfaced = captureSurfaced();
	const runtime = createRuntime<any>(
		{
			$Id: "root",
			...seed
		},
		{
			pauseTimers: true
		}
	) as IRuntimeInternal<any>;
	const dispatch = (fn: (draft: any) => void) =>
		runtime.dispatch(function* write(draft: any): IActionGenerator {
			fn(draft);
		}, "root");
	return {
		runtime,
		surfaced,
		write: async (fn: (draft: any) => void) => {
			await dispatch(fn);
			await settle();
		},
		refuse: async (fn: (draft: any) => void): Promise<unknown> => {
			const refusal = await dispatch(fn).then(
				() => undefined,
				(error: unknown) => error
			);
			await settle();
			return refusal;
		},
		lookup: () => runtime.get("runtime/writeGateway").lookup()
	};
}

export function describeSeededWrites(): void {
	describe("seeded writes", () => {
		it("seeded moves stay silent against a brute-force walk of the tree", () => {
			const { fires, moves, problems } = checkAgainstTree(false, 40);
			expect(problems).toEqual([]);
			expect(fires).toBe(0);
			expect(moves).toBeGreaterThan(100);
		});

		it("seeded aliases are refused with the tree left as it was, against a brute-force walk of it", () => {
			const { fires, problems } = checkAgainstTree(true, 80);
			expect(problems).toEqual([]);
			expect(fires).toBeGreaterThan(100);
		});
	});
}

function rng(seed: number): () => number {
	let a = seed + 0x6d2b79f5;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function reaches(from: any, to: object, seen = new Set<object>()): boolean {
	if (from === to) {
		return true;
	}
	if (from === null || typeof from !== "object" || seen.has(from)) {
		return false;
	}
	seen.add(from);
	return Object.keys(from).some((key) => reaches(from[key], to, seen));
}

function tree(entities: boolean): any {
	let made = 0;
	const id = (name: string) =>
		entities
			? {
					$Id: `${name}${made++}`
				}
			: {};
	return {
		$Id: "root",
		L: [
			{
				...id("l"),
				N: {
					...id("n")
				}
			},
			{
				...id("l"),
				N: {
					...id("n"),
					D: {}
				}
			},
			{
				...id("l")
			},
			{
				...id("l"),
				V: 1
			}
		],
		M: {
			...id("m"),
			X: {
				...id("x"),
				Y: {
					...id("y")
				}
			},
			Z: []
		},
		S: {}
	};
}

// Counted by (parent, key), so a node under a share has one slot and only the top counts.
function walkTree(root: object): {
	aliased: Set<object>;
	reachable: Set<object>;
} {
	const slots = new Map<object, Set<string>>();
	const ids = new Map<object, number>();
	const idOf = (node: object): number => {
		if (!ids.has(node)) {
			ids.set(node, ids.size);
		}
		return ids.get(node) as number;
	};
	const reachable = new Set<object>([
		root
	]);
	const visit = (node: any): void => {
		for (const key of Object.keys(node)) {
			const child = node[key];
			if (child === null || typeof child !== "object") {
				continue;
			}
			const holders = slots.get(child) ?? new Set<string>();
			slots.set(child, holders);
			holders.add(`${idOf(node)}:${key}`);
			if (!reachable.has(child)) {
				reachable.add(child);
				visit(child);
			}
		}
	};
	visit(root);
	return {
		aliased: new Set(
			[
				...slots
			]
				.filter(([, holders]) => holders.size > 1)
				.map(([node]) => node)
		),
		reachable
	};
}

type IEntry = {
	node: any;
	holder: any;
	key: string;
};

function collect(draft: any, out: IEntry[], seen: Set<object>, holder: any, key: string): void {
	const raw = rawOf(draft);
	if (seen.has(raw)) {
		return;
	}
	seen.add(raw);
	if (holder) {
		out.push({
			node: draft,
			holder,
			key
		});
	}
	for (const k of Object.keys(draft)) {
		const child = draft[k];
		if (child !== null && typeof child === "object") {
			collect(child, out, seen, draft, k);
		}
	}
}

function checkAgainstTree(
	aliases: boolean,
	seeds: number
): {
	fires: number;
	moves: number;
	problems: string[];
} {
	const problems: string[] = [];
	let fires = 0;
	let moves = 0;
	const deferred: (() => void)[] = [];
	const spy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
		deferred.push(callback);
	});
	try {
		for (let seed = 1; seed <= seeds && problems.length === 0; seed++) {
			const r = rng(seed);
			let failure: unknown;
			const runtime = createRuntime<any>(tree(seed % 2 === 0), {
				pauseTimers: true,
				onError: (error) => {
					failure = error;
				}
			}) as IRuntimeInternal<any>;
			if (seed % 3 === 0) {
				runtime.on("record", () => {});
			}
			const gateway = runtime.get("runtime/writeGateway");
			const rootRaw = () => gateway.rootNode();
			const pick = <T>(from: T[]): T => from[Math.floor(r() * from.length)];
			for (let frame = 0; frame < 8; frame++) {
				const label = `seed ${seed} frame ${frame}`;
				const before = walkTree(rootRaw());
				let reported = 0;
				runtime
					.dispatch(function* step(s: any): IActionGenerator {
						for (let op = 0; op < 4; op++) {
							const nodes: IEntry[] = [];
							collect(s, nodes, new Set(), null, "");
							if (nodes.length === 0) {
								continue;
							}
							const moved = pick(nodes);
							const rawMoved = rawOf(moved.node);
							const holders = [
								s,
								...nodes.map((entry) => entry.node)
							].filter((node) => !reaches(rawMoved, rawOf(node)));
							const arrays = nodes.filter((entry) => Array.isArray(rawOf(entry.node)));
							const take = (entry: IEntry): void => {
								if (Array.isArray(rawOf(entry.holder))) {
									entry.holder.splice(Number(entry.key), 1);
								} else {
									delete entry.holder[entry.key];
								}
							};
							const seat = (target: any, value: unknown): void => {
								const key = `k${Math.floor(r() * 4)}`;
								if (Array.isArray(rawOf(target))) {
									target.push(value);
								} else {
									target[key] = value;
								}
							};
							const roll = r();
							if (roll < 0.15) {
								take(moved);
							} else if (roll < 0.45 && holders.length > 0) {
								moves++;
								seat(pick(holders), moved.node);
								take(moved);
							} else if (roll < 0.55 && arrays.length > 0) {
								const array = pick(arrays).node;
								const kind = r();
								if (kind < 0.3) {
									array.reverse();
								} else if (kind < 0.6) {
									array.sort(() => r() - 0.5);
								} else if (array.length > 0) {
									array.splice(0, 1);
								}
							} else if (roll < 0.65 && arrays.length > 0) {
								const entry = pick(arrays);
								entry.holder[entry.key] = entry.node.filter(() => r() < 0.7);
							} else if (roll < 0.75 && holders.length > 0) {
								seat(pick(holders), {
									F: 1,
									Inner: {
										G: 2
									}
								});
							} else if (aliases && roll < 0.9 && holders.length > 0) {
								seat(pick(holders), moved.node);
							} else if (aliases && holders.length > 0 && !Array.isArray(rawMoved)) {
								const { $Id: _, ...spread } = moved.node;
								seat(pick(holders), spread);
							}
						}
					}, "root")
					.catch(() => {});
				for (const callback of deferred.splice(0)) {
					try {
						callback();
					} catch (error) {
						problems.push(`${label}: surfaced ${String(error)}`);
					}
				}
				const after = walkTree(rootRaw());
				if (failure !== undefined) {
					if (!(failure instanceof StateAliasError)) {
						problems.push(`${label}: threw ${String(failure)}`);
					} else if (
						after.reachable.size !== before.reachable.size ||
						[
							...after.reachable
						].some((node) => !before.reachable.has(node))
					) {
						problems.push(`${label}: a refused slice left the tree changed`);
					}
					reported++;
					failure = undefined;
				} else if (
					[
						...after.aliased
					].some((node) => !before.aliased.has(node))
				) {
					problems.push(`${label}: a new alias with no refusal`);
				}
				fires += reported;
				for (const node of after.reachable) {
					if (gateway.isDetached(node)) {
						problems.push(`${label}: a reachable node is marked gone`);
					}
					const id = (
						node as {
							$Id?: unknown;
						}
					).$Id;
					if (typeof id === "string" && id !== "" && rawOf(gateway.lookup()[id]?.state) !== node) {
						problems.push(`${label}: the cell for ${id} is wrong`);
					}
				}
				for (const id of Object.keys(gateway.lookup())) {
					if (!after.reachable.has(rawOf(gateway.lookup()[id].state))) {
						problems.push(`${label}: the index holds ${id}, which the tree no longer reaches`);
					}
				}
			}
			runtime.dispose();
		}
	} finally {
		spy.mockRestore();
	}
	return {
		fires,
		moves,
		problems
	};
}
