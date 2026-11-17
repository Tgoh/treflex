import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator, IOpenGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import type { IRecord } from "../../src/Types/IRecord";
import type { IResourceContext } from "../../src/Types/IResource";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "../../src/Effects/ask";
import { entity, idOf, withoutIds } from "../../src/Effects/entity";
import { openResource } from "../../src/Effects/openResource";
import { registerDataSource } from "../../src/Effects/registerDataSource";
import { start } from "../../src/Effects/start";
import { startTimer } from "../../src/Effects/startTimer";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { EntityReplacedError } from "../../src/Runtime/draftNode";
import { open } from "../../src/Runtime/open";
import { receiver } from "../../src/Runtime/receiver";
import { StateAliasError } from "../../src/Runtime/stateAlias";
import { MoveBetweenRootsError, transient } from "../../src/Runtime/transient";
import { createSnapshot } from "../../src/Snapshot/createSnapshot";
import { restoreRuntime } from "../../src/Snapshot/index";
import { settled } from "../../src/Testing/createTestRuntime";
import { captureSurfaced, inFlightOf, mountComponent, pendingAsksOf } from "../testHelpers";

declare module "../../src/Registries/IDataSourceRegistry" {
	interface IDataSourceRegistry {
		"Cs/Source": IEntity;
	}
}
declare module "../../src/Registries/ITimerRegistry" {
	interface ITimerRegistry {
		"Cs/Tick": {};
	}
}
declare module "../../src/Registries/IResourceRegistry" {
	interface IResourceTypeRegistry {
		"cs/upload": {
			Params: {
				Label: string;
			};
			Message: {
				Done: boolean;
			};
		};
	}
	interface IResourceRegistry {
		"Cs/Upload": {
			Type: "cs/upload";
		};
	}
}

type IRow = {
	$Id: string;
	Name: string;
};

type IScreen = {
	$Id: string;
	Rows: IRow[];
	Errors: string[];
};

type IRoot = {
	$Id: string;
	Screen: IScreen;
};

const seed = (): IRoot => ({
	$Id: "root",
	Screen: {
		$Id: "screen",
		Rows: [
			{
				$Id: "row-1",
				Name: "Alpha"
			}
		],
		Errors: []
	}
});

function build() {
	const runtime = createRuntime<IRoot>(seed(), {
		onError: () => {}
	});
	const internal = runtime as IRuntimeInternal<IRoot>;
	const releases = new Map<string, (value?: unknown) => void>();
	runtime.registerImplementation(
		"test/wait",
		(effect: { Type: string; Name: string }) =>
			new Promise((resolve) => {
				releases.set(effect.Name, resolve);
			})
	);
	const release = (name: string, value?: unknown): void => {
		const resolve = releases.get(name);
		if (!resolve) {
			throw new Error(`nothing waits on "${name}"`);
		}
		releases.delete(name);
		resolve(value);
	};
	const stateOf = <T>(id: string): T => internal.resolveCell(id)?.state as T;
	return {
		runtime,
		internal,
		release,
		releases,
		stateOf,
		mount: (ownerId: string | undefined, seed: object) => mountComponent(runtime, ownerId, seed)
	};
}

function* wait(name: string): Generator<any, any, any> {
	return yield {
		Type: "test/wait",
		Name: name
	};
}

type IDialog = IEntity & {
	EditingId: string | null;
	Copy: {
		Name: string;
	} | null;
	Error: string | null;
	Typed: string;
	Items: IEntity[];
	Log: string[];
};

const dialogSeed = (): Omit<IDialog, "$Id"> => ({
	EditingId: null,
	Copy: null,
	Error: null,
	Typed: "",
	Items: [],
	Log: []
});

const Uploads = receiver<IDialog>("CsUploads")({
	*"Cs/Upload"(draft) {
		draft.Log.push("upload");
	}
});

function* longScreenWork(draft: IScreen): IActionGenerator {
	yield* wait("screen");
	draft.Errors.push("screen:done");
}

function* setEditing(draft: IDialog, id: string | null): IActionGenerator {
	draft.EditingId = id;
}

function* type(draft: IDialog, text: string): IActionGenerator {
	draft.Typed = text;
}

