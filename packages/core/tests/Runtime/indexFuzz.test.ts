import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { mintedId } from "../../src/Runtime/draftNode";
import { rawOf } from "../../src/Runtime/viewProxy";
import * as reactive from "../reactive";
import { rootSetState } from "../testHelpers";

function rng(seed: number): () => number {
	let a = seed + 0x6d2b79f5;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type IAny = Record<string, any>;

let serial = 0;
const freshId = (): string => mintedId(`e${serial++}`);

function makeTree(r: () => number, depth: number): IAny {
	const node: IAny = {
		$Id: freshId(),
		N: 0
	};
	if (r() < 0.6) {
		node.Rows = Array.from(
			{
				length: Math.floor(r() * 4)
			},
			() =>
				depth > 0
					? makeTree(r, depth - 1)
					: {
							$Id: freshId(),
							N: 0
						}
		);
	}
	if (r() < 0.4) {
		node.Slot =
			depth > 0
				? makeTree(r, depth - 1)
				: {
						$Id: freshId(),
						N: 0
					};
	}
	if (r() < 0.3) {
		node.Plain = {
			V: 1
		};
	}
	return node;
}

function contains(root: IAny, needle: IAny): boolean {
	if (root === needle) {
		return true;
	}
	for (const k of Object.keys(root)) {
		const c = root[k];
		if (c && typeof c === "object" && contains(c, needle)) {
			return true;
		}
	}
	return false;
}

function containers(node: IAny, out: IAny[]): IAny[] {
	out.push(node);
	for (const k of Object.keys(node)) {
		const c = node[k];
		if (c && typeof c === "object") {
			containers(c, out);
		}
	}
	return out;
}

function liveEntities(node: IAny, out: Map<string, object>): Map<string, object> {
	if (node.$Id) {
		out.set(String(node.$Id), node);
	}
	for (const k of Object.keys(node)) {
		const c = node[k];
		if (c && typeof c === "object") {
			liveEntities(c, out);
		}
	}
	return out;
}

const OPS = [
	"scalar",
	"assignEntity",
	"assignPlain",
	"deleteKey",
	"push",
	"pop",
	"shift",
	"unshift",
	"splice",
	"lenShrink",
	"lenShrinkGrow",
	"moveDestFirst",
	"moveSrcFirst",
	"changeId",
	"filterCopy",
	"reverse",
	"swap",
	"assignTwice",
	"replaceSlot",
	"clearRows"
] as const;

function applyOp(d: IAny, op: string, r: () => number): void {
	const all = containers(d, []);
	const pick = (xs: IAny[]): IAny | undefined => (xs.length === 0 ? undefined : xs[Math.floor(r() * xs.length)]);
	const withRows = all.filter((n) => Array.isArray(n.Rows) && n.Rows.length > 0);
	const host = pick(all.filter((n) => Array.isArray(n.Rows)));
	switch (op) {
		case "scalar": {
			const t = pick(all);
			if (t) {
				t.N = (t.N ?? 0) + 1;
			}
			return;
		}
		case "assignEntity": {
			const t = pick(all);
			if (t) {
				t.Slot = {
					$Id: freshId(),
					N: 0
				};
			}
			return;
		}
		case "assignPlain": {
			const t = pick(all);
			if (t) {
				t.Plain = {
					V: Math.floor(r() * 9)
				};
			}
			return;
		}
		case "deleteKey": {
			const t = pick(all.filter((n) => n.Slot));
			if (t) {
				delete t.Slot;
			}
			return;
		}
		case "push":
			host?.Rows.push({
				$Id: freshId(),
				N: 0
			});
			return;
		case "pop":
			pick(withRows)?.Rows.pop();
			return;
		case "shift":
			pick(withRows)?.Rows.shift();
			return;
		case "unshift":
			host?.Rows.unshift({
				$Id: freshId(),
				N: 0
			});
			return;
		case "splice": {
			const t = pick(withRows);
			if (t) {
				t.Rows.splice(Math.floor(r() * t.Rows.length), 1);
			}
			return;
		}
		case "lenShrink": {
			const t = pick(withRows);
			if (t) {
				t.Rows.length = Math.floor(r() * t.Rows.length);
			}
			return;
		}
		case "lenShrinkGrow": {
			const t = pick(withRows);
			if (!t) {
				return;
			}
			t.Rows.length = Math.floor(r() * t.Rows.length);
			t.Rows.push({
				$Id: freshId(),
				N: 0
			});
			return;
		}
		case "moveDestFirst": {
			const src = pick(all.filter((n) => n.Slot));
			const dst = pick(all.filter((n) => !n.Slot));
			if (!src || !dst || src === dst || contains(src.Slot, dst)) {
				return;
			}
			dst.Slot = src.Slot;
			delete src.Slot;
			return;
		}
		case "moveSrcFirst": {
			const src = pick(all.filter((n) => n.Slot));
			const dst = pick(all.filter((n) => !n.Slot));
			if (!src || !dst || src === dst || contains(src.Slot, dst)) {
				return;
			}
			const moved = src.Slot;
			delete src.Slot;
			dst.Slot = moved;
			return;
		}
		case "changeId": {
			const t = pick(all.filter((n) => n.$Id && n !== d));
			if (t) {
				// Past the traps, which refuse it. The field write marks the node for the walk.
				rawOf(t).$Id = freshId();
				t.Renamed = true;
			}
			return;
		}
		case "filterCopy": {
			const t = pick(withRows);
			if (!t) {
				return;
			}
			t.Rows.push({
				$Id: freshId(),
				N: 0
			});
			t.Rows = t.Rows.filter((_: unknown, i: number) => i % 2 === 0);
			return;
		}
		case "reverse":
			pick(withRows)?.Rows.reverse();
			return;
		case "swap": {
			const t = pick(withRows.filter((n) => n.Rows.length > 1));
			if (!t) {
				return;
			}
			const i = Math.floor(r() * t.Rows.length);
			const j = Math.floor(r() * t.Rows.length);
			const held = t.Rows[i];
			t.Rows[i] = t.Rows[j];
			t.Rows[j] = held;
			return;
		}
		case "assignTwice": {
			const t = pick(all);
			if (!t) {
				return;
			}
			t.Slot = {
				$Id: freshId(),
				N: 0
			};
			t.Slot = {
				$Id: freshId(),
				N: 0
			};
			return;
		}
		case "replaceSlot": {
			const t = pick(withRows);
			if (!t) {
				return;
			}
			t.Rows[Math.floor(r() * t.Rows.length)] = {
				$Id: freshId(),
				N: 0
			};
			return;
		}
		case "clearRows": {
			const t = pick(withRows);
			if (t) {
				t.Rows = [];
			}
			return;
		}
		default:
			return;
	}
}

function runSeed(seed: number): string | null {
	const r = rng(seed);
	return reactive.root((dispose) => {
		const rt = createRuntime<IAny>(makeTree(r, 3), {
			verifyIndex: true
		});
		const internal = rt as unknown as IRuntimeInternal<IAny>;
		const lookup = internal.get("runtime/stateIdLookup");
		const gateway = internal.get("runtime/writeGateway");
		const disposed: string[] = [];
		rt.on("record", (record) => {
			if (record.Kind === "entity:dispose") {
				disposed.push(record.EntityId);
			}
		});
		try {
			for (let batch = 0; batch < 14; batch++) {
				const ops = Array.from(
					{
						length: 1 + Math.floor(r() * 4)
					},
					() => OPS[Math.floor(r() * OPS.length)] as string
				);
				const before = liveEntities(rawOf(rt.state) as IAny, new Map());
				const beforeNodes = new Set(before.values());
				disposed.length = 0;

				function* act(draft: IAny): IActionGenerator {
					for (const op of ops) {
						applyOp(draft, op, r);
					}
				}
				// The action has no yields, so its frame closes and the index
				// settles before the assertions below.
				void rt.processAction(
					act,
					() => rt.state,
					rootSetState(rt),
					() => String(rt.state.$Id)
				);

				const after = liveEntities(rawOf(rt.state) as IAny, new Map());
				const afterNodes = new Set(after.values());
				const where = `seed ${seed} batch ${batch} [${ops.join(",")}]`;

				for (const id of disposed) {
					if (after.has(id)) {
						return `${where}: disposed "${id}" while it is still in the tree`;
					}
				}
				// An entity left when its NODE left. A renamed node is still
				// present, and re-keying its cell is not a disposal.
				for (const [id, node] of before) {
					if (afterNodes.has(node) || after.has(id)) {
						continue;
					}
					if (!disposed.includes(id)) {
						return `${where}: "${id}" left the tree without a dispose`;
					}
				}
				void beforeNodes;

				const stamp = `${seed}-${batch}`;
				for (const [id, cell] of Object.entries(lookup())) {
					gateway.exemptFrame(() => {
						cell.setState((s: IAny) => {
							s.Probe = stamp;
						});
					});
					const node = after.get(id) as IAny | undefined;
					if (node && node.Probe !== stamp) {
						return `${where}: the cell setState for "${id}" did not reach its node`;
					}
				}
			}
		} catch (error) {
			return `seed ${seed}: ${(error as Error).message}`;
		} finally {
			rt.dispose();
			dispose();
		}
		return null;
	});
}

describe("write gateway index fuzz", () => {
	it("holds its invariants across randomized batches", () => {
		const env = (
			globalThis as {
				process?: {
					env?: Record<string, string | undefined>;
				};
			}
		).process?.env;
		const seeds = Number(env?.TREFLEX_FUZZ_SEEDS ?? 120);
		const failures: string[] = [];
		for (let seed = 1; seed <= seeds; seed++) {
			const failure = runSeed(seed);
			if (failure) {
				failures.push(failure);
			}
			if (failures.length >= 3) {
				break;
			}
		}
		expect(failures).toEqual([]);
	}, 300_000);
});
