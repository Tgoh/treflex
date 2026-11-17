import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEntity } from "../../src/Types/IEntity";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { expect, it, vi } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

interface IDoc extends IEntity {
	Title: string;
}

interface ISession extends IEntity {
	Docs: IDoc[];
}

it("reports nothing in production", async () => {
	const runtime = createRuntime<ISession>({
		$Id: "session",
		Docs: [
			{
				$Id: "doc",
				Title: "old"
			}
		]
	});
	let release!: () => void;
	runtime.registerImplementation(
		"park",
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			})
	);
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (diag) => diags.push(diag));
	const saving = runtime.dispatch(function* save(draft: IDoc): IActionGenerator<string> {
		yield {
			Type: "park"
		};
		return draft.Title;
	}, "doc");
	await runtime.dispatch(function* retitle(draft: ISession): IActionGenerator {
		draft.Docs[0]!.Title = "new";
	}, "session");
	release();
	await expect(saving).resolves.toBe("new");
	expect(diags).toEqual([]);
});