function* saveTyped(draft: IDialog): IActionGenerator {
	draft.Log.push(`save:${draft.Typed}`);
	yield* wait("save");
	draft.Log.push(`saved:${draft.Typed}`);
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ComponentState: a mount", () => {
	it("is seated synchronously, indexed, with a path through its owner", () => {
		const w = build();
		const id = w.mount("screen", dialogSeed());
		const cell = w.internal.get("runtime/stateIdLookup")()[id];
		expect(cell?.path).toEqual([
			"root",
			"screen",
			id
		]);
		expect(w.stateOf<IDialog>(id).Typed).toBe("");
		expect(w.internal.get("runtime/writeGateway").rootNameOf(id)).toBe("ComponentState");
		w.runtime.dispose();
	});

	it("under no owner hangs off the root's $Id", () => {
		const w = build();
		const id = w.mount(undefined, {});
		expect(w.internal.get("runtime/stateIdLookup")()[id]?.path).toEqual([
			"root",
			id
		]);
		w.runtime.dispose();
	});

	it("under an owner already gone seats nothing, and the mount can still unmount", async () => {
		const w = build();
		const { id, raw } = w.internal.seedComponent(dialogSeed(), "test");
		expect(w.internal.seatComponent("nobody", raw)).toBe(false);
		expect(w.internal.resolveCell(id)).toBeUndefined();
		await expect(w.runtime.dispatch(type, id, "x")).rejects.toThrow(/no entity/);
		expect(() => w.internal.unmountComponent(id)).not.toThrow();
		w.runtime.dispose();
	});

	it("under an owner in its cascade seats nothing, so nothing outlives the owner", async () => {
		const w = build();
		const seated: boolean[] = [];
		const gateway = w.internal.get("runtime/writeGateway");
		gateway.onDispose((disposedId) => {
			if (disposedId === "row-1") {
				const { raw } = w.internal.seedComponent({}, "test");
				seated.push(w.internal.seatComponent("row-1", raw));
			}
		}, "cancel");
		function* removeRow(draft: IScreen): IActionGenerator {
			draft.Rows.splice(0, 1);
		}
		await w.runtime.dispatch(removeRow, "screen");
		expect(seated).toEqual([
			false
		]);
		expect(
			Object.keys(
				(
					gateway.rootNode() as {
						ComponentState: object;
					}
				).ComponentState
			)
		).toEqual([]);
		w.runtime.dispose();
	});

	it("after the runtime's dispose seats nothing, and doesn't throw", () => {
		const w = build();
		w.runtime.dispose();
		const { id, raw } = w.internal.seedComponent(dialogSeed(), "test");
		expect(w.internal.seatComponent(undefined, raw)).toBe(false);
		expect(w.internal.reseatComponent(id, "screen")).toBe(false);
		expect(() => w.internal.unmountComponent(id)).not.toThrow();
	});

	it("moves under another owner with its node, its state and its work, and outlives the old owner", async () => {
		const w = build();
		const id = w.mount("row-1", dialogSeed());
		await w.runtime.dispatch(type, id, "kept");
		const node = w.stateOf<IDialog>(id);
		const saving = w.runtime.dispatch(saveTyped, id);
		expect(w.internal.reseatComponent(id, "screen")).toBe(true);
		expect(w.internal.get("runtime/stateIdLookup")()[id]?.path).toEqual([
			"root",
			"screen",
			id
		]);
		expect(w.stateOf<IDialog>(id)).toBe(node);
		expect(inFlightOf(w.runtime, saveTyped, node)).toBe(true);
		function* removeRow(draft: IScreen): IActionGenerator {
			draft.Rows.splice(0, 1);
		}
		await w.runtime.dispatch(removeRow, "screen");
		expect(w.stateOf<IDialog>(id).Typed).toBe("kept");
		w.release("save");
		await saving;
		expect(w.stateOf<IDialog>(id).Log).toEqual([
			"save:kept",
			"saved:kept"
		]);
		w.runtime.dispose();
	});

	it("doesn't move a mount that isn't seated, and unmounts one moved under an owner that's gone", () => {
		const w = build();
		const { id, raw } = w.internal.seedComponent({}, "test");
		expect(w.internal.reseatComponent(id, "screen")).toBe(false);
		expect(w.internal.seatComponent("screen", raw)).toBe(true);
		expect(w.internal.reseatComponent(id, "nobody")).toBe(false);
		expect(w.internal.resolveCell(id)).toBeUndefined();
		w.runtime.dispose();
	});

	it("refuses an owner in ComponentState, for a seat and a move alike", async () => {
		const w = build();
		const outer = w.mount("screen", dialogSeed());
		let nested = "";
		await w.runtime.dispatch(function* (draft: IDialog): IActionGenerator {
			const item = yield* entity({});
			draft.Items.push(item);
			nested = idOf(item);
		}, outer);
		const { raw } = w.internal.seedComponent({}, "test");
		expect(() => w.internal.seatComponent(outer, raw)).toThrow(/mounts are flat/);
		expect(() => w.internal.seatComponent(nested, raw)).toThrow(/mounts are flat/);
		const other = w.mount("screen", {});
		expect(() => w.internal.reseatComponent(other, nested)).toThrow(/mounts are flat/);
		expect(w.internal.get("runtime/stateIdLookup")()[other]?.path).toEqual([
			"root",
			"screen",
			other
		]);
		w.runtime.dispose();
	});

	it("doesn't queue behind a held owner, and work on it starts at once", async () => {
		const w = build();
		const long = w.runtime.dispatch(longScreenWork, "screen");
		const id = w.mount("screen", dialogSeed());
		void w.runtime.dispatch(setEditing, id, "row-1");
		expect(w.stateOf<IDialog>(id).EditingId).toBe("row-1");
		w.release("screen");
		await long;
		w.runtime.dispose();
	});

	it("unmounts once, and an unmount after the owner took it is a no-op", async () => {
		const w = build();
		const id = w.mount("row-1", {});
		function* removeRow(draft: IScreen): IActionGenerator {
			draft.Rows.splice(0, 1);
		}
		await w.runtime.dispatch(removeRow, "screen");
		expect(w.internal.resolveCell(id)).toBeUndefined();
		expect(() => w.internal.unmountComponent(id)).not.toThrow();
		const other = w.mount("screen", {});
		w.internal.unmountComponent(other);
		w.internal.unmountComponent(other);
		expect(w.internal.resolveCell(other)).toBeUndefined();
		w.runtime.dispose();
	});
});

