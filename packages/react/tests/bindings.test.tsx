import type { ReactNode } from "react";
import type { IActionGenerator, IAskId, IEffect, IEntity, IOpenGenerator, IResourceContext, IRuntime, ISelectorGenerator } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import type { IEntityRef } from "../src";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, Suspense, useDeferredValue, useEffect, useLayoutEffect, useState } from "react";
import { createSignal } from "solid-js";
import {
	answer,
	ask,
	closeResource,
	createRuntime,
	defineEffect,
	entity,
	getData,
	getDataGlobal,
	implementation,
	inFlight,
	leading,
	open as openRegion,
	openResource,
	registerDataSource,
	settled,
	transient
} from "treflex";
import { createSnapshot, restoreRuntime } from "treflex/snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComponentFeature, createEntityFeature, TreflexProvider, useComponentState, useEntity, useResource, useRoot } from "../src";
import { getFrames } from "../src/createFrames";
import { inFlightOf, minted, pendingAsksOf, treeWrite } from "./treeWrite";
import { unhandledDuring } from "./unhandledDuring";

declare module "treflex" {
	interface IResourceTypeRegistry {
		"react/preview": {
			Value: string;
			Supply: readonly string[];
			SupplyResponse: string;
		};
	}
	interface IResourceRegistry {
		"React/Preview": {
			Type: "react/preview";
		};
	}
	interface IDataSourceRegistry {
		ProbeTheme: IBoard;
		ProbeStation: IProbeStation;
	}
}

interface ITask extends IEntity {
	Text: string;
	Done: boolean;
}

interface IBoard extends IEntity {
	Title: string;
	Tasks: ITask[];
}

function seed(): IBoard {
	return {
		$Id: "board",
		Title: "Board",
		Tasks: [
			{
				$Id: "t1",
				Text: "one",
				Done: false
			},
			{
				$Id: "t2",
				Text: "two",
				Done: false
			}
		]
	};
}

function* rename(draft: IBoard, title: string): IActionGenerator {
	draft.Title = title;
}

function* add(draft: IBoard, text: string): IActionGenerator {
	const task = yield* entity<ITask>({
		Text: text,
		Done: false
	});
	draft.Tasks.push(task);
}

function* fail(_draft: IBoard): IActionGenerator {
	throw new Error("boom");
}

function* toggle(draft: ITask): IActionGenerator {
	draft.Done = !draft.Done;
}

function* open(draft: IEntity): IActionGenerator {
	yield* openResource(draft, "React/Preview", {
		Type: "react/preview"
	});
}

function* close(draft: IEntity): IActionGenerator {
	yield* closeResource(draft, "React/Preview");
}

function* remaining(draft: IBoard): ISelectorGenerator<number> {
	return draft.Tasks.filter((t) => !t.Done).length;
}

function* summary(draft: IBoard): ISelectorGenerator<{
	Open: ITask[];
	Title: string;
}> {
	return {
		Open: draft.Tasks.filter((t) => !t.Done),
		Title: draft.Title
	};
}

const Board = createEntityFeature<IBoard>("tests/Board")(
	{
		rename,
		add,
		fail,
		open,
		close
	},
	{
		remaining,
		summary
	}
);
const Task = createEntityFeature<ITask>("tests/Task")({
	toggle
});

const renders: Record<string, number> = {};
function count(name: string): void {
	renders[name] = (renders[name] ?? 0) + 1;
}

const TaskRow = Task.provider(() => {
	const task = Task.use();
	count(task.state.$Id);
	return (
		<li>
			<button type="button" onClick={() => task.toggle()}>
				{task.state.Text}:{task.state.Done ? "done" : "open"}
			</button>
		</li>
	);
});

const BoardView = Board.provider(() => {
	const board = Board.use();
	count("board");
	return (
		<div>
			<h1>{board.state.Title}</h1>
			<p>remaining {board.remaining()}</p>
			<button type="button" onClick={() => board.rename("Renamed")}>
				rename
			</button>
			<ul>
				{board.state.Tasks.map((task) => (
					<TaskRow key={task.$Id} state={task} />
				))}
			</ul>
		</div>
	);
});

function Root() {
	return <BoardView state={useRoot<IBoard>()} />;
}

function mount(node: ReactNode, runtime: IRuntime<any>) {
	return render(
		<StrictMode>
			<TreflexProvider value={runtime}>{node}</TreflexProvider>
		</StrictMode>
	);
}

function mountPlain(node: ReactNode, runtime: IRuntime<any>) {
	return render(<TreflexProvider value={runtime}>{node}</TreflexProvider>);
}

function tokens(runtime: IRuntime<any>): string[] {
	return Object.keys((runtime as IRuntimeInternal<any>).get("runtime/stateIdLookup")()).filter(
		(id) => !id.startsWith("t") && id !== "board"
	);
}

const consoleErrors = vi.spyOn(console, "error");

afterEach(() => {
	cleanup();
	for (const key of Object.keys(renders)) {
		delete renders[key];
	}
	expect(consoleErrors).not.toHaveBeenCalled();
	consoleErrors.mockClear();
});

describe("createEntityFeature", () => {
	it("renders the view and re-renders on an action's write", async () => {
		const runtime = createRuntime(seed());
		mount(<Root />, runtime);
		expect(screen.getByRole("heading").textContent).toBe("Board");
		await act(async () => {
			fireEvent.click(screen.getByText("rename"));
		});
		expect(screen.getByRole("heading").textContent).toBe("Renamed");
	});

	it("re-renders on a test write", () => {
		const runtime = createRuntime(seed());
		mount(<Root />, runtime);
		act(() => {
			treeWrite(runtime, (s) => {
				s.Title = "Mutated";
			});
		});
		expect(screen.getByRole("heading").textContent).toBe("Mutated");
	});

	it("serves selectors, object results included, without a getSnapshot loop", async () => {
		const runtime = createRuntime(seed());
		const seen: unknown[] = [];
		const Summary = Board.provider(() => {
			const board = Board.use();
			const value = board.summary();
			seen.push(value);
			return (
				<p>
					{value.Title} open {value.Open.map((t) => t.Text).join(",")}
				</p>
			);
		});
		mount(
			<>
				<Root />
				<Summary
					state={{
						$Id: "board"
					}}
				/>
			</>,
			runtime
		);
		expect(screen.getByText("remaining 2")).toBeTruthy();
		expect(screen.getByText("Board open one,two")).toBeTruthy();
		expect(new Set(seen).size).toBe(1);
		await act(async () => {
			fireEvent.click(screen.getByText("one:open"));
		});
		expect(screen.getByText("remaining 1")).toBeTruthy();
		expect(screen.getByText("Board open two")).toBeTruthy();
		expect(screen.getByText("one:done")).toBeTruthy();
		act(() => {
			treeWrite(runtime, (s) => {
				s.Tasks[1].Text = "second";
			});
		});
		expect(screen.getByText("Board open second")).toBeTruthy();
		const last = seen.at(-1);
		expect(Object.isFrozen(last)).toBe(true);
	});

	it("hands the runtime's onError a genuine throw, and the call still rejects", async () => {
		const errors: unknown[] = [];
		const runtime = createRuntime(seed(), {
			onError: (error) => errors.push(error)
		});
		let board!: ReturnType<typeof Board.use>;
		const Probe = Board.provider(() => {
			board = Board.use();
			return null;
		});
		mount(
			<Probe
				state={{
					$Id: "board"
				}}
			/>,
			runtime
		);
		await act(async () => {
			await expect(board.fail()).rejects.toThrow("boom");
		});
		expect(errors).toHaveLength(1);
		expect((errors[0] as Error).message).toBe("boom");
	});

	describe("a discarded call that fails", () => {
		const Quiet = createEntityFeature<IBoard>("tests/QuietBoard")({
			fail
		});

		function mountQuiet(runtime: IRuntime<IBoard>) {
			let quiet!: ReturnType<typeof Quiet.use>;
			const Probe = Quiet.provider(() => {
				quiet = Quiet.use();
				return null;
			});
			mount(
				<Probe
					state={{
						$Id: "board"
					}}
				/>,
				runtime
			);
			return quiet;
		}

		it("is no unhandled rejection when the runtime's onError heard it", async () => {
			const heard: unknown[] = [];
			const quiet = mountQuiet(
				createRuntime(seed(), {
					onError: (error) => heard.push(error)
				})
			);
			const unhandled = await unhandledDuring(() => {
				quiet.fail();
			});
			expect(unhandled).toEqual([]);
			expect(heard).toHaveLength(1);
		});

		it("stays unhandled with no onError", async () => {
			const quiet = mountQuiet(createRuntime(seed()));
			const unhandled = await unhandledDuring(() => {
				quiet.fail();
			});
			expect(unhandled).toHaveLength(1);
		});
	});

	it("throws outside the matching provider, naming the feature", () => {
		const runtime = createRuntime(seed());
		consoleErrors.mockImplementation(() => {});
		function Orphan() {
			Board.use();
			return null;
		}
		expect(() => mount(<Orphan />, runtime)).toThrow(
			/\[treflex-react\] createEntityFeature \(tests\/Board\) use\(\) called outside the matching provider/
		);
		consoleErrors.mockReset();
	});

	it("throws outside a TreflexProvider", () => {
		consoleErrors.mockImplementation(() => {});
		function Orphan() {
			useRoot();
			return null;
		}
		expect(() => render(<Orphan />)).toThrow(/\[treflex-react\] useRoot called outside a TreflexProvider/);
		consoleErrors.mockReset();
	});

	it("throws when mounted on an id the tree does not hold", () => {
		const runtime = createRuntime(seed());
		consoleErrors.mockImplementation(() => {});
		expect(() =>
			mount(
				<BoardView
					state={{
						$Id: "missing"
					}}
				/>,
				runtime
			)
		).toThrow(/no entity "missing" in the state tree/);
		consoleErrors.mockReset();
	});

	it("lands a controlled input's write inside its own event, so the input keeps its caret", () => {
		const runtime = createRuntime(seed());
		const Title = Board.provider(() => {
			const board = Board.use();
			return <input aria-label="title" value={board.state.Title} onChange={(e) => board.rename(e.currentTarget.value)} />;
		});
		mount(
			<Title
				state={{
					$Id: "board"
				}}
			/>,
			runtime
		);
		const input = screen.getByLabelText("title") as HTMLInputElement;
		fireEvent.change(input, {
			target: {
				value: "Board 2"
			}
		});
		expect(runtime.state.Title).toBe("Board 2");
		expect(input.value).toBe("Board 2");
	});
});

