import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { describe, expect, it, vi } from "vitest";
import { select } from "../../src/Reads/select";
import { createRuntime } from "../../src/Runtime/createRuntime";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

interface IRow {
	$Id: string;
	Title: string;
}

interface IList {
	$Id: string;
	Rows: IRow[];
}

function* titles(draft: IList): ISelectorGenerator<string[]> {
	return draft.Rows.map((row) => row.Title);
}

function* everyRow(draft: IList): ISelectorGenerator<IRow[]> {
	return draft.Rows;
}

function* readsAll(_draft: IList): IActionGenerator {
	yield* select(everyRow);
}

describe("hidden-cost diags in production", () => {
	it("stay silent", async () => {
		const runtime = createRuntime<IList>({
			$Id: "list",
			Rows: Array.from(
				{
					length: 30_000
				},
				(_, i) => ({
					$Id: `row-${i}`,
					Title: "t"
				})
			)
		}) as IRuntimeInternal<IList>;
		const diags: IRuntimeEventOf<"diag">[] = [];
		runtime.on("diag", (event) => diags.push(event));
		runtime.runSelector(titles, () => runtime.state);
		await runtime.dispatch(readsAll, "list");
		expect(diags).toEqual([]);
	});
});