describe("ComponentState: holds", () => {
	it("a widget's own save holds it, so typing during the save queues", async () => {
		const w = build();
		const id = w.mount("screen", dialogSeed());
		await w.runtime.dispatch(type, id, "a");
		const saving = w.runtime.dispatch(saveTyped, id);
		const typing = w.runtime.dispatch(type, id, "ab");
		await settled();
		expect(w.stateOf<IDialog>(id).Typed).toBe("a");
		w.release("save");
		await saving;
		await typing;
		expect(w.stateOf<IDialog>(id).Log).toEqual([
			"save:a",
			"saved:a"
		]);
		expect(w.stateOf<IDialog>(id).Typed).toBe("ab");
		w.runtime.dispose();
	});

	it("a save whose wait is inside open(...) lets typing in", async () => {
		const w = build();
		const id = w.mount("screen", dialogSeed());
		function* saveOpen(draft: IDialog): IOpenGenerator {
			const value = draft.Typed;
			yield* open(wait("save"));
			draft.Log.push(`saved:${value}`);
		}
		const saving = w.runtime.dispatch(saveOpen, id);
		void w.runtime.dispatch(type, id, "typed during");
		await settled();
		expect(w.stateOf<IDialog>(id).Typed).toBe("typed during");
		w.release("save");
		await saving;
		w.runtime.dispose();
	});

	it("inFlight() reads work on a component entity", async () => {
		const w = build();
		const id = w.mount("screen", dialogSeed());
		const saving = w.runtime.dispatch(saveTyped, id);
		expect(inFlightOf(w.runtime, saveTyped, w.stateOf<IDialog>(id))).toBe(true);
		w.release("save");
		await saving;
		expect(inFlightOf(w.runtime, saveTyped, w.stateOf<IDialog>(id))).toBe(false);
		w.runtime.dispose();
	});
});

describe("ComponentState: lifetime", () => {
	it("the owner's removal ends the entity's work and releases its resources", async () => {
		const w = build();
		let ctx!: IResourceContext<"cs/upload">;
		w.runtime.registerResourceType("cs/upload", (_params, r) => {
			ctx = r;
		});
		w.runtime.registerReceiver(Uploads);
		const id = w.mount("row-1", dialogSeed());
		function* startUpload(draft: IDialog): IActionGenerator {
			yield* openResource(draft, "Cs/Upload", Uploads, {
				Type: "cs/upload",
				Label: "group"
			});
			yield* wait("upload");
			draft.Log.push("never");
		}
		const uploading = w.runtime.dispatch(startUpload, id);
		await settled();
		expect(w.runtime.resources(id)).toHaveLength(1);
		function* removeRow(draft: IScreen): IActionGenerator {
			draft.Rows.splice(0, 1);
		}
		await w.runtime.dispatch(removeRow, "screen");
		expect(await uploading).toBeUndefined();
		expect(ctx.signal.aborted).toBe(true);
		expect(w.runtime.resources()).toEqual([]);
		expect(w.internal.resolveCell(id)).toBeUndefined();
		w.runtime.dispose();
	});

	it("unmount drops the copy, the error, the running work and the upload group", async () => {
		const w = build();
		let ctx!: IResourceContext<"cs/upload">;
		w.runtime.registerResourceType("cs/upload", (_params, r) => {
			ctx = r;
		});
		w.runtime.registerReceiver(Uploads);
		const id = w.mount("screen", dialogSeed());
		function* startUpload(draft: IDialog): IActionGenerator {
			draft.Error = "kept";
			yield* openResource(draft, "Cs/Upload", Uploads, {
				Type: "cs/upload",
				Label: "group"
			});
			yield* wait("upload");
		}
		const uploading = w.runtime.dispatch(startUpload, id);
		await settled();
		w.internal.unmountComponent(id);
		expect(await uploading).toBeUndefined();
		expect(ctx.signal.aborted).toBe(true);
		expect(w.runtime.resources()).toEqual([]);
		expect(w.internal.resolveCell(id)).toBeUndefined();
		w.runtime.dispose();
	});

	it("an action's failure escalates to the owner's receivers", async () => {
		const w = build();
		const ErrorBoundary = receiver<IScreen>("CsErrorBoundary")({
			["Action/Error" as any]: function* (
				draft: IScreen,
				e: {
					ActionName: string;
				}
			) {
				draft.Errors.push(e.ActionName);
			}
		});
		w.runtime.registerReceiver(ErrorBoundary);
		function* bindsErrorBoundary(draft: IScreen): IActionGenerator {
			bind(draft, ErrorBoundary);
		}
		await w.runtime.dispatch(bindsErrorBoundary, "screen");
		const id = w.mount("screen", dialogSeed());
		function* fails(_draft: IDialog): IActionGenerator {
			throw new Error("boom");
		}
		await w.runtime.dispatch(fails, id).catch(() => {});
		await settled();
		expect(w.runtime.state.Screen.Errors).toEqual([
			"fails"
		]);
		w.runtime.dispose();
	});

	it("nested entities come from its own init action, and a start reaches one", async () => {
		const w = build();
		const id = w.mount("screen", dialogSeed());
		function* note(
			draft: IEntity & {
				Name: string;
				Seen?: boolean;
			}
		): IActionGenerator {
			draft.Seen = true;
		}
		function* init(draft: IDialog): IActionGenerator {
			const item = yield* entity({
				Name: "nested"
			});
			draft.Items.push(item);
			yield* start(note, idOf(item));
		}
		await w.runtime.dispatch(init, id);
		await settled();
		const nested = w.stateOf<IDialog>(id).Items[0] as IEntity & {
			Seen?: boolean;
		};
		expect(nested.Seen).toBe(true);
		expect(w.internal.get("runtime/stateIdLookup")()[nested.$Id]?.path).toEqual([
			"root",
			"screen",
			id,
			nested.$Id
		]);
		w.runtime.dispose();
	});
});