describe("use()", () => {
	it("keeps two contexts' same-named selectors over one entity in separate memos", () => {
		const runtime = createRuntime(seed());
		function* view(draft: IBoard): ISelectorGenerator<{
			Title: string;
		}> {
			return {
				Title: draft.Title
			};
		}
		function* otherView(draft: IBoard): ISelectorGenerator<{
			Count: number;
		}> {
			return {
				Count: draft.Tasks.length
			};
		}
		const First = createEntityFeature<IBoard>()(
			{},
			{
				view
			}
		);
		const Second = createEntityFeature<IBoard>()(
			{},
			{
				view: otherView
			}
		);
		const FirstView = First.provider(() => <p>title {First.use().view().Title}</p>);
		const SecondView = Second.provider(() => <p>count {Second.use().view().Count}</p>);
		mount(
			<>
				<FirstView
					state={{
						$Id: "board"
					}}
				/>
				<SecondView
					state={{
						$Id: "board"
					}}
				/>
			</>,
			runtime
		);
		expect(screen.getByText("title Board")).toBeTruthy();
		expect(screen.getByText("count 2")).toBeTruthy();
		act(() => {
			treeWrite(runtime, (s) => {
				s.Title = "Again";
			});
		});
		expect(screen.getByText("title Again")).toBeTruthy();
	});

	it("re-renders a component that never reads state only for what it does read", () => {
		const runtime = createRuntime(seed());
		let rendered = 0;
		const Buttons = Board.provider(() => {
			const board = Board.use();
			rendered++;
			return (
				<button type="button" onClick={() => board.rename("x")}>
					rename
				</button>
			);
		});
		mount(
			<Buttons
				state={{
					$Id: "board"
				}}
			/>,
			runtime
		);
		const before = rendered;
		act(() => {
			treeWrite(runtime, (s) => {
				s.Title = "Changed";
			});
		});
		expect(rendered).toBe(before);
	});

	it("does not enter a selector a handler calls after its entity left", () => {
		const runtime = createRuntime(seed());
		let runs = 0;
		function* text(draft: ITask): ISelectorGenerator<string> {
			runs++;
			return draft.Text;
		}
		const Texted = createEntityFeature<ITask>()(
			{},
			{
				text
			}
		);
		let feature!: ReturnType<typeof Texted.use>;
		const Probe = Texted.provider(() => {
			feature = Texted.use();
			return <p>probe {feature.state.Text}</p>;
		});
		mount(
			<Probe
				state={{
					$Id: "t2"
				}}
			/>,
			runtime
		);
		act(() => {
			treeWrite(runtime, (s) => {
				s.Tasks.pop();
			});
		});
		runs = 0;
		expect(feature.text()).toBeUndefined();
		expect(runs).toBe(0);
	});

	it("keeps the last view once its entity leaves, and its dispatches reject", async () => {
		const runtime = createRuntime(seed());
		const diags: string[] = [];
		runtime.on("diag", (d) => diags.push(d.code));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let task!: ReturnType<typeof Task.use>;
		const Probe = Task.provider(() => {
			task = Task.use();
			return <p>left {task.state.Text}</p>;
		});
		mount(
			<Probe
				state={{
					$Id: "t2"
				}}
			/>,
			runtime
		);
		act(() => {
			treeWrite(runtime, (s) => {
				s.Tasks.pop();
			});
		});
		expect(screen.getByText("left two")).toBeTruthy();
		await act(async () => {
			await expect(task.toggle()).rejects.toThrow(/no entity "t2"/);
		});
		expect(diags).toContain("dispatch/unresolved-entity");
		warn.mockRestore();
	});
});

interface IProbeTicket extends IEntity {
	Text: string;
}

interface IProbeStation extends IEntity {
	Name: string;
	Tickets: IProbeTicket[];
}

interface IProbeKitchen extends IEntity {
	Stations: IProbeStation[];
}

describe("selector work on an entity that is leaving", () => {
	function* shout(draft: ITask): ISelectorGenerator<string> {
		return draft.Text.toUpperCase();
	}

	function* editAndDrop(draft: IBoard): IActionGenerator {
		draft.Tasks[0].Text = "edited";
		draft.Tasks.splice(0, 1);
	}

	it("does not run a watched selector on an entity spliced out in the drain that wrote it", async () => {
		const runtime = createRuntime(seed());
		const Shout = createEntityFeature<ITask>()(
			{},
			{
				shout
			}
		);
		const Row = Shout.provider(() => <li>{Shout.use().shout()}</li>);
		function Rows() {
			return (
				<ul>
					{useRoot<IBoard>().Tasks.map((task) => (
						<Row key={task.$Id} state={task} />
					))}
				</ul>
			);
		}
		mount(<Rows />, runtime);
		expect(screen.getByText("ONE")).toBeTruthy();
		await act(async () => {
			await expect(runtime.dispatch(editAndDrop, "board")).resolves.toBeUndefined();
		});
		expect(screen.queryByText("ONE")).toBeNull();
		expect(screen.getByText("TWO")).toBeTruthy();
	});

	it("does not run a getData selector on a ticket whose station is removed", async () => {
		const runtime = createRuntime<IProbeKitchen>({
			$Id: "kitchen",
			Stations: [
				{
					$Id: "s1",
					Name: "Wren",
					Tickets: [
						{
							$Id: "k1",
							Text: "soup"
						}
					]
				}
			]
		});
		function* register(draft: IProbeStation): IActionGenerator {
			yield* registerDataSource(draft, "ProbeStation");
		}
		function* cook(draft: IProbeTicket): ISelectorGenerator<string> {
			const station = yield* getData(draft, "ProbeStation");
			return `${draft.Text} by ${station?.Name ?? "nobody"}`;
		}
		function* close(draft: IProbeKitchen): IActionGenerator {
			draft.Stations = [];
		}
		await runtime.dispatch(register, "s1");
		const Ticket = createEntityFeature<IProbeTicket>()(
			{},
			{
				cook
			}
		);
		const Station = createEntityFeature<IProbeStation>()({});
		const TicketRow = Ticket.provider(() => <li>{Ticket.use().cook()}</li>);
		const StationColumn = Station.provider(() => (
			<ul>
				{Station.use().state.Tickets.map((ticket) => (
					<TicketRow key={ticket.$Id} state={ticket} />
				))}
			</ul>
		));
		function Columns() {
			return (
				<>
					{useRoot<IProbeKitchen>().Stations.map((station) => (
						<StationColumn key={station.$Id} state={station} />
					))}
				</>
			);
		}
		mount(<Columns />, runtime);
		expect(screen.getByText("soup by Wren")).toBeTruthy();
		await act(async () => {
			await expect(runtime.dispatch(close, "kitchen")).resolves.toBeUndefined();
		});
		expect(screen.queryByText("soup by Wren")).toBeNull();
	});

	it("leaves no selector memo behind a component feature's unmounts", async () => {
		const runtime = createRuntime(seed(), {
			activityLog: true
		});
		let runs = 0;
		function* logged(_draft: IEntity): ISelectorGenerator<number> {
			runs++;
			const log = yield* getDataGlobal("ActivityLog");
			return log?.Entries.length ?? 0;
		}
		const Counter = createComponentFeature<IEntity>("tests/Leak")(
			{},
			{
				logged
			}
		);
		const View = Counter.provider(
			() => <p>log {Counter.use().logged()}</p>,
			() => ({})
		);
		for (let i = 0; i < 3; i++) {
			const view = mount(<View />, runtime);
			await act(async () => {
				await runtime.dispatch(rename, "board", `round ${i}`);
			});
			view.unmount();
		}
		await settled();
		runs = 0;
		await act(async () => {
			await runtime.dispatch(rename, "board", "after");
		});
		expect(runs).toBe(0);
	});
});

describe("selector timing", () => {
	interface IPanelState extends IEntity {
		Open: boolean;
		Items: string[];
	}

	function* open(draft: IPanelState): IActionGenerator {
		draft.Open = true;
	}

	function* size(draft: IPanelState): ISelectorGenerator<number> {
		return draft.Items.length;
	}

	function* title(draft: IBoard): ISelectorGenerator<string> {
		return draft.Title;
	}

	it("renders once for a change that also calls a selector for the first time", async () => {
		const runtime = createRuntime(seed());
		const Panel = createComponentFeature<IPanelState>()(
			{
				open
			},
			{
				size
			}
		);
		let renders = 0;
		let feature!: ReturnType<typeof Panel.use>;
		const View = Panel.provider(
			() => {
				feature = Panel.use();
				renders++;
				return <p>{feature.state.Open ? feature.size() : "shut"}</p>;
			},
			() => ({
				Open: false,
				Items: []
			})
		);
		render(
			<TreflexProvider value={runtime}>
				<View />
			</TreflexProvider>
		);
		await act(async () => {});
		const before = renders;
		await act(async () => {
			await feature.open();
		});
		expect(screen.getByText("0")).toBeTruthy();
		expect(renders).toBe(before + 1);
	});

	it("computes a selector fresh when a handler calls it after an await", async () => {
		const runtime = createRuntime(seed());
		const Titled = createEntityFeature<IBoard>()(
			{
				rename
			},
			{
				title
			}
		);
		let seen: string[] = [];
		const View = Titled.provider(() => {
			const feature = Titled.use();
			return (
				<button
					type="button"
					onClick={async () => {
						await feature.rename("New");
						seen = [
							feature.state.Title,
							feature.title()
						];
					}}
				>
					{feature.title()}
				</button>
			);
		});
		mount(
			<View
				state={{
					$Id: "board"
				}}
			/>,
			runtime
		);
		await act(async () => {
			fireEvent.click(screen.getByText("Board"));
		});
		expect(seen).toEqual([
			"New",
			"New"
		]);
	});
});

