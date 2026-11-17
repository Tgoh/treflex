import type { IActionGenerator } from "treflex";
import { createTestRuntime, settled } from "treflex";
import { afterAll, it } from "vitest";

function* fails(_draft: object): IActionGenerator {
	throw new Error("boom");
}

it("afterAll: passes itself", () => {});

// A file's own afterAll runs ahead of treflex/vitest's, which Vitest runs last.
afterAll(async () => {
	const runtime = createTestRuntime({
		$Id: "Root"
	});
	void runtime.dispatch(fails, "Root");
	await settled();
});
