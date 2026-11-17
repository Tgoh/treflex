import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IRecord } from "../../src/Types/IRecord";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { StateAliasError } from "../../src/Runtime/stateAlias";
import { StateCycleError } from "../../src/Runtime/stateCycle";
import { rawOf } from "../../src/Runtime/viewProxy";
import { stepWrite, treeWrite } from "../testHelpers";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

function holdsLoop(root: object): boolean {
	const finished = new Set<object>();
	const onPath = new Set<object>();
	const visit = (node: any): boolean => {
		if (node === null || typeof node !== "object" || finished.has(node)) {
			return false;
		}
		if (onPath.has(node)) {
			return true;
		}
		onPath.add(node);
		const found = Object.keys(node).some((key) => visit(node[key]));
		onPath.delete(node);
		finished.add(node);
		return found;
	};
	return visit(root);
}

function buildWorld(journal: boolean, extra: object = {}) {
	const deferred: (() => void)[] = [];
	vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
		deferred.push(callback);
	});
	const runtime = createRuntime<any>(
		{
			$Id: "root",
			A: {
				$Id: "a",
				B: {
					$Id: "b",
					C: {
						$Id: "c"
					}
				}
			},
			L: [
				1,
				2,
				3
			],
			N: {
				X: 1
			},
			Plain: {
				PA: {
					PB: {
						V: 1
					}
				}
			},
			...extra
		},
		{
			verifyIndex: false
		}
	) as IRuntimeInternal<any>;
	const records: IRecord[] = [];
	if (journal) {
		runtime.on("record", (r) => records.push(r));
	}
	return {
		runtime,
		records,
		gateway: runtime.get("runtime/writeGateway"),
		raw: () => rawOf(runtime.state) as any,
		surface(): unknown[] {
			const surfaced: unknown[] = [];
			for (const callback of deferred.splice(0)) {
				try {
					callback();
				} catch (error) {
					surfaced.push(error);
				}
			}
			return surfaced;
		}
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each([
	{
		journal: true
	},
	{
		journal: false
	}
])("in a production build, journal $journal", ({ journal }) => {
	it("a direct cycle is refused and undone, and the next write runs", () => {
		const world = buildWorld(journal);
		expect(() =>
			treeWrite(world.runtime, (s) => {
				s.A.B.Back = s.A;
			})
		).toThrow(StateCycleError);
		expect(world.raw().A.B.Back).toBeUndefined();
		treeWrite(world.runtime, (s) => {
			s.A.B.X = 1;
		});
		expect(world.raw().A.B.X).toBe(1);
		world.gateway.resync();
		expect(world.surface()).toEqual([]);
	});

	it("a fresh cycle and a frozen one are refused at the write", () => {
		const world = buildWorld(journal);
		const fresh: any = {};
		fresh.self = fresh;
		const frozen: any = {};
		frozen.b = Object.freeze({
			frozen
		});
		Object.freeze(frozen);
		for (const value of [
			fresh,
			frozen
		]) {
			expect(() =>
				treeWrite(world.runtime, (s) => {
					s.Fresh = value;
				})
			).toThrow(/not plain: cycle at/);
			expect(world.raw().Fresh).toBeUndefined();
			expect(world.surface()).toEqual([]);
		}
		expect(Object.isFrozen(fresh)).toBe(false);
	});

	it("a raw write's loop in a fresh node of the frame is refused with the frame", () => {
		const world = buildWorld(journal);
		expect(() =>
			treeWrite(world.runtime, (s) => {
				s.A.B.Box = {};
				world.raw().A.B.Box.Up = world.raw().A;
			})
		).toThrow(StateCycleError);
		expect(world.raw().A.B.Box).toBeUndefined();
		treeWrite(world.runtime, (s) => {
			s.A.B.X = 1;
		});
		expect(world.raw().A.B.X).toBe(1);
	});

	it("a write with a cyclic value is refused before it writes, and the frame stays usable", () => {
		const world = buildWorld(journal);
		const payload: any = {
			V: 2
		};
		payload.PA = {
			Back: payload
		};
		treeWrite(world.runtime, (s) => {
			s.Plain.PA.Back = {
				X: 1
			};
		});
		expect(() =>
			treeWrite(world.runtime, (s) => {
				s.Plain = payload;
			})
		).toThrow(/not plain: cycle at/);
		expect(world.raw().Plain.V).toBeUndefined();
		expect(world.raw().Plain.PA.Back).toEqual({
			X: 1
		});
		expect(holdsLoop(world.raw())).toBe(false);
		treeWrite(world.runtime, (s) => {
			s.N.X = 5;
		});
		expect(world.raw().N.X).toBe(5);
		expect(world.surface()).toEqual([]);
	});

	describe("a loop formed through a node that still sits at another slot", () => {
		const moves: {
			name: string;
			write: (s: any) => void;
			repair: (s: any) => void;
		}[] = [
			{
				name: "delete the holder's slot, close, then re-seat",
				write: (s) => {
					const a = s.A;
					const b = a.B;
					delete s.A;
					b.Back = a;
					s.Top = b;
				},
				repair: (s) => {
					delete s.Top.Back;
				}
			},
			{
				name: "re-seat, close, then delete the holder's slot",
				write: (s) => {
					const a = s.A;
					const b = a.B;
					s.Top = b;
					b.Back = a;
					delete s.A;
				},
				repair: (s) => {
					delete s.Top.Back;
				}
			},
			{
				name: "re-seat, delete the holder's slot, then close",
				write: (s) => {
					const a = s.A;
					const b = a.B;
					s.Top = b;
					delete s.A;
					b.Back = a;
				},
				repair: (s) => {
					delete s.Top.Back;
				}
			},
			{
				name: "a child replaces its holder and holds it",
				write: (s) => {
					const a = s.A;
					const b = a.B;
					b.Kid = a;
					s.A = b;
				},
				repair: (s) => {
					delete s.A.Kid;
				}
			},
			{
				name: "a fresh wrapper replaces the holder",
				write: (s) => {
					const a = s.A;
					const b = a.B;
					b.Kid = a;
					s.A = {
						H: b
					};
				},
				repair: (s) => {
					delete s.A.H.Kid;
				}
			},
			{
				name: "an array takes the child",
				write: (s) => {
					const a = s.A;
					const b = a.B;
					s.Rows = [
						b
					];
					b.Kid = a;
					delete s.A;
				},
				repair: (s) => {
					delete s.Rows[0].Kid;
				}
			},
			{
				name: "a plain child replaces its holder's holder",
				write: (s) => {
					const pa = s.Plain.PA;
					const pb = pa.PB;
					pb.Back = pa;
					s.Plain = pb;
				},
				repair: (s) => {
					delete s.Plain.Back;
				}
			}
		];

		it.each(moves)("$name: refused at the frame's end as the alias it starts from, so no loop stands", ({ write }) => {
			const world = buildWorld(journal);
			const held = Object.keys(world.gateway.lookup()).sort();
			expect(() => treeWrite(world.runtime, write)).toThrow(StateAliasError);
			expect(holdsLoop(world.raw())).toBe(false);
			expect(world.surface()).toEqual([]);
			treeWrite(world.runtime, (s) => {
				s.N.X = 2;
			});
			expect(world.raw().N.X).toBe(2);
			world.gateway.resync();
			expect(world.surface()).toEqual([]);
			expect(Object.keys(world.gateway.lookup()).sort()).toEqual(held);
		});
	});
});

describe("the record in a production build", () => {
	it("holds no change for a refused write", () => {
		const world = buildWorld(true);
		Object.freeze(world.raw().N);
		expect(() =>
			stepWrite(world.runtime, (s) => {
				s.L[0] = 9;
				s.N.X = 2;
			})
		).toThrow(TypeError);
		expect(world.records.filter((r) => r.Kind === "step").flatMap((r) => (r as any).Changes)).toEqual([
			{
				Path: [
					"L",
					"0"
				],
				Prev: 1,
				Value: 9
			}
		]);
	});

	it("holds what a shrink dropped when it landed partway", () => {
		const world = buildWorld(true);
		Object.defineProperty(world.raw().L, 0, {
			configurable: false
		});
		expect(() =>
			stepWrite(world.runtime, (s) => {
				s.L.length = 0;
			})
		).toThrow(TypeError);
		const changes = world.records.filter((r) => r.Kind === "step").flatMap((r) => (r as any).Changes);
		expect(changes.map((change: any) => change.Path.join("."))).toEqual([
			"L.2",
			"L.1",
			"L.length"
		]);
		expect(changes[2].Value).toBe(1);
	});
});
