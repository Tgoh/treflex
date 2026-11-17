import type { IActionGenerator } from "../../src/Types/IAction";
import { expect, it, vi } from "vitest";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { rawReceiver } from "../testHelpers";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

const Noop = rawReceiver(
	"PlainNoopProduction",
	[
		"Plain/Topic"
	],
	function* noop(): IActionGenerator {}
);

it("fires in a production build", async () => {
	const runtime = createRuntime<any>({
		$Id: "root",
		Rows: [
			{
				$Id: "row-1"
			}
		]
	});
	runtime.registerReceiver(Noop);
	const codes: string[] = [];
	runtime.on("diag", (event) => codes.push(event.code));
	await runtime.dispatch(function* attach(draft: any): IActionGenerator {
		bind(draft, Noop);
	}, "row-1");

	await runtime.dispatch(function* refresh(draft: any): IActionGenerator {
		draft.Rows = [
			{
				Name: "fetched"
			}
		];
	}, "root");

	expect(codes).toContain("entity/replaced-by-plain-data");
	runtime.dispose();
});
