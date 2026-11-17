import type { IActionGenerator } from "treflex";
import { createTestRuntime, settled } from "treflex";
import { it, vi } from "vitest";

function* fails(_draft: object): IActionGenerator {
	throw new Error("boom");
}

it("node: fails on a failure nothing awaits", async () => {
	const runtime = createTestRuntime({
		$Id: "Root"
	});
	void runtime.dispatch(fails, "Root");
	await settled();
});

it("node: passes beside it", () => {});

it("node: fails on a failure that lands as the test ends", () => {
	const runtime = createTestRuntime({
		$Id: "Root"
	});
	void runtime.dispatch(fails, "Root");
});

it("node: passes after it, allowing the failure it awaits", async () => {
	const runtime = createTestRuntime(
		{
			$Id: "Root"
		},
		{},
		{
			allowFailures: [
				fails
			]
		}
	);
	await runtime.dispatch(fails, "Root").catch(() => {});
});

it("node: fails on a failure under fake timers", async () => {
	vi.useFakeTimers();
	try {
		const runtime = createTestRuntime({
			$Id: "Root"
		});
		void runtime.dispatch(fails, "Root");
		await settled();
	} finally {
		vi.useRealTimers();
	}
});

it("node: passes last", () => {});
