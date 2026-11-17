import { $TRACK, For } from "solid-js";
import { render } from "solid-js/web";
import { createRuntime, generateGuid, type IActionGenerator, type IEntity, type ISelectorGenerator } from "treflex";
import { DEV, solidTrack } from "treflex/internal";
import { createEntityFeature, TreflexProvider } from "treflex-solid";
import { expect, report, waitFor } from "../../shared/report.js";

interface ITodoList extends IEntity {
	Todos: { Id: string; Text: string; Done: boolean }[];
	Draft: string;
}

function* add(draft: ITodoList): IActionGenerator {
	const text = draft.Draft.trim();
	if (!text) return;
	draft.Draft = "";
	draft.Todos.push({ Id: yield* generateGuid(), Text: text, Done: false });
}

function* toggle(draft: ITodoList, id: string): IActionGenerator {
	const todo = draft.Todos.find((t) => t.Id === id);
	if (todo) todo.Done = !todo.Done;
}

function* remaining(draft: ITodoList): ISelectorGenerator<number> {
	return draft.Todos.filter((t) => !t.Done).length;
}

const TodoList = createEntityFeature<ITodoList>(import.meta.url)({ add, toggle }, { remaining });

const App = TodoList.provider(() => {
	const todo = TodoList.use();
	return (
		<div>
			<p id="remaining">{todo.remaining()} remaining</p>
			<For each={todo.state.Todos}>
				{(t) => (
					<label>
						<input type="checkbox" checked={t.Done} onChange={() => todo.toggle(t.Id)} />
						{t.Text}
					</label>
				)}
			</For>
		</div>
	);
});

report(async () => {
	const runtime = createRuntime<ITodoList>({ $Id: "TodoList", Todos: [], Draft: "Buy milk" });
	const root = document.createElement("div");
	document.body.append(root);
	render(
		() => (
			<TreflexProvider value={runtime}>
				<App state={runtime.state} />
			</TreflexProvider>
		),
		root
	);
	const remainingText = () => root.querySelector("#remaining")?.textContent;
	expect(remainingText() === "0 remaining", "the first render to read the seed");

	await runtime.dispatch(add, "TodoList");
	await waitFor(() => remainingText() === "1 remaining" && root.textContent.includes("Buy milk"), "the view to show the added todo");

	const box = root.querySelector("input[type=checkbox]") as HTMLInputElement;
	box.click();
	await waitFor(() => remainingText() === "0 remaining", "the view's toggle to dispatch and re-render");

	return { dev: DEV, oneSolid: solidTrack === $TRACK };
});
