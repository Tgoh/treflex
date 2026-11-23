import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IActionContext } from "../../src/Types/IActionContext";
import type { IEffect } from "../../src/Types/IEffect";
import type { IRecord } from "../../src/Types/IRecord";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineEffect } from "../../src/Effects/defineEffect";
import { entity } from "../../src/Effects/entity";
import { latest } from "../../src/Runtime/arrivalPolicy";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { EntityReplacedError } from "../../src/Runtime/draftNode";
import { REFUSAL_LIMIT } from "../../src/Runtime/fiberMachine";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { reconcileRows } from "../../src/Runtime/reconcileRows";
import { StateAliasError } from "../../src/Runtime/stateAlias";
import { StateCycleError } from "../../src/Runtime/stateCycle";
import { transient } from "../../src/Runtime/transient";
import { rawOf } from "../../src/Runtime/viewProxy";
import { captureSurfaced, minted } from "../testHelpers";

interface IPingEffect extends IEffect {
	Type: "atomic/ping";
}
const ping = defineEffect<IPingEffect, void>("atomic/ping");

interface IGateEffect extends IEffect {
	Type: "atomic/gate";
}
const gate = defineEffect<IGateEffect, void>("atomic/gate");

type IRow = {
	$Id: string;
	Name: string;
	K?: string;
	Back?: unknown;
};

type IWorld = {
	$Id: string;
	Rows: IRow[];
	List: number[];
	Note: string;
	Sel?: IRow;
	Pinned?: IRow;
	Fresh?: IRow;
	Box?: Record<string, number>;
	Shelf?: Record<string, number>;
};

const seed = (): IWorld => ({
	$Id: "root",
	Rows: [
		{
			$Id: "r1",
			Name: "one",
			K: "a"
		},
		{
			$Id: "r2",
			Name: "two",
			K: "b"
		}
	],
	List: [
		1,
		2
	],
	Note: "x"
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	vi.restoreAllMocks();
});

function build() {
	const surfaced = captureSurfaced();
	const errors: unknown[] = [];
	const pinged: number[] = [];
	const opens: (() => void)[] = [];
	const runtime = createRuntime<IWorld>(seed(), {
		onError: (error) => errors.push(error),
		implementations: {
			"atomic/ping": () => {
				pinged.push(1);
			},
			"atomic/gate": () =>
				new Promise<void>((resolve) => {
					opens.push(resolve);
				})
		}
	}) as IRuntimeInternal<IWorld>;
	const records: IRecord[] = [];
	runtime.on("record", (record) => records.push(record));
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	const failures: IRuntimeEventOf<"failure">[] = [];
	runtime.on("failure", (event) => failures.push(event));
	const gateway = runtime.get("runtime/writeGateway");
	const disposed: string[] = [];
	gateway.onDispose((id) => disposed.push(id), "cancel");
	const drains: (readonly object[] | null)[] = [];
	gateway.onDrained((touched) => drains.push(touched));
	const shape = () => JSON.stringify(rawOf(runtime.state));
	const indexed = () => Object.keys(gateway.lookup()).sort();
	const refusal = (action: (draft: IWorld) => IActionGenerator<unknown>): Promise<unknown> =>
		runtime.dispatch(action, "root").then(
			() => undefined,
			(error: unknown) => error
		);
	return {
		runtime,
		surfaced,
		errors,
		pinged,
		opens,
		records,
		diags,
		failures,
		disposed,
		drains,
		shape,
		indexed,
		refusal,
		steps: () => records.filter((record) => record.Kind === "step")
	};
}