describe("hot reload", () => {
	function* bumpTitle(draft: IBoard): IActionGenerator {
		draft.Title = `${draft.Title}+`;
	}

	function* bumpTitleTwice(draft: IBoard): IActionGenerator {
		draft.Title = `${draft.Title}++`;
	}

	function* labelV1(draft: IBoard): ISelectorGenerator<string> {
		return `v1:${draft.Title}`;
	}

	function* labelV2(draft: IBoard): ISelectorGenerator<string> {
		return `v2:${draft.Title}`;
	}

	function* added(draft: IBoard): ISelectorGenerator<number> {
		return draft.Tasks.length;
	}

	function* panelSize(draft: IPanelState): ISelectorGenerator<string> {
		return `panel:${draft.Count}`;
	}

	function* panelSizeV2(draft: IPanelState): ISelectorGenerator<string> {
		return `panel2:${draft.Count}`;
	}

	interface IPanelState extends IEntity {
		Count: number;
	}

	function evaluate(version: 1 | 2 | 3) {
		return {
			board:
				version === 1
					? createEntityFeature<IBoard>("tests/Hot")(
							{
								bump: bumpTitle
							},
							{
								label: labelV1
							}
						)
					: version === 2
						? createEntityFeature<IBoard>("tests/Hot")(
								{
									bump: bumpTitleTwice,
									rename
								},
								{
									label: labelV2,
									added
								}
							)
						: createEntityFeature<IBoard>("tests/Hot")(
								{
									bump: bumpTitleTwice
								},
								{
									added
								}
							),
			panel: createComponentFeature<IPanelState>("tests/HotPanel")(
				{},
				{
					size: version === 1 ? panelSize : panelSizeV2
				}
			)
		};
	}

	it("gives a re-evaluated factory call with the same id its context back, with the new actions and selectors", async () => {
		const runtime = createRuntime(seed());
		let module = evaluate(1);
		let version = 1;
		let localId = "";
		let board!: ReturnType<ReturnType<typeof evaluate>["board"]["use"]>;
		function Child() {
			const [clicks, setClicks] = useState(0);
			const local = useComponentState(() => ({
				Count: 0
			}));
			localId ||= local.state.$Id;
			board = module.board.use() as typeof board;
			const panel = module.panel.use();
			const label = version < 3 ? (board as any).label() : "gone";
			const extra = version > 1 ? `${typeof (board as any).rename} ${(board as any).added()}` : "-";
			return (
				<button type="button" onClick={() => setClicks(clicks + 1)}>
					{label} {panel.size()} {extra} {clicks} {local.state.$Id === localId ? "same" : "fresh"}
				</button>
			);
		}
		const Body = module.panel.provider(
			() => <Child />,
			() => ({
				Count: 0
			})
		);
		const View = module.board.provider(() => <Body />);
		mount(
			<View
				state={{
					$Id: "board"
				}}
			/>,
			runtime
		);
		expect(screen.getByText("v1:Board panel:0 - 0 same")).toBeTruthy();
		module = evaluate(2);
		version = 2;
		await act(async () => {
			fireEvent.click(screen.getByText("v1:Board panel:0 - 0 same"));
		});
		expect(screen.getByText("v2:Board panel2:0 function 2 1 same")).toBeTruthy();
		await act(async () => {
			await (board as any).bump();
		});
		expect(screen.getByText("v2:Board++ panel2:0 function 2 1 same")).toBeTruthy();
		module = evaluate(3);
		version = 3;
		await act(async () => {
			fireEvent.click(screen.getByText("v2:Board++ panel2:0 function 2 1 same"));
		});
		expect(screen.getByText("gone panel2:0 undefined 2 2 same")).toBeTruthy();
	});
});

describe("selector inputs outside the tree", () => {
	function* provide(draft: IBoard): IActionGenerator {
		yield* registerDataSource(draft, "ProbeTheme");
	}

	function* theme(draft: ITask): ISelectorGenerator<string> {
		const source = yield* getData(draft, "ProbeTheme");
		return source?.Title ?? "none";
	}

	function* logged(_draft: IBoard): ISelectorGenerator<number> {
		const log = yield* getDataGlobal("ActivityLog");
		return log?.Entries.length ?? -1;
	}

	it("re-renders when a data source registers with no tree write", async () => {
		const runtime = createRuntime(seed());
		const Themed = createEntityFeature<ITask>()(
			{},
			{
				theme
			}
		);
		const View = Themed.provider(() => <p>theme {Themed.use().theme()}</p>);
		mount(
			<View
				state={{
					$Id: "t1"
				}}
			/>,
			runtime
		);
		expect(screen.getByText("theme none")).toBeTruthy();
		await act(async () => {
			await runtime.dispatch(provide, "board");
		});
		expect(screen.getByText("theme Board")).toBeTruthy();
	});

	describe("transients", () => {
		const loadCount = (owner: IEntity) =>
			transient(owner, "React/Load", {
				Count: 0,
				Rows: [] as IEntity[]
			});

		function* count(draft: IEntity): ISelectorGenerator<number> {
			return (yield* loadCount(draft)).Count;
		}

		function parking() {
			const runtime = createRuntime(seed());
			const releases: (() => void)[] = [];
			runtime.registerImplementation(
				"park",
				() =>
					new Promise<void>((resolve) => {
						releases.push(resolve);
					})
			);
			return {
				runtime,
				releases
			};
		}

		function* load(draft: IBoard): IActionGenerator {
			const s = yield* loadCount(draft);
			s.Count++;
			try {
				yield {
					Type: "park"
				};
			} finally {
				s.Count--;
			}
		}

		it("re-renders through a selector when a transient changes with no tree write, its first write included", async () => {
			const { runtime, releases } = parking();
			const Gate = createEntityFeature<IBoard>()(
				{},
				{
					count
				}
			);
			const View = Gate.provider(() => <p>loading {Gate.use().count()}</p>);
			mount(
				<View
					state={{
						$Id: "board"
					}}
				/>,
				runtime
			);
			expect(screen.getByText("loading 0")).toBeTruthy();
			let done!: Promise<void>;
			act(() => {
				done = runtime.dispatch(load, "board");
			});
			expect(screen.getByText("loading 1")).toBeTruthy();
			await act(async () => {
				releases[0]();
				await done;
			});
			expect(screen.getByText("loading 0")).toBeTruthy();
		});

		it("drops a second press of a leading action, and a selector over its mark gates the button", async () => {
			const { runtime, releases } = parking();
			const saveTitle = leading(function* writeTitle(draft: IBoard, title: string): IActionGenerator<string> {
				draft.Title = title;
				yield {
					Type: "park"
				};
				return title;
			});
			function* saving(draft: IBoard): ISelectorGenerator<boolean> {
				return yield* inFlight(saveTitle, draft);
			}
			const Gate = createEntityFeature<IBoard>()(
				{
					saveTitle
				},
				{
					saving
				}
			);
			const results: Promise<string | undefined>[] = [];
			const View = Gate.provider(() => {
				const gate = Gate.use();
				return (
					<button
						type="button"
						disabled={gate.saving()}
						onClick={() => {
							results.push(gate.saveTitle("one"), gate.saveTitle("two"));
						}}
					>
						{gate.state.Title}
					</button>
				);
			});
			mount(
				<View
					state={{
						$Id: "board"
					}}
				/>,
				runtime
			);
			expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
			fireEvent.click(screen.getByRole("button"));
			await expect(results[1]).resolves.toBeUndefined();
			expect(screen.getByText("one")).toBeTruthy();
			expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
			await act(async () => {
				releases[0]();
				await expect(results[0]).resolves.toBe("one");
			});
			expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
		});

		describe("on component state", () => {
			interface ILocal extends IEntity {
				Log: string[];
			}

			const once = leading(function* noteOnce(draft: ILocal, text: string): IActionGenerator<string> {
				draft.Log.push(`once:${text}`);
				yield {
					Type: "park"
				};
				return text;
			});

			function* busy(draft: ILocal): ISelectorGenerator<boolean> {
				return yield* inFlight(once, draft);
			}

			it("drops a repeat of a leading action", async () => {
				const { runtime, releases } = parking();
				let local!: ReturnType<typeof useComponentState<ILocal>>;
				function Local() {
					local = useComponentState<ILocal>(() => ({
						Log: []
					}));
					return null;
				}
				mount(<Local />, runtime);
				const results: Promise<string | undefined>[] = [];
				await act(async () => {
					results.push(local.dispatch(once, "a"), local.dispatch(once, "b"));
					await new Promise((resolve) => setTimeout(resolve, 0));
				});
				await expect(results[1]).resolves.toBeUndefined();
				expect(local.state.Log).toEqual([
					"once:a"
				]);
				await act(async () => {
					for (const release of releases) {
						release();
					}
					await Promise.all(results);
				});
				await expect(Promise.all(results)).resolves.toEqual([
					"a",
					undefined
				]);
			});

			it("refuses an inFlight read on a view, and reads it from a component feature's selector", () => {
				const { runtime } = parking();
				vi.spyOn(console, "error").mockImplementation(() => {});
				let local!: ReturnType<typeof useComponentState<ILocal>>;
				function Local() {
					local = useComponentState<ILocal>(() => ({
						Log: []
					}));
					return null;
				}
				mount(<Local />, runtime);
				expect(() => runtime.processSelector(busy, () => local.state as ILocal)).toThrow("a React view reaches no runtime");
				const Busy = createComponentFeature<ILocal>()(
					{},
					{
						busy
					}
				);
				const View = Busy.provider(
					() => <p>{String(Busy.use().busy())}</p>,
					() => ({
						Log: []
					})
				);
				mount(<View />, runtime);
				expect(screen.getByText("false")).toBeTruthy();
			});
		});

		it("reads a whole transient through a selector, mounted from a view, and holds its result steady until the transient changes", async () => {
			const { runtime, releases } = parking();
			function* whole(draft: IBoard) {
				return yield* loadCount(draft);
			}
			const Gate = createEntityFeature<IBoard>()(
				{},
				{
					whole
				}
			);
			const views: unknown[] = [];
			const View = Gate.provider(() => {
				const node = Gate.use().whole();
				views.push(node);
				return <p>loading {node.Count}</p>;
			});
			function Root() {
				return <View state={useRoot<IBoard>()} />;
			}
			mount(<Root />, runtime);
			expect(screen.getByText("loading 0")).toBeTruthy();
			const unwritten = views.at(-1);
			expect(Object.isFrozen(unwritten)).toBe(true);
			await act(async () => {
				await runtime.dispatch(function* (draft: IBoard): IActionGenerator {
					draft.Title = "Renamed";
				}, "board");
			});
			expect(views.at(-1)).toBe(unwritten);
			let done!: Promise<void>;
			act(() => {
				done = runtime.dispatch(load, "board");
			});
			expect(screen.getByText("loading 1")).toBeTruthy();
			expect(Object.isFrozen(views.at(-1))).toBe(true);
			await act(async () => {
				releases[0]();
				await done;
			});
			expect(screen.getByText("loading 0")).toBeTruthy();
		});

		it("shows a transient entity in a selector's result as that entity's view, whose ref a provider and useEntity take", async () => {
			const { runtime } = parking();
			await runtime.dispatch(function* (draft: IBoard): IActionGenerator {
				(yield* loadCount(draft)).Rows.push(
					minted("in-transient", {
						Text: "held"
					})
				);
			}, "board");
			function* firstRow(draft: IBoard) {
				return (yield* loadCount(draft)).Rows[0] as ITask;
			}
			const Rows = createEntityFeature<IBoard>()(
				{},
				{
					firstRow
				}
			);
			function Row(props: { id: string }) {
				const row = useEntity<ITask>(props.id);
				return <p>row {row?.Text}</p>;
			}
			const View = Rows.provider(() => {
				const row = Rows.use().firstRow();
				expect(row).toEqual({
					$Id: "~in-transient",
					Text: "held"
				});
				return <Row id={row.$Id} />;
			});
			mount(
				<View
					state={{
						$Id: "board"
					}}
				/>,
				runtime
			);
			expect(screen.getByText("row held")).toBeTruthy();
		});

		it("reads by id from a component with no entity feature, and an owner that has gone reads as unwritten", async () => {
			const { runtime } = parking();
			await runtime.dispatch(function* (draft: ITask): IActionGenerator {
				(yield* loadCount(draft)).Count = 3;
			}, "t1");
			const Gate = createEntityFeature<ITask>()(
				{},
				{
					count
				}
			);
			const Count = Gate.provider(() => <p>loading {Gate.use().count()}</p>);
			function ById(props: { id: string }) {
				const owner = useEntity<ITask>(props.id);
				return owner ? <Count state={owner} /> : <p>loading 0</p>;
			}
			mount(<ById id="t1" />, runtime);
			expect(screen.getByText("loading 3")).toBeTruthy();
			await act(async () => {
				await runtime.dispatch(function* (draft: IBoard): IActionGenerator {
					draft.Tasks = draft.Tasks.filter((task) => task.$Id !== "t1");
				}, "board");
			});
			expect(screen.getByText("loading 0")).toBeTruthy();
		});

		it("reads by id for an owner that isn't there yet, and picks it up when it arrives", async () => {
			const { runtime } = parking();
			const Gate = createEntityFeature<ITask>()(
				{},
				{
					count
				}
			);
			const Count = Gate.provider(() => <p>loading {Gate.use().count()}</p>);
			function ById(props: { id: string }) {
				const owner = useEntity<ITask>(props.id);
				return owner ? <Count state={owner} /> : <p>none</p>;
			}
			mount(<ById id="~later" />, runtime);
			expect(screen.getByText("none")).toBeTruthy();
			await act(async () => {
				await runtime.dispatch(function* (draft: IBoard): IActionGenerator {
					draft.Tasks.push(
						minted("later", {
							Text: "late",
							Done: false
						})
					);
					(yield* loadCount(draft.Tasks.at(-1) as ITask)).Count = 2;
				}, "board");
			});
			expect(screen.getByText("loading 2")).toBeTruthy();
		});

		it("refuses a view as a transient's owner, pointing at a selector", () => {
			const { runtime } = parking();
			vi.spyOn(console, "error").mockImplementation(() => {});
			function Gate() {
				const view = useRoot<IBoard>();
				return <p>loading {runtime.processSelector(count, () => view)}</p>;
			}
			expect(() => mount(<Gate />, runtime)).toThrow("through a selector");
		});
	});

	it("catches a change made between the render that first calls a selector and the start of its watch", async () => {
		const runtime = createRuntime(seed());
		const [outside, setOutside] = createSignal(0);
		function* read(_draft: IBoard): ISelectorGenerator<number> {
			return outside();
		}
		const Outside = createEntityFeature<IBoard>()(
			{},
			{
				read
			}
		);
		function Change() {
			useLayoutEffect(() => {
				setOutside(1);
			}, []);
			return null;
		}
		const View = Outside.provider(() => {
			const feature = Outside.use();
			const [shown, setShown] = useState(false);
			return shown ? (
				<>
					<p>outside {feature.read()}</p>
					<Change />
				</>
			) : (
				<button type="button" onClick={() => setShown(true)}>
					show
				</button>
			);
		});
		render(
			<TreflexProvider value={runtime}>
				<View
					state={{
						$Id: "board"
					}}
				/>
			</TreflexProvider>
		);
		await act(async () => {
			fireEvent.click(screen.getByText("show"));
		});
		expect(screen.getByText("outside 1")).toBeTruthy();
	});

	it("keeps up with the activity log past the drain", async () => {
		const runtime = createRuntime(seed(), {
			activityLog: true
		});
		const Logged = createEntityFeature<IBoard>()(
			{
				rename
			},
			{
				logged
			}
		);
		let feature!: ReturnType<typeof Logged.use>;
		const View = Logged.provider(() => {
			feature = Logged.use();
			return <p>log {feature.logged()}</p>;
		});
		mount(
			<View
				state={{
					$Id: "board"
				}}
			/>,
			runtime
		);
		await act(async () => {
			await feature.rename("Logged");
		});
		const now = (runtime as IRuntimeInternal<any>).runSelector(logged, () => runtime.state);
		expect(now).toBeGreaterThan(0);
		expect(screen.getByText(`log ${now}`)).toBeTruthy();
	});
});

