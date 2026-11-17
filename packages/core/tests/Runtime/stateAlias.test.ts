import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEffect } from "../../src/Types/IEffect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineEffect, implementation } from "../../src/Effects/defineEffect";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { StateAliasError } from "../../src/Runtime/stateAlias";
import { StateCycleError } from "../../src/Runtime/stateCycle";
import { rawOf } from "../../src/Runtime/viewProxy";
import { captureSurfaced, minted } from "../testHelpers";
import { describeSeededWrites, row, rows, settle, world } from "./stateAliasShared";

interface IFetchRowEffect extends IEffect {
	Type: "alias/fetchRow";
}
const fetchRow = defineEffect<IFetchRowEffect, object>("alias/fetchRow");

interface IWaitEffect extends IEffect {
	Type: "alias/wait";
}
const wait = defineEffect<IWaitEffect, void>("alias/wait");

afterEach(() => {
	vi.restoreAllMocks();
});

function expectOneReport(surfaced: unknown[], path: string[], heldAt: string[], others = 0): void {
	expect(surfaced).toHaveLength(1);
	const error = surfaced[0] as StateAliasError;
	expect(error).toBeInstanceOf(StateAliasError);
	expect(error.name).toBe("StateAliasError");
	expect(error.path).toEqual([
		"AppState",
		...path
	]);
	expect(error.heldAt).toEqual([
		"AppState",
		...heldAt
	]);
	expect(error.others).toBe(others);
	expect(error.message).toContain(`[AppState.${path.join(".")}]`);
	expect(error.message).toContain(`[AppState.${heldAt.join(".")}]`);
	expect(error.message).toContain("$Id");
}

