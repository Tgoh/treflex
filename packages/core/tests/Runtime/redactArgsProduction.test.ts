import type { IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it, vi } from "vitest";
import { argsRedacted, redactArgs } from "../../src/Runtime/redactArgs";
import { build, type IDoc } from "./namedShared";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

describe("redactArgs in production", () => {
	it("marks a function that has already been dispatched, and its later records carry no arguments", async () => {
		function* early(_draft: IDoc, _password: string): IActionGenerator {}
		const h = build();
		await h.runtime.dispatch(early, "a", "first");
		expect(() => redactArgs(early)).not.toThrow();
		expect(argsRedacted(early)).toBe(true);
		await h.runtime.dispatch(early, "a", "second");
		expect(h.starts().map((record) => record.Args)).toEqual([
			[
				"first"
			],
			[]
		]);
	});
});
