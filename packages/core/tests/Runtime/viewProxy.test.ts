import { describe, expect, it, vi } from "vitest";
import { createRecordingProxy } from "../../src/Runtime/recordingProxy";
import { tracking } from "../../src/Runtime/tracking";
import { isWrappable, RAW, rawOf, setViewDiagEmitter, unwrapValue, view } from "../../src/Runtime/viewProxy";
import * as reactive from "../reactive";
import { createTreeState } from "../testHelpers";

function observe<T>(read: () => T) {
	let runs = 0;
	let last!: T;
	const dispose = reactive.root((d) => {
		reactive.effect(() => {
			runs++;
			last = read();
		});
		return d;
	});
	return {
		runs: () => runs,
		last: () => last,
		dispose
	};
}

function writeKey(target: object, key: string, value: unknown) {
	const had = Object.hasOwn(target, key);
	const changed = (target as any)[key] !== value;
	(target as any)[key] = value;
	reactive.batch(() => {
		if (changed) {
			tracking.notifyKey(target, key);
		}
		tracking.notifyShape(target);
		if (!had) {
			tracking.notifyHas(target, key);
		}
	});
}

function deleteKey(target: object, key: string) {
	const had = Object.hasOwn(target, key);
	delete (target as any)[key];
	reactive.batch(() => {
		tracking.notifyKey(target, key);
		tracking.notifyShape(target);
		if (had) {
			tracking.notifyHas(target, key);
		}
	});
}

describe("view proxy: identity and raw", () => {
	it("returns one proxy per raw, stable across reads and never evicted", () => {
		const raw = {
			A: {
				x: 1
			},
			List: [
				{
					Id: "a"
				}
			]
		};
		const v = view(raw);
		expect(view(raw)).toBe(v);
		expect(v.A).toBe(v.A);
		expect(v.List[0]).toBe(v.List[0]);
		expect(v.List).toBe(view(raw.List));
	});

	it("rawOf is total: view and recording proxies, and a bare raw", () => {
		const raw = {
			Id: "r",
			A: {
				x: 1
			}
		};
		expect(rawOf(view(raw))).toBe(raw);
		expect(rawOf(view(raw).A)).toBe(raw.A);
		expect(rawOf(raw)).toBe(raw);
		expect(rawOf(3)).toBe(3);
		expect(rawOf(null)).toBe(null);
		const recording = createRecordingProxy(
			raw,
			{
				currentJournalChanges: null
			},
			new WeakMap()
		);
		expect(rawOf(recording)).toBe(raw);
		expect(rawOf(recording.A)).toBe(raw.A);
	});

	it("view over a recording proxy resolves to the raw's view", () => {
		const raw = {
			Id: "r",
			A: {
				x: 1
			}
		};
		const recording = createRecordingProxy(
			raw,
			{
				currentJournalChanges: null
			},
			new WeakMap()
		);
		expect(view(recording)).toBe(view(raw));
		expect(view(recording.A)).toBe(view(raw.A));
	});

	it("a seed with a nested view proxy stores a copy of its node", () => {
		const row = view({
			Id: "row",
			n: 1
		});
		const { raw, setState } = createTreeState({
			Draft: {
				...row
			},
			Held: [
				row
			],
			Frozen: Object.freeze({
				k: 1
			}) as {
				k: number;
			}
		});
		expect(rawOf(raw.Held[0])).toBe(raw.Held[0]);
		expect(raw.Held[0]).not.toBe(rawOf(row));
		expect(Object.isFrozen(rawOf(row))).toBe(false);
		expect(() =>
			setState((s) => {
				s.Held[0].n = 2;
				s.Frozen.k = 2;
			})
		).not.toThrow();
		expect(raw.Held[0].n).toBe(2);
		expect(raw.Frozen.k).toBe(2);
		expect(raw.Draft.Id).toBe("row");
	});

	it("view of a view is the same view", () => {
		const raw = {
			x: 1
		};
		const v = view(raw);
		expect(view(v)).toBe(v);
		expect((v as any)[RAW]).toBe(raw);
	});
});