describe("what stays silent", () => {
	const shapes: {
		name: string;
		seed: object;
		write: (draft: any) => void;
		expected: (state: any) => void;
	}[] = [
		{
			name: "a move",
			seed: {
				A: row(0)
			},
			write: (d) => {
				d.B = d.A;
				delete d.A;
			},
			expected: (s) => {
				expect(s.B.$Id).toBe("r0");
				expect(s.A).toBeUndefined();
			}
		},
		{
			name: "a move of plain nodes between parents",
			seed: {
				P: {
					X: {
						Y: {
							V: 1
						}
					}
				},
				Q: {}
			},
			write: (d) => {
				d.Q.X = d.P.X;
				delete d.P.X;
			},
			expected: (s) => {
				expect(s.Q.X.Y.V).toBe(1);
				expect(s.P).toEqual({});
			}
		},
		{
			name: "a move out of a parent that leaves with it",
			seed: {
				P: {
					X: row(0)
				}
			},
			write: (d) => {
				d.X = d.P.X;
				d.P = null;
			},
			expected: (s) => {
				expect(s.X.$Id).toBe("r0");
			}
		},
		{
			name: "a move through a slot held only within the slice",
			seed: {
				A: row(0)
			},
			write: (d) => {
				d.T = d.A;
				delete d.A;
				d.B = d.T;
				delete d.T;
			},
			expected: (s) => {
				expect(s.B.$Id).toBe("r0");
			}
		},
		{
			name: "a wrapper around a node that leaves its slot",
			seed: {
				A: row(0)
			},
			write: (d) => {
				d.W = {
					Inner: d.A
				};
				delete d.A;
			},
			expected: (s) => {
				expect(s.W.Inner.$Id).toBe("r0");
			}
		},
		{
			name: "a swap",
			seed: {
				A: row(0),
				B: row(1)
			},
			write: (d) => {
				const a = d.A;
				d.A = d.B;
				d.B = a;
			},
			expected: (s) => {
				expect(s.A.$Id).toBe("r1");
				expect(s.B.$Id).toBe("r0");
			}
		},
		{
			name: "a swap across parents",
			seed: {
				P: {
					X: row(0)
				},
				Q: {
					X: row(1)
				}
			},
			write: (d) => {
				const a = d.P.X;
				d.P.X = d.Q.X;
				d.Q.X = a;
			},
			expected: (s) => {
				expect(s.P.X.$Id).toBe("r1");
				expect(s.Q.X.$Id).toBe("r0");
			}
		},
		{
			name: "a reorder by hand",
			seed: {
				Items: rows(4)
			},
			write: (d) => {
				const a = d.Items[0];
				d.Items[0] = d.Items[3];
				d.Items[3] = a;
			},
			expected: (s) => {
				expect(s.Items.map((r: any) => r.$Id)).toEqual([
					"r3",
					"r1",
					"r2",
					"r0"
				]);
			}
		},
		{
			name: "reverse",
			seed: {
				Items: rows(5)
			},
			write: (d) => {
				d.Items.reverse();
			},
			expected: (s) => {
				expect(s.Items[0].$Id).toBe("r4");
			}
		},
		{
			name: "sort",
			seed: {
				Items: rows(5)
			},
			write: (d) => {
				d.Items.sort((a: any, b: any) => (a.Name < b.Name ? 1 : -1));
			},
			expected: (s) => {
				expect(s.Items[0].$Id).toBe("r4");
			}
		},
		{
			name: "splice removing from the head",
			seed: {
				Items: rows(5)
			},
			write: (d) => {
				d.Items.splice(0, 2);
			},
			expected: (s) => {
				expect(s.Items.map((r: any) => r.$Id)).toEqual([
					"r2",
					"r3",
					"r4"
				]);
			}
		},
		{
			name: "splice inserting",
			seed: {
				Items: rows(3)
			},
			write: (d) => {
				d.Items.splice(
					1,
					0,
					minted("r9", {
						Name: "n9"
					})
				);
			},
			expected: (s) => {
				expect(s.Items.map((r: any) => r.$Id)).toEqual([
					"r0",
					"~r9",
					"r1",
					"r2"
				]);
			}
		},
		{
			name: "unshift",
			seed: {
				Items: rows(3)
			},
			write: (d) => {
				d.Items.unshift(
					minted("r9", {
						Name: "n9"
					})
				);
			},
			expected: (s) => {
				expect(s.Items[0].$Id).toBe("~r9");
			}
		},
		{
			name: "shift",
			seed: {
				Items: rows(3)
			},
			write: (d) => {
				d.Items.shift();
			},
			expected: (s) => {
				expect(s.Items[0].$Id).toBe("r1");
			}
		},
		{
			name: "filter into its own slot",
			seed: {
				Rows: rows(5)
			},
			write: (d) => {
				d.Rows = d.Rows.filter((r: any) => r.Name !== "n1");
			},
			expected: (s) => {
				expect(s.Rows).toHaveLength(4);
			}
		},
		{
			name: "push then filter into its own slot",
			seed: {
				Rows: rows(3)
			},
			write: (d) => {
				d.Rows.push(
					minted("r9", {
						Name: "n9"
					})
				);
				d.Rows = d.Rows.filter((r: any) => r.Name !== "n0");
			},
			expected: (s) => {
				expect(s.Rows.map((r: any) => r.$Id)).toEqual([
					"r1",
					"r2",
					"~r9"
				]);
			}
		},
		{
			name: "a spread into its own slot",
			seed: {
				Rows: rows(3)
			},
			write: (d) => {
				d.Rows = [
					...d.Rows,
					minted("r9", {
						Name: "n9"
					})
				];
			},
			expected: (s) => {
				expect(s.Rows).toHaveLength(4);
			}
		},
		{
			name: "a row moved between arrays",
			seed: {
				A: rows(2),
				B: []
			},
			write: (d) => {
				d.B.push(d.A[0]);
				d.A.splice(0, 1);
			},
			expected: (s) => {
				expect(s.B[0].$Id).toBe("r0");
				expect(s.A[0].$Id).toBe("r1");
			}
		},
		{
			name: "a fold cleared later in the slice",
			seed: {
				Old: row(0, {
					Kid: {
						V: 1
					}
				}),
				New: row(1)
			},
			write: (d) => {
				d.New.Kid = d.Old.Kid;
				d.Old = null;
			},
			expected: (s) => {
				expect(s.New.Kid.V).toBe(1);
			}
		},
		{
			name: "an alias cleared within the slice",
			seed: {
				Items: rows(2)
			},
			write: (d) => {
				d.Selected = d.Items[0];
				d.Selected = null;
			},
			expected: (s) => {
				expect(s.Selected).toBeNull();
				expect(s.Items).toHaveLength(2);
			}
		},
		{
			name: "a slot rewritten with what it holds",
			seed: {
				A: row(0)
			},
			write: (d) => {
				const held = d.A;
				d.A = held;
			},
			expected: (s) => {
				expect(s.A.$Id).toBe("r0");
			}
		},
		{
			name: "a deep copy of a form",
			seed: {
				Form: {
					Address: {
						City: "x"
					}
				}
			},
			write: (d) => {
				d.Snapshot = JSON.parse(JSON.stringify(d.Form));
			},
			expected: (s) => {
				expect(s.Snapshot).toEqual(s.Form);
			}
		},
		{
			name: "a spread of a flat form",
			seed: {
				Form: {
					Name: "x"
				}
			},
			write: (d) => {
				d.Snapshot = {
					...d.Form
				};
			},
			expected: (s) => {
				expect(s.Snapshot.Name).toBe("x");
			}
		}
	];

	it.each(shapes)("$name", async ({ seed, write, expected }) => {
		const w = world(seed);
		await w.write(write);
		expect(w.surfaced).toEqual([]);
		expected(rawOf(w.runtime.state));
	});

	it.each([
		{
			name: "one object in two slots",
			land: (d: any, value: object) => {
				d.A = value;
				d.B = value;
			},
			read: (s: any) => [
				s.A,
				s.B
			]
		},
		{
			name: "one object twice in a fresh array",
			land: (d: any, value: object) => {
				d.L = [
					value,
					value
				];
			},
			read: (s: any) => s.L
		}
	])("$name lands as two nodes, silently", async ({ land, read }) => {
		const w = world({});
		await w.write((d) => {
			land(d, {
				V: {
					W: 1
				}
			});
		});
		const [first, second] = read(rawOf(w.runtime.state));
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		expect(first.V).not.toBe(second.V);
		expect(w.surfaced).toEqual([]);
	});

	it("one effect result landing in two slots lands as two nodes, silently", async () => {
		const w = world({});
		w.runtime.registerImplementation(
			implementation(fetchRow, () => ({
				Nested: {
					V: 1
				}
			}))
		);
		await w.runtime.dispatch(function* land(draft: any): IActionGenerator {
			const result = yield* fetchRow();
			draft.A = result;
			draft.B = result;
		}, "root");
		await settle();
		expect(rawOf(w.runtime.state).A).not.toBe(rawOf(w.runtime.state).B);
		expect(w.surfaced).toEqual([]);
	});

	it("one object in the initial state's two slots lands as two nodes, silently", async () => {
		const shared = {
			V: {
				W: 1
			}
		};
		const w = world({
			A: shared,
			B: shared
		});
		await settle();
		expect(rawOf(w.runtime.state).A).not.toBe(rawOf(w.runtime.state).B);
		expect(w.surfaced).toEqual([]);
	});

	it("a frozen copy landing in two slots lands as two nodes", async () => {
		const w = world({});
		const seen = await w.runtime.dispatch(
			function* land(draft: any, arg: any): Generator<never, boolean[], never> {
				draft.Saved = arg;
				draft.A = arg;
				draft.B = arg;
				draft.List = [
					arg,
					arg
				];
				draft.Wrap = {
					X: arg,
					Y: arg
				};
				return [
					Object.isFrozen(arg)
				];
			},
			"root",
			{
				Nested: {
					V: 1
				}
			}
		);
		await settle();
		expect(seen).toEqual([
			true
		]);
		expect(w.surfaced).toEqual([]);
		const raw = rawOf(w.runtime.state);
		expect(raw.A).not.toBe(raw.B);
		expect(raw.A.Nested).not.toBe(raw.B.Nested);
		expect(raw.List[0]).not.toBe(raw.List[1]);
		expect(raw.Wrap.X).not.toBe(raw.Wrap.Y);
	});
});