describe("boundaries", () => {
	it("re-renders a child entity's component, not its parent's or its siblings'", async () => {
		const runtime = createRuntime(seed());
		mount(<Root />, runtime);
		const board = renders.board;
		const first = renders.t1;
		const second = renders.t2;
		act(() => {
			treeWrite(runtime, (s) => {
				s.Tasks[1].Text = "changed";
			});
		});
		expect(screen.getByText("changed:open")).toBeTruthy();
		expect(renders.t2).toBeGreaterThan(second);
		expect(renders.board).toBe(board);
		expect(renders.t1).toBe(first);
	});

	it("holds the child as a ref and serves its view through useEntity", () => {
		const runtime = createRuntime(seed());
		let parent!: readonly IEntityRef<ITask>[];
		function Peek() {
			parent = useRoot<IBoard>().Tasks;
			const task = useEntity<ITask>("t1");
			return <p>peek {task?.Text}</p>;
		}
		mount(<Peek />, runtime);
		expect(parent[0]).toEqual({
			$Id: "t1"
		});
		act(() => {
			treeWrite(runtime, (s) => {
				s.Tasks[0].Text = "first";
			});
		});
		expect(screen.getByText("peek first")).toBeTruthy();
	});

	it("renders a restored runtime's tree from its first view", async () => {
		const source = createRuntime<any>(seed());
		const saved = JSON.parse(createSnapshot(source));
		source.dispose();
		saved.AppState.Title = "restored";
		saved.AppState.Tasks[0].Text = "restored";
		const { runtime } = await restoreRuntime<any>(JSON.stringify(saved), {
			rootId: "board",
			options: {}
		});
		const rendered: string[] = [];
		function Picture() {
			const root = useRoot<any>() as any;
			const task = useEntity<any>("t1") as any;
			rendered.push(`${root.Title} ${task?.Text}`);
			return <p>{root.Title}</p>;
		}
		render(
			<TreflexProvider value={runtime}>
				<Picture />
			</TreflexProvider>
		);
		expect(rendered).toEqual([
			"restored restored"
		]);
	});

	it("serves undefined from useEntity once the entity leaves", () => {
		const runtime = createRuntime(seed());
		function Peek() {
			const task = useEntity<ITask>("t2");
			return <p>{task ? task.Text : "gone"}</p>;
		}
		mount(<Peek />, runtime);
		act(() => {
			treeWrite(runtime, (s) => {
				s.Tasks.pop();
			});
		});
		expect(screen.getByText("gone")).toBeTruthy();
	});
});

describe("useComponentState", () => {
	function* increment(draft: { $Id: string; Count: number }): IActionGenerator {
		draft.Count++;
	}

	it("keeps a ComponentState entity for as long as the component is mounted", async () => {
		const runtime = createRuntime(seed());
		function Counter() {
			const local = useComponentState(() => ({
				Count: 0
			}));
			return (
				<button type="button" onClick={() => local.dispatch(increment)}>
					count {local.state.Count}
				</button>
			);
		}
		function Toggle() {
			const [shown, setShown] = useState(true);
			return (
				<>
					<button type="button" onClick={() => setShown(false)}>
						hide
					</button>
					{shown && <Counter />}
				</>
			);
		}
		mount(<Toggle />, runtime);
		expect(tokens(runtime)).toHaveLength(1);
		await act(async () => {
			fireEvent.click(screen.getByText("count 0"));
		});
		expect(screen.getByText("count 1")).toBeTruthy();
		await act(async () => {
			fireEvent.click(screen.getByText("hide"));
		});
		expect(tokens(runtime)).toEqual([]);
	});

	it("seats the entity for a dispatch from a child's layout effect, which runs before its own", async () => {
		interface IWait extends IEffect {
			Type: "react-test/wait";
		}
		const wait = defineEffect<IWait, void>("react-test/wait");
		const runtime = createRuntime(seed(), {});
		const internal = runtime as IRuntimeInternal<any>;
		const releases: (() => void)[] = [];
		runtime.registerImplementation(
			implementation(
				wait,
				() =>
					new Promise<void>((resolve) => {
						releases.push(resolve);
					})
			)
		);
		function* park(_draft: { $Id: string }): IActionGenerator<string> {
			yield* wait();
			return "done";
		}
		const dispatched: Promise<string | undefined>[] = [];
		function Child(props: { dispatch: (action: typeof park) => Promise<string | undefined> }) {
			const { dispatch } = props;
			useLayoutEffect(() => {
				dispatched.push(dispatch(park));
			}, [
				dispatch
			]);
			return null;
		}
		let parentId = "";
		function Parent() {
			const parent = useComponentState(() => ({}));
			parentId = parent.id;
			return <Child dispatch={parent.dispatch} />;
		}
		const view = mount(<Parent />, runtime);
		await act(async () => {});
		expect(dispatched).toHaveLength(2);
		const node = internal.resolveCell(parentId)?.state as IEntity;
		expect(node).toBeDefined();
		expect(inFlightOf(runtime, park, node)).toBe(true);
		let outcome: string | undefined;
		void dispatched[1]!.then((value) => {
			outcome = value;
		});
		for (let round = 0; round < 4 && outcome === undefined; round++) {
			for (const release of releases.splice(0)) {
				release();
			}
			await settled();
		}
		expect(outcome).toBe("done");
		view.unmount();
	});

	it("changes through an action only, on an entity mounted under the provider above it", async () => {
		const runtime = createRuntime(seed());
		let local!: ReturnType<
			typeof useComponentState<{
				$Id: string;
				Count: number;
			}>
		>;
		function Counter() {
			local = useComponentState(() => ({
				Count: 0
			}));
			return <p>count {local.state.Count}</p>;
		}
		mount(<Counter />, runtime);
		expect((local as unknown as Record<string, unknown>).setState).toBeUndefined();
		await act(async () => {
			await local.dispatch(function* (draft): IActionGenerator {
				draft.Count = 5;
			});
		});
		expect(screen.getByText("count 5")).toBeTruthy();
		const lookup = (runtime as IRuntimeInternal<any>).get("runtime/stateIdLookup")();
		expect(lookup[local.id]?.path).toEqual([
			"board",
			local.id
		]);
	});
});

