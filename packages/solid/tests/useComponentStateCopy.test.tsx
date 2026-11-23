import type { IActionGenerator, IEntity } from "treflex";
import { createRuntime, EntityReplacedError, entity, HandWrittenIdError, idOf, MoveBetweenRootsError, start, withoutIds } from "treflex";
import { describe, expect, it } from "vitest";
import { TreflexProvider } from "../src/Context/TreflexContext";
import { useComponentState } from "../src/Hooks/useComponentState";
import { mount } from "./mount";
import { treeWrite } from "./treeWrite";

interface IRow extends IEntity {
	Name: string;
	Kids: IEntity[];
}

interface IWorld extends IEntity {
	Row: IRow;
}

interface ILocal extends IEntity {
	RowId: string;
	Name: string;
	Kids: object[];
	Editing?: object;
	Nested?: object;
}

describe.each([
	[
		"journal on",
		true
	],
	[
		"journal off",
		false
	]
])("useComponentState editing a copy of a live domain entity, %s", (_name, journal) => {
	function world() {
		const runtime = createRuntime<IWorld>({
			$Id: "root",
			Row: {
				$Id: "row-1",
				Name: "one",
				Kids: [
					{
						$Id: "kid-1"
					}
				]
			}
		});
		if (journal) {
			runtime.on("record", () => {});
		}
		return runtime;
	}

	function mountLocal<L>(
		runtime: ReturnType<typeof world>,
		hook: () => L
	): {
		local: L;
		dispose: () => void;
	} {
		let local!: L;
		const Inner = (): null => {
			local = hook();
			return null;
		};
		const { dispose } = mount(() => (
			<TreflexProvider value={runtime as any}>
				<Inner />
			</TreflexProvider>
		));
		return {
			local,
			dispose
		};
	}

	const fromRow = (runtime: ReturnType<typeof world>) =>
		useComponentState<ILocal>(() => ({
			...withoutIds(runtime.state.Row),
			RowId: idOf(runtime.state.Row)
		}));

	it("refuses a factory that spreads the row, naming the route, thrown from the render that mounts it", () => {
		const runtime = world();
		let thrown: unknown;
		try {
			mountLocal(runtime, () =>
				useComponentState(() => ({
					...runtime.state.Row
				}))
			);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(HandWrittenIdError);
		expect(String(thrown)).toMatch(/withoutIds/);
		runtime.dispose();
	});

	it("stamps its own $Id on a factory seeded from withoutIds, and two mounts share nothing", () => {
		const runtime = world();
		const first = mountLocal(runtime, () => fromRow(runtime));
		const second = mountLocal(runtime, () => fromRow(runtime));
		expect(first.local.state.$Id).not.toBe(second.local.state.$Id);
		expect(first.local.state).toMatchObject({
			RowId: "row-1",
			Name: "one",
			Kids: [
				{}
			]
		});
		first.dispose();
		second.dispose();
		runtime.dispose();
	});

	it("edits the copy without touching the row, and writes the edit back through the row's address", async () => {
		const runtime = world();
		const { local, dispose } = mountLocal(runtime, () => fromRow(runtime));
		await local.dispatch(function* rename(draft: ILocal): IActionGenerator {
			draft.Name = "edited";
		});
		expect(runtime.state.Row.Name).toBe("one");

		function* save(draft: IRow, name: string): IActionGenerator {
			draft.Name = name;
		}
		await runtime.dispatch(save, local.state.RowId, local.state.Name);
		expect(runtime.state.Row.Name).toBe("edited");
		dispose();
		runtime.dispose();
	});

	it.each<
		[
			string,
			(runtime: ReturnType<typeof world>) => object
		]
	>([
		[
			"an entity",
			(runtime) => runtime.state.Row
		],
		[
			"a plain node",
			(runtime) => runtime.state.Row.Kids
		],
		[
			"a node inside a value",
			(runtime) => ({
				Deep: [
					runtime.state.Row
				]
			})
		],
		[
			"a spread, whose fields are live",
			(runtime) => ({
				...withoutIds(runtime.state.Row),
				Kids: runtime.state.Row.Kids
			})
		]
	])("refuses a live node crossing in by reference, as %s", async (_shape, live) => {
		const runtime = world();
		const { local, dispose } = mountLocal(runtime, () => fromRow(runtime));
		await expect(
			local.dispatch(function* editing(draft: ILocal): IActionGenerator {
				draft.Editing = live(runtime);
			})
		).rejects.toThrow(MoveBetweenRootsError);
		expect(local.state.Editing).toBeUndefined();
		expect(runtime.state.Row.Name).toBe("one");
		dispose();
		runtime.dispose();
	});

	it("refuses a component state node crossing out to the tree by reference", async () => {
		const runtime = world();
		const { local, dispose } = mountLocal(runtime, () => fromRow(runtime));
		await expect(
			runtime.dispatch(function* taking(draft: any): IActionGenerator {
				draft.Taken = local.state.Kids[0];
			}, "root")
		).rejects.toThrow(MoveBetweenRootsError);
		expect((runtime.state as any).Taken).toBeUndefined();
		dispose();
		runtime.dispose();
	});

	it("refuses a copy from an action on an entity nested in component state", async () => {
		const runtime = world();
		const { local, dispose } = mountLocal(runtime, () => fromRow(runtime));
		await local.dispatch(function* nest(draft: ILocal): IActionGenerator {
			draft.Nested = yield* entity({
				Name: "nested"
			});
		});
		function* copying(draft: any): IActionGenerator {
			draft.Copy = JSON.parse(JSON.stringify(runtime.state.Row));
		}
		await expect(runtime.dispatch(copying, idOf(local.state.Nested as IEntity))).rejects.toThrow(EntityReplacedError);
		expect((local.state.Nested as any).Copy).toBeUndefined();
		dispose();
		runtime.dispose();
	});

	it("starts against an entity nested in component state", async () => {
		const runtime = world();
		const codes: string[] = [];
		runtime.on("diag", (event) => codes.push(event.code));
		const { local, dispose } = mountLocal(runtime, () => fromRow(runtime));
		let ran = false;
		function* init(): IActionGenerator {
			ran = true;
		}
		await local.dispatch(function* opening(draft: ILocal): IActionGenerator {
			const kid = yield* entity({
				Name: "kid"
			});
			draft.Nested = kid;
			yield* start(init as any, idOf(kid));
		});
		expect(ran).toBe(true);
		expect(codes).toEqual([]);
		dispose();
		runtime.dispose();
	});

	it("runs a nested entity's work through the component's own yield*, or a start on the component entity", async () => {
		const runtime = world();
		const { local, dispose } = mountLocal(runtime, () => fromRow(runtime));
		function* initKid(draft: any): IActionGenerator {
			draft.Ready = true;
		}
		function* onRoot(draft: any): IActionGenerator {
			draft.Nested.Started = true;
		}
		await local.dispatch(function* opening(draft: ILocal): IActionGenerator {
			draft.Nested = yield* entity({
				Name: "kid"
			});
			yield* initKid(draft.Nested);
			yield* start(onRoot as any, draft.$Id);
		});
		await Promise.resolve();
		expect(local.state.Nested).toMatchObject({
			Ready: true,
			Started: true
		});
		dispose();
		runtime.dispose();
	});

	it("refuses a copy carrying the row's $Id from an action, where the domain tree refuses it too", async () => {
		const runtime = world();
		const { local, dispose } = mountLocal(runtime, () => fromRow(runtime));
		const copy = (): IRow => JSON.parse(JSON.stringify(runtime.state.Row));
		await expect(
			local.dispatch(function* editing(draft: ILocal): IActionGenerator {
				draft.Editing = copy();
			})
		).rejects.toThrow(EntityReplacedError);
		expect(local.state.Editing).toBeUndefined();
		expect(() =>
			treeWrite(runtime, (s) => {
				s.Row = copy();
			})
		).toThrow(EntityReplacedError);
		dispose();
		runtime.dispose();
	});

	it("takes a copy without its ids from an action", async () => {
		const runtime = world();
		const { local, dispose } = mountLocal(runtime, () => fromRow(runtime));
		await local.dispatch(function* editing(draft: ILocal): IActionGenerator {
			draft.Editing = withoutIds(runtime.state.Row);
		});
		expect(local.state.Editing).toEqual({
			Name: "one",
			Kids: [
				{}
			]
		});
		await local.dispatch(function* editing(draft: ILocal): IActionGenerator {
			draft.Nested = withoutIds(runtime.state.Row.Kids[0]);
		});
		expect(local.state.Nested).toEqual({});
		dispose();
		runtime.dispose();
	});

	it("refuses a hand-written $Id in component state, nested or on the root", async () => {
		const runtime = world();
		const { local, dispose } = mountLocal(runtime, () => fromRow(runtime));
		const typed = () => ({
			$Id: "typed"
		});
		await expect(
			local.dispatch(function* nest(draft: ILocal): IActionGenerator {
				draft.Nested = typed();
			})
		).rejects.toThrow(HandWrittenIdError);
		await expect(
			local.dispatch(function* rename(draft: ILocal): IActionGenerator {
				(
					draft as {
						$Id: string;
					}
				).$Id = "typed";
			})
		).rejects.toThrow(HandWrittenIdError);
		dispose();
		runtime.dispose();
	});

	it("takes a nested entity the component's action makes with entity()", async () => {
		const runtime = world();
		const { local, dispose } = mountLocal(runtime, () => fromRow(runtime));
		await local.dispatch(function* nest(draft: ILocal): IActionGenerator {
			draft.Nested = yield* entity({
				Name: "nested"
			});
		});
		expect(local.state.Nested).toEqual({
			$Id: expect.stringMatching(/^~/),
			Name: "nested"
		});
		dispose();
		runtime.dispose();
	});
});

describe("component state and a disposed runtime", () => {
	const mounted = () => {
		const runtime = createRuntime<IEntity>({
			$Id: "root"
		});
		const Inner = (): null => {
			useComponentState(() => ({
				Count: 0
			}));
			return null;
		};
		const { dispose: unmount } = mount(() => (
			<TreflexProvider value={runtime as any}>
				<Inner />
			</TreflexProvider>
		));
		return {
			runtime,
			unmount
		};
	};

	it("unmounts cleanly after the runtime is disposed", () => {
		const { runtime, unmount } = mounted();
		runtime.dispose();
		expect(unmount).not.toThrow();
	});

	it("disposes cleanly straight after an unmount", () => {
		const { runtime, unmount } = mounted();
		unmount();
		expect(() => runtime.dispose()).not.toThrow();
	});

	it("mounts nothing on a disposed runtime, and doesn't throw", async () => {
		const runtime = createRuntime<IEntity>({
			$Id: "root"
		});
		runtime.dispose();
		let local!: ReturnType<
			typeof useComponentState<
				IEntity & {
					Count: number;
				}
			>
		>;
		const Inner = (): null => {
			local = useComponentState(() => ({
				Count: 3
			}));
			return null;
		};
		let unmount!: () => void;
		expect(() => {
			unmount = mount(() => (
				<TreflexProvider value={runtime as any}>
					<Inner />
				</TreflexProvider>
			)).dispose;
		}).not.toThrow();
		expect(local.state.Count).toBe(3);
		await expect(local.dispatch(function* (): IActionGenerator {})).rejects.toThrow();
		expect(unmount).not.toThrow();
	});
});