describe("a slice that breaks the tree rule is rolled back, and its action fails", () => {
	it.each([
		{
			cause: "an alias",
			kind: StateAliasError,
			write: (d: IWorld) => {
				d.Note = "written";
				d.Sel = d.Rows[0];
			}
		},
		{
			cause: "a loop",
			kind: StateCycleError,
			write: (d: IWorld) => {
				d.Note = "written";
				d.Rows[0]!.Back = d.Rows;
			}
		},
		{
			cause: "a duplicate $Id among the frame's arrivals",
			kind: EntityReplacedError,
			write: (d: IWorld) => {
				const row = minted("dup", {
					Name: "dup"
				});
				d.Note = "written";
				d.Rows.push(row);
				d.Pinned = row;
			}
		},
		{
			cause: "a hole left past an array's end",
			kind: NonPlainDataError,
			write: (d: IWorld) => {
				d.Note = "written";
				d.List[3] = 9;
			}
		},
		{
			cause: "a hole left by a trailing delete",
			kind: NonPlainDataError,
			write: (d: IWorld) => {
				d.Note = "written";
				delete d.List[1];
			}
		},
		{
			cause: "a live row a refresh's add returns",
			kind: StateAliasError,
			write: (d: IWorld) => {
				d.Note = "written";
				const refresh = reconcileRows(
					d.Rows,
					[
						"a",
						"b",
						"c"
					],
					(row: IRow | string) => (typeof row === "string" ? row : row.K),
					{
						add: () => d.Rows[0]!,
						update: () => {}
					}
				);
				for (let next = refresh.next(); !next.done; next = refresh.next()) {}
			}
		}
	])("$cause: state, index and record are as they were", async ({ kind, write }) => {
		const h = build();
		const before = h.shape();
		const indexed = h.indexed();
		const error = await h.refusal(function* write_(d) {
			write(d);
		});
		expect(error).toBeInstanceOf(kind);
		expect((error as Error).message).toContain("The step ending at its return was undone, so state is as it was before it.");
		expect(h.shape()).toBe(before);
		expect(h.indexed()).toEqual(indexed);
		expect(h.steps()).toEqual([]);
		expect(h.errors).toEqual([
			error
		]);
		await tick();
		expect(h.surfaced).toEqual([]);
		h.runtime.dispose();
	});

	it("lets the slice's own throw win, still rolling the slice back", async () => {
		const h = build();
		const before = h.shape();
		const error = await h.refusal(function* (d) {
			d.Sel = d.Rows[0];
			throw new Error("its own");
		});
		expect((error as Error).message).toBe("its own");
		expect(h.shape()).toBe(before);
		h.runtime.dispose();
	});

	it("runs no disposal, cascade record or yielded effect ahead of the rollback", async () => {
		const h = build();
		const before = h.shape();
		const error = await h.refusal(function* (d) {
			d.Rows.splice(0, 1);
			d.Fresh = minted("born", {
				Name: "born"
			});
			d.Sel = d.Rows[0];
			yield* ping();
		});
		expect(error).toBeInstanceOf(StateAliasError);
		expect((error as Error).message).toContain('The step ending at the yield of "atomic/ping" was undone');
		expect(h.pinged).toEqual([]);
		expect(h.disposed).toEqual([]);
		expect(h.records.filter((record) => record.Kind === "entity:dispose" || record.Kind === "effect")).toEqual([]);
		expect(h.shape()).toBe(before);
		expect(h.indexed()).not.toContain("~born");
		h.runtime.dispose();
	});

	it("throws the refusal into the generator at the yield, where a catch finds the draft live and as it was", async () => {
		const h = build();
		const seen = await h.runtime.dispatch(function* (d: IWorld): IActionGenerator<unknown[]> {
			d.Note = "written";
			d.Sel = d.Rows[0];
			try {
				yield* ping();
			} catch (error) {
				d.Note = "caught";
				return [
					error instanceof StateAliasError,
					d.Sel
				];
			}
			return [];
		}, "root");
		expect(seen).toEqual([
			true,
			undefined
		]);
		expect(h.pinged).toEqual([]);
		expect(rawOf(h.runtime.state).Note).toBe("caught");
		h.runtime.dispose();
	});
});