describe("view proxy: tracking", () => {
	it("tracks per key: a write to another key does not re-run", () => {
		const raw = {
			a: 1,
			b: 2
		};
		const v = view(raw);
		const obs = observe(() => v.a);
		expect(obs.runs()).toBe(1);
		writeKey(raw, "b", 3);
		expect(obs.runs()).toBe(1);
		writeKey(raw, "a", 5);
		expect(obs.runs()).toBe(2);
		expect(obs.last()).toBe(5);
		obs.dispose();
	});

	it("tracks nested reads through child views", () => {
		const raw = {
			A: {
				x: 1
			},
			B: {
				x: 1
			}
		};
		const v = view(raw);
		const obs = observe(() => v.A.x);
		writeKey(raw.B, "x", 2);
		expect(obs.runs()).toBe(1);
		writeKey(raw.A, "x", 2);
		expect(obs.runs()).toBe(2);
		obs.dispose();
	});

	it("two keys written in one batch re-run once; A-to-B-to-A re-runs once", () => {
		const raw = {
			a: 1,
			b: 1
		};
		const v = view(raw);
		const obs = observe(() => v.a + v.b);
		reactive.batch(() => {
			writeKey(raw, "a", 2);
			writeKey(raw, "b", 2);
		});
		expect(obs.runs()).toBe(2);
		reactive.batch(() => {
			writeKey(raw, "a", 9);
			writeKey(raw, "a", 2);
		});
		expect(obs.runs()).toBe(3);
		obs.dispose();
	});

	it("the no-listener fast path creates no version", () => {
		const raw = {
			a: 1
		};
		const v = view(raw);
		reactive.untrack(() => v.a);
		expect(v.a).toBe(1);
		expect(() => tracking.notifyKey(raw, "a")).not.toThrow();
	});

	it("$TRACK subscribes to the container's shape", () => {
		const raw: Record<string, number> = {
			a: 1
		};
		const v = view(raw);
		const obs = observe(() => {
			(v as any)[reactive.TRACK];
			return Object.keys(reactive.untrack(() => v)).length;
		});
		writeKey(raw, "b", 2);
		expect(obs.runs()).toBe(2);
		writeKey(raw, "a", 5);
		expect(obs.runs()).toBe(3);
		obs.dispose();
	});

	it("Object.keys tracks the shape", () => {
		const raw: Record<string, number> = {
			a: 1
		};
		const v = view(raw);
		const obs = observe(() => Object.keys(v).join(","));
		writeKey(raw, "b", 2);
		expect(obs.last()).toBe("a,b");
		deleteKey(raw, "a");
		expect(obs.last()).toBe("b");
		obs.dispose();
	});

	it("`in` tracks a has-version, including for keys that do not exist yet", () => {
		const raw: Record<string, number> = {};
		const v = view(raw);
		const obs = observe(() => "a" in v);
		expect(obs.last()).toBe(false);
		writeKey(raw, "a", 1);
		expect(obs.last()).toBe(true);
		deleteKey(raw, "a");
		expect(obs.last()).toBe(false);
		obs.dispose();
	});

	it("`in` accepts symbol keys and answers them from the target", () => {
		const raw = {
			a: 1
		};
		const v = view(raw);
		expect(Symbol.unscopables in v).toBe(false);
		expect(Symbol.iterator in v).toBe(false);
		expect(Symbol.iterator in view([])).toBe(true);
		expect("a" in v).toBe(true);
		expect("toString" in v).toBe(true);
	});

	it("serves a `with` block: free identifiers resolve through has and get", () => {
		const raw = {
			Price: 3,
			Qty: 4
		};
		const v = view(raw);
		const script = new Function("context", "with (context) { return Price * Qty; }") as (c: object) => number;
		expect(script(v)).toBe(12);
		const obs = observe(() => script(v));
		writeKey(raw, "Qty", 5);
		expect(obs.last()).toBe(15);
		obs.dispose();
	});

	it("a same-value write through the draft bumps neither the key nor the shape", () => {
		const { raw, setState } = createTreeState({
			Items: [
				{
					n: 1
				}
			],
			a: 1
		});
		const v = view(raw);
		const shape = observe(() => {
			(v.Items as any)[reactive.TRACK];
			(v as any)[reactive.TRACK];
		});
		const key = observe(() => v.a);
		setState((s) => {
			const first = s.Items[0];
			s.Items[0] = first;
			s.a = 1;
			s.Items.sort(() => 0);
		});
		expect(shape.runs()).toBe(1);
		expect(key.runs()).toBe(1);
		setState((s) => {
			s.a = 2;
		});
		expect(key.runs()).toBe(2);
		expect(shape.runs()).toBe(2);
		shape.dispose();
		key.dispose();
	});

	it("a delete of an absent key bumps nothing", () => {
		const { raw, setState } = createTreeState({
			Items: [
				1
			] as number[] & {
				NoSuchKey?: number;
			}
		});
		const v = view(raw);
		const shape = observe(() => {
			(v.Items as any)[reactive.TRACK];
			return "NoSuchKey" in v.Items;
		});
		setState((s) => {
			delete s.Items.NoSuchKey;
		});
		expect(shape.runs()).toBe(1);
		shape.dispose();
	});

	it("length = undefined is refused before anything observes or journals it", () => {
		const raw = {
			Items: [
				1,
				2,
				3
			]
		};
		const changes: any[] = [];
		const observed: string[] = [];
		const draft = createRecordingProxy(
			raw,
			{
				currentJournalChanges: changes,
				gateway: {
					observe: (_t, key) => {
						observed.push(key);
					}
				}
			},
			new WeakMap()
		);
		expect(() => {
			(draft.Items as any).length = undefined;
		}).toThrow(TypeError);
		expect(raw.Items).toEqual([
			1,
			2,
			3
		]);
		expect(changes).toEqual([]);
		expect(observed).toEqual([]);
	});

	it("length is a key of its own", () => {
		const raw: number[] = [
			1,
			2
		];
		const v = view(raw);
		const obs = observe(() => v.length);
		raw.push(3);
		reactive.batch(() => {
			tracking.notifyKey(raw, "2");
			tracking.notifyKey(raw, "length");
			tracking.notifyShape(raw);
		});
		expect(obs.last()).toBe(3);
		obs.dispose();
	});
});

