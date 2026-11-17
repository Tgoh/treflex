import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import { createEffect, createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { createRecordingProxy } from "../../src/Runtime/recordingProxy";
import { rawOf, view } from "../../src/Runtime/viewProxy";
import { captureSurfaced, stepWrite } from "../testHelpers";

function buildWorld(initial: object) {
	const runtime = createRuntime<any>(initial, {
		verifyIndex: true
	}) as IRuntimeInternal<any>;
	const records: IRecord[] = [];
	runtime.on("record", (r) => records.push(r));
	const gateway = runtime.get("runtime/writeGateway");
	const drains: (readonly object[] | null)[] = [];
	gateway.onDrained((touched) => {
		drains.push(touched);
	});
	return {
		runtime,
		records,
		drains,
		gateway,
		raw: () => rawOf(runtime.state) as any,
		written: () => records.filter((r) => r.Kind === "step").flatMap((r) => (r as any).Changes)
	};
}

const rows = () => ({
	$Id: "root",
	L: [
		{
			$Id: "a"
		},
		{
			$Id: "b"
		},
		{
			$Id: "c"
		},
		{
			$Id: "d"
		}
	],
	N: {
		X: 1
	},
	Other: 0
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a write the engine refuses", () => {
	it.each([
		{
			name: "a set on a frozen node",
			prepare: (raw: any) => Object.freeze(raw.N),
			write: (s: any) => {
				s.N.X = 2;
			}
		},
		{
			name: "a new key on a sealed node",
			prepare: (raw: any) => Object.seal(raw.N),
			write: (s: any) => {
				s.N.Y = 2;
			}
		},
		{
			name: "a new key on a non-extensible node",
			prepare: (raw: any) => Object.preventExtensions(raw.N),
			write: (s: any) => {
				s.N.Y = 2;
			}
		},
		{
			name: "a delete on a sealed node",
			prepare: (raw: any) => Object.seal(raw.N),
			write: (s: any) => {
				delete s.N.X;
			}
		},
		{
			name: "a set of undefined on a sealed node, which is a delete",
			prepare: (raw: any) => Object.seal(raw.N),
			write: (s: any) => {
				s.N.X = undefined;
			}
		},
		{
			name: "a push on a frozen array",
			prepare: (raw: any) => Object.freeze(raw.L),
			write: (s: any) => {
				s.L.push(1);
			}
		},
		{
			name: "a push on a non-extensible array",
			prepare: (raw: any) => Object.preventExtensions(raw.L),
			write: (s: any) => {
				s.L.push(1);
			}
		},
		{
			name: "a pop on a sealed array",
			prepare: (raw: any) => Object.seal(raw.L),
			write: (s: any) => {
				s.L.pop();
			}
		},
		{
			name: "a reverse on a frozen array",
			prepare: (raw: any) => Object.freeze(raw.L),
			write: (s: any) => {
				s.L.reverse();
			}
		},
		{
			name: "a length set on a frozen array",
			prepare: (raw: any) => Object.freeze(raw.L),
			write: (s: any) => {
				s.L.length = 1;
			}
		},
		{
			name: "a same-length set on a frozen array",
			prepare: (raw: any) => Object.freeze(raw.L),
			write: (s: any) => {
				s.L.length = 4;
			}
		},
		{
			name: "a shrink on a sealed array, where nothing lands",
			prepare: (raw: any) => Object.seal(raw.L),
			write: (s: any) => {
				s.L.length = 0;
			}
		}
	])("$name leaves no record, no touch and no notification", ({ prepare, write }) => {
		const world = buildWorld(rows());
		prepare(world.raw());
		const before = JSON.stringify(world.raw());
		const cells = Object.keys(world.gateway.lookup()).sort();
		const runs = createRoot((dispose) => {
			let count = 0;
			createEffect(() => {
				void world.runtime.state.N.X;
				void world.runtime.state.N.Y;
				void world.runtime.state.L.length;
				count++;
			});
			return {
				read: () => count,
				dispose
			};
		});
		const ran = runs.read();
		expect(() => stepWrite(world.runtime, write)).toThrow(TypeError);
		expect(JSON.stringify(world.raw())).toBe(before);
		expect(world.written()).toEqual([]);
		expect(world.drains).toEqual([]);
		expect(runs.read()).toBe(ran);
		expect(Object.keys(world.gateway.lookup()).sort()).toEqual(cells);
		runs.dispose();
	});

	it("reads the same on a step", async () => {
		const world = buildWorld(rows());
		Object.freeze(world.raw().N);
		function* action(draft: any): IActionGenerator {
			draft.Other = 1;
			draft.N.X = 2;
			draft.Other = 2;
		}
		await expect(world.runtime.dispatch(action, "root")).rejects.toBeInstanceOf(TypeError);
		const steps = world.records.filter((r) => r.Kind === "step");
		expect(steps.flatMap((r) => (r as any).Changes)).toEqual([
			{
				Path: [
					"Other"
				],
				Prev: 0,
				Value: 1
			}
		]);
		expect(world.raw().Other).toBe(1);
	});

	it("keeps the step when the frame's flush throws", async () => {
		const world = buildWorld(rows());
		const dispose = createRoot((d) => {
			createEffect(() => {
				if (world.runtime.state.Other === 1) {
					throw new Error("a view threw");
				}
			});
			return d;
		});
		await expect(
			world.runtime.dispatch(function* write(draft: any): IActionGenerator {
				draft.Other = 1;
			}, "root")
		).rejects.toThrow("a view threw");
		expect(world.written().map((change: any) => change.Path.join("."))).toEqual([
			"Other"
		]);
		dispose();
	});

	it("records a write whose record can't clone what it replaces as neither landed nor recorded", () => {
		const held = {
			get Y(): number {
				throw new Error("no snapshot");
			}
		};
		const raw: any = {
			X: held
		};
		const changes: any[] = [];
		const observed: string[] = [];
		const draft: any = createRecordingProxy(
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
			draft.X = 2;
		}).toThrow("no snapshot");
		expect(() => {
			delete draft.X;
		}).toThrow("no snapshot");
		expect(raw.X).toBe(held);
		expect(changes).toEqual([]);
		expect(observed).toEqual([]);
	});

	it("takes no touch for a refused non-plain write", () => {
		const world = buildWorld(rows());
		expect(() =>
			stepWrite(world.runtime, (s) => {
				s.N.When = new Date(0);
			})
		).toThrow("not plain");
		expect(world.raw().N.When).toBeUndefined();
		expect(world.drains).toEqual([]);
	});

	it("keeps the record when a view's flush throws out of the notify", () => {
		const raw: any = {
			X: 1
		};
		const changes: any[] = [];
		const v: any = view(raw);
		const dispose = createRoot((d) => {
			createEffect(() => {
				if (v.X === 2) {
					throw new Error("a view threw");
				}
			});
			return d;
		});
		const draft: any = createRecordingProxy(
			raw,
			{
				currentJournalChanges: changes
			},
			new WeakMap()
		);
		expect(() => {
			draft.X = 2;
		}).toThrow("a view threw");
		expect(raw.X).toBe(2);
		expect(changes).toEqual([
			{
				Path: [
					"X"
				],
				Prev: 1,
				Value: 2
			}
		]);
		dispose();
	});
});