describe("ComponentState: editing a copy of a live row", () => {
	it("refuses the live row, and a row passed as an argument is a copy that keeps its $Id", async () => {
		const w = build();
		const id = w.mount("screen", dialogSeed());
		const live = w.runtime.state.Screen.Rows[0]!;
		function* takeLive(draft: IDialog): IActionGenerator {
			draft.Copy = live;
		}
		await expect(w.runtime.dispatch(takeLive, id)).rejects.toThrow(MoveBetweenRootsError);
		function* takeArg(draft: IDialog, row: IRow): IActionGenerator {
			draft.Copy = row;
		}
		await expect(w.runtime.dispatch(takeArg, id, live)).rejects.toThrow(EntityReplacedError);
		w.runtime.dispose();
	});
});

describe("the crossing rule, one rule for all three roots", () => {
	type IFreshHolder = {
		Fresh?: {
			Held?: unknown;
		};
	};
	const shelf = (owner: IEntity) =>
		transient(
			owner,
			"Cs/Shelf",
			{} as IFreshHolder & {
				Kept?: {
					X: number;
				};
			}
		);

	// verifyIndex on every drain, so an index the refusal left inconsistent throws.
	async function crossingWorld() {
		const runtime = createRuntime<IRoot>(seed(), {
			onError: () => {},
			verifyIndex: true
		});
		const internal = runtime as IRuntimeInternal<IRoot>;
		const component = mountComponent(runtime, "screen", {
			Box: {
				X: 1
			}
		});
		await runtime.dispatch(function* keep(draft: IScreen): IActionGenerator {
			(yield* shelf(draft)).Kept = {
				X: 2
			};
		}, "screen");
		const slotOfScreen = () =>
			runtime.processSelector(
				function* (draft: IScreen) {
					return yield* shelf(draft);
				},
				() => runtime.state.Screen
			);
		const live = {
			AppState: () => runtime.state.Screen.Rows[0]!,
			TransientState: () => slotOfScreen().Kept!,
			ComponentState: () =>
				(
					internal.resolveCell(component)!.state as {
						Box: object;
					}
				).Box
		};
		const into = {
			AppState: (write: (holder: IFreshHolder) => void) =>
				runtime.dispatch(function* (draft: IScreen): IActionGenerator {
					write(draft as IFreshHolder);
				}, "screen"),
			TransientState: (write: (holder: IFreshHolder) => void) =>
				runtime.dispatch(function* (draft: IScreen): IActionGenerator {
					write(yield* shelf(draft));
				}, "screen"),
			ComponentState: (write: (holder: IFreshHolder) => void) =>
				runtime.dispatch(function* (draft: IFreshHolder): IActionGenerator {
					write(draft);
				}, component)
		};
		const freshIn = {
			AppState: () => (runtime.state.Screen as IFreshHolder).Fresh,
			TransientState: () => slotOfScreen().Fresh,
			ComponentState: () => (internal.resolveCell(component)!.state as IFreshHolder).Fresh
		};
		return {
			runtime,
			componentId: component,
			live,
			into,
			freshIn
		};
	}

	const ROOTS = [
		"AppState",
		"TransientState",
		"ComponentState"
	] as const;
	const PAIRS = ROOTS.flatMap((to) =>
		ROOTS.filter((from) => from !== to).map(
			(from) =>
				[
					from,
					to
				] as const
		)
	);

	it.each(PAIRS)("refuses a live %s node written below a %s node new in the same step, and keeps the write before it", async (from, to) => {
		const surfaced = captureSurfaced();
		const w = await crossingWorld();
		const node = w.live[from]();
		const before = JSON.stringify(node);
		const refused = w.into[to]((holder) => {
			holder.Fresh = {};
			holder.Fresh.Held = node;
		});
		await expect(refused).rejects.toThrow(MoveBetweenRootsError);
		await expect(refused).rejects.toMatchObject({
			from: expect.arrayContaining([
				from
			]),
			to: [
				to,
				"…"
			]
		});
		await settled();
		expect(w.freshIn[to]()).toEqual({});
		expect(JSON.stringify(w.live[from]())).toBe(before);
		expect(surfaced.filter((error) => error instanceof StateAliasError)).toEqual([]);
		await w.into[to]((holder) => {
			holder.Fresh = {};
			holder.Fresh.Held = withoutIds(node);
		});
		expect(w.freshIn[to]()).toEqual({
			Held: withoutIds(node)
		});
		w.runtime.dispose();
	});

	type IBorn = {
		N?: number;
		Inner: {
			Held?: unknown;
		};
		Fresh?: {
			Held?: unknown;
		};
	};
	const born = (owner: IEntity) =>
		transient(owner, "Cs/Born", {
			Inner: {}
		} as IBorn);
	const BORN_WRITES: [
		string,
		(
			draft: IEntity & {
				Copy?: unknown;
			},
			slot: IBorn,
			live: object
		) => void
	][] = [
		[
			"a live node below the slot's default",
			(_draft, slot, live) => {
				slot.N = 1;
				slot.Inner.Held = live;
			}
		],
		[
			"a live node below the node that bore the slot",
			(_draft, slot, live) => {
				slot.Fresh = {};
				slot.Fresh.Held = live;
			}
		],
		[
			"the slot's default written out of it",
			(draft, slot) => {
				slot.N = 1;
				draft.Copy = slot.Inner;
			}
		]
	];

	it.each(
		BORN_WRITES.flatMap(([shape, write]) =>
			(
				[
					"screen",
					"component"
				] as const
			).map(
				(owner) =>
					[
						shape,
						owner,
						write
					] as const
			)
		)
	)("refuses %s, with the slot of the %s born in the same step", async (_shape, owner, write) => {
		const surfaced = captureSurfaced();
		const w = await crossingWorld();
		const live = w.live.AppState();
		const ownerId = owner === "screen" ? "screen" : w.componentId;
		const refused = w.runtime.dispatch(function* (
			draft: IEntity & {
				Copy?: unknown;
			}
		): IActionGenerator {
			write(draft, yield* born(draft), live);
		}, ownerId);
		await expect(refused).rejects.toThrow(MoveBetweenRootsError);
		await settled();
		expect(surfaced.filter((error) => error instanceof StateAliasError)).toEqual([]);
		w.runtime.dispose();
	});

	it("refuses a removed tree row written into component state, and a nested entity held past its unmount written into the tree", async () => {
		const w = build();
		const component = w.mount("screen", dialogSeed());
		const row = w.runtime.state.Screen.Rows[0]!;
		await w.runtime.dispatch(function* (draft: IScreen): IActionGenerator {
			draft.Rows.splice(0, 1);
		}, "screen");
		await expect(
			w.runtime.dispatch(function* (draft: IDialog): IActionGenerator {
				draft.Copy = row;
			}, component)
		).rejects.toThrow(MoveBetweenRootsError);
		await w.runtime.dispatch(function* (draft: IDialog): IActionGenerator {
			draft.Items.push(
				yield* entity({
					Name: "nested"
				})
			);
		}, component);
		const nested = w.stateOf<IDialog>(component).Items[0]!;
		w.internal.unmountComponent(component);
		await expect(
			w.runtime.dispatch(function* (
				draft: IScreen & {
					Taken?: unknown;
				}
			): IActionGenerator {
				draft.Taken = nested;
			}, "screen")
		).rejects.toThrow(MoveBetweenRootsError);
		expect(JSON.parse(createSnapshot(w.runtime)).AppState.Screen.Taken).toBeUndefined();
		w.runtime.dispose();
	});

	it.each([
		"is unmounted",
		"loses its owner"
	] as const)("refuses a nested entity written into the tree after its only component %s, with no other mount or slot", async (how) => {
		const w = build();
		const component = w.mount(how === "is unmounted" ? undefined : "row-1", dialogSeed());
		await w.runtime.dispatch(function* (draft: IDialog): IActionGenerator {
			draft.Items.push(
				yield* entity({
					Name: "kid"
				})
			);
		}, component);
		const kid = w.stateOf<IDialog>(component).Items[0]!;
		if (how === "is unmounted") {
			w.internal.unmountComponent(component);
		} else {
			await w.runtime.dispatch(function* (draft: IScreen): IActionGenerator {
				draft.Rows.splice(0, 1);
			}, "screen");
		}
		expect(w.internal.resolveCell(component)).toBeUndefined();
		await expect(
			w.runtime.dispatch(function* (
				draft: IScreen & {
					Taken?: unknown;
				}
			): IActionGenerator {
				draft.Taken = kid;
			}, "screen")
		).rejects.toThrow(MoveBetweenRootsError);
		expect(w.internal.get("runtime/writeGateway").rootNameOf(kid.$Id)).toBeUndefined();
		expect(JSON.parse(createSnapshot(w.runtime)).AppState.Screen.Taken).toBeUndefined();
		w.runtime.dispose();
	});

	it("puts a node that left back into its own root", async () => {
		const w = build();
		w.mount("screen", {});
		const back = w.runtime.dispatch(function* (draft: IScreen): IActionGenerator {
			const row = draft.Rows[0]!;
			draft.Rows.splice(0, 1);
			yield* wait("away");
			draft.Rows.push(row);
		}, "screen");
		await settled();
		w.release("away");
		await back;
		expect(w.runtime.state.Screen.Rows.map((r) => r.$Id)).toEqual([
			"row-1"
		]);
		w.runtime.dispose();
	});

	it("refuses a node removed before a wait and written after it into the tree and a slot in one step", async () => {
		const surfaced = captureSurfaced();
		const w = build();
		await w.runtime.dispatch(function* (draft: IScreen): IActionGenerator {
			(
				draft as IScreen & {
					Box?: object;
				}
			).Box = {
				X: 1
			};
			(yield* shelf(draft)).Kept = {
				X: 2
			};
		}, "screen");
		const refused = w.runtime.dispatch(function* (
			draft: IScreen & {
				Box?: object;
				Again?: object;
			}
		): IActionGenerator {
			const slot = yield* shelf(draft);
			const box = draft.Box!;
			delete draft.Box;
			yield* wait("gap");
			draft.Again = box;
			slot.Fresh = {
				Held: box
			};
		}, "screen");
		await settled();
		w.release("gap");
		await expect(refused).rejects.toThrow(MoveBetweenRootsError);
		await settled();
		expect(surfaced.filter((error) => error instanceof StateAliasError)).toEqual([]);
		w.runtime.dispose();
	});

	it.each([
		[
			"AppState",
			"TransientState",
			"screen"
		],
		[
			"TransientState",
			"AppState",
			"screen"
		],
		[
			"ComponentState",
			"TransientState",
			"component"
		],
		[
			"TransientState",
			"ComponentState",
			"component"
		]
	] as const)("refuses a node new in %s in the same step written into %s", async (from, to, owner) => {
		const surfaced = captureSurfaced();
		const w = await crossingWorld();
		const ownerId = owner === "screen" ? "screen" : w.componentId;
		const refused = w.runtime.dispatch(function* (draft: IEntity & IFreshHolder): IActionGenerator {
			const holders = {
				AppState: draft,
				ComponentState: draft,
				TransientState: yield* shelf(draft)
			};
			holders[from].Fresh = {};
			holders[to].Fresh = {
				Held: holders[from].Fresh
			};
		}, ownerId);
		await expect(refused).rejects.toThrow(MoveBetweenRootsError);
		await settled();
		expect(surfaced.filter((error) => error instanceof StateAliasError)).toEqual([]);
		w.runtime.dispose();
	});

	it("takes withoutIds(row), keeps the input across a failed save, and saves back by $Id", async () => {
		const w = build();
		const id = w.mount("screen", dialogSeed());
		function* openFor(draft: IDialog, row: IRow): IActionGenerator {
			draft.EditingId = row.$Id;
			draft.Copy = withoutIds(row);
		}
		await w.runtime.dispatch(openFor, id, w.runtime.state.Screen.Rows[0]!);
		function* edit(draft: IDialog, name: string): IActionGenerator {
			draft.Copy!.Name = name;
		}
		await w.runtime.dispatch(edit, id, "Beta");
		let fail = true;
		function* saveRow(
			draft: IScreen,
			rowId: string,
			value: {
				Name: string;
			}
		): IActionGenerator<
			| {
					Error: string;
			  }
			| undefined
		> {
			yield* wait("api");
			if (fail) {
				return {
					Error: "refused"
				};
			}
			const row = draft.Rows.find((r) => r.$Id === rowId);
			if (row) {
				row.Name = value.Name;
			}
			return undefined;
		}
		const dialog = w.stateOf<IDialog>(id);
		const first = w.runtime.dispatch(saveRow, "screen", dialog.EditingId!, dialog.Copy!);
		await settled();
		w.release("api");
		const outcome = await first;
		function* showError(draft: IDialog, error: string | null): IActionGenerator {
			draft.Error = error;
		}
		await w.runtime.dispatch(showError, id, outcome?.Error ?? null);
		expect(dialog.Error).toBe("refused");
		expect(dialog.Copy?.Name).toBe("Beta");
		expect(w.runtime.state.Screen.Rows[0]!.Name).toBe("Alpha");
		fail = false;
		const second = w.runtime.dispatch(saveRow, "screen", dialog.EditingId!, dialog.Copy!);
		await settled();
		w.release("api");
		expect(await second).toBeUndefined();
		expect(w.runtime.state.Screen.Rows[0]!.Name).toBe("Beta");
		w.runtime.dispose();
	});
});

