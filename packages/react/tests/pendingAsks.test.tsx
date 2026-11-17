import type { IActionGenerator, IAskEntry, IAskId, IEntity, ISelectorGenerator } from "treflex";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { answer, ask, createRuntime, open, pendingAsks } from "treflex";
import { afterEach, describe, expect, it } from "vitest";
import { createEntityFeature, TreflexProvider, useEntity } from "../src";

type IAnswer = "yes" | "no" | undefined;

interface IRow extends IEntity {
	Name: string;
}

interface IRoot extends IEntity {
	Result: string | null;
	Rows: IRow[];
}

function* asksOnRow(draft: IRoot, path: string) {
	const answered = yield* open(
		ask<IAnswer>(draft.Rows[0]!, {
			Path: path
		})
	);
	draft.Result = String(answered);
}

function* pending(draft: IRoot): ISelectorGenerator<readonly IAskEntry[]> {
	return yield* pendingAsks(draft);
}

const Dialogs = createEntityFeature<IRoot>()(
	{},
	{
		pending
	}
);

function* answers(_owner: IEntity, id: IAskId<IAnswer>, value: IAnswer): IActionGenerator {
	yield* answer(id, value);
}

afterEach(() => {
	cleanup();
});

describe("a React view rendering pendingAsks(...)", () => {
	it("lists the pending asks through a selector, keyed by id, and a click on the owner answers", async () => {
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
		const Dialog = Dialogs.provider(() => {
			const listed = Dialogs.use().pending();
			if (listed.length === 0) return <p>no dialog</p>;
			return (
				<>
					{listed.map((entry) => (
						<button
							key={entry.Id}
							type="button"
							onClick={() => void runtime.dispatch(answers, entry.OwnerId, entry.Id as IAskId<IAnswer>, "yes")}
						>
							{
								(
									entry.Request as {
										Path: string;
									}
								).Path
							}
						</button>
					))}
				</>
			);
		});
		render(
			<TreflexProvider value={runtime}>
				<Dialog
					state={{
						$Id: "root"
					}}
				/>
			</TreflexProvider>
		);
		expect(screen.getByText("no dialog")).toBeTruthy();

		let asking!: Promise<void>;
		await act(async () => {
			asking = runtime.dispatch(asksOnRow, "root", "Demo/Confirm");
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const button = screen.getByText("Demo/Confirm");
		await act(async () => {
			fireEvent.click(button);
			await asking;
		});

		expect(runtime.state.Result).toBe("yes");
		expect(screen.getByText("no dialog")).toBeTruthy();
	});

	it("renders the owner as its entity's view, whose action answers", async () => {
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
		function Body(props: { entry: IAskEntry }) {
			const row = useEntity<IRow>(props.entry.OwnerId);
			if (!row) return <p>no row</p>;
			return (
				<button type="button" onClick={() => void runtime.dispatch(answers, row.$Id, props.entry.Id as IAskId<IAnswer>, "no")}>
					answer {row.Name}
				</button>
			);
		}
		const Dialog = Dialogs.provider(() => {
			const listed = Dialogs.use().pending();
			return listed.length > 0 ? <Body entry={listed[0]!} /> : <p>no dialog</p>;
		});
		render(
			<TreflexProvider value={runtime}>
				<Dialog
					state={{
						$Id: "root"
					}}
				/>
			</TreflexProvider>
		);

		let asking!: Promise<void>;
		await act(async () => {
			asking = runtime.dispatch(asksOnRow, "root", "Demo/Row");
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await act(async () => {
			fireEvent.click(screen.getByText("answer first"));
			await asking;
		});

		expect(runtime.state.Result).toBe("no");
		expect(screen.getByText("no dialog")).toBeTruthy();
	});
});