describe("what fires", () => {
	const shapes: {
		name: string;
		seed: object;
		write: (draft: any) => void;
		path: string[];
		heldAt: string[];
		others?: number;
	}[] = [
		{
			name: "an entity at a second slot",
			seed: {
				Items: rows(2)
			},
			write: (d) => {
				d.Selected = d.Items[0];
			},
			path: [
				"Selected"
			],
			heldAt: [
				"Items",
				"0"
			]
		},
		{
			name: "a plain node at a second slot",
			seed: {
				A: {
					V: 1
				}
			},
			write: (d) => {
				d.B = d.A;
			},
			path: [
				"B"
			],
			heldAt: [
				"A"
			]
		},
		{
			name: "a spread of a form holding nested objects",
			seed: {
				Form: {
					Address: {
						City: "x"
					},
					Phones: [
						1
					]
				}
			},
			write: (d) => {
				d.Snapshot = {
					...d.Form
				};
			},
			path: [
				"Snapshot",
				"Address"
			],
			heldAt: [
				"Form",
				"Address"
			],
			others: 1
		},
		{
			name: "filter into another slot",
			seed: {
				List: rows(3)
			},
			write: (d) => {
				d.Picked = d.List.filter((r: any) => r.Name !== "n0");
			},
			path: [
				"Picked",
				"0"
			],
			heldAt: [
				"List",
				"1"
			],
			others: 1
		},
		{
			name: "one node twice in one array",
			seed: {
				Items: rows(2)
			},
			write: (d) => {
				d.Items.push(d.Items[0]);
			},
			path: [
				"Items",
				"2"
			],
			heldAt: [
				"Items",
				"0"
			]
		},
		{
			name: "one fresh node twice in a fresh array",
			seed: {},
			write: (d) => {
				d.L = [
					{
						V: 1
					}
				];
				d.L.push(d.L[0]);
			},
			path: [
				"L",
				"1"
			],
			heldAt: [
				"L",
				"0"
			]
		},
		{
			name: "a whole subtree shared, naming only its top",
			seed: {
				A: {
					B: {
						C: {
							D: {
								V: 1
							}
						}
					},
					Rows: rows(3)
				}
			},
			write: (d) => {
				d.Other = d.A;
			},
			path: [
				"Other"
			],
			heldAt: [
				"A"
			]
		},
		{
			name: "one fresh literal, read back into a second slot",
			seed: {},
			write: (d) => {
				d.A = {
					V: 1
				};
				d.B = d.A;
			},
			path: [
				"B"
			],
			heldAt: [
				"A"
			]
		},
		{
			name: "a wrapper around a node that stays",
			seed: {
				A: row(0)
			},
			write: (d) => {
				d.W = {
					Inner: d.A
				};
			},
			path: [
				"W",
				"Inner"
			],
			heldAt: [
				"A"
			]
		}
	];

	it.each(shapes)("$name is refused, and the slice undone", async ({ seed, write, path, heldAt, others }) => {
		const w = world(seed);
		const before = JSON.stringify(rawOf(w.runtime.state));
		const refusal = await w.refuse(write);
		expectOneReport(
			[
				refusal
			],
			path,
			heldAt,
			others
		);
		expect((refusal as Error).message).toContain("was undone, so state is as it was before it");
		expect(JSON.stringify(rawOf(w.runtime.state))).toBe(before);
		expect(w.surfaced).toEqual([]);
	});

	it("one refusal per slice, counting the rest", async () => {
		const w = world({
			Items: rows(3)
		});
		const refusal = await w.refuse((d) => {
			d.First = d.Items[0];
			d.Second = d.Items[1];
			d.Third = d.Items[2];
		});
		expectOneReport(
			[
				refusal
			],
			[
				"First"
			],
			[
				"Items",
				"0"
			],
			2
		);
	});

	it("a later slice is refused again", async () => {
		const w = world({
			Items: rows(2)
		});
		const first = await w.refuse((d) => {
			d.First = d.Items[0];
		});
		const second = await w.refuse((d) => {
			d.Second = d.Items[1];
		});
		expect(first).toBeInstanceOf(StateAliasError);
		expect((second as StateAliasError).path).toEqual([
			"AppState",
			"Second"
		]);
	});

	it("a move split across a yield is refused at the yield, before its effect runs, and a catch there finds the slice undone", async () => {
		const w = world({
			A: row(0)
		});
		let waited = 0;
		w.runtime.registerImplementation(
			implementation(wait, () => {
				waited++;
				return settle();
			})
		);
		const caught = await w.runtime.dispatch(function* move(draft: any): IActionGenerator<unknown[]> {
			draft.B = draft.A;
			try {
				yield* wait();
				return [];
			} catch (error) {
				return [
					error instanceof StateAliasError && (error as Error).message.includes('The step ending at the yield of "alias/wait" was undone'),
					draft.B,
					draft.A.$Id
				];
			}
		}, "root");
		await settle();
		expect(caught).toEqual([
			true,
			undefined,
			"r0"
		]);
		expect(waited).toBe(0);
		expect(w.surfaced).toEqual([]);
		expect(w.lookup().r0).toBeDefined();
	});

	it("an alias a raw write made fails the resync that meets it, loudly", () => {
		const w = world({
			A: {
				V: {
					W: 1
				}
			}
		});
		rawOf(w.runtime.state).B = rawOf(w.runtime.state).A;
		expect(() => w.runtime.get("runtime/writeGateway").resync()).toThrow(
			/a rebuild met the node at \[AppState\.A\] again at \[AppState\.B\]/
		);
	});

	it("a raw write's alias fails the consistency walk that reaches it, loudly", async () => {
		captureSurfaced();
		const runtime = createRuntime<any>(
			{
				$Id: "root",
				A: {
					V: 1
				},
				Tick: 0
			},
			{
				pauseTimers: true,
				verifyIndex: true
			}
		);
		const raw = rawOf(runtime.state);
		raw.B = raw.A;
		await expect(
			runtime.dispatch(function* tick(draft: any): IActionGenerator {
				draft.Tick = 1;
			}, "root")
		).rejects.toThrow(/the tree holds a node twice/);
	});

	it("a loop is refused only as a cycle", async () => {
		const w = world({
			A: {
				B: {}
			}
		});
		const refusal = await w.refuse((d) => {
			d.A.B.Back = d.A;
		});
		expect(refusal).toBeInstanceOf(StateCycleError);
		expect(w.surfaced).toEqual([]);
	});
});

describeSeededWrites();
