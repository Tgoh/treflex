import type { IWriteGateway } from "../../src/Runtime/createWriteGateway";
import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { EntityReplacedError } from "../../src/Runtime/draftNode";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { wrapSetState } from "../../src/Runtime/sliceSetState";
import { StateAliasError } from "../../src/Runtime/stateAlias";
import { StateCycleError } from "../../src/Runtime/stateCycle";
import { rawOf, unwrapValue, view } from "../../src/Runtime/viewProxy";
import { frameWrite, minted, rawWrite, stepWrite, treeWrite } from "../testHelpers";

// Nothing here runs a drain against up-links that loop, so a regression fails instead of
// wedging the worker: `expectUpLinksLoopFree` climbs with a bound, ahead of each next write.

function captureMicrotasks() {
	const deferred: (() => void)[] = [];
	vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
		deferred.push(callback);
	});
	return {
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

const initial = (extra: object = {}) => ({
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
	Side: {
		$Id: "side",
		Rows: [
			{
				$Id: "r0"
			},
			{
				$Id: "r1"
			},
			{
				$Id: "r2"
			}
		]
	},
	Plain: {
		Text: "x"
	},
	...extra
});

function buildWorld(journal: boolean, verifyIndex: boolean = true, seed: object = initial()) {
	const microtasks = captureMicrotasks();
	const runtime = createRuntime<any>(seed, {
		verifyIndex
	}) as IRuntimeInternal<any>;
	const records: IRecord[] = [];
	if (journal) {
		runtime.on("record", (r) => records.push(r));
	}
	const gateway = runtime.get("runtime/writeGateway");
	return {
		runtime,
		records,
		gateway,
		microtasks,
		raw: () => rawOf(runtime.state) as any
	};
}

type IWorldOf = ReturnType<typeof buildWorld>;

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

function expectUpLinksLoopFree(gateway: IWriteGateway, root: object): void {
	const seen = new Set<object>();
	const visit = (node: any): void => {
		if (node === null || typeof node !== "object" || seen.has(node)) {
			return;
		}
		seen.add(node);
		let current: object | null = node;
		let hops = 0;
		while (current) {
			current = gateway.nodeUpLink(current)?.parent ?? null;
			if (++hops > 1000) {
				throw new Error("the up-links loop");
			}
		}
		for (const key of Object.keys(node)) {
			visit(node[key]);
		}
	};
	visit(root);
}

const cyclicFresh = (): any => {
	const o: any = {
		N: 1
	};
	o.self = o;
	return o;
};

const cycleTwoDown = (): any => {
	const top: any = {
		L1: {
			L2: {}
		}
	};
	top.L1.L2.Back = top.L1;
	return top;
};

const frozenCycle = (): any => {
	const a: any = {};
	const b: any = {
		a
	};
	a.b = b;
	Object.freeze(a);
	Object.freeze(b);
	return a;
};

const journalModes = [
	{
		journal: true
	},
	{
		journal: false
	}
];

const routes: {
	name: string;
	write: (s: any) => void;
	path: string[];
	loop: string[];
}[] = [
	{
		name: "a direct write to a descendant",
		write: (s) => {
			s.A.B.Back = s.A;
		},
		path: [
			"AppState",
			"A",
			"B",
			"Back"
		],
		loop: [
			"Back",
			"B"
		]
	},
	{
		name: "a node written into itself",
		write: (s) => {
			s.A.Self = s.A;
		},
		path: [
			"AppState",
			"A",
			"Self"
		],
		loop: [
			"Self"
		]
	},
	{
		name: "the root written below itself",
		write: (s) => {
			s.A.B.C.Root = s;
		},
		path: [
			"AppState",
			"A",
			"B",
			"C",
			"Root"
		],
		loop: [
			"Root",
			"A",
			"B",
			"C"
		]
	},
	{
		name: "a view proxy of a live ancestor",
		write: (s) => {
			s.A.B.Back = view(rawOf(s.A));
		},
		path: [
			"AppState",
			"A",
			"B",
			"Back"
		],
		loop: [
			"Back",
			"B"
		]
	},
	{
		name: "a fresh object holding a live ancestor",
		write: (s) => {
			s.A.B.Box = {
				Up: s.A
			};
		},
		path: [
			"AppState",
			"A",
			"B",
			"Box",
			"Up"
		],
		loop: [
			"Up",
			"B",
			"Box"
		]
	},
	{
		name: "arr.push(arr)",
		write: (s) => {
			s.Side.Rows.push(s.Side.Rows);
		},
		path: [
			"AppState",
			"Side",
			"Rows",
			"3"
		],
		loop: [
			"3"
		]
	},
	{
		name: "arr.unshift(arr)",
		write: (s) => {
			s.Side.Rows.unshift(s.Side.Rows);
		},
		path: [
			"AppState",
			"Side",
			"Rows",
			"0"
		],
		loop: [
			"0"
		]
	},
	{
		name: "arr.splice inserting its own holder",
		write: (s) => {
			s.Side.Rows.splice(0, 0, s.Side);
		},
		path: [
			"AppState",
			"Side",
			"Rows",
			"0"
		],
		loop: [
			"0",
			"Rows"
		]
	},
	{
		name: "Object.assign through the proxy",
		write: (s) => {
			Object.assign(s.A.B, {
				Back: s.A
			});
		},
		path: [
			"AppState",
			"A",
			"B",
			"Back"
		],
		loop: [
			"Back",
			"B"
		]
	},
	{
		name: "Object.defineProperty through the proxy",
		write: (s) => {
			Object.defineProperty(s.A.B, "Back", {
				value: s.A,
				writable: true,
				enumerable: true,
				configurable: true
			});
		},
		path: [
			"AppState",
			"A",
			"B",
			"Back"
		],
		loop: [
			"Back",
			"B"
		]
	},
	{
		name: "a raw write to a fresh object in the frame",
		write: (s) => {
			s.A.B.Box = {};
			rawOf(s.A.B.Box).Up = rawOf(s.A);
		},
		path: [
			"AppState",
			"A",
			"B",
			"Box",
			"Up"
		],
		loop: [
			"Up",
			"B",
			"Box"
		]
	}
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each(journalModes)("a cycle through the draft, journal $journal", ({ journal }) => {
	it.each([
		{
			name: "a fresh object holding itself",
			value: cyclicFresh,
			at: "Fresh.self"
		},
		{
			name: "a fresh object with a cycle two levels down",
			value: cycleTwoDown,
			at: "Fresh.L1.L2.Back"
		},
		{
			name: "a frozen object carrying a cycle",
			value: frozenCycle,
			at: "Fresh.b.a"
		}
	])("$name is refused at the write, and left as it was", ({ value, at }) => {
		const world = buildWorld(journal);
		const cyclic = value();
		const wasFrozen = Object.isFrozen(cyclic);
		expect(() =>
			treeWrite(world.runtime, (s) => {
				s.Fresh = cyclic;
			})
		).toThrow(new RegExp(`not plain: cycle at \\[(AppState\\.)?${at.replaceAll(".", "\\.")}\\]`));
		expect(Object.isFrozen(cyclic)).toBe(wasFrozen);
		expect(world.raw().Fresh).toBeUndefined();
		expect(world.microtasks.surface()).toEqual([]);
	});

	it.each(routes)("$name is refused when the frame ends, naming the slot and the loop, and undone", ({ write, path, loop }) => {
		const world = buildWorld(journal);
		const before = JSON.stringify(world.raw());
		let refusal: unknown;
		try {
			treeWrite(world.runtime, write);
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(StateCycleError);
		expect((refusal as StateCycleError).path).toEqual(path);
		expect((refusal as StateCycleError).loop).toEqual(loop);
		expect(holdsLoop(world.raw())).toBe(false);
		expect(JSON.stringify(world.raw())).toBe(before);
		expectUpLinksLoopFree(world.gateway, world.raw());
		treeWrite(world.runtime, (s) => {
			s.Plain.Y = 2;
		});
		expect(world.raw().Plain.Y).toBe(2);
		expect(world.microtasks.surface()).toEqual([]);
	});

	it("counts the slice's other closing slots in one refusal", () => {
		const world = buildWorld(journal);
		let refusal: unknown;
		try {
			treeWrite(world.runtime, (s) => {
				s.A.B.Back = s.A;
				s.Plain.Self = s.Plain;
			});
		} catch (error) {
			refusal = error;
		}
		expect((refusal as StateCycleError).others).toBe(1);
		expect((refusal as Error).message).toContain("1 other closing slot was met in the same step");
	});
});

describe("a loop through the draft is refused", () => {
	it("behind the frame's own error, which wins, with the loop undone", () => {
		const world = buildWorld(true);
		expect(() =>
			treeWrite(world.runtime, (s) => {
				s.A.B.Back = s.A;
				throw new Error("the frame's own");
			})
		).toThrow("the frame's own");
		expect(world.raw().A.B.Back).toBeUndefined();
		expect(world.microtasks.surface()).toEqual([]);
	});

	it("reaching the writer: the action fails, and what it wrote in the slice is undone", async () => {
		const world = buildWorld(true);
		function* action(draft: any): IActionGenerator<string> {
			draft.B.Back = draft;
			draft.B.After = 1;
			return "carried on";
		}
		const refusal = await world.runtime.dispatch(action, "a").then(
			() => undefined,
			(error: unknown) => error
		);
		expect(refusal).toBeInstanceOf(StateCycleError);
		expect((refusal as StateCycleError).path).toEqual([
			"AppState",
			"A",
			"B",
			"Back"
		]);
		expect(world.raw().A.B.After).toBeUndefined();
		expect(holdsLoop(world.raw())).toBe(false);
		expect(world.microtasks.surface()).toEqual([]);
	});
});

describe("a loop a raw write makes", () => {
	it("fails the resync that meets it, loudly", () => {
		const world = buildWorld(false, false);
		expect(() =>
			rawWrite(world.runtime, (raw: any) => {
				raw.A.B.Back = raw.A;
			})
		).toThrow(/a rebuild met a loop at \[AppState\.A\.B\.Back\]/);
	});

	it("fails the consistency walk that meets it, loudly", () => {
		const world = buildWorld(false, true);
		world.raw().A.B.Back = world.raw().A;
		expect(() =>
			treeWrite(world.runtime, (s) => {
				s.Plain.Tick = 1;
			})
		).toThrow(/the tree holds a node twice/);
	});

	it("over a dense mesh, fails the resync without walking every path", () => {
		let reads = 0;
		const cells: any[][] = [];
		for (let y = 0; y < 6; y++) {
			cells.push([]);
			for (let x = 0; x < 6; x++) {
				cells[y]!.push({
					get Watch() {
						if (++reads > 2000) {
							throw new Error("a walk is enumerating every path through the mesh");
						}
						return 0;
					}
				});
			}
		}
		for (let y = 0; y < 6; y++) {
			for (let x = 0; x < 6; x++) {
				if (x + 1 < 6) {
					cells[y]![x].R = cells[y]![x + 1];
				}
				if (y + 1 < 6) {
					cells[y]![x].D = cells[y + 1]![x];
				}
				if (x > 0) {
					cells[y]![x].L = cells[y]![x - 1];
				}
			}
		}
		const world = buildWorld(false, false, {
			$Id: "root",
			Plain: {}
		});
		expect(() =>
			rawWrite(world.runtime, (raw: any) => {
				raw.Mesh = cells[0]![0];
			})
		).toThrow(/a rebuild met/);
	});
});

describe("a cyclic plain value is refused on every way in", () => {
	const seedLoop = (): any => {
		const seed: any = initial();
		seed.A.B.Back = seed.A;
		return seed;
	};

	it.each([
		{
			name: "a seed",
			make: seedLoop
		},
		{
			name: "a frozen seed",
			make: frozenCycle
		}
	])("$name", ({ make }) => {
		const seed = make();
		const wasFrozen = Object.isFrozen(seed);
		expect(() => createRuntime<any>(seed)).toThrow(/not plain: cycle at/);
		expect(Object.isFrozen(seed)).toBe(wasFrozen);
	});
});

describe("a proxy seated by a raw write", () => {
	it("is unwrapped with no loop, so the slot holds the raw node", () => {
		const world = buildWorld(true, true, {
			$Id: "root",
			Rows: [],
			Other: {}
		});
		const other = world.raw().Other;
		treeWrite(world.runtime, (s) => {
			s.Rows.push({});
			rawOf(s.Rows[0]).Link = s.Other;
			delete s.Other;
		});
		expect(world.raw().Rows[0].Link).toBe(other);
		expect(world.microtasks.surface()).toEqual([]);
	});
});

describe("walks that meet a loop ahead of the guard", () => {
	it("unwrapValue gives each slot its own copy of a frozen value", () => {
		const shared = Object.freeze({
			V: 1
		});
		const out = unwrapValue(
			Object.freeze({
				a: shared,
				b: shared
			})
		) as any;
		expect(out.a).not.toBe(out.b);
		expect(Object.isFrozen(out.a)).toBe(false);
	});

	it("a frozen value at two slots, or filling an array, writes one slot at a time", () => {
		const blank = Object.freeze({
			Text: ""
		});
		const world = buildWorld(true, true, {
			$Id: "root",
			Left: blank,
			Right: blank
		});
		treeWrite(world.runtime, (s) => {
			s.Left.Text = "x";
			s.Rows = new Array(3).fill(blank);
			s.Rows[1].Text = "y";
		});
		expect(world.raw().Right.Text).toBe("");
		expect(world.raw().Rows.map((row: any) => row.Text)).toEqual([
			"",
			"y",
			""
		]);
		expect(world.microtasks.surface()).toEqual([]);
	});

	it("a frozen entity at two slots lands as two copies under one $Id, which the frame's end refuses", () => {
		const world = buildWorld(true);
		const entity = Object.freeze(minted("e"));
		expect(() =>
			treeWrite(world.runtime, (s) => {
				s.P = {
					A: entity,
					B: entity
				};
			})
		).toThrow(EntityReplacedError);
		expect(world.raw().P).toBeUndefined();
		expect(world.gateway.lookup()["~e"]).toBeUndefined();
		expect(world.microtasks.surface()).toEqual([]);
	});
});

describe("a ladder written through the draft", () => {
	it("is refused at the frame's end as an alias, so no walk ever meets it", () => {
		const world = buildWorld(false, false);
		expect(() =>
			treeWrite(world.runtime, (s) => {
				s.G = {};
				let current = s.G;
				for (let i = 0; i < 28; i++) {
					current.L = {};
					current.R = current.L;
					current = current.L;
				}
			})
		).toThrow(StateAliasError);
		expect(world.raw().G).toBeUndefined();
		expect(world.microtasks.surface()).toEqual([]);
	});
});

describe("a payload diamond", () => {
	it("reaches both slots", () => {
		const shared: any = {
			V: 2
		};
		const world = buildWorld(false, false, {
			...initial(),
			Box: {
				Left: {
					V: 1
				},
				Right: {
					V: 1
				}
			}
		});
		treeWrite(world.runtime, (s) => {
			s.Box.Left = shared;
			s.Box.Right = shared;
		});
		expect(world.raw().Box.Left.V).toBe(2);
		expect(world.raw().Box.Right.V).toBe(2);
		expect(world.raw().Box.Left).not.toBe(world.raw().Box.Right);
	});
});

describe("a cyclic value", () => {
	function refusedBy(call: () => void, at: string): void {
		expect(call).toThrow(new RegExp(`not plain: cycle at \\[(AppState\\.)?${at.replaceAll(".", "\\.")}\\]`));
	}

	function usableAfter(world: IWorldOf): void {
		expect(holdsLoop(world.raw())).toBe(false);
		expectUpLinksLoopFree(world.gateway, world.raw());
		treeWrite(world.runtime, (s) => {
			s.Plain.Tick = 1;
		});
		expect(world.raw().Plain.Tick).toBe(1);
		world.gateway.resync();
		expect(world.microtasks.surface()).toEqual([]);
	}

	const objectSeed = () => ({
		...initial(),
		G: {
			K: {
				Back: {
					X: 1
				}
			}
		}
	});

	const objectPayload = (): any => {
		const payload: any = {
			K: {
				New: 1
			}
		};
		payload.K.Back = payload;
		return payload;
	};

	it.each(journalModes)("a write is refused, naming the slot, and writes nothing, journal $journal", ({ journal }) => {
		const world = buildWorld(journal, true, objectSeed());
		refusedBy(
			() =>
				treeWrite(world.runtime, (s) => {
					s.G = objectPayload();
				}),
			"G.K.Back"
		);
		expect(world.raw().G.K).toEqual({
			Back: {
				X: 1
			}
		});
		usableAfter(world);
	});

	it("a step around it records what landed, and rethrows", () => {
		const world = buildWorld(true, true, objectSeed());
		refusedBy(
			() =>
				stepWrite(world.runtime, (s) => {
					s.Plain.Before = 1;
					s.G = objectPayload();
				}),
			"G.K.Back"
		);
		const changes = world.records.filter((r) => r.Kind === "step").flatMap((r) => (r as any).Changes);
		expect(changes.map((change: any) => change.Path.join("."))).toEqual([
			"Plain.Before"
		]);
		expect(world.raw().Plain.Before).toBe(1);
		usableAfter(world);
	});

	it("the writer can catch it inside the frame, and the frame goes on", () => {
		const world = buildWorld(false, true, objectSeed());
		treeWrite(world.runtime, (s) => {
			refusedBy(() => {
				s.G = objectPayload();
			}, "G.K.Back");
			s.Plain.After = 1;
		});
		expect(world.raw().Plain.After).toBe(1);
		usableAfter(world);
	});

	it("a refresh's incoming row is refused before anything moves", async () => {
		const world = buildWorld(false, true, {
			...initial(),
			Grid: [
				{
					Key: "r",
					V: 1
				}
			]
		});
		const row: any = {
			Key: "r",
			V: 2
		};
		row.Kids = [
			row
		];
		function* refresh(draft: any): IActionGenerator {
			yield* reconcileRows(
				draft.Grid,
				[
					row
				],
				(r: any) => r.Key,
				{
					update: () => {}
				}
			);
		}
		await expect(world.runtime.dispatch(refresh, "root")).rejects.toThrow(
			/reconcileRows\(\): the incoming rows is not plain: cycle at \[0\.Kids\.0\]/
		);
		expect(world.raw().Grid[0].V).toBe(1);
		usableAfter(world);
	});
});

describe("a tree outside any runtime, which nothing indexes", () => {
	it("takes a loop without a report, and nothing walks it", () => {
		const microtasks = captureMicrotasks();
		const raw: any = {
			$Id: "local",
			A: {
				B: {}
			}
		};
		const setState = wrapSetState(raw);
		setState((s: any) => {
			s.A.B.Back = s.A;
		});
		expect(raw.A.B.Back).toBe(raw.A);
		setState((s: any) => {
			s.A.B.X = 1;
			s.A.B.Back = null;
		});
		expect(raw.A.B.Back).toBeNull();
		expect(microtasks.surface()).toEqual([]);
	});
});

describe("what forms no loop raises no StateCycleError", () => {
	it.each(journalModes)("aliases are refused only as aliases, and diamonds in a value land as copies, journal $journal", ({ journal }) => {
		const world = buildWorld(journal);
		const shared = {
			V: 1
		};
		expect(() =>
			treeWrite(world.runtime, (s) => {
				s.A.Link = s.Plain;
				s.Side.Link = s.Plain;
			})
		).toThrow(StateAliasError);
		treeWrite(world.runtime, (s) => {
			s.Plain.Dia = {
				a: shared,
				b: shared,
				c: {
					d: shared,
					e: [
						shared,
						shared
					]
				}
			};
			s.Plain.Frozen = Object.freeze({
				a: shared,
				b: shared
			});
		});
		world.gateway.resync();
		const raw = world.raw().Plain;
		expect(raw.Dia.a).not.toBe(raw.Dia.b);
		expect(raw.Frozen.a).not.toBe(shared);
		expect(raw.Frozen.a).toEqual(shared);
		expect(world.raw().A.Link).toBeUndefined();
		expect(world.microtasks.surface()).toEqual([]);
	});

	it.each(journalModes)("a rearrangement with no cycle at any instant, journal $journal", ({ journal }) => {
		const world = buildWorld(journal);
		const a = world.raw().A;
		const b = world.raw().A.B;
		treeWrite(world.runtime, (s) => {
			const held = s.A.B;
			delete s.A.B;
			held.Kid = s.A;
			s.A = held;
		});
		expect(world.raw().A).toBe(b);
		expect(world.raw().A.Kid).toBe(a);
		expect(world.gateway.lookup().a.path).toEqual([
			"root",
			"b",
			"a"
		]);
		expectUpLinksLoopFree(world.gateway, world.raw());
		expect(world.microtasks.surface()).toEqual([]);
	});

	it("the deferred order: a node walked before the holder that re-parents it", () => {
		const world = buildWorld(true);
		treeWrite(world.runtime, (s) => {
			const b = s.A.B;
			const c = b.C;
			c.Mark = 1;
			delete b.C;
			s.A.Mid = c;
			c.B = b;
			delete s.A.B;
		});
		expect(world.raw().A.Mid.B.$Id).toBe("b");
		expect(world.gateway.lookup().b.path).toEqual([
			"root",
			"a",
			"c",
			"b"
		]);
		expect(world.microtasks.surface()).toEqual([]);
	});

	it("array re-seats, a swap and a filter", () => {
		const world = buildWorld(true);
		treeWrite(world.runtime, (s) => {
			const rows = s.Side.Rows;
			const first = rows[0];
			rows[0] = rows[2];
			rows[2] = first;
			rows.reverse();
			rows.sort((x: any, y: any) => (x.$Id < y.$Id ? 1 : -1));
			rows.splice(0, 1);
			rows.push(rows.shift());
			s.Side.Rows = rows.filter(() => true);
		});
		expect(world.raw().Side.Rows.map((r: any) => r.$Id)).toEqual([
			"r0",
			"r1"
		]);
		expect(world.microtasks.surface()).toEqual([]);
	});

	it("a dispose cleanup that rearranges mid-drain", () => {
		const world = buildWorld(true);
		world.gateway.onDispose((id) => {
			if (id === "c") {
				frameWrite(world.runtime, (s) => {
					const side = s.Side;
					delete s.Side;
					side.Plain = s.Plain;
					delete s.Plain;
					s.Plain = side;
				});
			}
		}, "tables");
		treeWrite(world.runtime, (s) => {
			delete s.A.B.C;
		});
		expect(world.raw().Plain.$Id).toBe("side");
		expect(world.raw().Plain.Plain.Text).toBe("x");
		expect(world.gateway.lookup().r0.path).toEqual([
			"root",
			"side",
			"r0"
		]);
		expect(world.microtasks.surface()).toEqual([]);
	});
});

describe("seeded rearrangements", () => {
	function rng(seed: number): () => number {
		let a = seed + 0x6d2b79f5;
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	const reaches = (from: any, to: object, seen = new Set<object>()): boolean => {
		if (from === to) {
			return true;
		}
		if (from === null || typeof from !== "object" || seen.has(from)) {
			return false;
		}
		seen.add(from);
		return Object.keys(from).some((key) => reaches(from[key], to, seen));
	};

	const tree = (entities: boolean): any => {
		const id = (name: string) =>
			entities
				? {
						$Id: name
					}
				: {};
		return {
			$Id: "root",
			L: [
				{
					...id("l0"),
					N: {
						...id("n0")
					}
				},
				{
					...id("l1"),
					N: {
						...id("n1"),
						D: {}
					}
				},
				{
					...id("l2")
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
			}
		};
	};

	const collect = (
		draft: any,
		out: {
			node: any;
			holder: any;
			key: string;
		}[],
		seen: Set<object>,
		holder: any,
		key: string
	): void => {
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
	};

	it.each([
		{
			name: "moves alone",
			aliases: false
		},
		{
			name: "moves beside aliases",
			aliases: true
		}
	])("$name form no loop: the index stays right in every order, and only an alias is refused", ({ aliases }) => {
		for (let seed = 1; seed <= 200; seed++) {
			const r = rng(seed);
			const entities = seed % 2 === 0;
			const world = buildWorld(seed % 3 === 0, true, tree(entities));
			const pick = <T>(from: T[]): T => from[Math.floor(r() * from.length)];
			const slotOn = (t: any) => (Array.isArray(rawOf(t)) ? String(rawOf(t).length) : `k${Math.floor(r() * 4)}`);
			if (seed % 5 === 0) {
				let armed = true;
				world.gateway.onDispose(() => {
					if (!armed) {
						return;
					}
					armed = false;
					frameWrite(world.runtime, (s) => {
						const holder = s.M;
						const moved = holder?.Z;
						if (moved) {
							delete holder.Z;
							holder.Moved = moved;
						}
					});
				}, "tables");
			}
			for (let frame = 0; frame < 6; frame++) {
				const before = JSON.stringify(world.raw());
				let refusal: unknown;
				try {
					treeWrite(world.runtime, (s) => {
						for (let op = 0; op < 5; op++) {
							const nodes: {
								node: any;
								holder: any;
								key: string;
							}[] = [];
							collect(s, nodes, new Set(), null, "");
							if (nodes.length === 0) {
								continue;
							}
							const moved = pick(nodes);
							const rawMoved = rawOf(moved.node);
							const targets = nodes.filter((entry) => !reaches(rawMoved, rawOf(entry.node)));
							const roll = r();
							if (roll < 0.15) {
								Array.isArray(rawOf(moved.holder)) ? moved.holder.splice(Number(moved.key), 1) : delete moved.holder[moved.key];
								continue;
							}
							if (targets.length === 0) {
								continue;
							}
							const target = pick(targets).node;
							// Taken out first, then seated, so no instant holds a loop.
							if (Array.isArray(rawOf(moved.holder))) {
								moved.holder.splice(Number(moved.key), 1);
							} else {
								delete moved.holder[moved.key];
							}
							const slot = slotOn(target);
							if (aliases && r() < 0.3) {
								s[`alias${seed}`] = moved.node;
							}
							target[slot] = moved.node;
						}
					});
				} catch (error) {
					refusal = error;
				}
				if (refusal !== undefined) {
					expect(aliases && refusal instanceof StateAliasError, `seed ${seed}: ${String(refusal)}`).toBe(true);
					expect(JSON.stringify(world.raw()), `seed ${seed}`).toBe(before);
				}
				expect(world.microtasks.surface(), `seed ${seed}`).toEqual([]);
				expect(holdsLoop(world.raw()), `seed ${seed}`).toBe(false);
				expectUpLinksLoopFree(world.gateway, world.raw());
			}
			world.runtime.dispose();
			vi.restoreAllMocks();
		}
	});

	it("any writes at all: nothing hangs, a refusal names a loop or an alias, and no loop ever stands", () => {
		let cycles = 0;
		for (let seed = 1; seed <= 150; seed++) {
			const r = rng(seed);
			const world = buildWorld(seed % 2 === 0, true, tree(false));
			for (let frame = 0; frame < 8; frame++) {
				const before = JSON.stringify(world.raw(), (_key, value) => value);
				let refusal: unknown;
				try {
					treeWrite(world.runtime, (s) => {
						const held: any[] = [];
						const nodes: {
							node: any;
							holder: any;
							key: string;
						}[] = [];
						collect(s, nodes, new Set(), null, "");
						held.push(s, ...nodes.map((entry) => entry.node));
						const pick = () => held[Math.floor(r() * held.length)];
						for (let op = 0; op < 4; op++) {
							const t = pick();
							const key = Array.isArray(rawOf(t)) ? String(rawOf(t).length) : `k${Math.floor(r() * 3)}`;
							if (r() < 0.2) {
								const keys = Object.keys(rawOf(t)).filter((k) => k !== "$Id");
								if (Array.isArray(rawOf(t))) {
									t.pop();
								} else if (keys.length > 0) {
									delete t[keys[Math.floor(r() * keys.length)]];
								}
							} else {
								t[key] = pick();
							}
						}
					});
				} catch (error) {
					refusal = error;
				}
				if (refusal !== undefined) {
					expect(refusal instanceof StateCycleError || refusal instanceof StateAliasError, `seed ${seed}: ${String(refusal)}`).toBe(true);
					expect(JSON.stringify(world.raw()), `seed ${seed}`).toBe(before);
					if (refusal instanceof StateCycleError) {
						cycles++;
					}
				}
				expect(holdsLoop(world.raw()), `seed ${seed}`).toBe(false);
				expect(world.microtasks.surface(), `seed ${seed}`).toEqual([]);
				expectUpLinksLoopFree(world.gateway, world.raw());
			}
			world.runtime.dispose();
			vi.restoreAllMocks();
		}
		expect(cycles).toBeGreaterThan(100);
	});
});
