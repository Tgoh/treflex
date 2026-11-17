import type { JSX } from "solid-js";
import type { IActionGenerator, IAskId, IEntity, IOpenGenerator, IResourceContext } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import {
	createEffect,
	createRenderEffect,
	createResource,
	createRoot,
	createSignal,
	For,
	Index,
	on,
	Show,
	Suspense,
	startTransition
} from "solid-js";
import { answer, ask, createRuntime, entity, latest, open, openResource, withoutIds } from "treflex";
import { createSnapshot, restoreRuntime } from "treflex/snapshot";
import { describe, expect, it } from "vitest";
import { createComponentFeature } from "../src/Context/createComponentFeature";
import { createEntityFeature } from "../src/Context/createEntityFeature";
import { TreflexProvider } from "../src/Context/TreflexContext";
import { useComponentState } from "../src/Hooks/useComponentState";
import { inFlightOf, pendingAsksOf } from "./treeWrite";

declare module "treflex" {
	interface IResourceTypeRegistry {
		"spike/objectUrl": {
			Params: {};
		};
		"spike/uploadGroup": {
			Params: {};
		};
	}
	interface IResourceRegistry {
		"Spike/Url": {
			Type: "spike/objectUrl";
		};
		"Spike/Uploads": {
			Type: "spike/uploadGroup";
		};
	}
}

interface IRow extends IEntity {
	Name: string;
	BlobGuid: string;
}

interface IScreen extends IEntity {
	Rows: IRow[];
	Query: {
		Page: number;
	};
	Log: string[];
}

interface IRoot extends IEntity {
	Screen: IScreen;
}

