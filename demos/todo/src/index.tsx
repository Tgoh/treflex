import { createRuntime, generateGuid, type IActionGenerator, type IEntity, type ISelectorGenerator } from "treflex";
import { createEntityFeature, TreflexProvider } from "treflex-solid";
import { For } from "solid-js";
import { render } from "solid-js/web";

interface ITodo {
	Id: string;
	Text: string;
	Done: boolean;
}

interface ITodoList extends IEntity {
	Todos: ITodo[];
	Draft: string;
}

function getDefaultState(id: string): ITodoList {
	return { $Id: id, Todos: [], Draft: "" };
}

function* setDraft(draft: ITodoList, text: string): IActionGenerator {
	draft.Draft = text;
}

function* add(draft: ITodoList): IActionGenerator {
	const text = draft.Draft.trim();
	if (!text) return;
	draft.Draft = "";
	draft.Todos.push({
		Id: yield* generateGuid(),
		Text: text,
		Done: false
	});
}

function* toggle(draft: ITodoList, id: string): IActionGenerator {
	const todo = draft.Todos.find((t) => t.Id === id);
	if (todo) todo.Done = !todo.Done;
}

function* remaining(draft: ITodoList): ISelectorGenerator<number> {
	return draft.Todos.filter((t) => !t.Done).length;
}

const TodoList = createEntityFeature<ITodoList>("TodoList")(
	{ setDraft, add, toggle },
	{ remaining }
);

const App = TodoList.provider(() => {
	const todo = TodoList.use();
	return (
		<div>
			<input
				value={todo.state.Draft}
				onInput={(e) => todo.setDraft(e.currentTarget.value)}
				onKeyDown={(e) => e.key === "Enter" && todo.add()}
			/>
			<button onClick={() => todo.add()}>Add</button>
			<p>{todo.remaining()} remaining</p>
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

const runtime = createRuntime<ITodoList>(getDefaultState("TodoList"));

render(
	() => (
		<TreflexProvider value={runtime}>
			<App state={runtime.state} />
		</TreflexProvider>
	),
	document.getElementById("root") as HTMLElement
);