describe("an array operation refused partway", () => {
	it("splice over a sealed array unwinds the sets that landed, and records none of them", async () => {
		const surfaced = captureSurfaced();
		const world = buildWorld(rows());
		const raw = world.raw().L;
		const [a, b, c, d] = raw;
		Object.seal(raw);
		expect(() =>
			stepWrite(world.runtime, (s) => {
				s.L.splice(0, 1);
			})
		).toThrow(TypeError);
		expect(raw).toEqual([
			a,
			b,
			c,
			d
		]);
		expect(world.written()).toEqual([]);
		expect(rawOf(world.gateway.lookup().a!.state)).toBe(a);
		await Promise.resolve();
		expect(surfaced).toEqual([]);
	});

	it("shift on a sealed array unwinds to the array it started from", async () => {
		const surfaced = captureSurfaced();
		const world = buildWorld(rows());
		const raw = world.raw().L;
		const before = [
			...raw
		];
		Object.seal(raw);
		expect(() =>
			stepWrite(world.runtime, (s) => {
				s.L.shift();
			})
		).toThrow(TypeError);
		expect(raw).toEqual(before);
		expect(world.written()).toEqual([]);
		await Promise.resolve();
		expect(surfaced).toEqual([]);
	});

	it("a refused write in a splice leaves a catching action an untouched array", async () => {
		const world = buildWorld(rows());
		const raw = world.raw().L;
		const before = [
			...raw
		];
		let caught: unknown;
		stepWrite(world.runtime, (s) => {
			try {
				s.L.splice(1, 0, {
					When: new Date(0)
				});
			} catch (error) {
				caught = error;
			}
			expect(s.L.map((row: any) => row.$Id)).toEqual(before.map((row: any) => row.$Id));
		});
		expect(caught).toBeInstanceOf(NonPlainDataError);
		expect(raw).toEqual(before);
		expect(world.written()).toEqual([]);
	});

	it("a refusal caught inside the callback leaves no claim on the step", () => {
		const world = buildWorld(rows());
		Object.freeze(world.raw().N);
		stepWrite(world.runtime, (s) => {
			try {
				s.N.X = 2;
			} catch {}
			s.Other = 1;
		});
		expect(world.written().map((change: any) => change.Path.join("."))).toEqual([
			"Other"
		]);
		expect(world.raw().N.X).toBe(1);
	});

	it("a shrink stopped by a non-configurable slot records what it dropped", () => {
		const world = buildWorld(rows());
		const raw = world.raw().L;
		Object.defineProperty(raw, 1, {
			configurable: false
		});
		let lengthRuns = 0;
		let slotRuns = 0;
		const dispose = createRoot((d) => {
			createEffect(() => {
				void world.runtime.state.L.length;
				lengthRuns++;
			});
			createEffect(() => {
				void world.runtime.state.L[3];
				slotRuns++;
			});
			return d;
		});
		const lengthBefore = lengthRuns;
		const slotBefore = slotRuns;
		expect(() =>
			stepWrite(world.runtime, (s) => {
				s.L.length = 0;
			})
		).toThrow(TypeError);
		expect(raw.length).toBe(2);
		expect(world.written()).toEqual([
			{
				Path: [
					"L",
					"3"
				],
				Prev: {
					$Id: "d"
				},
				Deleted: true
			},
			{
				Path: [
					"L",
					"2"
				],
				Prev: {
					$Id: "c"
				},
				Deleted: true
			},
			{
				Path: [
					"L",
					"length"
				],
				Prev: 4,
				Value: 2
			}
		]);
		expect(lengthRuns).toBe(lengthBefore + 1);
		expect(slotRuns).toBe(slotBefore + 1);
		expect(world.gateway.lookup().c).toBeUndefined();
		expect(world.gateway.lookup().d).toBeUndefined();
		expect(world.gateway.lookup().a).toBeDefined();
		expect(world.gateway.lookup().b).toBeDefined();
		expect(world.drains).toEqual([
			[
				raw
			]
		]);
		dispose();
	});

	it("a shrink past a sparse tail records only present slots", () => {
		const world = buildWorld(rows());
		const raw = world.raw().L;
		Object.defineProperty(raw, 0, {
			configurable: false
		});
		delete raw[2];
		world.runtime.get("runtime/writeGateway").resync();
		world.records.length = 0;
		expect(() =>
			stepWrite(world.runtime, (s) => {
				s.L.length = 0;
			})
		).toThrow(TypeError);
		expect(world.written().map((change: any) => change.Path.join("."))).toEqual([
			"L.3",
			"L.1",
			"L.length"
		]);
		expect(raw.length).toBe(1);
	});
});

