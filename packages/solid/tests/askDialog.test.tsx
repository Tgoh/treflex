import type { JSX } from "solid-js";
import type { IActionGenerator, IAskEntry, IAskId, IEntity, IRuntime, ISelectorGenerator } from "treflex";
import { createRoot, For } from "solid-js";
import { AnswerOutsideOwnerError, answer, ask, createRuntime, open, pendingAsks } from "treflex";
import { describe, expect, it } from "vitest";
import { createEntityFeature } from "../src/Context/createEntityFeature";
import { TreflexProvider, useDispatch } from "../src/Context/TreflexContext";
import { useComponentState } from "../src/Hooks/useComponentState";
import { pendingAsksOf } from "./treeWrite";

type IAnswer = "yes" | "no" | undefined;

interface IRow extends IEntity {
	Name: string;
}

interface IRoot extends IEntity {
	Result: string | null;
	Rows: IRow[];
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function* asksOnRow(draft: IRoot) {
	const answered = yield* open(
		ask<IAnswer>(draft.Rows[0]!, {
			Path: "Confirm"
		})
	);
	draft.Result = String(answered);
}

function* answers(_owner: IEntity, id: IAskId<IAnswer>, value: IAnswer): IActionGenerator {
	yield* answer(id, value);
}

function* openAsks(draft: IRoot): ISelectorGenerator<readonly IAskEntry[]> {
	return yield* pendingAsks(draft);
}

const Screen = createEntityFeature<IRoot>("tests/askDialog/Screen")(
	{},
	{
		openAsks
	}
);
const Row = createEntityFeature<IRow>("tests/askDialog/Row")({});

type IButtons = Record<string, () => Promise<unknown>>;

// The dialog a view renders for an open ask: its buttons stand in for DOM clicks.
function mount(runtime: IRuntime<IRoot>, Dialog: (props: { entry: IAskEntry; buttons: IButtons }) => JSX.Element) {
	const buttons: IButtons = {};
	const View = Screen.provider(() => {
		const screen = Screen.use();
		return <For each={screen.openAsks()}>{(entry) => <Dialog entry={entry} buttons={buttons} />}</For>;
	});
	const dispose = createRoot((disposer) => {
		TreflexProvider({
			value: runtime,
			get children() {
				return <View state={runtime.state} />;
			}
		});
		return disposer;
	});
	return {
		buttons,
		dispose
	};
}

describe("change 5 in Solid: a dialog answers an ask by dispatching at its owner", () => {
	it("answers through the provider's dispatch at entry.OwnerId, and a dispatch above the owner is refused", async () => {
		const runtime = createRuntime<IRoot>({
			$Id: "root",
			Result: null,
			Rows: [
				{
					$Id: "row",
					Name: "first"
				}
			]
		});
		const { buttons, dispose } = mount(runtime, (props) => {
			const dispatch = useDispatch();
			const id = props.entry.Id as IAskId<IAnswer>;
			props.buttons.yes = () => dispatch(answers, props.entry.OwnerId, id, "yes");
			props.buttons.above = () => dispatch(answers, "root", id, "no");
			return null;
		});
		const asking = runtime.dispatch(asksOnRow, "root");
		await settle();

		await expect(buttons.above!()).rejects.toBeInstanceOf(AnswerOutsideOwnerError);
		await buttons.yes!();
		await asking;

		expect(runtime.state.Result).toBe("yes");
		expect(pendingAsksOf(runtime, runtime.state)).toEqual([]);
		dispose();
	});

	it("answers from a dialog's own component state mounted under the owner's provider", async () => {
		const runtime = createRuntime<IRoot>({
			$Id: "root",
			Result: null,
			Rows: [
				{
					$Id: "row",
					Name: "first"
				}
			]
		});
		const RowDialog = Row.provider((props: { entry: IAskEntry; buttons: IButtons }) => {
			const local = useComponentState(() => ({
				Choice: "yes" as IAnswer
			}));
			props.buttons.local = () => local.dispatch(answers, props.entry.Id as IAskId<IAnswer>, local.state.Choice);
			return null;
		});
		const { buttons, dispose } = mount(runtime, (props) => {
			const row = runtime.state.Rows.find((r) => r.$Id === props.entry.OwnerId)!;
			return <RowDialog state={row} entry={props.entry} buttons={props.buttons} />;
		});
		const asking = runtime.dispatch(asksOnRow, "root");
		await settle();

		await buttons.local!();
		await asking;

		expect(runtime.state.Result).toBe("yes");
		dispose();
	});
});