describe("a record's key order after a rolled-back slice", () => {
	async function boxed() {
		const h = build();
		await h.runtime.dispatch(function* (d: IWorld): IActionGenerator {
			d.Box = {
				a: 1,
				b: 2,
				c: 3,
				d: 4,
				e: 5
			};
			d.Shelf = {
				x: 1,
				y: 2,
				z: 3
			};
		}, "root");
		const before = h.shape();
		const keys = () => {
			const raw = rawOf(h.runtime.state);
			return [
				Object.keys(raw.Box!),
				Object.keys(raw.Shelf!)
			];
		};
		return {
			...h,
			before,
			keys
		};
	}

	it("puts keys deleted by delete and by writing undefined back in their places", async () => {
		const h = await boxed();
		const error = await h.refusal(function* (d) {
			delete d.Box!.b;
			d.Box!.d = undefined as never;
			delete d.Box!.a;
			d.Sel = d.Rows[0];
		});
		expect(error).toBeInstanceOf(StateAliasError);
		expect(h.shape()).toBe(h.before);
		expect(h.keys()).toEqual([
			[
				"a",
				"b",
				"c",
				"d",
				"e"
			],
			[
				"x",
				"y",
				"z"
			]
		]);
		h.runtime.dispose();
	});

	it("puts a key deleted and added again in the slice back in its place, with its old value", async () => {
		const h = await boxed();
		const error = await h.refusal(function* (d) {
			delete d.Box!.b;
			d.Box!.b = 9;
			delete d.Box!.d;
			d.Sel = d.Rows[0];
		});
		expect(error).toBeInstanceOf(StateAliasError);
		expect(h.shape()).toBe(h.before);
		expect(h.keys()[0]).toEqual([
			"a",
			"b",
			"c",
			"d",
			"e"
		]);
		h.runtime.dispose();
	});

	it("puts back deletes interleaved across two records, each in its own order", async () => {
		const h = await boxed();
		const error = await h.refusal(function* (d) {
			delete d.Box!.c;
			delete d.Shelf!.x;
			delete d.Box!.a;
			delete d.Shelf!.y;
			delete d.Box!.e;
			d.Sel = d.Rows[0];
		});
		expect(error).toBeInstanceOf(StateAliasError);
		expect(h.shape()).toBe(h.before);
		expect(h.keys()).toEqual([
			[
				"a",
				"b",
				"c",
				"d",
				"e"
			],
			[
				"x",
				"y",
				"z"
			]
		]);
		h.runtime.dispose();
	});

	it("puts back the order the slice began with, after an earlier slice's deletes landed", async () => {
		const h = await boxed();
		await h.runtime.dispatch(function* (d: IWorld): IActionGenerator {
			delete d.Box!.b;
		}, "root");
		const before = h.shape();
		const error = await h.refusal(function* (d) {
			delete d.Shelf!.y;
			delete d.Box!.d;
			delete d.Box!.a;
			d.Sel = d.Rows[0];
		});
		expect(error).toBeInstanceOf(StateAliasError);
		expect(h.shape()).toBe(before);
		expect(h.keys()).toEqual([
			[
				"a",
				"c",
				"d",
				"e"
			],
			[
				"x",
				"y",
				"z"
			]
		]);
		h.runtime.dispose();
	});
});

describe("a dispatch made inside a step", () => {
	it("starts after the frame passes its check, not inside the step", async () => {
		const h = build();
		const log: string[] = [];
		function* child(draft: IRow): IActionGenerator {
			log.push(`child sees ${draft.Name}`);
			draft.Name = "by child";
		}
		let inner!: Promise<unknown>;
		await h.runtime.dispatch(function* (d: IWorld): IActionGenerator {
			d.Rows[1]!.Name = "by parent";
			inner = h.runtime.dispatch(child, "r2");
			log.push("parent after the dispatch");
		}, "root");
		await inner;
		expect(log).toEqual([
			"parent after the dispatch",
			"child sees by parent"
		]);
		expect(rawOf(h.runtime.state).Rows[1]!.Name).toBe("by child");
		h.runtime.dispose();
	});

	it("is dropped when the frame rolls back: it never starts, and its promise settles cancelled", async () => {
		const h = build();
		const log: string[] = [];
		function* child(draft: IRow): IActionGenerator {
			log.push("child ran");
			draft.Name = "by child";
		}
		let inner!: Promise<unknown>;
		const error = await h.refusal(function* parent(d) {
			inner = h.runtime.dispatch(child, "r2");
			d.Sel = d.Rows[0];
		});
		expect(error).toBeInstanceOf(StateAliasError);
		await expect(inner).resolves.toBeUndefined();
		expect(log).toEqual([]);
		expect(
			h.records
				.filter((record) => record.Kind === "action:start")
				.map(
					(record) =>
						(
							record as {
								Label: string | null;
							}
						).Label
				)
		).toEqual([
			"parent"
		]);
		expect(rawOf(h.runtime.state).Rows[1]!.Name).toBe("two");
		h.runtime.dispose();
	});
});

describe("a close", () => {
	it("is one unit: a tree-rule failure in an inner finally undoes the outer one's correct write too", async () => {
		const h = build();
		const flow = latest(function* flow(d: IWorld): IActionGenerator {
			try {
				try {
					yield* gate();
				} finally {
					d.Rows[0]!.Name = "inner";
					d.Sel = d.Rows[1];
				}
			} finally {
				d.Note = "outer";
			}
		});
		const before = h.shape();
		const first = h.runtime.dispatch(flow, "root");
		await tick();
		const second = h.runtime.dispatch(flow, "root");
		await expect(first).resolves.toBeUndefined();
		expect(h.shape()).toBe(before);
		const thrown = h.failures.filter((failure) => failure.Close);
		expect(thrown).toHaveLength(1);
		expect((thrown[0]!.Error as Error).name).toBe("StateAliasError");
		expect(
			h.steps().filter(
				(record) =>
					(
						record as {
							Cancelling?: true;
						}
					).Cancelling
			)
		).toEqual([]);
		h.opens.at(-1)?.();
		await expect(second).rejects.toBeInstanceOf(StateAliasError);
		h.runtime.dispose();
	});
});