describe("ComponentState: the tree rule and asks", () => {
	it("refuses an alias inside component state, and undoes the slice", async () => {
		const surfaced = captureSurfaced();
		const w = build();
		const id = w.mount("screen", {
			A: {
				X: 1
			},
			B: null as unknown
		});
		function* alias(draft: { A: object; B: unknown }): IActionGenerator {
			draft.B = draft.A;
		}
		await expect(w.runtime.dispatch(alias, id)).rejects.toThrow(StateAliasError);
		await settled();
		expect(surfaced).toEqual([]);
		expect(w.internal.get("runtime/stateIdLookup")()[id]!.state).toMatchObject({
			B: null
		});
		w.runtime.dispose();
	});

	it("an ask a component entity owns is listed under its owner", async () => {
		const w = build();
		const id = w.mount("screen", dialogSeed());
		function* confirm(draft: IDialog): IOpenGenerator<boolean | undefined> {
			return yield* open(
				ask<boolean>(draft, {
					Path: "Confirm"
				})
			);
		}
		const asking = w.runtime.dispatch(confirm, id);
		await settled();
		expect(pendingAsksOf(w.runtime, w.runtime.state.Screen).map((a) => a.Request)).toEqual([
			{
				Path: "Confirm"
			}
		]);
		w.internal.unmountComponent(id);
		expect(await asking).toBeUndefined();
		expect(pendingAsksOf(w.runtime, w.runtime.state.Screen)).toEqual([]);
		w.runtime.dispose();
	});
});

