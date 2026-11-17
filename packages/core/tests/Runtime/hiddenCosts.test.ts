import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDataSource } from "../../src/Effects/registerDataSource";
import { getData, select } from "../../src/index";
import { createRuntime } from "../../src/Runtime/createRuntime";

interface IRow {
	$Id: string;
	Title: string;
}

interface IList {
	$Id: string;
	Rows: IRow[];
}

const seed = (count: number): IList => ({
	$Id: "list",
	Rows: Array.from(
		{
			length: count
		},
		(_, i) => ({
			$Id: `row-${i}`,
			Title: "t"
		})
	)
});

function build(count: number) {
	const runtime = createRuntime<IList>(seed(count)) as IRuntimeInternal<IList>;
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	return {
		runtime,
		diags,
		codes: () => diags.map((event) => event.code)
	};
}

function* titles(draft: IList): ISelectorGenerator<string[]> {
	return draft.Rows.map((row) => row.Title);
}

function* first(draft: IList): ISelectorGenerator<string | undefined> {
	return draft.Rows[0]?.Title;
}

function* everyRow(draft: IList): ISelectorGenerator<IRow[]> {
	return draft.Rows;
}

function* readsAll(_draft: IList): IActionGenerator {
	yield* select(everyRow);
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const MANY_ROWS = 30_000;

describe("selector/many-tracked-reads", () => {
	it("reports a whole-list selector, once per selector, with the count", () => {
		const { runtime, diags, codes } = build(MANY_ROWS);
		const read = () => runtime.runSelector(titles, () => runtime.state);
		read();
		read();
		expect(codes()).toEqual([
			"selector/many-tracked-reads"
		]);
		expect(diags[0]!.data).toMatchObject({
			selector: "titles"
		});
		expect(diags[0]!.data!.trackedReads as number).toBeGreaterThan(MANY_ROWS * 2);
		expect(diags[0]!.message).toContain('Selector "titles"');
	});

	it("reports each selector of its own", () => {
		const { runtime, codes } = build(MANY_ROWS);
		function* titlesAgain(draft: IList): ISelectorGenerator<string[]> {
			return draft.Rows.map((row) => row.Title);
		}
		runtime.runSelector(titles, () => runtime.state);
		runtime.runSelector(titlesAgain, () => runtime.state);
		expect(codes()).toHaveLength(2);
	});

	it("reports each function of its own, a second one under the same name included", () => {
		const { runtime, diags } = build(MANY_ROWS);
		const sameName = {
			titles: function* (draft: IList): ISelectorGenerator<string[]> {
				return draft.Rows.map((row) => row.Title);
			}
		}.titles;
		runtime.runSelector(titles, () => runtime.state);
		runtime.runSelector(sameName, () => runtime.state);
		expect(diags.map((event) => event.data!.selector)).toEqual([
			"titles",
			"titles"
		]);
	});

	it("says nothing for a selector that reads a little of a long list", () => {
		const { runtime, codes } = build(MANY_ROWS);
		runtime.runSelector(first, () => runtime.state);
		expect(codes()).toEqual([]);
	});

	it("says nothing for an ordinary list", () => {
		const { runtime, codes } = build(1_000);
		runtime.runSelector(titles, () => runtime.state);
		expect(codes()).toEqual([]);
	});

	it("counts a nested selector's reads as that selector's and one read for its caller", () => {
		const { runtime, diags } = build(MANY_ROWS);
		function* outer(draft: IList): ISelectorGenerator<number> {
			const nested: string[] = yield* select(titles);
			return nested.length + draft.Rows.length;
		}
		runtime.runSelector(outer, () => runtime.state);
		expect(diags.map((event) => event.data!.selector)).toEqual([
			"titles"
		]);
	});
});

describe("action/large-read-copy", () => {
	it("reports a large select from an action, once per action name, naming a narrow select", async () => {
		const { runtime, diags, codes } = build(MANY_ROWS);
		await runtime.dispatch(readsAll, "list");
		await runtime.dispatch(readsAll, "list");
		expect(codes().filter((code) => code === "action/large-read-copy")).toHaveLength(1);
		const event = diags.find((d) => d.code === "action/large-read-copy")!;
		expect(event.data).toMatchObject({
			actionName: "readsAll",
			type: "select"
		});
		expect(event.data!.copied as number).toBeGreaterThan(MANY_ROWS);
		expect(event.message).toContain("narrow select");
	});

	it("reports a large getData", async () => {
		const { runtime, codes } = build(MANY_ROWS);
		function* publishes(draft: IList): IActionGenerator {
			yield* (registerDataSource as any)(draft, "HiddenCosts/List");
		}
		function* readsSource(draft: IList): IActionGenerator {
			yield* (getData as any)(draft, "HiddenCosts/List");
		}
		await runtime.dispatch(publishes, "list");
		await runtime.dispatch(readsSource, "list");
		expect(codes()).toContain("action/large-read-copy");
	});

	it("says nothing for a narrow select of the same list", async () => {
		const { runtime, codes } = build(MANY_ROWS);
		function* readsOne(_draft: IList): IActionGenerator {
			yield* select(first);
		}
		await runtime.dispatch(readsOne, "list");
		expect(codes()).not.toContain("action/large-read-copy");
	});
});
