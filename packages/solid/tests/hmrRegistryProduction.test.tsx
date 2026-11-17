import type { IEntity } from "treflex";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createComponentFeature } from "../src/Context/createComponentFeature";
import { createEntityFeature } from "../src/Context/createEntityFeature";
import { componentFeatureRegistry, entityFeatureRegistry } from "../src/Context/hmrRegistry";
import { TreflexProvider } from "../src/Context/TreflexContext";
import { unhandledDuring } from "./unhandledDuring";

vi.mock("treflex/internal", async (importOriginal) => ({
	...(await importOriginal<typeof import("treflex/internal")>()),
	DEV: false
}));

interface State extends IEntity {
	Value: number;
}

const CHUNK = "https://host/assets/index-BdhACKtC.js";

// A throw in a view under the provider is raised uncaught.
async function crashes(mount: () => unknown): Promise<string[]> {
	return (await unhandledDuring(mount)).map(String);
}

function* a(_draft: State) {}
function* b(_draft: State) {}
function* selA(_draft: State) {
	return "a";
}
function* selB(_draft: State) {
	return "b";
}

const hostValue = {
	dispatch: () => Promise.resolve(),
	runSelector: (selector: Function, getState: () => unknown) => selector(getState()).next().value
};

function useInside(outer: any, inner: any): () => any {
	return () =>
		createRoot((dispose) => {
			let seen: any;
			(TreflexProvider as unknown as Function)({
				value: hostValue,
				get children() {
					const Wrapped = outer.provider(() => {
						seen = inner.use();
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
			dispose();
			return seen;
		});
}

function useInsideComponent(outer: any, inner: any): () => any {
	return () =>
		createRoot((dispose) => {
			let seen: any;
			(TreflexProvider as unknown as Function)({
				value: {
					...hostValue,
					get: () => ({}),
					seedComponent: () => ({
						id: "~mounted",
						raw: {
							$Id: "~mounted",
							Value: 0
						}
					}),
					seatComponent: () => true,
					unmountComponent: () => {}
				},
				get children() {
					const Wrapped = outer.provider(
						() => {
							seen = inner.use();
							return null;
						},
						() => ({
							Value: 0
						})
					);
					return (Wrapped as Function)({});
				}
			});
			dispose();
			return seen;
		});
}

describe("createEntityFeature in a production build", () => {
	it("gives two features that share a chunk URL two distinct contexts", async () => {
		const first = createEntityFeature<State>(CHUNK)(
			{
				a
			},
			{
				selA
			}
		);
		const second = createEntityFeature<State>(CHUNK)(
			{
				b
			},
			{
				selB
			}
		);

		const insideFirst = useInside(first, first)();
		expect(typeof insideFirst.a).toBe("function");
		expect(insideFirst.b).toBeUndefined();
		expect(insideFirst.selA()).toBe("a");

		const insideSecond = useInside(second, second)();
		expect(typeof insideSecond.b).toBe("function");
		expect(insideSecond.a).toBeUndefined();
		expect(insideSecond.selB()).toBe("b");

		expect(await crashes(useInside(first, second))).toEqual([
			expect.stringMatching(/outside the matching provider/)
		]);
		expect(await crashes(useInside(second, first))).toEqual([
			expect.stringMatching(/outside the matching provider/)
		]);
	});

	it("leaves the registry empty, so nothing is keyed by the chunk URL", () => {
		createEntityFeature<State>(CHUNK)({
			a
		});
		expect(entityFeatureRegistry.get(CHUNK)).toBeUndefined();
	});

	it("still converges a hand-picked id onto one context", () => {
		const first = createEntityFeature<State>("Features/Cart")({
			a
		});
		const second = createEntityFeature<State>("Features/Cart")({
			b
		});
		expect(entityFeatureRegistry.get("Features/Cart")).toBeDefined();
		expect(useInside(first, second)).not.toThrow();
		expect(useInside(second, first)).not.toThrow();
	});
});

describe("createComponentFeature in a production build", () => {
	it("gives two component features that share a chunk URL two distinct contexts", async () => {
		const first = createComponentFeature<State>(CHUNK)({
			a
		});
		const second = createComponentFeature<State>(CHUNK)({
			b
		});

		const insideFirst = useInsideComponent(first, first)();
		expect(typeof insideFirst.a).toBe("function");
		expect(insideFirst.b).toBeUndefined();

		expect(await crashes(useInsideComponent(first, second))).toEqual([
			expect.stringMatching(/outside the matching provider/)
		]);
		expect(await crashes(useInsideComponent(second, first))).toEqual([
			expect.stringMatching(/outside the matching provider/)
		]);
		expect(componentFeatureRegistry.get(CHUNK)).toBeUndefined();
	});
});