describe("createComponentFeature", () => {
	interface IPanel extends IEntity {
		Open: boolean;
		Items: string[];
	}

	function* togglePanel(draft: IPanel): IActionGenerator {
		draft.Open = !draft.Open;
	}

	function* push(draft: IPanel, item: string): IActionGenerator {
		draft.Items.push(item);
	}

	function* size(draft: IPanel): ISelectorGenerator<number> {
		return draft.Items.length;
	}

	const Panel = createComponentFeature<IPanel>("tests/Panel")(
		{
			togglePanel,
			push
		},
		{
			size
		}
	);

	function Inner(props: { label: string }) {
		const panel = Panel.use();
		return (
			<div>
				<button type="button" onClick={() => panel.togglePanel()}>
					{props.label} {panel.state.Open ? "open" : "shut"}
				</button>
				<button type="button" onClick={() => panel.push("x")}>
					items {panel.size()}
				</button>
			</div>
		);
	}

	const PanelView = Panel.provider(Inner, () => ({
		Open: false,
		Items: []
	}));

	it("mints its state, runs its actions and selectors on it, and drops its token on unmount", async () => {
		const runtime = createRuntime(seed());
		const view = mount(<PanelView label="panel" />, runtime);
		expect(tokens(runtime)).toHaveLength(1);
		await act(async () => {
			fireEvent.click(screen.getByText("panel shut"));
		});
		expect(screen.getByText("panel open")).toBeTruthy();
		await act(async () => {
			fireEvent.click(screen.getByText("items 0"));
		});
		expect(screen.getByText("items 1")).toBeTruthy();
		view.unmount();
		await settled();
		expect(tokens(runtime)).toEqual([]);
	});

	it("unmounts cleanly after its runtime is disposed", async () => {
		const runtime = createRuntime(seed());
		const view = mount(<PanelView label="panel" />, runtime);
		runtime.dispose();
		expect(() => view.unmount()).not.toThrow();
		await settled();
	});

	it("lets its runtime dispose cleanly straight after an unmount", async () => {
		const runtime = createRuntime(seed());
		const view = mount(<PanelView label="panel" />, runtime);
		view.unmount();
		expect(() => runtime.dispose()).not.toThrow();
		await settled();
	});

	it("gives each mount its own state", async () => {
		const runtime = createRuntime(seed());
		mount(
			<>
				<PanelView label="first" />
				<PanelView label="second" />
			</>,
			runtime
		);
		await act(async () => {
			fireEvent.click(screen.getByText("first shut"));
		});
		expect(screen.getByText("first open")).toBeTruthy();
		expect(screen.getByText("second shut")).toBeTruthy();
	});
});

describe("useResource", () => {
	function preview(runtime: IRuntime<any>) {
		let ctx!: IResourceContext<"react/preview">;
		runtime.registerResourceType("react/preview", (_params, r) => {
			ctx = r;
			r.onSupply((files) => `${r.ownerId}:${files.length}`);
		});
		return () => ctx;
	}

	it("re-renders on status and value, and supplies to the owner", async () => {
		const runtime = createRuntime(seed());
		const ctx = preview(runtime);
		let supply!: (value: readonly string[]) => Promise<string | undefined>;
		function View(props: { owner: string | IEntity | (() => string | undefined) }) {
			const files = useResource(props.owner, "React/Preview");
			supply = files.supply;
			return (
				<p>
					{files.status.State}:{files.value ?? "-"}
				</p>
			);
		}
		mount(<View owner="board" />, runtime);
		expect(screen.getByText("none:-")).toBeTruthy();
		await act(async () => {
			await runtime.dispatch(open, "board");
		});
		expect(screen.getByText("live:-")).toBeTruthy();
		await act(async () => {
			ctx().expose("blob:1");
		});
		expect(screen.getByText("live:blob:1")).toBeTruthy();
		await act(async () => {
			ctx().expose("blob:2");
		});
		expect(screen.getByText("live:blob:2")).toBeTruthy();
		await act(async () => {
			await expect(
				supply([
					"a",
					"b"
				])
			).resolves.toBe("board:2");
		});
		await act(async () => {
			await runtime.dispatch(close, "board");
		});
		expect(screen.getByText("none:-")).toBeTruthy();
	});

	it("follows an owner that changes between renders", async () => {
		const runtime = createRuntime(seed());
		const ctx = preview(runtime);
		function View(props: { owner: string }) {
			const files = useResource(props.owner, "React/Preview");
			return (
				<p>
					{files.status.State}:{files.value ?? "-"}
				</p>
			);
		}
		const view = mount(<View owner="t1" />, runtime);
		await act(async () => {
			await runtime.dispatch(open, "board");
		});
		await act(async () => {
			ctx().expose("blob:board");
		});
		expect(screen.getByText("none:-")).toBeTruthy();
		view.rerender(
			<StrictMode>
				<TreflexProvider value={runtime}>
					<View owner="board" />
				</TreflexProvider>
			</StrictMode>
		);
		expect(screen.getByText("live:blob:board")).toBeTruthy();
	});

	it("follows an accessor, and supplies nothing while it names no owner", async () => {
		const runtime = createRuntime(seed());
		preview(runtime);
		const diags: string[] = [];
		runtime.on("diag", (d) => diags.push(d.code));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let target: string | undefined;
		let supply!: (value: readonly string[]) => Promise<string | undefined>;
		function View() {
			const files = useResource(() => target, "React/Preview");
			supply = files.supply;
			return <p>{files.status.State}</p>;
		}
		mount(<View />, runtime);
		await act(async () => {
			await expect(
				supply([
					"a"
				])
			).resolves.toBeUndefined();
		});
		expect(diags).toContain("resource/supply-dropped");
		target = "board";
		await act(async () => {
			await expect(
				supply([
					"a"
				])
			).resolves.toBeUndefined();
		});
		await act(async () => {
			await runtime.dispatch(open, "board");
		});
		await act(async () => {
			await expect(
				supply([
					"a",
					"b",
					"c"
				])
			).resolves.toBe("board:3");
		});
		warn.mockRestore();
	});
});

describe("ComponentState under StrictMode's double mount", () => {
	it("keeps one entity per mount with a stable id and its state, connects only the kept mount's resource, and leaves none at unmount", async () => {
		const runtime = createRuntime(seed());
		const internal = runtime as IRuntimeInternal<any>;
		const opened: IResourceContext<"react/preview">[] = [];
		runtime.registerResourceType("react/preview", (_params, r) => {
			opened.push(r);
		});
		const componentIds = () =>
			Object.keys(internal.get("runtime/stateIdLookup")()).filter(
				(id) => internal.get("runtime/writeGateway").rootNameOf(id) === "ComponentState"
			);
		const seen = new Set<string>();
		function* start(
			draft: IEntity & {
				Starts: number;
			}
		): IActionGenerator {
			draft.Starts++;
			yield* open(draft);
		}
		function Widget() {
			const local = useComponentState(() => ({
				Starts: 0
			}));
			seen.add(local.id);
			const { dispatch } = local;
			useLayoutEffect(() => {
				void dispatch(start);
			}, [
				dispatch
			]);
			return <p>starts {local.state.Starts}</p>;
		}
		const view = mount(
			<>
				<Widget />
				<Widget />
			</>,
			runtime
		);
		await act(async () => {});
		expect(seen.size).toBe(2);
		expect(componentIds()).toHaveLength(2);
		expect(screen.getAllByText("starts 2")).toHaveLength(2);
		expect(opened).toHaveLength(2);
		expect(runtime.resources()).toHaveLength(2);
		view.unmount();
		await settled();
		expect(componentIds()).toEqual([]);
		expect(runtime.resources()).toEqual([]);
		await settled();
		expect(opened.every((r) => r.signal.aborted)).toBe(true);
	});
});

