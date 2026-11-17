import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { ISetState } from "../../src/Runtime/sliceSetState";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRecord } from "../../src/Types/IRecord";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type IWithoutIds, withoutIds } from "../../src/Effects/entity";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { DraftDetachedError, EntityReplacedError } from "../../src/Runtime/draftNode";
import { open } from "../../src/Runtime/open";
import { MoveBetweenRootsError } from "../../src/Runtime/transient";
import { rawOf } from "../../src/Runtime/viewProxy";
import { minted, mountComponent, treeWrite } from "../testHelpers";

type IRow = {
	$Id: string;
	Name: string;
	Child?: IRow;
	Items?: IRow[];
};

type IWorld = {
	$Id: string;
	Rows: IRow[];
	Other: IRow[];
	Note?: string;
	Wrap?: {
		Inner: IRow;
	};
};

const seed = (): IWorld => ({
	$Id: "root",
	Rows: [
		{
			$Id: "row-1",
			Name: "one",
			Child: {
				$Id: "child-1",
				Name: "child"
			}
		},
		{
			$Id: "row-2",
			Name: "two"
		}
	],
	Other: []
});

const fresh = (id = "row-1"): IRow => ({
	$Id: id,
	Name: "fresh"
});

function build(journal: boolean, initial: IWorld = seed()) {
	const runtime = createRuntime<IWorld>(initial, {
		onError: () => {}
	});
	const records: IRecord[] = [];
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	if (journal) {
		runtime.on("record", (record) => records.push(record));
	}
	return {
		runtime,
		records,
		diags,
		row: () => rawOf(runtime.state.Rows[0])
	};
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const REFUSED: [
	string,
	(s: IWorld) => void
][] = [
	[
		"into its own slot",
		(s) => {
			s.Rows[0] = fresh();
		}
	],
	[
		"as a spread of the node",
		(s) => {
			s.Rows[0] = {
				...s.Rows[0]
			};
		}
	],
	[
		"in a fresh array",
		(s) => {
			s.Rows = [
				fresh(),
				s.Rows[1]
			];
		}
	],
	[
		"nested in a payload",
		(s) => {
			s.Rows[1].Child = minted("other", {
				Name: "other",
				Child: fresh("child-1")
			});
		}
	],
	[
		"through a wrapper with no $Id",
		(s) => {
			s.Wrap = {
				Inner: fresh()
			};
		}
	],
	[
		"into another slot, with the node staying",
		(s) => {
			s.Other.push(fresh());
		}
	],
	[
		"after a removal in the same frame",
		(s) => {
			s.Rows.splice(0, 1);
			s.Rows.push(fresh());
		}
	],
	[
		"after clearing the array in the same frame",
		(s) => {
			s.Rows = [];
			s.Rows = [
				fresh()
			];
		}
	],
	[
		"after a delete in the same frame",
		(s) => {
			delete s.Rows[0].Child;
			s.Rows[0].Child = fresh("child-1");
		}
	],
	[
		"into a node written earlier in the frame",
		(s) => {
			s.Wrap = {
				Inner: minted("new", {
					Name: "fresh"
				})
			};
			s.Wrap.Inner = fresh();
		}
	],
	[
		"through Object.assign",
		(s) => {
			Object.assign(s.Rows, {
				0: fresh()
			});
		}
	]
];

describe.each([
	[
		"journal on",
		true
	],
	[
		"journal off",
		false
	]
])("a different node carrying a live $Id, %s", (_name, journal) => {
	it.each(REFUSED)("is refused %s", (_case, write) => {
		const h = build(journal);
		expect(() => treeWrite(h.runtime, write)).toThrow(EntityReplacedError);
		h.runtime.dispose();
	});

	it("throws ahead of that write, so it is not recorded and the frame's earlier writes stand", () => {
		const h = build(journal);
		const before = h.row();
		expect(() =>
			treeWrite(h.runtime, (s) => {
				s.Note = "landed first";
				s.Rows[0] = fresh();
			})
		).toThrow(EntityReplacedError);

		expect(h.row()).toBe(before);
		expect(h.runtime.state.Note).toBe("landed first");
		if (journal) {
			const paths = h.records.flatMap((r) => (r.Kind === "step" ? r.Changes.map((c) => c.Path.join(".")) : []));
			expect(paths).toEqual([
				"Note"
			]);
		}
		h.runtime.dispose();
	});

	it("names the $Id and where its node sits, and says what to do instead", () => {
		const h = build(journal);
		let thrown: EntityReplacedError | undefined;
		try {
			treeWrite(h.runtime, (s) => {
				s.Rows[0] = fresh();
			});
		} catch (error) {
			thrown = error as EntityReplacedError;
		}
		expect(thrown?.id).toBe("row-1");
		expect(thrown?.path).toEqual([
			"AppState",
			"Rows",
			"0"
		]);
		expect(thrown?.message).toContain("Write the new values into that node's fields");
		expect(thrown?.message).toContain("reconcileRows()");
		expect(thrown?.message).toContain("entity()");
		expect(thrown?.message).not.toContain("merge");
		h.runtime.dispose();
	});

	it("rejects an action's dispatch, and its catch can handle it", async () => {
		const h = build(journal);
		function* replacing(draft: IWorld): IActionGenerator {
			draft.Rows[0] = fresh();
		}
		await expect(h.runtime.dispatch(replacing, "root")).rejects.toThrow(EntityReplacedError);

		function* catching(draft: IWorld): IActionGenerator<string> {
			try {
				draft.Rows[0] = fresh();
			} catch (error) {
				return (error as Error).name;
			}
			return "no throw";
		}
		await expect(h.runtime.dispatch(catching, "root")).resolves.toBe("EntityReplacedError");
		h.runtime.dispose();
	});

	it("leaves a parked action on the entity running", async () => {
		const h = build(journal);
		let release!: () => void;
		h.runtime.registerImplementation(
			"gate",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		function* worker(draft: IRow): IActionGenerator<string> {
			yield {
				Type: "gate"
			};
			draft.Name = "carried on";
			return "done";
		}
		const run = h.runtime.dispatch(worker, "row-1");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(() =>
			treeWrite(h.runtime, (s) => {
				s.Rows[0] = fresh();
			})
		).toThrow(EntityReplacedError);

		release();
		await expect(run).resolves.toBe("done");
		expect(h.runtime.state.Rows[0].Name).toBe("carried on");
		h.runtime.dispose();
	});

	it("allows the same node to move, swap, filter and re-seat", () => {
		const h = build(journal);
		const first = h.row();
		treeWrite(h.runtime, (s) => {
			const row = s.Rows[0];
			s.Rows[0] = s.Rows[1];
			s.Rows[1] = row;
			s.Rows.reverse();
			s.Rows = s.Rows.filter(() => true);
			s.Rows = [
				...s.Rows
			];
			const moved = s.Rows.shift()!;
			s.Other.push(moved);
		});
		expect(rawOf(h.runtime.state.Other[0])).toBe(first);
		treeWrite(h.runtime, (s) => {
			s.Wrap = {
				Inner: s.Other[0]
			};
			s.Other.pop();
		});
		expect(rawOf(h.runtime.state.Wrap!.Inner)).toBe(first);
		expect(h.diags).toEqual([]);
		h.runtime.dispose();
	});

	it("allows a node with another $Id in the slot, and the same $Id once a later frame finds it gone", () => {
		const h = build(journal);
		const other = minted("row-other", {
			Name: "fresh"
		});
		treeWrite(h.runtime, (s) => {
			s.Rows[0] = other;
		});
		treeWrite(h.runtime, (s) => {
			s.Rows[0] = minted("row-next", {
				Name: "fresh"
			});
		});
		treeWrite(h.runtime, (s) => {
			s.Rows[0] = {
				...other
			};
		});
		expect(h.runtime.state.Rows[0].$Id).toBe("~row-other");
		expect(h.diags).toEqual([]);
		h.runtime.dispose();
	});

	it("refuses two fresh nodes with a new $Id in one frame when the frame ends, since neither was live, and undoes the frame", () => {
		const h = build(journal);
		const made = minted("new", {
			Name: "fresh"
		});
		const before = rawOf(h.runtime.state.Rows).length;
		expect(() =>
			treeWrite(h.runtime, (s) => {
				s.Rows.push(made, {
					...made
				});
			})
		).toThrow(EntityReplacedError);
		expect(rawOf(h.runtime.state.Rows)).toHaveLength(before);
		expect((h.runtime as IRuntimeInternal<any>).get("runtime/stateIdLookup")()["~new"]).toBeUndefined();
		expect(h.diags.map((d) => d.code)).toEqual([]);
		h.runtime.dispose();
	});

	it("refuses a cyclic payload as non-plain", () => {
		const h = build(journal);
		const cyclic: any = {
			Name: "cycle"
		};
		cyclic.Self = {
			Back: cyclic
		};
		expect(() =>
			treeWrite(h.runtime, (s: any) => {
				s.Plain = {
					Cycle: cyclic,
					Row: fresh()
				};
			})
		).toThrow(/not plain: cycle at/);
		h.runtime.dispose();
	});

	it("throws DraftDetachedError for a write through a detached reference, ahead of the refusal", async () => {
		const h = build(journal);
		let held!: IRow;
		function* wait(): IActionGenerator {
			yield {
				Type: "wait"
			};
		}
		function* holder(draft: IWorld) {
			held = draft.Rows[0];
			yield* open(wait());
			held.Child = fresh("child-1");
		}
		h.runtime.registerImplementation("wait", () => new Promise((resolve) => setTimeout(resolve, 0)));
		const run = h.runtime.dispatch(holder, "root");
		treeWrite(h.runtime, (s) => {
			s.Rows.splice(0, 1);
		});
		await expect(run).rejects.toThrow(DraftDetachedError);
		h.runtime.dispose();
	});

	describe("a ComponentState entity", () => {
		type ILocal = {
			$Id: string;
			Editing?: IRow;
			Copy?: IWithoutIds<IRow>;
		};

		// Exempt writes stand in for the framework's own, so the refusals are seen without an action.
		function local(h: ReturnType<typeof build>) {
			const internal = h.runtime as IRuntimeInternal<IWorld>;
			const gateway = internal.get("runtime/writeGateway");
			const id = mountComponent(internal, "root", {});
			const cell = internal.resolveCell(id)!;
			const state = cell.state as ILocal;
			const setState: ISetState<ILocal> = (...args) => gateway.exemptFrame(() => cell.setState(...args));
			return {
				internal,
				id,
				raw: rawOf(state),
				state,
				setState
			};
		}

		it("refuses a copy of a live domain node from setState, and takes one without its ids", () => {
			const h = build(journal);
			const { state, setState } = local(h);
			const write = () =>
				setState((s) => {
					s.Editing = {
						...h.row()
					};
				});
			expect(write).toThrow(EntityReplacedError);
			expect(state.Editing).toBeUndefined();
			setState((s) => {
				s.Copy = withoutIds(h.row());
			});
			expect(rawOf(state).Copy).toEqual({
				Name: "one",
				Child: {
					Name: "child"
				}
			});
			expect(h.diags).toEqual([]);
			h.runtime.dispose();
		});

		it("refuses a copy of a live domain node from an action, and takes one without its ids", async () => {
			const h = build(journal);
			const { internal, id, state } = local(h);
			function* editing(draft: ILocal): IActionGenerator {
				draft.Editing = {
					...h.row()
				};
			}
			const refused = internal.dispatch(editing, id);
			await expect(refused).rejects.toThrow(EntityReplacedError);
			expect(state.Editing).toBeUndefined();

			function* copying(draft: ILocal): IActionGenerator {
				draft.Copy = withoutIds(h.row());
			}
			await internal.dispatch(copying, id);
			expect(rawOf(state).Copy).toEqual({
				Name: "one",
				Child: {
					Name: "child"
				}
			});
			expect(h.diags).toEqual([]);
			h.runtime.dispose();
		});

		it.each<
			[
				string,
				(s: ILocal, row: IRow) => void
			]
		>([
			[
				"alone",
				(s, row) => {
					s.Editing = row;
				}
			],
			[
				"inside a value",
				(s, row) => {
					(s as any).Wrap = {
						Held: [
							row
						]
					};
				}
			],
			[
				"written below a node new this frame",
				(s, row) => {
					(s as any).Fresh = {};
					(s as any).Fresh.Held = row;
				}
			]
		])("refuses a live node crossing into component state %s, from setState and from an action", async (_shape, write) => {
			const h = build(journal);
			const { internal, id, raw, setState } = local(h);
			const row = h.runtime.state.Rows[0];
			expect(() => setState((s) => write(s, row))).toThrow(MoveBetweenRootsError);
			function* crossing(draft: ILocal): IActionGenerator {
				write(draft, row);
			}
			await expect(internal.dispatch(crossing, id)).rejects.toThrow(MoveBetweenRootsError);
			expect(raw.Editing).toBeUndefined();
			expect((raw as any).Wrap).toBeUndefined();
			expect((raw as any).Fresh?.Held).toBeUndefined();
			h.runtime.dispose();
		});

		it("refuses a plain live node, with no $Id, crossing into component state", () => {
			const h = build(journal, {
				...seed(),
				Wrap: {
					Inner: {
						$Id: "inner",
						Name: "inner"
					}
				}
			});
			const { raw, setState } = local(h);
			expect(() =>
				setState((s) => {
					(s as any).Held = h.runtime.state.Wrap;
				})
			).toThrow(MoveBetweenRootsError);
			expect((raw as any).Held).toBeUndefined();
			h.runtime.dispose();
		});

		it("refuses a component node crossing into AppState, alone or inside a value", async () => {
			const h = build(journal);
			const { state, setState } = local(h);
			setState((s) => {
				(s as any).Rows = [
					{
						Name: "local row"
					}
				];
			});
			const held = (state as any).Rows[0];
			await expect(
				h.runtime.dispatch(function* (draft: IWorld): IActionGenerator {
					(draft as any).Taken = held;
				}, "root")
			).rejects.toThrow(MoveBetweenRootsError);
			await expect(
				h.runtime.dispatch(function* (draft: IWorld): IActionGenerator {
					(draft as any).Taken = {
						Held: held
					};
				}, "root")
			).rejects.toThrow(MoveBetweenRootsError);
			expect((h.runtime.state as any).Taken).toBeUndefined();
			h.runtime.dispose();
		});

		it("takes a move inside component state, and inside the domain tree into a node new this frame", () => {
			const h = build(journal);
			const { raw, setState } = local(h);
			setState((s) => {
				(s as any).A = {
					Name: "moves"
				};
			});
			const node = (raw as any).A;
			setState((s) => {
				(s as any).B = {};
				(s as any).B.Held = (s as any).A;
				delete (s as any).A;
			});
			expect((raw as any).B.Held).toBe(node);

			const row = h.row();
			treeWrite(h.runtime, (s) => {
				s.Wrap = {} as IWorld["Wrap"];
				(s.Wrap as any).Inner = s.Rows[0];
				s.Rows.splice(0, 1);
			});
			expect(rawOf(h.runtime.state).Wrap?.Inner).toBe(row);
			h.runtime.dispose();
		});

		it("takes a node written into the tree, removed and written elsewhere in one frame, which isn't local", () => {
			const h = build(journal);
			treeWrite(h.runtime, (s: any) => {
				s.Fresh = {
					V: 1
				};
				const fresh = s.Fresh;
				delete s.Fresh;
				s.Moved = fresh;
			});
			expect((h.runtime.state as any).Moved).toEqual({
				V: 1
			});
			h.runtime.dispose();
		});

		it("refuses a copy of a live node from an action on an entity nested in component state", async () => {
			const h = build(journal);
			const { internal, raw, setState } = local(h);
			setState((s) => {
				(s as any).Nested = minted("nested", {
					Name: "nested"
				});
			});
			function* copying(draft: any): IActionGenerator {
				draft.Copy = {
					...h.row()
				};
			}
			await expect(internal.dispatch(copying, "~nested")).rejects.toThrow(EntityReplacedError);
			expect((raw as any).Nested.Copy).toBeUndefined();
			h.runtime.dispose();
		});
	});
});