describe("table and dispose records name their owner's root", () => {
	const Listens = receiver<IEntity>("CsListens")({
		*"Cs/Tick"() {}
	});
	function* times(draft: IEntity): IActionGenerator {
		yield* startTimer(draft, "Cs/Tick", Listens, 60_000);
	}

	function recorded() {
		const w = build();
		const records: IRecord[] = [];
		w.runtime.on("record", (record) => {
			records.push(record);
		});
		w.runtime.registerReceiver(Listens);
		w.runtime.registerResourceType("cs/upload", () => {});
		w.runtime.registerReceiver(Uploads);
		return {
			w,
			records
		};
	}

	it("an AppState action that only starts a timer records its table row as AppState", async () => {
		const { w, records } = recorded();
		await w.runtime.dispatch(times, "screen");
		expect(records.filter((r) => r.Kind === "table")).toEqual([
			expect.objectContaining({
				Table: "timers",
				Root: "AppState"
			})
		]);
		w.runtime.dispose();
	});

	it("records every row a component's unmount retracts, and its dispose, as ComponentState", async () => {
		const { w, records } = recorded();
		const id = w.mount("screen", dialogSeed());
		await w.runtime.dispatch(times, id);
		await w.runtime.dispatch(function* (draft: IDialog): IActionGenerator {
			yield* registerDataSource(draft, "Cs/Source");
			yield* openResource(draft, "Cs/Upload", Uploads, {
				Type: "cs/upload",
				Label: "group"
			});
		}, id);
		await settled();
		records.length = 0;
		w.internal.unmountComponent(id);
		await settled();
		const kinds = records.map((r) => (r.Kind === "table" ? r.Table : r.Kind));
		expect(kinds).toEqual(
			expect.arrayContaining([
				"timers",
				"dataSources",
				"resources",
				"entity:dispose"
			])
		);
		expect(
			records.map(
				(r) =>
					(
						r as {
							Root?: unknown;
						}
					).Root
			)
		).toEqual(records.map(() => "ComponentState"));
		w.runtime.dispose();
	});

	it("names each owner's root on every ordinary removal: a slot entity, a tree row with components under it, and dispose", async () => {
		const { w, records } = recorded();
		const roots: Record<string, string> = {
			root: "AppState",
			screen: "AppState",
			"row-1": "AppState"
		};
		const outer = w.mount("row-1", dialogSeed());
		const inner = w.mount("row-1", dialogSeed());
		const kept = w.mount("screen", dialogSeed());
		roots[outer] = "ComponentState";
		roots[inner] = "ComponentState";
		roots[kept] = "ComponentState";
		const slotIds: string[] = [];
		await w.runtime.dispatch(function* (draft: IScreen): IActionGenerator {
			const slot = yield* transient(draft, "Cs/Owned", {
				Rows: [] as IEntity[]
			});
			for (const name of [
				"leaves",
				"stays"
			]) {
				const made = yield* entity({
					Name: name
				});
				slot.Rows.push(made);
				slotIds.push(idOf(made));
			}
		}, "screen");
		for (const id of slotIds) {
			roots[id] = "TransientState";
		}
		for (const id of Object.keys(roots)) {
			await w.runtime.dispatch(times, id);
		}
		const ownerOf = (r: IRecord): string | undefined =>
			r.Kind === "entity:dispose" ? r.EntityId : r.Kind === "table" && "OwnerId" in r ? r.OwnerId : undefined;
		const removals = (): [
			string,
			unknown
		][] =>
			records
				.filter((r) => r.Kind === "entity:dispose" || (r.Kind === "table" && r.Table === "timers" && r.Value === null))
				.map((r) => [
					ownerOf(r)!,
					(
						r as {
							Root?: unknown;
						}
					).Root
				]);
		const expectRoots = (owners: string[]) => {
			const seen = removals();
			expect(seen.map(([owner]) => owner)).toEqual(expect.arrayContaining(owners));
			expect(seen).toEqual(
				seen.map(([owner]) => [
					owner,
					roots[owner]
				])
			);
			records.length = 0;
		};
		records.length = 0;
		await w.runtime.dispatch(function* (draft: IScreen): IActionGenerator {
			(yield* transient(draft, "Cs/Owned", {
				Rows: [] as IEntity[]
			})).Rows.splice(0, 1);
		}, "screen");
		expectRoots([
			slotIds[0]!
		]);
		await w.runtime.dispatch(function* (draft: IScreen): IActionGenerator {
			draft.Rows.splice(0, 1);
		}, "screen");
		expectRoots([
			"row-1",
			outer,
			inner
		]);
		w.runtime.dispose();
		expectRoots([
			"screen",
			kept,
			slotIds[1]!
		]);
	});
});

