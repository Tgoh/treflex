// @vitest-environment jsdom
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";

async function crossed(thrown: unknown): Promise<{
	caught: unknown;
	diags: IRuntimeEventOf<"diag">[];
}> {
	const runtime = createRuntime(
		{
			$Id: "root"
		},
		{
			onError: () => {},
			implementations: {
				"t/fetch": () => Promise.reject(thrown)
			}
		}
	);
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	let caught: unknown = "nothing caught";
	await runtime.dispatch(function* fetches(): IActionGenerator {
		try {
			yield {
				Type: "t/fetch"
			} as never;
		} catch (error) {
			caught = error;
		}
	}, "root");
	return {
		caught,
		diags
	};
}

describe("a DOMException under jsdom", () => {
	it("from the environment's DOMException arrives as one, with its name and message", async () => {
		const original = new DOMException("The operation was aborted.", "AbortError");
		const { caught, diags } = await crossed(original);
		expect(caught).not.toBe(original);
		expect(caught).toBeInstanceOf(globalThis.DOMException);
		expect((caught as DOMException).name).toBe("AbortError");
		expect((caught as DOMException).message).toBe("The operation was aborted.");
		expect(diags).toEqual([]);
	});

	it("from the platform's AbortController arrives as the environment's DOMException, with its name and message", async () => {
		const controller = new AbortController();
		controller.abort();
		const reason = controller.signal.reason as Error;
		expect(reason).not.toBeInstanceOf(globalThis.DOMException);
		const { caught, diags } = await crossed(reason);
		expect(caught).toBeInstanceOf(globalThis.DOMException);
		expect((caught as DOMException).name).toBe("AbortError");
		expect((caught as DOMException).message).toBe(reason.message);
		expect(diags).toEqual([]);
	});
});
