import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { rootSetState } from "../testHelpers";

// DEV is a module constant, so this file mocks it off for the whole file.
vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

type TestState = {
	$Id: string;
	Count: number;
};

const initialState = (): TestState => ({
	$Id: "root",
	Count: 0
});

function diagsOf(runtime: ReturnType<typeof createRuntime<TestState>>): IRuntimeEventOf<"diag">[] {
	const seen: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => seen.push(event));
	return seen;
}

describe("the outside-write rule in a production build", () => {
	it("refuses a frameless setState and reports state/outside-action-write", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const runtime = createRuntime<TestState>(initialState());
		try {
			const diags = diagsOf(runtime);
			expect(() =>
				rootSetState(runtime)((s) => {
					s.Count = 99;
				})
			).toThrow(/state mutations belong to actions/);

			expect(runtime.state.Count).toBe(0);
			const hits = diags.filter((d) => d.code === "state/outside-action-write");
			expect(hits).toHaveLength(1);
			expect(hits[0].severity).toBe("warn");
			expect(hits[0].data?.path).toEqual([
				"AppState"
			]);
		} finally {
			runtime.dispose();
			warn.mockRestore();
		}
	});

	it("reports each refused write", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const runtime = createRuntime<TestState>(initialState());
		try {
			const diags = diagsOf(runtime);
			for (const count of [
				1,
				2
			]) {
				expect(() =>
					rootSetState(runtime)((s) => {
						s.Count = count;
					})
				).toThrow();
			}
			expect(diags.filter((d) => d.code === "state/outside-action-write")).toHaveLength(2);
		} finally {
			runtime.dispose();
			warn.mockRestore();
		}
	});
});
