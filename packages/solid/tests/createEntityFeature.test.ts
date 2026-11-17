import type { IEntity } from "treflex";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { createEntityFeature } from "../src/Context/createEntityFeature";
import { TreflexProvider } from "../src/Context/TreflexContext";

interface State extends IEntity {
	Value: number;
}

describe("createEntityFeature", () => {
	it("use() throws a clear error when called outside the matching provider", () => {
		const ctx = createEntityFeature<State>("test-feature")({});
		expect(() => ctx.use()).toThrowError(/use\(\) called outside the matching provider.*test-feature/);
	});

	it("two factory calls with one id share one context in development (the HMR contract)", () => {
		// The dev server re-evaluates a module on edit and the second
		// evaluation must get the first's context back, or mounted providers
		// go stale. Under DEV a URL-shaped id registers; the production side
		// of this contract is hmrRegistryProduction.test.tsx.
		const id = "http://localhost:5173/src/Features/Todo/Context.ts";
		const first = createEntityFeature<State>(id)({
			a: function* () {}
		});
		const second = createEntityFeature<State>(id)({
			b: function* () {}
		});
		let seen: any;
		createRoot((d) => {
			(TreflexProvider as unknown as Function)({
				value: {
					dispatch: () => Promise.resolve(),
					runSelector: () => undefined
				},
				get children() {
					const Wrapped = first.provider(() => {
						seen = second.use();
						return null;
					});
					return (Wrapped as Function)({
						state: {
							$Id: "e1",
							Value: 0
						}
					});
				}
			});
			d();
		});
		// second.use() resolved inside first's provider, so the context is
		// shared, and the refs now hold the second evaluation's module.
		expect(typeof seen.b).toBe("function");
		expect(seen.a).toBeUndefined();
	});

	it("use() throws with the module id in the message when provided", () => {
		const ctx = createEntityFeature<State>("/path/to/my/Module.ts")({});
		try {
			ctx.use();
			expect.fail("expected use() to throw");
		} catch (e) {
			expect((e as Error).message).toContain("/path/to/my/Module.ts");
		}
	});

	it("use() throws without an id when the factory was constructed anonymously", () => {
		const ctx = createEntityFeature<State>()({});
		expect(() => ctx.use()).toThrowError(/use\(\) called outside the matching provider/);
	});
});
