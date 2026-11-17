import type { IActionGenerator, IEntity } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import { createRoot, createSignal } from "solid-js";
import { createRuntime } from "treflex";
import { rawOf, view } from "treflex/internal";
import { describe, expect, it, vi } from "vitest";
import { createEntityFeature } from "../src/Context/createEntityFeature";
import { TreflexProvider } from "../src/Context/TreflexContext";
import { minted, treeWrite } from "./treeWrite";
import { unhandledDuring } from "./unhandledDuring";

// Compiled through vite-plugin-solid, so `props` is Solid's getter-backed object: under a plain
// literal, a provider that reads `props.state` once at mount passes "re-reads props.state on
// every dispatch".

interface IChild extends IEntity {
	Value: number;
}

interface IParent extends IEntity {
	A: IChild[];
	B: IChild[];
}

function* bump(draft: IChild): IActionGenerator {
	draft.Value++;
}

const Child = createEntityFeature<IChild>("test/Child")({
	bump
});

interface IBound {
	bump: () => Promise<unknown>;
}

function mount(
	host: unknown,
	props: {
		state: unknown;
	}
): {
	bound: IBound;
	dispose: () => void;
} {
	let captured: IBound | undefined;
	const Inner = (): null => {
		captured = Child.use() as unknown as IBound;
		return null;
	};
	const Wrapped = Child.provider(Inner);
	const dispose = createRoot((disposer) => {
		// Evaluated eagerly: Solid's JSX compiles a component to a
		// createComponent call, and the Provider reads its children.
		void (
			<TreflexProvider value={host as any}>
				<Wrapped {...(props as any)} />
			</TreflexProvider>
		);
		return disposer;
	});
	if (!captured) {
		throw new Error("harness: the wrapped component never ran");
	}
	return {
		bound: captured,
		dispose
	};
}

function seed(): IParent {
	return {
		$Id: "root",
		A: [
			{
				$Id: "c1",
				Value: 0
			}
		],
		B: []
	};
}

describe("a discarded call that fails, with only a runtime onError", () => {
	function discarding(props: { state: unknown }) {
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		const onError = vi.fn();
		const runtime = createRuntime<IParent>(seed(), {
			onError
		});
		const { bound, dispose } = mount(runtime, props);
		return {
			onError,
			call: bound.bump,
			finish: () => {
				dispose();
				runtime.dispose();
				warnings.mockRestore();
			}
		};
	}

	it("stays an unhandled rejection, since onError heard nothing", async () => {
		const { onError, call, finish } = discarding({
			state: {
				$Id: "ghost",
				Value: 0
			}
		});
		const unhandled = await unhandledDuring(() => {
			call();
		});
		expect(unhandled).toHaveLength(1);
		expect(onError).not.toHaveBeenCalled();
		finish();
	});

	it("is nobody's unhandled rejection when the caller catches it", async () => {
		const { call, finish } = discarding({
			state: {
				$Id: "ghost",
				Value: 0
			}
		});
		const unhandled = await unhandledDuring(() => {
			call().catch(() => {});
		});
		expect(unhandled).toEqual([]);
		finish();
	});
});