describe("an action's records name its root", () => {
	it("on a tree row, a slot's entity and component state, its resource rows included", async () => {
		const w = build();
		const records: IRecord[] = [];
		w.runtime.on("record", (record) => {
			records.push(record);
		});
		w.runtime.registerResourceType("cs/upload", () => {});
		w.runtime.registerReceiver(Uploads);
		const component = w.mount("screen", dialogSeed());
		let slotEntity = "";
		await w.runtime.dispatch(function* (draft: IScreen): IActionGenerator {
			const kept = yield* entity({
				Name: "in a slot"
			});
			(yield* transient(draft, "Cs/Kept", {
				Rows: [] as IEntity[]
			})).Rows.push(kept);
			slotEntity = idOf(kept);
		}, "screen");
		function* works(
			draft: IEntity & {
				Seen?: boolean;
			}
		): IActionGenerator {
			draft.Seen = true;
			yield* openResource(draft as unknown as IDialog, "Cs/Upload", Uploads, {
				Type: "cs/upload",
				Label: "group"
			});
		}
		const roots: Record<string, unknown[]> = {};
		for (const [id, expected] of [
			[
				"row-1",
				"AppState"
			],
			[
				slotEntity,
				"TransientState"
			],
			[
				component,
				"ComponentState"
			]
		] as const) {
			records.length = 0;
			await w.runtime.dispatch(works, id);
			await settled();
			const actionId = (
				records.find((r) => r.Kind === "action:start") as {
					ActionId: string;
				}
			).ActionId;
			const own = records.filter((r) => ("ActionId" in r && r.ActionId === actionId) || (r.Kind === "table" && r.Table === "resources"));
			expect(own.map((r) => r.Kind)).toEqual(
				expect.arrayContaining([
					"action:start",
					"step",
					"effect",
					"action:end",
					"table"
				])
			);
			roots[expected] = [
				...new Set(
					own.map(
						(r) =>
							(
								r as {
									Root?: unknown;
								}
							).Root
					)
				)
			];
		}
		expect(roots).toEqual({
			AppState: [
				"AppState"
			],
			TransientState: [
				"TransientState"
			],
			ComponentState: [
				"ComponentState"
			]
		});
		w.runtime.dispose();
	});
});