describe("the records of writes that land", () => {
	it("keeps the order of a splice, deletes then length", () => {
		const world = buildWorld(rows());
		stepWrite(world.runtime, (s) => {
			s.L.splice(1, 2);
		});
		expect(
			world.written().map((change: any) => [
				change.Path.join("."),
				change.Deleted ?? false
			])
		).toEqual([
			[
				"L.1",
				false
			],
			[
				"L.3",
				true
			],
			[
				"L.2",
				true
			],
			[
				"L.length",
				false
			]
		]);
	});

	it("synthesizes a shrink's deletes high to low, ahead of the length", () => {
		const world = buildWorld(rows());
		stepWrite(world.runtime, (s) => {
			s.L.length = 2;
		});
		expect(world.written().map((change: any) => change.Path.join("."))).toEqual([
			"L.3",
			"L.2",
			"L.length"
		]);
		expect(world.gateway.lookup().c).toBeUndefined();
	});

	it("records a coerced length as the length that landed, with its dropped slots", () => {
		const world = buildWorld(rows());
		stepWrite(world.runtime, (s) => {
			s.L.length = "2";
		});
		expect(world.written().at(-1)).toEqual({
			Path: [
				"L",
				"length"
			],
			Prev: 4,
			Value: 2
		});
		expect(world.written().map((change: any) => change.Path.join("."))).toEqual([
			"L.3",
			"L.2",
			"L.length"
		]);
		expect(world.gateway.lookup().c).toBeUndefined();
	});

	it("keeps Created and GrewFrom on a write past the end", () => {
		const world = buildWorld(rows());
		stepWrite(world.runtime, (s) => {
			s.L[4] = 1;
			s.N.New = 1;
		});
		expect(world.written()).toEqual([
			{
				Path: [
					"L",
					"4"
				],
				Value: 1,
				Created: true,
				GrewFrom: 4
			},
			{
				Path: [
					"N",
					"New"
				],
				Value: 1,
				Created: true
			}
		]);
	});

	it.each([
		{
			name: "a set of undefined on an absent key",
			write: (s: any) => {
				s.N.Y = undefined;
			}
		},
		{
			name: "a delete of an absent key",
			write: (s: any) => {
				delete s.N.Y;
			}
		},
		{
			name: "a delete past the end",
			write: (s: any) => {
				delete s.L[9];
			}
		}
	])("records nothing and touches nothing for a no-op: $name", ({ write }) => {
		const world = buildWorld(rows());
		stepWrite(world.runtime, write);
		expect(world.written()).toEqual([]);
		expect(world.drains).toEqual([]);
		expect(world.raw().L.length).toBe(4);
	});

	it.each([
		{
			name: "a scalar",
			value: 5
		},
		{
			name: "an object",
			value: {
				P: 1
			}
		}
	])("refuses a write to __proto__, with nothing landing: $name", ({ value }) => {
		const world = buildWorld(rows());
		const before = Object.getPrototypeOf(world.raw().N);
		expect(() =>
			stepWrite(world.runtime, (s) => {
				s.N.__proto__ = value;
			})
		).toThrow(TypeError);
		expect(Object.hasOwn(world.raw().N, "__proto__")).toBe(false);
		expect(Object.getPrototypeOf(world.raw().N)).toBe(before);
		expect(world.written()).toEqual([]);
		expect(world.drains).toEqual([]);
	});

	it("takes GrewFrom from the landed length, so a key that only reads like an index claims nothing", () => {
		const world = buildWorld(rows());
		stepWrite(world.runtime, (s) => {
			s.L["1e3"] = 1;
		});
		expect(world.raw().L.length).toBe(4);
		expect(world.written()).toEqual([
			{
				Path: [
					"L",
					"1e3"
				],
				Value: 1,
				Created: true
			}
		]);
	});

	describe("backward replay over holes", () => {
		const replayBack = (changes: any[], after: unknown[]): unknown[] => {
			const out: any = [
				...after
			];
			Object.setPrototypeOf(out, Array.prototype);
			for (let i = 0; i < after.length; i++) {
				if (!(i in after)) {
					delete out[i];
				}
			}
			for (let i = changes.length - 1; i >= 0; i--) {
				const change = changes[i];
				const key = change.Path[change.Path.length - 1];
				if (change.Created) {
					if (change.GrewFrom !== undefined) {
						out.length = change.GrewFrom;
					} else {
						delete out[key];
					}
				} else {
					out[key] = change.Prev;
				}
			}
			return out;
		};

		const sparse = () => {
			const list: unknown[] = [
				1,
				2,
				3,
				4,
				5
			];
			delete list[1];
			delete list[3];
			return list;
		};

		it.each([
			{
				name: "delete arr[9]",
				write: (a: any) => {
					delete a[9];
				}
			},
			{
				name: "splice over holes",
				write: (a: any) => a.splice(0, 2)
			},
			{
				name: "pop onto a hole",
				write: (a: any) => {
					a.pop();
					a.pop();
				}
			}
		])("$name restores what was there", ({ write }) => {
			const world = buildWorld({
				$Id: "root",
				L: [
					1,
					2,
					3,
					4,
					5
				]
			});
			delete world.raw().L[1];
			delete world.raw().L[3];
			stepWrite(world.runtime, (s) => write(s.L));
			const back = replayBack(world.written(), world.raw().L);
			const before = sparse();
			expect(back.length).toBe(before.length);
			for (let i = 0; i < before.length; i++) {
				expect(i in back, `slot ${i}`).toBe(i in before);
				expect(back[i]).toBe(before[i]);
			}
		});
	});
});