describe("ComponentState and its owner's removal", () => {
	interface IWidget extends IEntity {
		Count: number;
	}
	function* removeFirst(draft: IBoard): IActionGenerator {
		draft.Tasks = draft.Tasks.filter((task) => task.$Id !== "t1");
	}
	function* bump(draft: IWidget): IActionGenerator {
		draft.Count++;
	}
	const componentIds = (runtime: IRuntime<any>) => {
		const internal = runtime as IRuntimeInternal<any>;
		return Object.keys(internal.get("runtime/stateIdLookup")()).filter(
			(id) => internal.get("runtime/writeGateway").rootNameOf(id) === "ComponentState"
		);
	};

	it("mounts nothing under an owner removed before its seat, and renders the factory's values", async () => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		let widget!: ReturnType<typeof useComponentState<IWidget>>;
		function Remover() {
			useLayoutEffect(() => {
				void runtime.dispatch(removeFirst, "board");
			}, []);
			return null;
		}
		function Widget() {
			widget = useComponentState<IWidget>(() => ({
				Count: 7
			}));
			return (
				<>
					<Remover />
					<p>count {widget.state.Count}</p>
				</>
			);
		}
		const Row = Task.provider(() => <Widget />);
		function Host() {
			const [first] = useState(() => firstTaskRef(runtime));
			return <Row state={first} />;
		}
		const view = mount(<Host />, runtime);
		await act(async () => {});
		expect(runtime.state.Tasks.map((t) => t.$Id)).toEqual([
			"t2"
		]);
		expect(screen.getByText("count 7")).toBeTruthy();
		expect(componentIds(runtime)).toEqual([]);
		await expect(widget.dispatch(bump)).rejects.toThrow(/no entity/);
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it("keeps its last view when its owner goes while it stays mounted, and its feature's selectors hold", async () => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		function* doubled(draft: IWidget): ISelectorGenerator<number> {
			return draft.Count * 2;
		}
		const Counter = createComponentFeature<IWidget>("tests/OwnerGone")(
			{
				bump
			},
			{
				doubled
			}
		);
		let counter!: ReturnType<typeof Counter.use>;
		const CounterView = Counter.provider(
			() => {
				counter = Counter.use();
				return (
					<p>
						count {counter.state.Count} doubled {counter.doubled()}
					</p>
				);
			},
			() => ({
				Count: 1
			})
		);
		const Row = Task.provider(() => <CounterView />);
		function Host() {
			const [first] = useState(() => firstTaskRef(runtime));
			return <Row state={first} />;
		}
		const view = mount(<Host />, runtime);
		await act(async () => {
			await counter.bump();
		});
		expect(screen.getByText("count 2 doubled 4")).toBeTruthy();
		expect(componentIds(runtime)).toHaveLength(1);
		await act(async () => {
			await runtime.dispatch(removeFirst, "board");
		});
		expect(componentIds(runtime)).toEqual([]);
		expect(screen.getByText("count 2 doubled 4")).toBeTruthy();
		await expect(counter.bump()).rejects.toThrow(/no entity/);
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	const pathOf = (runtime: IRuntime<any>, id: string) => (runtime as IRuntimeInternal<any>).get("runtime/stateIdLookup")()[id]?.path;

	it("moves with an unkeyed provider to its new entity, keeping its state, and outlives the old one", async () => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		let widget!: ReturnType<typeof useComponentState<IWidget>>;
		function Widget() {
			widget = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return <p>count {widget.state.Count}</p>;
		}
		const Row = Task.provider(() => <Widget />);
		let show!: (id: string) => void;
		function Host() {
			const [id, setId] = useState("t1");
			show = setId;
			return (
				<Row
					state={{
						$Id: id
					}}
				/>
			);
		}
		const view = mount(<Host />, runtime);
		await act(async () => {
			await widget.dispatch(bump);
		});
		const id = widget.id;
		expect(pathOf(runtime, id)).toEqual([
			"board",
			"t1",
			id
		]);
		await act(async () => {
			show("t2");
		});
		expect(widget.id).toBe(id);
		expect(pathOf(runtime, id)).toEqual([
			"board",
			"t2",
			id
		]);
		expect(screen.getByText("count 1")).toBeTruthy();
		await act(async () => {
			await runtime.dispatch(removeFirst, "board");
		});
		await act(async () => {
			await widget.dispatch(bump);
		});
		expect(screen.getByText("count 2")).toBeTruthy();
		expect(componentIds(runtime)).toEqual([
			id
		]);
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it("starts again from its factory under the new entity when the old one's removal took it first", async () => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		let widget!: ReturnType<typeof useComponentState<IWidget>>;
		function Widget() {
			widget = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return <p>count {widget.state.Count}</p>;
		}
		const Row = Task.provider(() => <Widget />);
		let show!: (id: string) => void;
		function Host() {
			const [id, setId] = useState("t1");
			show = setId;
			return (
				<Row
					state={{
						$Id: id
					}}
				/>
			);
		}
		const view = mount(<Host />, runtime);
		await act(async () => {
			await widget.dispatch(bump);
		});
		const first = widget.id;
		await act(async () => {
			await runtime.dispatch(removeFirst, "board");
		});
		await act(async () => {
			show("t2");
		});
		expect(widget.id).not.toBe(first);
		expect(pathOf(runtime, widget.id)).toEqual([
			"board",
			"t2",
			widget.id
		]);
		expect(screen.getByText("count 0")).toBeTruthy();
		await act(async () => {
			await widget.dispatch(bump);
		});
		expect(screen.getByText("count 1")).toBeTruthy();
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it("keeps working in a list keyed by position when the first row is removed", async () => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		const widgets: ReturnType<typeof useComponentState<IWidget>>[] = [];
		function Widget(props: { index: number }) {
			const widget = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			widgets[props.index] = widget;
			return (
				<p>
					row {props.index} count {widget.state.Count}
				</p>
			);
		}
		const Row = Task.provider((props: { index: number }) => <Widget index={props.index} />);
		function Host() {
			const board = useRoot<IBoard>();
			return (
				<>
					{board.Tasks.map((task, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a list keyed by position is the case under test
						<Row key={index} index={index} state={task} />
					))}
				</>
			);
		}
		const view = mount(<Host />, runtime);
		await act(async () => {});
		await act(async () => {
			await runtime.dispatch(removeFirst, "board");
		});
		const widget = widgets[0]!;
		expect(pathOf(runtime, widget.id)).toEqual([
			"board",
			"t2",
			widget.id
		]);
		await act(async () => {
			await widget.dispatch(bump);
		});
		expect(screen.getByText("row 0 count 1")).toBeTruthy();
		expect(componentIds(runtime)).toEqual([
			widget.id
		]);
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it("in a conditional, moves the state to a new entity that replaces the old one", async () => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		let widget!: ReturnType<typeof useComponentState<IWidget>>;
		function Widget() {
			widget = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return <p>count {widget.state.Count}</p>;
		}
		const Row = Task.provider(() => <Widget />);
		let show!: (ref: IEntityRef<ITask> | null) => void;
		function Host() {
			const [shown, setShown] = useState<IEntityRef<ITask> | null>(() => firstTaskRef(runtime));
			show = setShown;
			return shown && <Row state={shown} />;
		}
		const view = mount(<Host />, runtime);
		await act(async () => {
			await widget.dispatch(bump);
		});
		const id = widget.id;
		await act(async () => {
			await runtime.dispatch(add, "board", "three");
		});
		const added = runtime.state.Tasks[2]!.$Id;
		await act(async () => {
			show({
				$Id: added
			});
		});
		expect(widget.id).toBe(id);
		expect(pathOf(runtime, id)).toEqual([
			"board",
			added,
			id
		]);
		await act(async () => {
			await runtime.dispatch(removeFirst, "board");
		});
		await act(async () => {
			await widget.dispatch(bump);
		});
		expect(screen.getByText("count 2")).toBeTruthy();
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it("seats a fresh entity from the current props when the old owner's removal took it", async () => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		function Widget(props: { label: string }) {
			const widget = useComponentState(() => ({
				Label: props.label
			}));
			return (
				<p>
					prop {props.label} state {widget.state.Label}
				</p>
			);
		}
		const Row = Task.provider((props: { state: IEntityRef<ITask> }) => <Widget label={props.state.$Id} />);
		let show!: (id: string) => void;
		function Host() {
			const [id, setId] = useState("t1");
			show = setId;
			return (
				<Row
					state={{
						$Id: id
					}}
				/>
			);
		}
		const view = mount(<Host />, runtime);
		await act(async () => {});
		expect(screen.getByText("prop t1 state t1")).toBeTruthy();
		await act(async () => {
			await runtime.dispatch(removeFirst, "board");
		});
		await act(async () => {
			show("t2");
		});
		expect(screen.getByText("prop t2 state t2")).toBeTruthy();
		view.unmount();
	});

	function suspending() {
		let pending: Promise<void> | null = null;
		let reveal = () => {};
		let setTick: (tick: number) => void = () => {};
		let tick = 0;
		function Suspender() {
			const [, set] = useState(0);
			setTick = set;
			if (pending) {
				throw pending;
			}
			return null;
		}
		return {
			Suspender,
			hide: async () => {
				pending = new Promise<void>((resolve) => {
					reveal = resolve;
				});
				await act(async () => {
					setTick(++tick);
				});
				expect(screen.getByText("loading")).toBeTruthy();
				await settled();
			},
			show: async () => {
				const hidden = pending;
				pending = null;
				reveal();
				await act(async () => {
					await hidden;
				});
				expect(screen.queryByText("loading")).toBeNull();
			}
		};
	}
	const mountIn = (strict: boolean, node: ReactNode, runtime: IRuntime<any>) => (strict ? mount(node, runtime) : mountPlain(node, runtime));

	it.each([
		false,
		true
	])("resolves a child's layout-effect dispatch to its component feature across a Suspense reveal, StrictMode %s", async (strict) => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		function* bumpPanel(draft: IWidget): IActionGenerator {
			draft.Count++;
		}
		const Panel = createComponentFeature<IWidget>(`tests/RevealPanel/${strict}`)({
			bumpPanel
		});
		const results: Promise<void>[] = [];
		function Child() {
			const panel = Panel.use();
			const bumps = panel.bumpPanel;
			useLayoutEffect(() => {
				results.push(bumps());
			}, [
				bumps
			]);
			return <p>panel {panel.state.Count}</p>;
		}
		const PanelView = Panel.provider(
			() => <Child />,
			() => ({
				Count: 0
			})
		);
		const { Suspender, hide, show } = suspending();
		const view = mountIn(
			strict,
			<Suspense fallback={<p>loading</p>}>
				<PanelView />
				<Suspender />
			</Suspense>,
			runtime
		);
		await act(async () => {});
		const before = results.length;
		await hide();
		await show();
		expect(results.length).toBeGreaterThan(before);
		await expect(Promise.all(results)).resolves.toBeDefined();
		expect(componentIds(runtime)).toHaveLength(1);
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it.each([
		false,
		true
	])("resolves a component state dispatch a child calls in its layout effect across a Suspense reveal, StrictMode %s", async (strict) => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		const results: Promise<void>[] = [];
		function Child(props: { dispatch: (action: typeof bump) => Promise<void> }) {
			const { dispatch } = props;
			useLayoutEffect(() => {
				results.push(dispatch(bump));
			}, [
				dispatch
			]);
			return null;
		}
		let parent!: ReturnType<typeof useComponentState<IWidget>>;
		function Parent() {
			parent = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return <Child dispatch={parent.dispatch} />;
		}
		const { Suspender, hide, show } = suspending();
		const view = mountIn(
			strict,
			<Suspense fallback={<p>loading</p>}>
				<Parent />
				<Suspender />
			</Suspense>,
			runtime
		);
		await act(async () => {});
		const before = results.length;
		await hide();
		await show();
		expect(results.length).toBeGreaterThan(before);
		await expect(Promise.all(results)).resolves.toBeDefined();
		expect(componentIds(runtime)).toEqual([
			parent.id
		]);
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it.each([
		false,
		true
	])("resolves the effect dispatches of component state inside a component feature when one action removes the owner and switches to another, StrictMode %s", async (strict) => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		function* moveOff(
			draft: IBoard & {
				Selected?: string;
			}
		): IActionGenerator {
			draft.Selected = "t2";
			draft.Tasks = draft.Tasks.filter((task) => task.$Id !== "t1");
		}
		const Panel = createComponentFeature<IWidget>(`tests/SwitchPanel/${strict}`)({});
		let panelId = "";
		const dispatched: Promise<void>[] = [];
		const childIds: string[] = [];
		function LayoutChild(props: { rowId: string }) {
			const child = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			childIds[0] = child.id;
			const { dispatch } = child;
			const { rowId } = props;
			useLayoutEffect(() => {
				void rowId;
				dispatched.push(dispatch(bump));
			}, [
				dispatch,
				rowId
			]);
			return null;
		}
		function EffectChild(props: { rowId: string }) {
			const child = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			childIds[1] = child.id;
			const { dispatch } = child;
			const { rowId } = props;
			useEffect(() => {
				void rowId;
				dispatched.push(dispatch(bump));
			}, [
				dispatch,
				rowId
			]);
			return null;
		}
		const PanelView = Panel.provider(
			(props: { rowId: string }) => {
				panelId = Panel.use().state.$Id;
				return (
					<>
						<LayoutChild rowId={props.rowId} />
						<EffectChild rowId={props.rowId} />
					</>
				);
			},
			() => ({
				Count: 0
			})
		);
		const Row = Task.provider((props: { state: IEntityRef<ITask> }) => <PanelView rowId={props.state.$Id} />);
		function Host() {
			const board = useRoot<
				IBoard & {
					Selected?: string;
				}
			>();
			return (
				<Row
					state={{
						$Id: board.Selected ?? "t1"
					}}
				/>
			);
		}
		const view = mountIn(strict, <Host />, runtime);
		await act(async () => {});
		const before = dispatched.length;
		await act(async () => {
			await runtime.dispatch(moveOff, "board");
		});
		await act(async () => {});
		expect(dispatched.length).toBeGreaterThan(before);
		await expect(Promise.all(dispatched.slice(before))).resolves.toBeDefined();
		expect(pathOf(runtime, panelId)).toEqual([
			"board",
			"t2",
			panelId
		]);
		for (const id of childIds) {
			expect(pathOf(runtime, id)).toEqual([
				"board",
				"t2",
				id
			]);
		}
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it.each([
		false,
		true
	])("starts fresh after a Suspense reveal when a cascade took the entity while it showed, StrictMode %s", async (strict) => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		let widget!: ReturnType<typeof useComponentState<IWidget>>;
		function Widget() {
			widget = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return <p>count {widget.state.Count}</p>;
		}
		const Row = Task.provider(() => <Widget />);
		let show!: (id: string) => void;
		function Host(props: { children: ReactNode }) {
			const [id, setId] = useState("t1");
			show = setId;
			return (
				<Suspense fallback={<p>loading</p>}>
					<Row
						state={{
							$Id: id
						}}
					/>
					{props.children}
				</Suspense>
			);
		}
		const { Suspender, hide, show: reveal } = suspending();
		const view = mountIn(
			strict,
			<Host>
				<Suspender />
			</Host>,
			runtime
		);
		await act(async () => {
			await widget.dispatch(bump);
		});
		const first = widget.id;
		await act(async () => {
			await runtime.dispatch(removeFirst, "board");
		});
		await hide();
		await act(async () => {
			show("t2");
		});
		await reveal();
		expect(widget.id).not.toBe(first);
		expect(pathOf(runtime, widget.id)).toEqual([
			"board",
			"t2",
			widget.id
		]);
		expect(screen.getByText("count 0")).toBeTruthy();
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it.each([
		false,
		true
	])("stays under the committed owner while a deferred render to another one is pending, StrictMode %s", async (strict) => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		const internal = runtime as IRuntimeInternal<IBoard>;
		let widget!: ReturnType<typeof useComponentState<IWidget>>;
		function Widget() {
			widget = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return <p>count {widget.state.Count}</p>;
		}
		const Row = Task.provider(() => <Widget />);
		let pending: Promise<void> | null = null;
		function Detail(props: { id: string }) {
			if (props.id === "t2" && pending) {
				throw pending;
			}
			return <p>detail {props.id}</p>;
		}
		let choose!: (id: string) => void;
		function Host() {
			const [selected, setSelected] = useState("t1");
			choose = setSelected;
			const shown = useDeferredValue(selected);
			return (
				<>
					<Row
						state={{
							$Id: shown
						}}
					/>
					<Suspense fallback={<p>loading</p>}>
						<Detail id={shown} />
					</Suspense>
				</>
			);
		}
		const view = mountIn(strict, <Host />, runtime);
		await act(async () => {});
		const id = widget.id;
		let reveal = () => {};
		pending = new Promise<void>((resolve) => {
			reveal = resolve;
		});
		await act(async () => {
			choose("t2");
		});
		expect(screen.getByText("detail t1")).toBeTruthy();
		await act(async () => {
			await widget.dispatch(bump);
		});
		expect(pathOf(runtime, id)).toEqual([
			"board",
			"t1",
			id
		]);
		function* asksOnRow(draft: ITask): IOpenGenerator<string | undefined> {
			return yield* openRegion(
				ask<string>(draft, {
					Path: "Row"
				})
			);
		}
		function* answers(_draft: IWidget, askId: IAskId<string>): IActionGenerator {
			yield* answer(askId, "yes");
		}
		const asking = runtime.dispatch(asksOnRow, "t1");
		await settled();
		const entry = pendingAsksOf(runtime, internal.resolveCell("t1")!.state as ITask)[0]!;
		await act(async () => {
			await widget.dispatch(answers, entry.Id as IAskId<string>);
		});
		await expect(asking).resolves.toBe("yes");
		const hidden = pending;
		pending = null;
		reveal();
		await act(async () => {
			await hidden;
		});
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it.each([
		[
			false,
			"switches then the old owner goes"
		],
		[
			true,
			"switches then the old owner goes"
		],
		[
			false,
			"the old owner goes then it switches"
		],
		[
			true,
			"the old owner goes then it switches"
		],
		[
			false,
			"switches and the old owner stays"
		],
		[
			true,
			"switches and the old owner stays"
		]
	] as const)("while hidden, StrictMode %s, the owner %s: the state moves to the new owner standing at reveal", async (strict, order) => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		let widget!: ReturnType<typeof useComponentState<IWidget>>;
		function Widget() {
			widget = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return <p>count {widget.state.Count}</p>;
		}
		const Row = Task.provider(() => <Widget />);
		let show!: (id: string) => void;
		function Host(props: { children: ReactNode }) {
			const [id, setId] = useState("t1");
			show = setId;
			return (
				<Suspense fallback={<p>loading</p>}>
					<Row
						state={{
							$Id: id
						}}
					/>
					{props.children}
				</Suspense>
			);
		}
		const { Suspender, hide, show: reveal } = suspending();
		const view = mountIn(
			strict,
			<Host>
				<Suspender />
			</Host>,
			runtime
		);
		await act(async () => {
			await widget.dispatch(bump);
		});
		const id = widget.id;
		await hide();
		const switchToT2 = () =>
			act(async () => {
				show("t2");
			});
		const removeT1 = () =>
			act(async () => {
				await runtime.dispatch(removeFirst, "board");
			});
		if (order === "the old owner goes then it switches") {
			await removeT1();
			await switchToT2();
		} else {
			await switchToT2();
			if (order === "switches then the old owner goes") {
				await removeT1();
			}
		}
		await reveal();
		expect(widget.id).toBe(id);
		expect(pathOf(runtime, id)).toEqual([
			"board",
			"t2",
			id
		]);
		expect(screen.getByText("count 1")).toBeTruthy();
		await act(async () => {
			await widget.dispatch(bump);
		});
		expect(screen.getByText("count 2")).toBeTruthy();
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	function* removeSecond(draft: IBoard): IActionGenerator {
		draft.Tasks = draft.Tasks.filter((task) => task.$Id !== "t2");
	}

	it.each([
		false,
		true
	])("while hidden, StrictMode %s, a switch to an owner that goes before reveal shows the factory's values, and the next owner starts fresh", async (strict) => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		await runtime.dispatch(add, "board", "three");
		const t3 = (
			getFrames(runtime).root() as {
				Tasks: IEntityRef<ITask>[];
			}
		).Tasks[2]!.$Id;
		let widget!: ReturnType<typeof useComponentState<IWidget>>;
		function Widget() {
			widget = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return <p>count {widget.state.Count}</p>;
		}
		const Row = Task.provider(() => <Widget />);
		let show!: (id: string) => void;
		function Host(props: { children: ReactNode }) {
			const [id, setId] = useState("t1");
			show = setId;
			return (
				<Suspense fallback={<p>loading</p>}>
					<Row
						state={{
							$Id: id
						}}
					/>
					{props.children}
				</Suspense>
			);
		}
		const { Suspender, hide, show: reveal } = suspending();
		const view = mountIn(
			strict,
			<Host>
				<Suspender />
			</Host>,
			runtime
		);
		await act(async () => {
			await widget.dispatch(bump);
		});
		const id = widget.id;
		await hide();
		await act(async () => {
			show("t2");
		});
		await act(async () => {
			await runtime.dispatch(removeSecond, "board");
		});
		await reveal();
		expect(screen.getByText("count 0")).toBeTruthy();
		expect(componentIds(runtime)).toEqual([]);
		await act(async () => {
			show(t3);
		});
		expect(widget.id).not.toBe(id);
		expect(pathOf(runtime, widget.id)).toEqual([
			"board",
			t3,
			widget.id
		]);
		expect(screen.getByText("count 0")).toBeTruthy();
		await act(async () => {
			await widget.dispatch(bump);
		});
		expect(screen.getByText("count 1")).toBeTruthy();
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it.each([
		false,
		true
	])("while hidden, StrictMode %s, an owner that goes and is still shown at reveal leaves the next owner to start fresh", async (strict) => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		let widget!: ReturnType<typeof useComponentState<IWidget>>;
		function Widget() {
			widget = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return <p>count {widget.state.Count}</p>;
		}
		const Row = Task.provider(() => <Widget />);
		let show!: (id: string) => void;
		function Host(props: { children: ReactNode }) {
			const [id, setId] = useState("t1");
			show = setId;
			return (
				<Suspense fallback={<p>loading</p>}>
					<Row
						state={{
							$Id: id
						}}
					/>
					{props.children}
				</Suspense>
			);
		}
		const { Suspender, hide, show: reveal } = suspending();
		const view = mountIn(
			strict,
			<Host>
				<Suspender />
			</Host>,
			runtime
		);
		await act(async () => {
			await widget.dispatch(bump);
		});
		const id = widget.id;
		await hide();
		await act(async () => {
			await runtime.dispatch(removeFirst, "board");
		});
		await reveal();
		expect(screen.getByText("count 1")).toBeTruthy();
		expect(componentIds(runtime)).toEqual([]);
		await act(async () => {
			show("t2");
		});
		expect(widget.id).not.toBe(id);
		expect(pathOf(runtime, widget.id)).toEqual([
			"board",
			"t2",
			widget.id
		]);
		expect(screen.getByText("count 0")).toBeTruthy();
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it.each([
		false,
		true
	])("while hidden, StrictMode %s, a switch to an owner already gone shows the factory's values at reveal", async (strict) => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		let widget!: ReturnType<typeof useComponentState<IWidget>>;
		function Widget() {
			widget = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return <p>count {widget.state.Count}</p>;
		}
		const Row = Task.provider(() => <Widget />);
		let show!: (id: string) => void;
		function Host(props: { children: ReactNode }) {
			const [id, setId] = useState("t1");
			show = setId;
			return (
				<Suspense fallback={<p>loading</p>}>
					<Row
						state={{
							$Id: id
						}}
					/>
					{props.children}
				</Suspense>
			);
		}
		const { Suspender, hide, show: reveal } = suspending();
		const view = mountIn(
			strict,
			<Host>
				<Suspender />
			</Host>,
			runtime
		);
		await act(async () => {
			await widget.dispatch(bump);
		});
		await hide();
		await act(async () => {
			show("gone");
		});
		await reveal();
		expect(screen.getByText("count 0")).toBeTruthy();
		expect(componentIds(runtime)).toEqual([]);
		await expect(widget.dispatch(bump)).rejects.toThrow(/no entity/);
		expect(screen.getByText("count 0")).toBeTruthy();
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it.each([
		false,
		true
	])("renders the factory's values when the provider switches to an owner already gone, StrictMode %s", async (strict) => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		let widget!: ReturnType<typeof useComponentState<IWidget>>;
		function Widget() {
			widget = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return <p>count {widget.state.Count}</p>;
		}
		const Row = Task.provider(() => <Widget />);
		let show!: (id: string) => void;
		function Host() {
			const [id, setId] = useState("t1");
			show = setId;
			return (
				<Row
					state={{
						$Id: id
					}}
				/>
			);
		}
		const view = mountIn(strict, <Host />, runtime);
		await act(async () => {
			await widget.dispatch(bump);
		});
		expect(screen.getByText("count 1")).toBeTruthy();
		await act(async () => {
			show("gone");
		});
		expect(screen.getByText("count 0")).toBeTruthy();
		expect(componentIds(runtime)).toEqual([]);
		await expect(widget.dispatch(bump)).rejects.toThrow(/no entity/);
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	describe("component features nested three deep", () => {
		interface ILevel extends IEntity {
			Marker: string;
		}
		function* mark(draft: ILevel, value: string): IActionGenerator {
			draft.Marker = value;
		}
		type ILevelUse = {
			state: {
				$Id: string;
				Marker: string;
			};
			mark: (value: string) => Promise<void>;
		};

		function threeLevels(strict: boolean, runtime: IRuntime<IBoard>) {
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
				levels.C = C.use() as ILevelUse;
				levels.outerFromC = A.use() as ILevelUse;
				return <p>c {levels.C.state.Marker}</p>;
			}, marker);
			const BView = B.provider(() => {
				levels.B = B.use() as ILevelUse;
				return (
					<>
						<p>b {levels.B.state.Marker}</p>
						<CView />
					</>
				);
			}, marker);
			const AView = A.provider(() => {
				levels.A = A.use() as ILevelUse;
				return (
					<>
						<p>a {levels.A.state.Marker}</p>
						<BView />
					</>
				);
			}, marker);
			const Row = Task.provider(() => <AView />);
			const { Suspender, hide, show } = suspending();
			let showRow!: (id: string) => void;
			function Host() {
				const [id, setId] = useState("t1");
				showRow = setId;
				return (
					<Suspense fallback={<p>loading</p>}>
						<Row
							state={{
								$Id: id
							}}
						/>
						<Suspender />
					</Suspense>
				);
			}
			const view = mountIn(strict, <Host />, runtime);
			const ids = () => [
				levels.A!.state.$Id,
				levels.B!.state.$Id,
				levels.C!.state.$Id
			];
			const markAll = () =>
				act(async () => {
					await levels.A!.mark("a!");
					await levels.B!.mark("b!");
					await levels.C!.mark("c!");
				});
			const marked = () => ids().map((id) => ((runtime as IRuntimeInternal<IBoard>).resolveCell(id)?.state as ILevel | undefined)?.Marker);
			return {
				levels,
				view,
				hide,
				show,
				ids,
				markAll,
				marked,
				switchTo: (id: string) =>
					act(async () => {
						showRow(id);
					})
			};
		}

		it.each([
			false,
			true
		])("sit each directly under the tree owner, StrictMode %s", async (strict) => {
			const runtime = createRuntime(seed(), {
				verifyIndex: true
			});
			const w = threeLevels(strict, runtime);
			await act(async () => {});
			for (const id of w.ids()) {
				expect(pathOf(runtime, id)).toEqual([
					"board",
					"t1",
					id
				]);
			}
			w.view.unmount();
			await settled();
			expect(componentIds(runtime)).toEqual([]);
		});

		it.each([
			false,
			true
		])("keep every level's state across a Suspense hide and reveal, StrictMode %s", async (strict) => {
			const runtime = createRuntime(seed(), {
				verifyIndex: true
			});
			const w = threeLevels(strict, runtime);
			await act(async () => {});
			await w.markAll();
			const ids = w.ids();
			await w.hide();
			await w.show();
			expect(w.ids()).toEqual(ids);
			expect(w.marked()).toEqual([
				"a!",
				"b!",
				"c!"
			]);
			expect(screen.getByText("c c!")).toBeTruthy();
			w.view.unmount();
			await settled();
			expect(componentIds(runtime)).toEqual([]);
		});

		it.each([
			false,
			true
		])("leave the inner entities alone when the outer one's mount is removed, StrictMode %s", async (strict) => {
			const runtime = createRuntime(seed(), {
				verifyIndex: true
			});
			const w = threeLevels(strict, runtime);
			await act(async () => {});
			const [outer, middle, inner] = w.ids();
			(runtime as IRuntimeInternal<IBoard>).unmountComponent(outer!);
			expect(componentIds(runtime).sort()).toEqual(
				[
					middle,
					inner
				].sort()
			);
			w.view.unmount();
			await settled();
			expect(componentIds(runtime)).toEqual([]);
		});

		it.each([
			false,
			true
		])("all move with their state when the tree owner switches, StrictMode %s", async (strict) => {
			const runtime = createRuntime(seed(), {
				verifyIndex: true
			});
			const w = threeLevels(strict, runtime);
			await act(async () => {});
			await w.markAll();
			const ids = w.ids();
			await w.switchTo("t2");
			expect(w.ids()).toEqual(ids);
			for (const id of ids) {
				expect(pathOf(runtime, id)).toEqual([
					"board",
					"t2",
					id
				]);
			}
			expect(w.marked()).toEqual([
				"a!",
				"b!",
				"c!"
			]);
			w.view.unmount();
			await settled();
			expect(componentIds(runtime)).toEqual([]);
		});

		it.each([
			false,
			true
		])("all go with the tree owner's removal, StrictMode %s", async (strict) => {
			const runtime = createRuntime(seed(), {
				verifyIndex: true
			});
			const w = threeLevels(strict, runtime);
			await act(async () => {});
			await act(async () => {
				await runtime.dispatch(removeFirst, "board");
			});
			expect(componentIds(runtime)).toEqual([]);
			w.view.unmount();
			await settled();
			expect(componentIds(runtime)).toEqual([]);
		});

		it.each([
			false,
			true
		])("let the innermost call the outer widget's actions through its use(), StrictMode %s", async (strict) => {
			const runtime = createRuntime(seed(), {
				verifyIndex: true
			});
			const w = threeLevels(strict, runtime);
			await act(async () => {});
			await act(async () => {
				await w.levels.outerFromC!.mark("from c");
			});
			expect(w.marked()[0]).toBe("from c");
			expect(screen.getByText("a from c")).toBeTruthy();
			w.view.unmount();
			await settled();
			expect(componentIds(runtime)).toEqual([]);
		});
	});

	it.each([
		false,
		true
	])("mounts a widget under a tree provider over a component's nested entity beneath the nearest tree owner, StrictMode %s", async (strict) => {
		interface IItem extends IEntity {
			Label: string;
		}
		interface IList extends IEntity {
			Item: IItem | null;
		}
		function* makeItem(draft: IList): IActionGenerator {
			draft.Item = yield* entity<IItem>({
				Label: "item"
			});
		}
		const Item = createEntityFeature<IItem>("tests/NestedItem")({});
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		let list!: ReturnType<typeof useComponentState<IList>>;
		let inner!: ReturnType<typeof useComponentState<IWidget>>;
		function Inner() {
			inner = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return <p>inner {inner.state.Count}</p>;
		}
		const ItemView = Item.provider(() => <Inner />);
		function List() {
			list = useComponentState<IList>(() => ({
				Item: null
			}));
			return list.state.Item ? <ItemView state={list.state.Item} /> : null;
		}
		const Row = Task.provider(() => <List />);
		const view = mountIn(strict, <Row state={firstTaskRef(runtime)} />, runtime);
		await act(async () => {
			await list.dispatch(makeItem);
		});
		const itemId = list.state.Item!.$Id;
		expect((runtime as IRuntimeInternal<IBoard>).get("runtime/writeGateway").rootNameOf(itemId)).toBe("ComponentState");
		expect(pathOf(runtime, inner.id)).toEqual([
			"board",
			"t1",
			inner.id
		]);
		await act(async () => {
			await inner.dispatch(bump);
		});
		expect(screen.getByText("inner 1")).toBeTruthy();
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it("keeps a child's state working after Suspense hides and reveals it, outside StrictMode", async () => {
		const runtime = createRuntime(seed(), {
			verifyIndex: true
		});
		let child!: ReturnType<typeof useComponentState<IWidget>>;
		function Child() {
			child = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return <p>child {child.state.Count}</p>;
		}
		const Panel = createComponentFeature<
			IEntity & {
				Open: boolean;
			}
		>("tests/SuspensePanel")({});
		const PanelView = Panel.provider(
			() => <Child />,
			() => ({
				Open: false
			})
		);
		let pending: Promise<void> | null = null;
		function Suspender(_props: { tick: number }) {
			if (pending) {
				throw pending;
			}
			return null;
		}
		let setTick!: (tick: number) => void;
		function Host() {
			const [tick, set] = useState(0);
			setTick = set;
			return (
				<Suspense fallback={<p>loading</p>}>
					<PanelView />
					<Suspender tick={tick} />
				</Suspense>
			);
		}
		const view = render(
			<TreflexProvider value={runtime}>
				<Host />
			</TreflexProvider>
		);
		await act(async () => {});
		let reveal!: () => void;
		pending = new Promise<void>((resolve) => {
			reveal = resolve;
		});
		await act(async () => {
			setTick(1);
		});
		expect(screen.getByText("loading")).toBeTruthy();
		await settled();
		const hidden = pending;
		pending = null;
		reveal();
		await act(async () => {
			await hidden;
		});
		expect(screen.queryByText("loading")).toBeNull();
		await act(async () => {
			await child.dispatch(bump);
		});
		expect(screen.getByText("child 1")).toBeTruthy();
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
	});

	it.each([
		true,
		false
	])("starts a dispatch a real unmount's leftovers make, then stops it and leaves nothing seated, StrictMode %s", async (strict) => {
		interface IHang extends IEffect {
			Type: "react-test/hang";
		}
		const hang = defineEffect<IHang, void>("react-test/hang");
		const runtime = createRuntime(seed());
		runtime.registerImplementation(implementation(hang, () => new Promise<void>(() => {})));
		function* hangs(draft: IWidget): IActionGenerator<string> {
			draft.Count++;
			yield* hang();
			return "finished";
		}
		let widget!: ReturnType<typeof useComponentState<IWidget>>;
		function Widget() {
			widget = useComponentState<IWidget>(() => ({
				Count: 0
			}));
			return null;
		}
		const view = strict ? mount(<Widget />, runtime) : mountPlain(<Widget />, runtime);
		await act(async () => {});
		const { dispatch } = widget;
		view.unmount();
		await settled();
		expect(componentIds(runtime)).toEqual([]);
		const leftover = dispatch(hangs);
		expect(componentIds(runtime)).toEqual([
			widget.id
		]);
		await settled();
		expect(componentIds(runtime)).toEqual([]);
		await expect(leftover).resolves.toBeUndefined();
	});
});

function firstTaskRef(runtime: IRuntime<IBoard>): IEntityRef<ITask> {
	return (
		getFrames(runtime).root() as {
			Tasks: IEntityRef<ITask>[];
		}
	).Tasks[0]!;
}