describe("ComponentState: never saved", () => {
	it("a snapshot's in-flight index leaves out work on a slot's entity and on component state alike", async () => {
		const w = build();
		const component = w.mount("screen", dialogSeed());
		let slotEntity = "";
		await w.runtime.dispatch(function* (draft: IScreen): IActionGenerator {
			const kept = yield* entity({
				Name: "in a slot"
			});
			(yield* transient(draft, "Cs/Kept", {
				Rows: [] as IEntity[]
			})).Rows.push(kept);
			slotEntity = idOf(kept);
		}, "screen");
		function* waits(_draft: IEntity, name: string): IActionGenerator {
			yield* wait(name);
		}
		const onScreen = w.runtime.dispatch(waits, "row-1", "tree");
		const onSlot = w.runtime.dispatch(waits, slotEntity, "slot");
		const onComponent = w.runtime.dispatch(waits, component, "component");
		await settled();
		expect(JSON.parse(createSnapshot(w.runtime)).InFlight.map((row: { EntityId: string }) => row.EntityId)).toEqual([
			"row-1"
		]);
		for (const name of [
			"tree",
			"slot",
			"component"
		]) {
			w.release(name);
		}
		await Promise.all([
			onScreen,
			onSlot,
			onComponent
		]);
		w.runtime.dispose();
	});

	it("a snapshot carries no component state, its rows or its in-flight work, and a restore leaves nothing dangling", async () => {
		const w = build();
		w.runtime.registerResourceType("cs/upload", () => {});
		w.runtime.registerReceiver(Uploads);
		const id = w.mount("screen", dialogSeed());
		function* startUpload(draft: IDialog): IActionGenerator {
			yield* openResource(draft, "Cs/Upload", Uploads, {
				Type: "cs/upload",
				Label: "group"
			});
			yield* wait("upload");
		}
		void w.runtime.dispatch(startUpload, id);
		await settled();
		const envelope = JSON.parse(createSnapshot(w.runtime));
		expect(JSON.stringify(envelope)).not.toContain(id);
		expect(envelope.Resources).toEqual([]);
		expect(envelope.InFlight).toEqual([]);
		const { runtime: restored, result } = await restoreRuntime<IRoot>(createSnapshot(w.runtime), {
			rootId: "root",
			options: {},
			setup: (runtime) => runtime.registerReceiver(Uploads)
		});
		const internal = restored as IRuntimeInternal<IRoot>;
		expect(internal.resolveCell(id)).toBeUndefined();
		expect(restored.resources()).toEqual([]);
		expect(result.dropped).toEqual([]);
		const again = mountComponent(restored, "screen", dialogSeed());
		expect(internal.resolveCell(again)).toBeDefined();
		restored.dispose();
		w.runtime.dispose();
	});
});