describe("view proxy: arrays", () => {
	it("Array.isArray is true and prototype methods run through the receiver", () => {
		const raw = [
			{
				Id: "a",
				n: 1
			},
			{
				Id: "b",
				n: 2
			}
		];
		const v = view(raw);
		expect(Array.isArray(v)).toBe(true);
		expect(v.map((r) => r.n)).toEqual([
			1,
			2
		]);
		expect(v.find((r) => r.Id === "b")).toBe(v[1]);
		expect(v.indexOf(v[1])).toBe(1);
		expect(v.includes(v[0])).toBe(true);
		expect(v.filter((r) => r.n > 1).length).toBe(1);
		expect(v.some((r) => r.n === 2)).toBe(true);
		expect(v.every((r) => r.n > 0)).toBe(true);
		expect(v.reduce((acc, r) => acc + r.n, 0)).toBe(3);
		expect(
			[
				...v
			].length
		).toBe(2);
		expect(v.slice(0)[0]).toBe(v[0]);
		expect(v.concat([]).length).toBe(2);
		expect(v.at(-1)).toBe(v[1]);
		expect(v.join("")).toBe("[object Object][object Object]");
		const seen: string[] = [];
		v.forEach((r) => {
			seen.push(r.Id);
		});
		expect(seen).toEqual([
			"a",
			"b"
		]);
	});

	it("array methods track the keys they read", () => {
		const raw = [
			{
				n: 1
			},
			{
				n: 2
			}
		];
		const v = view(raw);
		const obs = observe(() => v.map((r) => r.n).join(","));
		writeKey(raw[1], "n", 5);
		expect(obs.last()).toBe("1,5");
		obs.dispose();
	});

	it("getOwnPropertyDescriptor bails to the raw descriptor for length", () => {
		const raw = [
			1
		];
		const v = view(raw);
		const desc = Object.getOwnPropertyDescriptor(v, "length");
		expect(desc).toEqual(Object.getOwnPropertyDescriptor(raw, "length"));
		expect(
			{
				...view({
					a: {
						b: 1
					}
				})
			}.a.b
		).toBe(1);
	});

	it("getOwnPropertyDescriptor substitutes the wrapped value for a configurable key", () => {
		const child = {
			b: 1
		};
		const raw = {
			a: child
		};
		const v = view(raw);
		const desc = Object.getOwnPropertyDescriptor(v, "a")!;
		expect(desc.value).toBe(v.a);
		expect(desc.configurable).toBe(true);
	});
});

