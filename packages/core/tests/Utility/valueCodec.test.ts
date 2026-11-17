import { describe, expect, it } from "vitest";
import { clone, cloneNode, trimTrailingUndefined } from "../../src/Utility/valueCodec";

// The old owning clone, kept as the reference implementation the structural
// clone must match on plain data.
function jsonRoundTrip(value: unknown): unknown {
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return undefined;
	}
}

// Deterministic pseudo-random plain-data generator (mulberry32) for the
// property-style equivalence sweep. Generates only JSON-representable plain
// data — no undefined in arrays (a doctrine violation with its own pinned
// behavior below), undefined-valued object keys are exercised separately.
function makeRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomPlain(rng: () => number, depth: number): unknown {
	const pick = rng();
	if (depth <= 0 || pick < 0.45) {
		const leaf = rng();
		if (leaf < 0.2) return null;
		if (leaf < 0.4) return Math.floor(rng() * 2000 - 1000);
		if (leaf < 0.55) return rng(); // finite float
		if (leaf < 0.75) return `s${Math.floor(rng() * 1e6)}`;
		if (leaf < 0.9) return rng() < 0.5;
		return "";
	}
	if (pick < 0.7) {
		const len = Math.floor(rng() * 5);
		const arr = new Array(len);
		for (let i = 0; i < len; i++) arr[i] = randomPlain(rng, depth - 1);
		return arr;
	}
	const keys = Math.floor(rng() * 5);
	const obj: Record<string, unknown> = {};
	for (let i = 0; i < keys; i++) {
		obj[`k${i}`] = randomPlain(rng, depth - 1);
	}
	return obj;
}

describe("valueCodec.clone — plain-data structural clone", () => {
	it("matches the old JSON round-trip on representative plain shapes", () => {
		const shapes: unknown[] = [
			null,
			0,
			-0.5,
			42,
			"",
			"text",
			true,
			false,
			[],
			{},
			[
				1,
				"two",
				null,
				[
					3,
					{
						deep: [
							false
						]
					}
				]
			],
			{
				A: 1,
				B: {
					C: [
						null,
						{
							D: "x"
						}
					]
				},
				E: []
			}
		];
		for (const shape of shapes) {
			expect(clone(shape)).toStrictEqual(jsonRoundTrip(shape));
		}
	});

	it("property-style: equals the JSON round-trip across seeded random plain trees", () => {
		const rng = makeRng(29);
		for (let i = 0; i < 200; i++) {
			const value = randomPlain(rng, 4);
			expect(clone(value)).toStrictEqual(jsonRoundTrip(value));
		}
	});

	it("returns fresh objects — mutating the source after cloning does not touch the clone", () => {
		const source = {
			A: [
				1,
				2
			],
			B: {
				C: 3
			}
		};
		const copy = clone(source) as typeof source;
		source.A.push(99);
		source.B.C = -1;
		expect(copy).toStrictEqual({
			A: [
				1,
				2
			],
			B: {
				C: 3
			}
		});
	});

	it("passes undefined through at the root (absence is representable)", () => {
		expect(clone(undefined)).toBeUndefined();
	});

	it("skips undefined-valued object keys — the absence discipline", () => {
		const value = {
			A: 1,
			B: undefined,
			C: {
				D: undefined
			}
		};
		const copy = clone(value) as Record<string, unknown>;
		expect(copy).toStrictEqual({
			A: 1,
			C: {}
		});
		expect("B" in copy).toBe(false);
		expect("D" in (copy.C as object)).toBe(false);
	});

	it("clones non-plain nodes to undefined — the doctrine's lossy half", () => {
		// Whole-value.
		expect(clone(new Date(0))).toBeUndefined();
		expect(clone(/abc/i)).toBeUndefined();
		expect(clone(new Map())).toBeUndefined();
		expect(clone(new Set())).toBeUndefined();
		expect(clone(new Uint8Array(2))).toBeUndefined();
		expect(clone(() => 1)).toBeUndefined();
		expect(clone(Symbol("s"))).toBeUndefined();
		expect(clone(1n)).toBeUndefined();
		class Foo {
			X = 1;
		}
		expect(clone(new Foo())).toBeUndefined();
		// As an object value: the key lands as absence.
		expect(
			clone({
				keep: 1,
				drop: new Map()
			})
		).toStrictEqual({
			keep: 1
		});
		// As an array element: the slot stays (positions bind), holding
		// undefined.
		const arr = clone([
			1,
			new Set(),
			2
		]) as unknown[];
		expect(arr.length).toBe(3);
		expect(arr[1]).toBeUndefined();
	});

	it("returns undefined for the WHOLE value on a cycle — matching the round-trip's throw-and-catch", () => {
		const value: Record<string, unknown> = {
			A: 1
		};
		value.Self = value;
		expect(clone(value)).toBeUndefined();
		expect(jsonRoundTrip(value)).toBeUndefined();

		const deep: Record<string, unknown> = {
			Child: {
				Grand: {}
			}
		};
		((deep.Child as Record<string, unknown>).Grand as Record<string, unknown>).Back = deep;
		expect(clone(deep)).toBeUndefined();
	});

	it("duplicates shared (acyclic) references instead of treating them as cycles — as JSON did", () => {
		const shared = {
			X: 1
		};
		const value = {
			A: shared,
			B: shared
		};
		const copy = clone(value) as {
			A: {
				X: number;
			};
			B: {
				X: number;
			};
		};
		expect(copy).toStrictEqual(jsonRoundTrip(value));
		expect(copy.A).not.toBe(copy.B);
	});
});

describe("valueCodec.cloneNode — the shared node-level domain", () => {
	it("delegates child cloning to the caller (the walk's recursion seam)", () => {
		const seen: unknown[] = [];
		const result = cloneNode(
			{
				A: 1,
				B: [
					2
				]
			},
			(child) => {
				seen.push(child);
				return child;
			}
		) as Record<string, unknown>;
		expect(result.A).toBe(1);
		expect(seen).toContain(1);
		// The array child came back by reference from our callback — the
		// node level does not deep-clone on its own.
		expect(result.B).toStrictEqual([
			2
		]);
	});
});

describe("valueCodec.trimTrailingUndefined", () => {
	it("trims trailing undefined args — f(x, undefined) binds like f(x)", () => {
		expect(
			trimTrailingUndefined([
				1,
				undefined,
				undefined
			])
		).toStrictEqual([
			1
		]);
		expect(
			trimTrailingUndefined([
				undefined
			])
		).toStrictEqual([]);
		expect(trimTrailingUndefined([])).toStrictEqual([]);
	});

	it("keeps mid-array undefined for the assert to catch", () => {
		expect(
			trimTrailingUndefined([
				1,
				undefined,
				2
			])
		).toStrictEqual([
			1,
			undefined,
			2
		]);
	});
});