describe("a loop through the draft", () => {
	it("is refused and undone, so the drains after it reconcile rather than rebuild", async () => {
		const h = build();
		const error = await h.refusal(function* (d) {
			d.Rows[0]!.Back = d.Rows;
		});
		expect(error).toBeInstanceOf(StateCycleError);
		expect(rawOf(h.runtime.state).Rows[0]!.Back).toBeUndefined();
		for (const note of [
			"y",
			"z"
		]) {
			h.drains.length = 0;
			await h.runtime.dispatch(function* (d: IWorld): IActionGenerator {
				d.Note = note;
			}, "root");
			expect(h.drains).toEqual([
				[
					rawOf(h.runtime.state)
				]
			]);
		}
		await tick();
		expect(h.surfaced).toEqual([]);
		h.runtime.dispose();
	});

	it("tells no drain listener of the refused slice, since nothing it wrote stands", async () => {
		const h = build();
		h.drains.length = 0;
		await h.refusal(function* (d) {
			d.Note = "written";
			d.Rows[0]!.Back = d.Rows;
		});
		expect(h.drains).toEqual([]);
		h.runtime.dispose();
	});
});

const slot = (owner: IWorld) =>
	transient(owner, "Atomic/Slot", {
		Count: 0
	});

describe("a transient the refused slice opened", () => {
	const count = (h: ReturnType<typeof build>) =>
		h.runtime.processSelector(
			function* (d: IWorld) {
				return (yield* slot(d)).Count;
			},
			() => h.runtime.state
		);

	it("works for a later action", async () => {
		const h = build();
		const error = await h.refusal(function* (d) {
			const s = yield* slot(d);
			s.Count = 1;
			d.Sel = d.Rows[0];
		});
		expect(error).toBeInstanceOf(StateAliasError);
		expect(count(h)).toBe(0);
		await h.runtime.dispatch(function* (d: IWorld): IActionGenerator {
			(yield* slot(d)).Count = 5;
		}, "root");
		expect(count(h)).toBe(5);
		h.runtime.dispose();
	});

	it("works for a catch at the refused yield", async () => {
		const h = build();
		await h.runtime.dispatch(function* (d: IWorld): IActionGenerator {
			const s = yield* slot(d);
			s.Count = 1;
			d.Sel = d.Rows[0];
			try {
				yield* ping();
			} catch {
				s.Count = 2;
			}
		}, "root");
		expect(count(h)).toBe(2);
		h.runtime.dispose();
	});

	it("answers a catch that reads it again with the same slot, not a second unborn one", async () => {
		const h = build();
		await h.runtime.dispatch(function* (d: IWorld): IActionGenerator {
			const s = yield* slot(d);
			s.Count = 1;
			d.Sel = d.Rows[0];
			try {
				yield* ping();
			} catch {
				const again = yield* slot(d);
				again.Count = 3;
				s.Count += 1;
			}
		}, "root");
		expect(count(h)).toBe(4);
		h.runtime.dispose();
	});
});

