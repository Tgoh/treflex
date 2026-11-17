import {
	createRuntime,
	external,
	generateGuid,
	type IActionGenerator,
	type IActivityLogEntry,
	type IEntity,
	type IRuntimeServiceKey,
	publish
} from "treflex";
import { DEV } from "treflex/internal";
import { createSnapshot, restoreRuntime } from "treflex/snapshot";
import { expect, report } from "../../shared/report.js";

declare module "treflex" {
	interface IMessageRegistry {
		"Todo/Added": { Text: string };
	}
}

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

export function* announce(draft: ITodoList): IActionGenerator {
	yield* publish("Todo/Added", { Text: draft.Draft });
	// @ts-expect-error The augmentation above types the topic's payload.
	yield* publish("Todo/Added", { Txt: draft.Draft });
}

// The keys below come from treflex's own `declare module` augmentations, which
// a resolution that can't follow their specifiers drops, leaving `never`.
export function* readsTheActivityLog(): IActionGenerator {
	const log: readonly IActivityLogEntry[] | undefined = yield* external("ActivityLog");
	void log;
}
export const journalKey: IRuntimeServiceKey = "runtime/journal";

report(async () => {
	const runtime = createRuntime<ITodoList>({ $Id: "TodoList", Todos: [], Draft: "Buy milk" });
	await runtime.dispatch(add, "TodoList");
	expect(runtime.state.Todos.length === 1 && runtime.state.Todos[0].Text === "Buy milk", "add to write the todo");

	const { runtime: restored } = await restoreRuntime<ITodoList>(createSnapshot(runtime), { rootId: "TodoList", options: {} });
	expect(restored.state.Todos[0].Text === "Buy milk", "the restored runtime to hold the todo");

	return { dev: DEV };
});