async function failure(fn: () => unknown): Promise<Error> {
	let caught: unknown;
	try {
		await fn();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(Error);
	return caught as Error;
}

function runtimeWorld<R>(fn: (runtime: IRuntimeInternal<IParent>) => Promise<R>): Promise<R> {
	return new Promise<R>((resolve, reject) => {
		createRoot(async (disposer) => {
			const runtime = createRuntime<IParent>(seed()) as IRuntimeInternal<IParent>;
			try {
				resolve(await fn(runtime));
			} catch (error) {
				reject(error);
			} finally {
				runtime.dispose();
				disposer();
			}
		});
	});
}

function diagsOf(runtime: IRuntimeInternal<IParent>) {
	const seen: {
		code: string;
		data: unknown;
	}[] = [];
	const off = runtime.on("diag", (event) => {
		seen.push({
			code: event.code,
			data: event.data
		});
	});
	return {
		seen,
		off
	};
}

describe("the provider's dispatch on its state", () => {
	it("writes to the entity when the mount site passes only state", async () => {
		await runtimeWorld(async (runtime) => {
			const { bound, dispose } = mount(runtime, {
				state: runtime.state.A[0]
			});

			await bound.bump();

			expect(runtime.state.A[0].Value).toBe(1);
			dispose();
		});
	});

	it("re-reads props.state on every dispatch, not once at mount", async () => {
		await runtimeWorld(async (runtime) => {
			treeWrite(runtime, (state) => {
				state.B.push(
					minted("c2", {
						Value: 0
					})
				);
			});

			const [which, setWhich] = createSignal<"c1" | "c2">("c1");
			const { bound, dispose } = mount(runtime, {
				get state() {
					return which() === "c1" ? runtime.state.A[0] : runtime.state.B[0];
				}
			});

			await bound.bump();
			expect(runtime.state.A[0].Value).toBe(1);
			expect(runtime.state.B[0].Value).toBe(0);

			setWhich("c2");

			await bound.bump();
			expect(runtime.state.A[0].Value).toBe(1);
			expect(runtime.state.B[0].Value).toBe(1);

			dispose();
		});
	});

	it("accepts a raw node for the same entity: the check compares raw nodes", async () => {
		await runtimeWorld(async (runtime) => {
			const { bound, dispose } = mount(runtime, {
				state: rawOf(runtime.state.A[0])
			});

			await bound.bump();

			expect(runtime.state.A[0].Value).toBe(1);
			dispose();
		});
	});

	it("rejects a view over a different node bearing the same $Id, and diags it once", async () => {
		await runtimeWorld(async (runtime) => {
			const diags = diagsOf(runtime);
			const stray = view({
				$Id: "c1",
				Value: 100
			});
			const { bound, dispose } = mount(runtime, {
				state: stray
			});

			const error = await failure(() => bound.bump());
			await failure(() => bound.bump());

			expect(error.message).toMatch(/not a node of this runtime's tree/);
			expect(diags.seen).toEqual([
				{
					code: "dispatch/node-mismatch",
					data: {
						entityId: "c1",
						cause: "foreign"
					}
				}
			]);
			expect(runtime.state.A[0].Value).toBe(0);
			diags.off();
			dispose();
		});
	});

	it("rejects a superseded node: a raw replacement under the same $Id", async () => {
		await runtimeWorld(async (runtime) => {
			const diags = diagsOf(runtime);
			const held = runtime.state.A[0];
			const { bound, dispose } = mount(runtime, {
				state: held
			});
			rawOf(runtime.state).A[0] = {
				$Id: "c1",
				Value: 50
			};
			runtime.get("runtime/writeGateway").resync();

			const error = await failure(() => bound.bump());

			expect(error.message).toMatch(/superseded node/);
			expect(diags.seen.map((d) => d.data)).toEqual([
				{
					entityId: "c1",
					cause: "superseded"
				}
			]);
			expect(runtime.state.A[0].Value).toBe(50);
			diags.off();
			dispose();
		});
	});

	it("rejects a plain copy that kept its $Id, and diags it as foreign", async () => {
		await runtimeWorld(async (runtime) => {
			const diags = diagsOf(runtime);
			const { bound, dispose } = mount(runtime, {
				state: {
					...runtime.state.A[0]
				}
			});

			const error = await failure(() => bound.bump());

			expect(error.message).toMatch(/a copy or other plain value carrying the \$Id/);
			expect(runtime.state.A[0].Value).toBe(0);
			expect(diags.seen.map((d) => d.data)).toEqual([
				{
					entityId: "c1",
					cause: "foreign"
				}
			]);
			diags.off();
			dispose();
		});
	});

	it("rejects when the $Id is not in the tree, and diags dispatch/unresolved-entity once", async () => {
		await runtimeWorld(async (runtime) => {
			const diags = diagsOf(runtime);
			const { bound, dispose } = mount(runtime, {
				state: {
					$Id: "ghost",
					Value: 0
				}
			});

			const error = await failure(() => bound.bump());
			for (let attempt = 0; attempt < 4; attempt++) {
				await failure(() => bound.bump());
			}

			expect(error.message).toMatch(/no entity "ghost" in the state tree/);
			expect(diags.seen).toEqual([
				{
					code: "dispatch/unresolved-entity",
					data: {
						entityId: "ghost",
						cause: "unresolved"
					}
				}
			]);
			diags.off();
			dispose();
		});
	});

	it("rejects a state prop with an empty $Id rather than writing nowhere", async () => {
		await runtimeWorld(async (runtime) => {
			const { bound, dispose } = mount(runtime, {
				state: {
					$Id: "",
					Value: 0
				}
			});

			const error = await failure(() => bound.bump());

			expect(error.message).toMatch(/no entity ""/);
			dispose();
		});
	});

	it("names each cause once: an unresolved entity, then a node that isn't the one indexed", async () => {
		await runtimeWorld(async (runtime) => {
			const codes: string[] = [];
			const off = runtime.on("diag", (event) => codes.push(event.code));

			const late = view(
				minted("late", {
					Value: 0
				})
			);
			const { bound, dispose } = mount(runtime, {
				state: late
			});

			await failure(() => bound.bump());
			expect(codes).toEqual([
				"dispatch/unresolved-entity"
			]);

			treeWrite(runtime, (state) => {
				state.B.push(
					minted("late", {
						Value: 0
					})
				);
			});

			await failure(() => bound.bump());
			expect(codes).toEqual([
				"dispatch/unresolved-entity",
				"dispatch/node-mismatch"
			]);

			off();
			dispose();
		});
	});

	it("rejects rather than cross-writing between two runtimes", async () => {
		await new Promise<void>((resolve, reject) => {
			createRoot(async (disposer) => {
				const a = createRuntime<IParent>(seed());
				const b = createRuntime<IParent>(seed());
				try {
					const { bound, dispose } = mount(b, {
						state: a.state.A[0]
					});

					const error = await failure(() => bound.bump());

					expect(error.message).toMatch(/not a node of this runtime's tree/);
					expect(a.state.A[0].Value).toBe(0);
					expect(b.state.A[0].Value).toBe(0);
					dispose();
					resolve();
				} catch (error) {
					reject(error);
				} finally {
					a.dispose();
					b.dispose();
					disposer();
				}
			});
		});
	});
});