const seed = (): IRoot => ({
	$Id: "root",
	Screen: {
		$Id: "screen",
		Rows: [
			{
				$Id: "row-1",
				Name: "Alpha",
				BlobGuid: "g1"
			},
			{
				$Id: "row-2",
				Name: "Beta",
				BlobGuid: "g2"
			}
		],
		Query: {
			Page: 1
		},
		Log: []
	}
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function world(state: IRoot = seed()) {
	const runtime = createRuntime<IRoot>(state, {
		onError: () => {}
	});
	const internal = runtime as IRuntimeInternal<IRoot>;
	const waits = new Map<string, (value?: unknown) => void>();
	const asked: string[] = [];
	runtime.registerImplementation(
		"spike/wait",
		(effect: { Type: string; Name: string }) =>
			new Promise((resolve) => {
				asked.push(effect.Name);
				waits.set(effect.Name, resolve);
			})
	);
	const release = (name: string, value?: unknown) => {
		const resolve = waits.get(name);
		if (!resolve) {
			throw new Error(`nothing waits on "${name}"`);
		}
		waits.delete(name);
		resolve(value);
	};
	const urls = {
		opened: 0,
		closed: 0
	};
	runtime.registerResourceType("spike/objectUrl", (_params, ctx: IResourceContext<"spike/objectUrl">) => {
		urls.opened++;
		ctx.signal.addEventListener("abort", () => urls.closed++);
	});
	const uploads = {
		opened: 0,
		closed: 0
	};
	runtime.registerResourceType("spike/uploadGroup", (_params, ctx: IResourceContext<"spike/uploadGroup">) => {
		uploads.opened++;
		ctx.signal.addEventListener("abort", () => uploads.closed++);
	});
	return {
		runtime,
		internal,
		release,
		waits,
		asked,
		urls,
		uploads,
		pathOf: (id: string) => internal.get("runtime/stateIdLookup")()[id]?.path,
		componentIds: () => {
			const lookup = internal.get("runtime/stateIdLookup")();
			return Object.keys(lookup).filter((id) => internal.get("runtime/writeGateway").rootNameOf(id) === "ComponentState");
		}
	};
}

function* wait(name: string): Generator<any, any, any> {
	return yield {
		Type: "spike/wait",
		Name: name
	};
}

const RowFeature = createEntityFeature<IRow>("tests/spike/Row")({});

// BlobImage's shape: state at first render, a load with async work, and an object URL
// resource the component entity owns.
interface IBlobImage extends IEntity {
	BlobGuid: string;
	Url: string | undefined;
}

function* loadImage(draft: IBlobImage, guid: string): IActionGenerator {
	draft.BlobGuid = guid;
	const bytes: string = yield* wait(`blob:${guid}`);
	if (draft.BlobGuid !== guid) {
		return;
	}
	yield* openResource(draft, "Spike/Url", {
		Type: "spike/objectUrl"
	});
	draft.Url = `blob:${bytes}`;
}

function blobImageWorld(loader: typeof loadImage) {
	const w = world();
	const BlobImageFeature = createComponentFeature<IBlobImage>()({
		loadImage: loader
	});
	const firstRender: (string | undefined)[] = [];
	let ctx!: ReturnType<typeof BlobImageFeature.use>;
	const [guid, setGuid] = createSignal("g1");
	const [shown, setShown] = createSignal(true);
	const BlobImage = BlobImageFeature.provider(
		() => {
			ctx = BlobImageFeature.use();
			firstRender.push(ctx.state.$Id, ctx.state.BlobGuid);
			createEffect(
				on(guid, (g) => {
					ctx.loadImage(g).catch(() => {});
				})
			);
			return null;
		},
		() => ({
			BlobGuid: "",
			Url: undefined
		})
	);
	const Row = RowFeature.provider(() => <Show when={shown()}>{<BlobImage />}</Show>);
	const dispose = createRoot((disposer) => {
		TreflexProvider({
			value: w.runtime,
			get children() {
				return <Row state={w.runtime.state.Screen.Rows[0]!} />;
			}
		});
		return disposer;
	});
	return {
		...w,
		firstRender,
		ctx: () => ctx,
		setGuid,
		setShown,
		dispose
	};
}

describe("a BlobImage-shaped widget on ComponentState", () => {
	it("has its state at first render, mounted under the row it renders in", () => {
		const w = blobImageWorld(loadImage);
		const [id, guid] = w.firstRender;
		expect(guid).toBe("");
		expect(w.pathOf(id!)).toEqual([
			"root",
			"screen",
			"row-1",
			id
		]);
		expect((w.ctx() as unknown as Record<string, unknown>).setState).toBeUndefined();
		w.dispose();
		w.runtime.dispose();
	});

	it("loads, owns the URL resource, and unmount releases it and ends a load in flight", async () => {
		const w = blobImageWorld(loadImage);
		await settle();
		w.release("blob:g1", "bytes1");
		await settle();
		expect(w.ctx().state.Url).toBe("blob:bytes1");
		expect(w.urls).toEqual({
			opened: 1,
			closed: 0
		});
		w.setGuid("g2");
		await settle();
		const id = w.ctx().state.$Id;
		w.setShown(false);
		await settle();
		expect(w.urls.closed).toBe(1);
		expect(w.internal.resolveCell(id)).toBeUndefined();
		expect(w.runtime.resources()).toEqual([]);
		w.release("blob:g2", "late");
		await settle();
		expect(w.urls.opened).toBe(1);
		w.dispose();
		w.runtime.dispose();
	});

	it("holds: a guid change during a load queues the next load behind it", async () => {
		const w = blobImageWorld(loadImage);
		await settle();
		w.setGuid("g2");
		await settle();
		expect(w.asked).toEqual([
			"blob:g1"
		]);
		expect(inFlightOf(w.runtime, loadImage, w.ctx().state)).toBe(true);
		w.release("blob:g1", "bytes1");
		await settle();
		expect(w.asked).toEqual([
			"blob:g1",
			"blob:g2"
		]);
		w.release("blob:g2", "bytes2");
		await settle();
		expect(w.ctx().state.Url).toBe("blob:bytes2");
		w.dispose();
		w.runtime.dispose();
	});

	it("with latest(), a guid change stops the load in flight and starts the next at once", async () => {
		const latestLoad = latest(loadImage);
		const w = blobImageWorld(latestLoad);
		await settle();
		w.setGuid("g2");
		await settle();
		expect(w.asked).toEqual([
			"blob:g1",
			"blob:g2"
		]);
		w.release("blob:g2", "bytes2");
		await settle();
		expect(w.ctx().state.Url).toBe("blob:bytes2");
		w.dispose();
		w.runtime.dispose();
	});

	it("goes with its owner: removing the row ends it before the view unmounts it", async () => {
		const w = world();
		const Image = createComponentFeature<IBlobImage>()({
			loadImage
		});
		const ids: string[] = [];
		const Body = Image.provider(
			() => {
				const ctx = Image.use();
				ids.push(ctx.state.$Id);
				void ctx.loadImage("g").catch(() => {});
				return null;
			},
			() => ({
				BlobGuid: "",
				Url: undefined
			})
		);
		const Row = RowFeature.provider(() => <Body />);
		const dispose = createRoot((disposer) => {
			TreflexProvider({
				value: w.runtime,
				get children() {
					return <For each={w.runtime.state.Screen.Rows}>{(row) => <Row state={row} />}</For>;
				}
			});
			return disposer;
		});
		await settle();
		expect(w.componentIds()).toHaveLength(2);
		function* removeFirst(draft: IScreen): IActionGenerator {
			draft.Rows.splice(0, 1);
		}
		await w.runtime.dispatch(removeFirst, "screen");
		await settle();
		expect(w.internal.resolveCell(ids[0]!)).toBeUndefined();
		expect(w.componentIds()).toEqual([
			ids[1]
		]);
		dispose();
		expect(w.componentIds()).toEqual([]);
		w.runtime.dispose();
	});
});

// Case 1 of dialogs-are-components.md, Agency/EditCommission's shape.
interface IEditing extends IEntity {
	EditingId: string | null;
}

interface IDialog extends IEntity {
	Copy: {
		Name: string;
		BlobGuid: string;
	};
	Error: string | null;
	Staged: string[];
}

function* longRefresh(draft: IScreen): IActionGenerator {
	yield* wait("refresh");
	draft.Log.push("refreshed");
}

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
	const outcome: string = yield* wait("api");
	if (outcome === "refused") {
		return {
			Error: "The name is taken."
		};
	}
	const row = draft.Rows.find((r) => r.$Id === rowId);
	if (row) {
		row.Name = value.Name;
	}
	return undefined;
}

function* setEditing(draft: IEditing, id: string | null): IActionGenerator {
	draft.EditingId = id;
}

function* typeName(draft: IDialog, name: string): IActionGenerator {
	draft.Copy.Name = name;
}

function* showOutcome(draft: IDialog, error: string | null): IActionGenerator {
	draft.Error = error;
}

function* stageUpload(draft: IDialog, file: string): IActionGenerator {
	if (draft.Staged.length === 0) {
		yield* openResource(draft, "Spike/Uploads", {
			Type: "spike/uploadGroup"
		});
	}
	yield* wait(`upload:${file}`);
	draft.Staged.push(file);
}

function* stageUploadOpen(draft: IDialog, file: string): IOpenGenerator {
	if (draft.Staged.length === 0) {
		yield* openResource(draft, "Spike/Uploads", {
			Type: "spike/uploadGroup"
		});
	}
	yield* open(wait(`upload:${file}`));
	draft.Staged.push(file);
}

function dialogWorld() {
	const w = world();
	const ScreenFeature = createEntityFeature<IScreen>("tests/spike/Screen")({
		longRefresh,
		saveRow
	});
	type IDialogApi = {
		state: IDialog;
		dispatch: ReturnType<typeof useComponentState<IDialog>>["dispatch"];
		ok: () => Promise<void>;
	};
	let screen!: ReturnType<typeof ScreenFeature.use>;
	let editing!: ReturnType<typeof useComponentState<IEditing>>;
	let dialog: IDialogApi | null = null;
	const renders: string[] = [];

	const EditDialog = (props: {
		row: IRow;
		save: (value: IDialog["Copy"]) => Promise<
			| {
					Error: string;
			  }
			| undefined
		>;
		close: () => void;
	}) => {
		const local = useComponentState<IDialog>(() => ({
			Copy: withoutIds({
				Name: props.row.Name,
				BlobGuid: props.row.BlobGuid
			}),
			Error: null,
			Staged: []
		}));
		renders.push(`dialog:${local.state.Copy.Name}`);
		dialog = {
			state: local.state,
			dispatch: local.dispatch,
			ok: async () => {
				const outcome = await props.save(local.state.Copy);
				if (outcome) {
					await local.dispatch(showOutcome, outcome.Error);
					return;
				}
				props.close();
			}
		};
		return null;
	};

	const Screen = ScreenFeature.provider(() => {
		screen = ScreenFeature.use();
		editing = useComponentState<IEditing>(() => ({
			EditingId: null
		}));
		const row = () => screen.state.Rows.find((r) => r.$Id === editing.state.EditingId);
		return (
			<Show when={row()}>
				{(r) => (
					<EditDialog
						row={r()}
						save={(value) => screen.saveRow(r().$Id, value)}
						close={() => {
							void editing.dispatch(setEditing, null);
						}}
					/>
				)}
			</Show>
		);
	});
	const dispose = createRoot((disposer) => {
		TreflexProvider({
			value: w.runtime,
			get children() {
				return <Screen state={w.runtime.state.Screen} />;
			}
		});
		return disposer;
	});
	return {
		...w,
		screen: () => screen,
		editing: () => editing,
		dialog: () => dialog,
		closeDialogRef: () => {
			dialog = null;
		},
		renders,
		dispose
	};
}

describe("a dialog as a component (dialogs-are-components.md, case 1)", () => {
	it("opens through a component-state write that doesn't queue behind the held screen", async () => {
		const w = dialogWorld();
		const refreshing = w.screen().longRefresh();
		expect(inFlightOf(w.runtime, longRefresh, w.screen().state)).toBe(true);
		void w.editing().dispatch(setEditing, "row-1");
		expect(w.dialog()?.state.Copy.Name).toBe("Alpha");
		expect(w.pathOf(w.dialog()!.state.$Id)).toEqual([
			"root",
			"screen",
			w.dialog()!.state.$Id
		]);
		expect(w.pathOf(w.editing().id)).toEqual([
			"root",
			"screen",
			w.editing().id
		]);
		w.release("refresh");
		await refreshing;
		w.dispose();
		w.runtime.dispose();
	});

	it("keeps the copy apart from the live row, keeps the mount and the input across a failed save, and saves on retry", async () => {
		const w = dialogWorld();
		void w.editing().dispatch(setEditing, "row-1");
		const dialog = w.dialog()!;
		await dialog.dispatch(typeName, "Gamma");
		expect(w.runtime.state.Screen.Rows[0]!.Name).toBe("Alpha");
		const first = dialog.ok();
		await settle();
		expect(inFlightOf(w.runtime, saveRow, w.screen().state)).toBe(true);
		await dialog.dispatch(typeName, "Gamma!");
		expect(dialog.state.Copy.Name).toBe("Gamma!");
		w.release("api", "refused");
		await first;
		expect(w.dialog()).toBe(dialog);
		expect(dialog.state.Error).toBe("The name is taken.");
		expect(dialog.state.Copy.Name).toBe("Gamma!");
		const second = dialog.ok();
		await settle();
		w.release("api", "ok");
		await second;
		await settle();
		expect(w.runtime.state.Screen.Rows[0]!.Name).toBe("Gamma!");
		expect(w.internal.resolveCell(dialog.state.$Id)).toBeUndefined();
		expect(w.componentIds()).toEqual([
			w.editing().id
		]);
		w.dispose();
		w.runtime.dispose();
	});

	it("an OK that arrives while the screen is held queues there, and the dialog stays editable", async () => {
		const w = dialogWorld();
		const refreshing = w.screen().longRefresh();
		void w.editing().dispatch(setEditing, "row-1");
		const dialog = w.dialog()!;
		const saving = dialog.ok();
		await settle();
		expect(w.asked).toEqual([
			"refresh"
		]);
		await dialog.dispatch(typeName, "Typed while queued");
		expect(dialog.state.Copy.Name).toBe("Typed while queued");
		w.release("refresh");
		await settle();
		w.release("api", "ok");
		await saving;
		expect(w.runtime.state.Screen.Rows[0]!.Name).toBe("Alpha");
		await refreshing;
		w.dispose();
		w.runtime.dispose();
	});

	it("the dialog's own upload holds the dialog, so typing queues behind it unless the wait is open", async () => {
		const w = dialogWorld();
		void w.editing().dispatch(setEditing, "row-1");
		const dialog = w.dialog()!;
		const uploading = dialog.dispatch(stageUpload, "a.pdf");
		const typing = dialog.dispatch(typeName, "During upload");
		await settle();
		expect(dialog.state.Copy.Name).toBe("Alpha");
		w.release("upload:a.pdf");
		await uploading;
		await typing;
		expect(dialog.state.Copy.Name).toBe("During upload");
		const openUpload = dialog.dispatch(stageUploadOpen, "b.pdf");
		await dialog.dispatch(typeName, "During open upload");
		expect(dialog.state.Copy.Name).toBe("During open upload");
		w.release("upload:b.pdf");
		await openUpload;
		expect(dialog.state.Staged).toEqual([
			"a.pdf",
			"b.pdf"
		]);
		w.dispose();
		w.runtime.dispose();
	});

	it("unmount drops the copy, the error, a staged upload group and an upload in flight", async () => {
		const w = dialogWorld();
		void w.editing().dispatch(setEditing, "row-1");
		const dialog = w.dialog()!;
		await dialog.dispatch(showOutcome, "kept until unmount");
		const uploading = dialog.dispatch(stageUploadOpen, "a.pdf");
		await settle();
		expect(w.uploads.opened).toBe(1);
		await w.editing().dispatch(setEditing, null);
		await settle();
		expect(await uploading).toBeUndefined();
		expect(w.uploads.closed).toBe(1);
		expect(w.internal.resolveCell(dialog.state.$Id)).toBeUndefined();
		expect(w.runtime.resources()).toEqual([]);
		w.dispose();
		w.runtime.dispose();
	});
});

interface IGrid extends IEntity {
	Page: number;
	Filter: string;
}

describe("a grid's query in component state (question 7)", () => {
	it("comes back at its defaults after a restore, while the screen's stored query comes back as saved", async () => {
		const Grid = createComponentFeature<IGrid>()({
			*setPage(draft: IGrid, page: number): IActionGenerator {
				draft.Page = page;
			}
		});
		function* storePage(draft: IScreen, page: number): IActionGenerator {
			draft.Query.Page = page;
		}
		const mountGrid = (runtime: ReturnType<typeof createRuntime<IRoot>>) => {
			let grid!: ReturnType<typeof Grid.use>;
			const Body = Grid.provider(
				() => {
					grid = Grid.use();
					return null;
				},
				() => ({
					Page: 1,
					Filter: ""
				})
			);
			const Screen = createEntityFeature<IScreen>()({}).provider(() => <Body />);
			const dispose = createRoot((disposer) => {
				TreflexProvider({
					value: runtime,
					get children() {
						return <Screen state={runtime.state.Screen} />;
					}
				});
				return disposer;
			});
			return {
				grid: () => grid,
				dispose
			};
		};
		const w = world();
		const first = mountGrid(w.runtime);
		await first.grid().setPage(3);
		await w.runtime.dispatch(storePage, "screen", 3);
		const snapshot = createSnapshot(w.runtime);
		first.dispose();
		w.runtime.dispose();
		const { runtime } = await restoreRuntime<IRoot>(snapshot, {
			rootId: "root",
			options: {}
		});
		const second = mountGrid(runtime);
		expect(runtime.state.Screen.Query.Page).toBe(3);
		expect(second.grid().state.Page).toBe(1);
		second.dispose();
		runtime.dispose();
	});
});

describe("nested component entities", () => {
	it("mount beside the component provider above them, under its tree owner, and an init action adds nested entities", async () => {
		const w = world();
		const Outer = createComponentFeature<
			IEntity & {
				Items: IEntity[];
			}
		>()({
			*init(
				draft: IEntity & {
					Items: IEntity[];
				}
			): IActionGenerator {
				draft.Items.push(
					yield* entity({
						Name: "nested"
					})
				);
			}
		});
		let outer!: ReturnType<typeof Outer.use>;
		let inner!: ReturnType<typeof useComponentState<IEntity>>;
		const Inner = () => {
			inner = useComponentState<IEntity>(() => ({}));
			return null;
		};
		const Body = Outer.provider(
			() => {
				outer = Outer.use();
				return <Inner />;
			},
			() => ({
				Items: []
			})
		);
		const dispose = createRoot((disposer) => {
			TreflexProvider({
				value: w.runtime,
				get children() {
					return <Body />;
				}
			});
			return disposer;
		});
		await outer.init();
		const nested = outer.state.Items[0]!;
		expect(w.pathOf(nested.$Id)).toEqual([
			"root",
			outer.state.$Id,
			nested.$Id
		]);
		expect(w.pathOf(inner.id)).toEqual([
			"root",
			inner.id
		]);
		dispose();
		expect(w.componentIds()).toEqual([]);
		w.runtime.dispose();
	});

	it("put a widget under a tree provider over a component's nested entity beneath the nearest tree owner", async () => {
		const w = world();
		type IItem = IEntity & {
			Label: string;
		};
		type IList = IEntity & {
			Item: IItem | null;
		};
		function* makeItem(draft: IList): IActionGenerator {
			draft.Item = yield* entity<IItem>({
				Label: "item"
			});
		}
		const ItemFeature = createEntityFeature<IItem>("tests/spike/NestedItem")({});
		let list!: ReturnType<typeof useComponentState<IList>>;
		let inner: ReturnType<typeof useComponentState<IEntity>> | undefined;
		const Inner = () => {
			inner = useComponentState<IEntity>(() => ({}));
			return null;
		};
		const ItemView = ItemFeature.provider(() => <Inner />);
		const List = () => {
			list = useComponentState<IList>(() => ({
				Item: null
			}));
			return <Show when={list.state.Item}>{(item) => <ItemView state={item()} />}</Show>;
		};
		const Row = RowFeature.provider(() => <List />);
		const row = w.runtime.state.Screen.Rows[0]!;
		const dispose = createRoot((disposer) => {
			const rendered = TreflexProvider({
				value: w.runtime,
				get children() {
					return <Row state={row} />;
				}
			});
			createRenderEffect(() => (typeof rendered === "function" ? (rendered as () => unknown)() : rendered));
			return disposer;
		});
		await list.dispatch(makeItem);
		const itemId = list.state.Item!.$Id;
		expect(w.internal.get("runtime/writeGateway").rootNameOf(itemId)).toBe("ComponentState");
		expect(inner).toBeDefined();
		expect(w.pathOf(inner!.id)).toEqual([
			"root",
			"screen",
			"row-1",
			inner!.id
		]);
		dispose();
		expect(w.componentIds()).toEqual([]);
		w.runtime.dispose();
	});
});

describe("mounting and Solid's ownership", () => {
	function* bump(
		draft: IEntity & {
			Count: number;
		}
	): IActionGenerator {
		draft.Count++;
	}

	it("under a provider whose entity is gone, mounts nothing and renders the factory's values", async () => {
		const w = world();
		let widget!: ReturnType<
			typeof useComponentState<
				IEntity & {
					Count: number;
				}
			>
		>;
		const Widget = () => {
			widget = useComponentState(() => ({
				Count: 3
			}));
			return null;
		};
		const Row = RowFeature.provider(() => <Widget />);
		const dispose = createRoot((disposer) => {
			TreflexProvider({
				value: w.runtime,
				get children() {
					return (
						<Row
							state={{
								$Id: "gone",
								Name: "",
								BlobGuid: ""
							}}
						/>
					);
				}
			});
			return disposer;
		});
		expect(widget.state.Count).toBe(3);
		expect(w.componentIds()).toEqual([]);
		await expect(widget.dispatch(bump)).rejects.toThrow(/no entity/);
		expect(() => dispose()).not.toThrow();
		w.runtime.dispose();
	});

	it("mounts a fresh entity when the computation that owns it re-runs, and drops the old one", () => {
		const w = world();
		const ids: string[] = [];
		const [key, setKey] = createSignal(1);
		const Widget = () => {
			ids.push(
				useComponentState(() => ({
					Count: 0
				})).id
			);
			return null;
		};
		const dispose = createRoot((disposer) => {
			const rendered = TreflexProvider({
				value: w.runtime,
				get children() {
					return (
						<Show when={key() === 1} fallback={<Widget />}>
							<Widget />
						</Show>
					);
				}
			});
			createRenderEffect(() => (typeof rendered === "function" ? (rendered as () => unknown)() : rendered));
			return disposer;
		});
		expect(w.componentIds()).toEqual([
			ids[0]
		]);
		setKey(2);
		expect(ids).toHaveLength(2);
		expect(w.componentIds()).toEqual([
			ids[1]
		]);
		dispose();
		expect(w.componentIds()).toEqual([]);
		w.runtime.dispose();
	});
});

describe("a provider reused for another entity", () => {
	type IWidget = IEntity & {
		Count: number;
	};
	type IHandle = ReturnType<typeof useComponentState<IWidget>>;
	function* bump(draft: IWidget): IActionGenerator {
		draft.Count++;
	}
	function* removeRow1(draft: IScreen): IActionGenerator {
		draft.Rows = draft.Rows.filter((row) => row.$Id !== "row-1");
	}
	function* addRow(draft: IScreen): IActionGenerator {
		draft.Rows.push(
			yield* entity({
				Name: "Gamma",
				BlobGuid: "g3"
			})
		);
	}

	type IRowView = (props: { state: IRow; index: number }) => JSX.Element;
	function mountRows(w: ReturnType<typeof world>, view: (Row: IRowView) => JSX.Element) {
		const handles: IHandle[] = [];
		const Widget = (props: { index: number }) => {
			handles[props.index] = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return null;
		};
		const Row = RowFeature.provider((props: { index: number }) => <Widget index={props.index} />);
		const dispose = createRoot((disposer) => {
			const rendered = TreflexProvider({
				value: w.runtime,
				get children() {
					return view(Row as unknown as IRowView);
				}
			});
			createRenderEffect(() => (typeof rendered === "function" ? (rendered as () => unknown)() : rendered));
			return disposer;
		});
		return {
			handles,
			dispose
		};
	}

	it("moves the state under the new entity, keeps it working, and outlives the old one", async () => {
		const w = world();
		const [row, setRow] = createSignal<IRow>(w.runtime.state.Screen.Rows[0]!);
		const { handles, dispose } = mountRows(w, (Row) => <Row state={row()} index={0} />);
		const widget = handles[0]!;
		await widget.dispatch(bump);
		const id = widget.id;
		setRow(w.runtime.state.Screen.Rows[1]!);
		expect(widget.id).toBe(id);
		expect(w.pathOf(id)).toEqual([
			"root",
			"screen",
			"row-2",
			id
		]);
		expect(widget.state.Count).toBe(1);
		await w.runtime.dispatch(removeRow1, "screen");
		await widget.dispatch(bump);
		expect(widget.state.Count).toBe(2);
		expect(w.componentIds()).toEqual([
			id
		]);
		dispose();
		expect(w.componentIds()).toEqual([]);
		w.runtime.dispose();
	});

	it("in an <Index>, keeps the first position working when the first row is removed", async () => {
		const w = world();
		const { handles, dispose } = mountRows(w, (Row) => (
			<Index each={w.runtime.state.Screen.Rows}>{(row, index) => <Row state={row()} index={index} />}</Index>
		));
		await w.runtime.dispatch(removeRow1, "screen");
		const widget = handles[0]!;
		expect(w.pathOf(widget.id)).toEqual([
			"root",
			"screen",
			"row-2",
			widget.id
		]);
		await widget.dispatch(bump);
		expect(widget.state.Count).toBe(1);
		expect(w.componentIds()).toEqual([
			widget.id
		]);
		dispose();
		expect(w.componentIds()).toEqual([]);
		w.runtime.dispose();
	});

	it("stays under the shown row while a transition to another is pending, answers its ask, and moves at commit", async () => {
		const w = world();
		const [row, setRow] = createSignal<IRow>(w.runtime.state.Screen.Rows[0]!);
		let finish = () => {};
		const [detail] = createResource(
			() => row().$Id,
			(id) =>
				id === "row-2"
					? new Promise<string>((resolve) => {
							finish = () => resolve(id);
						})
					: id
		);
		const Detail = () => (() => detail()) as unknown as JSX.Element;
		const { handles, dispose } = mountRows(w, (Row) => (
			<Suspense fallback="loading">
				<Row state={row()} index={0} />
				<Detail />
			</Suspense>
		));
		const widget = handles[0]!;
		const id = widget.id;
		await widget.dispatch(bump);
		const committed = startTransition(() => setRow(w.runtime.state.Screen.Rows[1]!));
		await settle();
		expect(w.pathOf(id)).toEqual([
			"root",
			"screen",
			"row-1",
			id
		]);
		function* asksOnRow(draft: IRow): IOpenGenerator<string | undefined> {
			return yield* open(
				ask<string>(draft, {
					Path: "Row"
				})
			);
		}
		function* answers(_draft: IEntity, askId: IAskId<string>): IActionGenerator {
			yield* answer(askId, "yes");
		}
		const asking = w.runtime.dispatch(asksOnRow, "row-1");
		await settle();
		const entry = pendingAsksOf(w.runtime, w.runtime.state.Screen.Rows[0]!)[0]!;
		await widget.dispatch(answers as never, entry.Id as IAskId<string>);
		await expect(asking).resolves.toBe("yes");
		finish();
		await committed;
		await settle();
		expect(widget.id).toBe(id);
		expect(w.pathOf(id)).toEqual([
			"root",
			"screen",
			"row-2",
			id
		]);
		expect(widget.state.Count).toBe(1);
		dispose();
		w.runtime.dispose();
	});

	it("in an unkeyed <Show>, moves the state to a new entity that replaces the old one", async () => {
		const w = world();
		const [shown, setShown] = createSignal<IRow | undefined>(w.runtime.state.Screen.Rows[0]);
		const { handles, dispose } = mountRows(w, (Row) => <Show when={shown()}>{(row) => <Row state={row()} index={0} />}</Show>);
		const widget = handles[0]!;
		const id = widget.id;
		await widget.dispatch(bump);
		await w.runtime.dispatch(addRow, "screen");
		const added = w.runtime.state.Screen.Rows[2]!;
		setShown(added);
		expect(handles[0]).toBe(widget);
		expect(w.pathOf(id)).toEqual([
			"root",
			"screen",
			added.$Id,
			id
		]);
		await w.runtime.dispatch(removeRow1, "screen");
		await widget.dispatch(bump);
		expect(widget.state.Count).toBe(2);
		dispose();
		expect(w.componentIds()).toEqual([]);
		w.runtime.dispose();
	});

	it("renders the factory's values when the provider switches to an owner already gone", async () => {
		const w = world();
		const [row, setRow] = createSignal<IRow>(w.runtime.state.Screen.Rows[0]!);
		const { handles, dispose } = mountRows(w, (Row) => <Row state={row()} index={0} />);
		const widget = handles[0]!;
		await widget.dispatch(bump);
		expect(widget.state.Count).toBe(1);
		setRow({
			$Id: "gone",
			Name: "",
			BlobGuid: ""
		});
		expect(widget.state.Count).toBe(0);
		expect(w.componentIds()).toEqual([]);
		await expect(widget.dispatch(bump)).rejects.toThrow(/no entity/);
		dispose();
		w.runtime.dispose();
	});

	it("starts fresh when, while the boundary is hidden, the owner goes and the provider then switches", async () => {
		const w = world();
		const [row, setRow] = createSignal<IRow>(w.runtime.state.Screen.Rows[0]!);
		const [gate, setGate] = createSignal(0);
		let resume = () => {};
		const [held] = createResource(gate, (n) =>
			n === 0
				? n
				: new Promise<number>((resolve) => {
						resume = () => resolve(n);
					})
		);
		const Hold = () => (() => held()) as unknown as JSX.Element;
		const { handles, dispose } = mountRows(w, (Row) => (
			<Suspense fallback="loading">
				<Row state={row()} index={0} />
				<Hold />
			</Suspense>
		));
		const widget = handles[0]!;
		const first = widget.id;
		await widget.dispatch(bump);
		setGate(1);
		await settle();
		await w.runtime.dispatch(removeRow1, "screen");
		setRow(w.runtime.state.Screen.Rows[0]!);
		resume();
		await settle();
		expect(widget.id).not.toBe(first);
		expect(widget.state.Count).toBe(0);
		expect(w.pathOf(widget.id)).toEqual([
			"root",
			"screen",
			"row-2",
			widget.id
		]);
		dispose();
		w.runtime.dispose();
	});

	it("starts a dispatch left over from the unmount, then stops it and leaves nothing seated", async () => {
		const w = world();
		function* hangs(draft: IWidget): IActionGenerator {
			draft.Count++;
			yield* wait("left over");
		}
		const Panel = createComponentFeature<IWidget>()({
			hangs
		});
		let panel!: ReturnType<typeof Panel.use>;
		const PanelView = Panel.provider(
			() => {
				panel = Panel.use();
				return null;
			},
			() => ({
				Count: 0
			})
		);
		const { handles, dispose } = mountRows(w, (Row) => (
			<>
				<Row state={w.runtime.state.Screen.Rows[0]!} index={0} />
				<PanelView />
			</>
		));
		const widget = handles[0]!;
		const featureId = panel.state.$Id;
		dispose();
		expect(w.componentIds()).toEqual([]);
		const fromHook = widget.dispatch(hangs);
		const fromFeature = panel.hangs();
		expect(w.componentIds().sort()).toEqual(
			[
				widget.id,
				featureId
			].sort()
		);
		await settle();
		expect(w.componentIds()).toEqual([]);
		await expect(fromHook).resolves.toBeUndefined();
		await expect(fromFeature).resolves.toBeUndefined();
		w.runtime.dispose();
	});

	it("fails a component feature's action through dispatch once its owner has gone", async () => {
		const w = world();
		const diags: string[] = [];
		w.runtime.on("diag", (event) => {
			diags.push(event.code);
		});
		const Panel = createComponentFeature<IWidget>()({
			bump
		});
		let panel!: ReturnType<typeof Panel.use>;
		const PanelView = Panel.provider(
			() => {
				panel = Panel.use();
				return null;
			},
			() => ({
				Count: 0
			})
		);
		const Row = RowFeature.provider(() => <PanelView />);
		const first = w.runtime.state.Screen.Rows[0]!;
		const dispose = createRoot((disposer) => {
			TreflexProvider({
				value: w.runtime,
				get children() {
					return <Row state={first} />;
				}
			});
			return disposer;
		});
		await w.runtime.dispatch(removeRow1, "screen");
		await expect(panel.bump()).rejects.toThrow(/no entity/);
		expect(diags).toContain("dispatch/unresolved-entity");
		dispose();
		w.runtime.dispose();
	});

	describe("component features nested three deep", () => {
		type ILevel = IEntity & {
			Marker: string;
		};
		function* mark(draft: ILevel, value: string): IActionGenerator {
			draft.Marker = value;
		}
		type ILevelUse = {
			state: ILevel;
			mark: (value: string) => Promise<void>;
		};

		function threeLevels(w: ReturnType<typeof world>) {
			const A = createComponentFeature<ILevel>()({
				mark
			});
			const B = createComponentFeature<ILevel>()({
				mark
			});
			const C = createComponentFeature<ILevel>()({
				mark
			});
			const levels: {
				A?: ILevelUse;
				B?: ILevelUse;
				C?: ILevelUse;
				outerFromC?: ILevelUse;
			} = {};
			const marker = () => ({
				Marker: ""
			});
			const CView = C.provider(() => {
				levels.C = C.use() as unknown as ILevelUse;
				levels.outerFromC = A.use() as unknown as ILevelUse;
				return null;
			}, marker);
			const BView = B.provider(() => {
				levels.B = B.use() as unknown as ILevelUse;
				return <CView />;
			}, marker);
			const AView = A.provider(() => {
				levels.A = A.use() as unknown as ILevelUse;
				return <BView />;
			}, marker);
			const [row, setRow] = createSignal<IRow>(w.runtime.state.Screen.Rows[0]!);
			const [gate, setGate] = createSignal(0);
			let resume = () => {};
			const [held] = createResource(gate, (n) =>
				n === 0
					? n
					: new Promise<number>((resolve) => {
							resume = () => resolve(n);
						})
			);
			const Hold = () => (() => held()) as unknown as JSX.Element;
			const Row = RowFeature.provider(() => <AView />);
			const dispose = createRoot((disposer) => {
				const rendered = TreflexProvider({
					value: w.runtime,
					get children() {
						return (
							<Suspense fallback="loading">
								<Row state={row()} />
								<Hold />
							</Suspense>
						);
					}
				});
				createRenderEffect(() => (typeof rendered === "function" ? (rendered as () => unknown)() : rendered));
				return disposer;
			});
			const ids = () => [
				levels.A!.state.$Id,
				levels.B!.state.$Id,
				levels.C!.state.$Id
			];
			return {
				levels,
				ids,
				dispose,
				setRow,
				markAll: async () => {
					await levels.A!.mark("a!");
					await levels.B!.mark("b!");
					await levels.C!.mark("c!");
				},
				marked: () => [
					levels.A!.state.Marker,
					levels.B!.state.Marker,
					levels.C!.state.Marker
				],
				hideAndReveal: async () => {
					setGate(1);
					await settle();
					resume();
					await settle();
				}
			};
		}

		it("sit each directly under the tree owner", () => {
			const w = world();
			const t = threeLevels(w);
			for (const id of t.ids()) {
				expect(w.pathOf(id)).toEqual([
					"root",
					"screen",
					"row-1",
					id
				]);
			}
			t.dispose();
			expect(w.componentIds()).toEqual([]);
			w.runtime.dispose();
		});

		it("keep every level's state across a Suspense hide and reveal", async () => {
			const w = world();
			const t = threeLevels(w);
			await t.markAll();
			const ids = t.ids();
			await t.hideAndReveal();
			expect(t.ids()).toEqual(ids);
			expect(t.marked()).toEqual([
				"a!",
				"b!",
				"c!"
			]);
			t.dispose();
			w.runtime.dispose();
		});

		it("leave the inner entities alone when the outer one's mount is removed", () => {
			const w = world();
			const t = threeLevels(w);
			const [outer, middle, inner] = t.ids();
			w.internal.unmountComponent(outer!);
			expect(w.componentIds().sort()).toEqual(
				[
					middle,
					inner
				].sort()
			);
			t.dispose();
			expect(w.componentIds()).toEqual([]);
			w.runtime.dispose();
		});

		it("all move with their state when the tree owner switches", async () => {
			const w = world();
			const t = threeLevels(w);
			await t.markAll();
			const ids = t.ids();
			t.setRow(w.runtime.state.Screen.Rows[1]!);
			expect(t.ids()).toEqual(ids);
			for (const id of ids) {
				expect(w.pathOf(id)).toEqual([
					"root",
					"screen",
					"row-2",
					id
				]);
			}
			expect(t.marked()).toEqual([
				"a!",
				"b!",
				"c!"
			]);
			t.dispose();
			w.runtime.dispose();
		});

		it("all go with the tree owner's removal", async () => {
			const w = world();
			const t = threeLevels(w);
			await w.runtime.dispatch(removeRow1, "screen");
			expect(w.componentIds()).toEqual([]);
			t.dispose();
			w.runtime.dispose();
		});

		it("let the innermost call the outer widget's actions through its use()", async () => {
			const w = world();
			const t = threeLevels(w);
			await t.levels.outerFromC!.mark("from c");
			expect(t.marked()[0]).toBe("from c");
			t.dispose();
			w.runtime.dispose();
		});
	});
});
