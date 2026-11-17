// @vitest-environment jsdom
import type { IActionGenerator } from "treflex";
import { createTestRuntime, settled } from "treflex";
import { it } from "vitest";

function* fails(_draft: object): IActionGenerator {
	throw new Error("boom");
}

it("jsdom: fails on a failure nothing awaits", async () => {
	const runtime = createTestRuntime({
		$Id: "Root"
	});
	void runtime.dispatch(fails, "Root");
	await settled();
});

it("jsdom: passes beside it", () => {});