describe("a dispatch made while a drain runs", () => {
	// On another entity than the removal's, so its hold doesn't queue the dispatch past the drain.
	function* loopRow(d: IRow): IActionGenerator {
		d.Back = d;
	}
	function* removeSecond(d: IWorld): IActionGenerator {
		d.Rows.splice(1, 1);
	}

	it("from a record tap on entity:dispose is held past the drain and its slice checked", async () => {
		const h = build();
		const refused: unknown[] = [];
		h.runtime.on("record", (record) => {
			if (record.Kind === "entity:dispose") {
				h.runtime.dispatch(loopRow, "r1").catch((error) => refused.push(error));
			}
		});
		await h.runtime.dispatch(removeSecond, "root");
		await tick();
		expect(refused).toHaveLength(1);
		expect(refused[0]).toBeInstanceOf(StateCycleError);
		expect(rawOf(h.runtime.state).Rows[0]!.Back).toBeUndefined();
		expect(h.surfaced).toEqual([]);
		h.runtime.dispose();
	});

	it("from a dispose callback is held past the drain and its slice checked", async () => {
		const h = build();
		const refused: unknown[] = [];
		h.runtime.get("runtime/writeGateway").onDispose((id) => {
			if (id === "r2") {
				h.runtime.dispatch(loopRow, "r1").catch((error) => refused.push(error));
			}
		}, "tables");
		await h.runtime.dispatch(removeSecond, "root");
		await tick();
		expect(refused).toHaveLength(1);
		expect(refused[0]).toBeInstanceOf(StateCycleError);
		expect(rawOf(h.runtime.state).Rows[0]!.Back).toBeUndefined();
		expect(h.surfaced).toEqual([]);
		h.runtime.dispose();
	});

	it("from an abort listener the removal cascade fires is held past the drain and its slice checked", async () => {
		const h = build();
		const refused: unknown[] = [];
		h.runtime.registerImplementation(
			"atomic/watched",
			(_effect: IEffect, action?: IActionContext) =>
				new Promise<void>(() => {
					action!.signal.addEventListener("abort", () => {
						h.runtime.dispatch(loopRow, "r1").catch((error) => refused.push(error));
					});
				})
		);
		void h.runtime.dispatch(function* (_d: IRow): IActionGenerator {
			yield {
				Type: "atomic/watched"
			};
		}, "r2");
		await tick();
		await h.runtime.dispatch(removeSecond, "root");
		await tick();
		expect(refused).toHaveLength(1);
		expect(refused[0]).toBeInstanceOf(StateCycleError);
		expect(rawOf(h.runtime.state).Rows[0]!.Back).toBeUndefined();
		expect(h.surfaced).toEqual([]);
		h.runtime.dispose();
	});
});

describe("a held reference after a rollback", () => {
	it("records the restored path, not the one a reorder in the refused slice gave it", async () => {
		const h = build();
		await h.runtime.dispatch(function* (d: IWorld): IActionGenerator {
			const first = d.Rows[0]!;
			d.Rows.reverse();
			d.Sel = d.Rows[1];
			try {
				yield* ping();
			} catch {
				first.Name = "after";
			}
		}, "root");
		const changes = h.steps().flatMap(
			(record) =>
				(
					record as {
						Changes: {
							Path: string[];
						}[];
					}
				).Changes
		);
		expect(changes.map((change) => change.Path.join("."))).toEqual([
			"Rows.0.Name"
		]);
		expect(rawOf(h.runtime.state).Rows[0]!.Name).toBe("after");
		h.runtime.dispose();
	});
});

describe("a catch that retries the refused writes", () => {
	it("ends the action errored with the refusal and a diag once the refusals run past the limit", async () => {
		const h = build();
		let tries = 0;
		const error = await h.refusal(function* (d) {
			while (true) {
				tries++;
				d.Sel = d.Rows[0];
				try {
					yield* ping();
					return;
				} catch {}
			}
		});
		expect(error).toBeInstanceOf(StateAliasError);
		expect(tries).toBe(REFUSAL_LIMIT + 1);
		expect(h.diags.filter((d) => d.code === "action/refusal-loop")).toHaveLength(1);
		expect(h.pinged).toEqual([]);
		h.runtime.dispose();
	});
});

describe("order and messages", () => {
	it("lands a parent's step record ahead of the child it dispatched", async () => {
		const h = build();
		function* child(draft: IRow): IActionGenerator {
			draft.Name = "by child";
		}
		await h.runtime.dispatch(function* parent(d: IWorld): IActionGenerator {
			d.Note = "by parent";
			void h.runtime.dispatch(child, "r2");
		}, "root");
		await tick();
		const order = h.records
			.filter((record) => record.Kind === "step" || record.Kind === "action:start")
			.map((record) =>
				record.Kind === "step"
					? `step ${(
							record as {
								Changes: {
									Path: string[];
								}[];
							}
						).Changes[0]!.Path.join(".")}`
					: `start ${
							(
								record as {
									Label: string | null;
								}
							).Label
						}`
			);
		expect(order).toEqual([
			"start parent",
			"step Note",
			"start child",
			"step Name"
		]);
		h.runtime.dispose();
	});

	it("gives an empty index its own hint", async () => {
		const h = build();
		const error = await h.refusal(function* (d) {
			d.List[3] = 9;
		});
		expect((error as Error).message).toContain("an empty index at [AppState.List.2]");
		expect((error as Error).message).toContain("write at `length` or use `push`");
		h.runtime.dispose();
	});

	it("names a step ending at entity() as the entity() call", async () => {
		const h = build();
		const error = await h.refusal(function* (d) {
			d.Sel = d.Rows[0];
			yield* entity({
				Name: "n"
			});
		});
		expect((error as Error).message).toContain("The step ending at an entity() call was undone");
		expect((error as Error).message).not.toContain("generateGuid");
		h.runtime.dispose();
	});
});