describe("view proxy: isWrappable pass-through", () => {
	it("passes Dates, Maps, Sets and class instances through raw", () => {
		class Foo {
			n = 1;
		}
		const date = new Date(0);
		const raw = {
			D: date,
			M: new Map([
				[
					"k",
					1
				]
			]),
			S: new Set([
				1
			]),
			F: new Foo()
		};
		const v = view(raw);
		expect(v.D).toBe(date);
		expect(v.D.toISOString()).toBe("1970-01-01T00:00:00.000Z");
		expect(v.M.get("k")).toBe(1);
		expect(v.S.has(1)).toBe(true);
		expect(v.F).toBe(raw.F);
		expect(isWrappable(date)).toBe(false);
		expect(isWrappable(Object.create(null))).toBe(true);
		expect(isWrappable([])).toBe(true);
		expect(view(date)).toBe(date);
	});

	it("functions come back as-is", () => {
		const fn = () => 1;
		const raw = {
			f: fn
		};
		expect(view(raw).f).toBe(fn);
	});
});

describe("view proxy: writes are refused", () => {
	it("throws with a diag, leaving the raw untouched", () => {
		const raw = {
			a: 1
		};
		const v = view(raw) as any;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const codes: string[] = [];
		const release = setViewDiagEmitter((event) => codes.push(event.code));
		try {
			expect(() => {
				v.a = 2;
			}).toThrow(/read-only/);
			expect(() => {
				delete v.a;
			}).toThrow(/read-only/);
			expect(() =>
				Object.defineProperty(v, "b", {
					value: 1,
					configurable: true,
					enumerable: true,
					writable: true
				})
			).toThrow(/read-only/);
			expect(raw).toEqual({
				a: 1
			});
			expect(warn).toHaveBeenCalled();
			expect(codes).toEqual([
				"state/view-write",
				"state/view-write",
				"state/view-write"
			]);
		} finally {
			release();
			warn.mockRestore();
		}
	});
});

describe("unwrapValue", () => {
	it("answers a view proxy's node, copies the plain containers around one, and lists them for freezing", () => {
		const rowRaw = {
			Id: "r"
		};
		const rowView = view(rowRaw);
		expect(unwrapValue(rowView)).toBe(rowRaw);
		const list = [
			rowView,
			{
				inner: rowView
			}
		];
		const walked: object[] = [];
		const out = unwrapValue(list, [], undefined, walked);
		expect(out).not.toBe(list);
		expect(out[0]).toBe(rowRaw);
		expect((out[1] as any).inner).toBe(rowRaw);
		expect(walked).toEqual([
			list[1],
			list
		]);
		expect(walked).not.toContain(rowRaw);
		expect(Object.isFrozen(list)).toBe(false);
	});

	it("strips recording proxies", () => {
		const raw = {
			Id: "r",
			A: {
				x: 1
			}
		};
		const recording = createRecordingProxy(
			raw,
			{
				currentJournalChanges: null
			},
			new WeakMap()
		);
		expect(rawOf(recording)).toBe(raw);
		expect(unwrapValue(recording.A)).toBe(raw.A);
		expect(
			unwrapValue({
				held: recording.A
			}).held
		).toBe(raw.A);
	});

	it("copies a frozen container and refuses an exotic object", () => {
		const inner = view({
			x: 1
		});
		const frozen = Object.freeze([
			inner
		]);
		const out = unwrapValue(frozen);
		expect(out).not.toBe(frozen);
		expect(Object.isFrozen(out)).toBe(false);
		expect(out[0]).toBe(rawOf(inner));
		expect(() => unwrapValue(new Date(0))).toThrow(/not plain: Date at \[\]/);
	});

	it("refuses a cyclic plain graph", () => {
		const a: any = {};
		a.self = a;
		expect(() => unwrapValue(a)).toThrow(/not plain: cycle at \[self\]/);
	});
});

describe("view proxy: memos", () => {
	it("a detached-root memo tracks through the view and stops after disposal", () => {
		const raw = {
			n: 1
		};
		const v = view(raw);
		let computes = 0;
		let read!: () => number;
		const dispose = reactive.root((d) => {
			read = reactive.memo(() => {
				computes++;
				return v.n * 2;
			});
			return d;
		});
		expect(read()).toBe(2);
		writeKey(raw, "n", 2);
		expect(read()).toBe(4);
		expect(computes).toBe(2);
		dispose();
		writeKey(raw, "n", 3);
		expect(computes).toBe(2);
	});
});
