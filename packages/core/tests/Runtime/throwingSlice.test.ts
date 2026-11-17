import type { IActionGenerator } from "../../src/Types/IAction";
import {
	catchError,
	createComputed,
	createEffect,
	createRenderEffect,
	createRoot,
	createSignal,
	getOwner,
	type Owner,
	runWithOwner
} from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { host } from "../../src/Solid/host";

// An action's finally writes the tree on its way out of a throw. Solid's batch
// drops every queued computation when its callback throws, leaving the signal
// written but each observer marked stale and never re-run, so a view stuck on
// the pre-throw value can no longer be revived by later writes.

type ILoading = {
	$Id: string;
	IsLoading: number;
};

const makeState = (): ILoading => ({
	$Id: "Window",
	IsLoading: 0
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("a throwing action slice", () => {
	it("notifies observers of the writes its finally made, when the first slice throws", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<ILoading>(makeState());
				const seen: number[] = [];
				createEffect(() => seen.push(runtime.state.IsLoading));
				await settle();

				function* failing(draft: ILoading): IActionGenerator {
					draft.IsLoading++;
					try {
						throw new Error("refused");
					} finally {
						draft.IsLoading--;
					}
				}
				await runtime.dispatch(failing, "Window").catch(() => {});
				await settle();

				expect(runtime.state.IsLoading).toBe(0);
				expect(seen.at(-1)).toBe(0);

				// The ++ and -- land in one batch, so the last value seen is 0
				// either way; what the dropped queue breaks is the next write.
				function* bump(draft: ILoading): IActionGenerator {
					draft.IsLoading = 5;
				}
				await runtime.dispatch(bump, "Window");
				await settle();
				expect(seen.at(-1)).toBe(5);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("notifies observers of the writes its finally made, when a slice after a park throws", async () => {
		await createRoot(async (dispose) => {
			try {
				const runtime = createRuntime<ILoading>(makeState());
				runtime.registerImplementation("throwingSlice/park", async () => {});
				const seen: number[] = [];
				createEffect(() => seen.push(runtime.state.IsLoading));
				await settle();

				function* failingAfterPark(draft: ILoading): IActionGenerator {
					draft.IsLoading++;
					try {
						yield {
							Type: "throwingSlice/park"
						};
						throw new Error("refused");
					} finally {
						draft.IsLoading--;
					}
				}
				await runtime.dispatch(failingAfterPark, "Window").catch(() => {});
				await settle();

				expect(runtime.state.IsLoading).toBe(0);
				expect(seen).toContain(1);
				expect(seen.at(-1)).toBe(0);

				// A later successful write must still reach the observer.
				function* bump(draft: ILoading): IActionGenerator {
					draft.IsLoading = 5;
				}
				await runtime.dispatch(bump, "Window");
				await settle();
				expect(seen.at(-1)).toBe(5);
				runtime.dispose();
			} finally {
				dispose();
			}
		});
	});

	it("rejects with its own error when dispatched inside an owned root under catchError", async () => {
		const runtime = createRuntime<ILoading>(makeState());
		function* failing(_draft: ILoading): IActionGenerator {
			throw new Error("refused");
		}
		let disposeRoot!: () => void;
		const pending = createRoot((d) => {
			disposeRoot = d;
			return catchError(
				() => runtime.dispatch(failing, "Window"),
				() => {}
			);
		});
		try {
			await expect(pending).rejects.toThrow("refused");
		} finally {
			disposeRoot();
			runtime.dispose();
		}
	});
});

describe("host.batch", () => {
	// The observer is built inside a root, and the batch runs outside it: a
	// root's body is itself one batch, which would defer the flush past the
	// assertion.
	function observe(read: () => number): {
		seen: number[];
		dispose: () => void;
	} {
		const seen: number[] = [];
		const dispose = createRoot((d) => {
			createRenderEffect(() => seen.push(read()));
			return d;
		});
		return {
			seen,
			dispose
		};
	}

	it("flushes the batch's writes before rethrowing its callback's error", () => {
		const [read, write] = createSignal(0);
		const { seen, dispose } = observe(read);
		try {
			expect(() =>
				host.batch(() => {
					write(1);
					throw new Error("refused");
				})
			).toThrow("refused");
			expect(seen.at(-1)).toBe(1);
			write(2);
			expect(seen.at(-1)).toBe(2);
		} finally {
			dispose();
		}
	});

	it("rethrows from a nested batch after the outer batch flushes", () => {
		const [read, write] = createSignal(0);
		const { seen, dispose } = observe(read);
		try {
			expect(() =>
				host.batch(() =>
					host.batch(() => {
						write(1);
						throw new Error("refused");
					})
				)
			).toThrow("refused");
			expect(seen.at(-1)).toBe(1);
		} finally {
			dispose();
		}
	});

	describe("when the flush throws too", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		// An observer that throws once the signal reaches 1.
		function observeThrowing(read: () => number): () => void {
			return createRoot((d) => {
				createRenderEffect(() => {
					if (read() === 1) throw new Error("effect-boom");
				});
				return d;
			});
		}

		it("rethrows the callback's error and surfaces the flush's separately", () => {
			const queued: (() => void)[] = [];
			vi.stubGlobal("queueMicrotask", (task: () => void) => {
				queued.push(task);
			});
			const [read, write] = createSignal(0);
			const dispose = observeThrowing(read);
			try {
				expect(() =>
					host.batch(() => {
						write(1);
						throw new Error("action-error");
					})
				).toThrow("action-error");
				expect(queued).toHaveLength(1);
				expect(() => queued[0]()).toThrow("effect-boom");
			} finally {
				dispose();
			}
		});

		it("rethrows the flush's error when the callback did not throw", () => {
			const [read, write] = createSignal(0);
			const dispose = observeThrowing(read);
			try {
				expect(() =>
					host.batch(() => {
						write(1);
					})
				).toThrow("effect-boom");
			} finally {
				dispose();
			}
		});
	});

	it("throws rather than returning nothing when the caller's boundary absorbs a flush error", () => {
		const [read, write] = createSignal(0);
		// A pure computation, so it flushes inside this batch rather than with
		// an outer effect queue; its own root has no boundary, so its throw
		// reaches the batch.
		const disposeComputed = createRoot((d) => {
			createComputed(() => {
				if (read() === 1) throw new Error("computed-boom");
			});
			return d;
		});
		const absorbed: unknown[] = [];
		let owner: Owner | null = null;
		const disposeBoundary = createRoot((d) => {
			catchError(
				() => {
					owner = getOwner();
				},
				(e) => absorbed.push(e)
			);
			return d;
		});
		let returned: unknown = "unset";
		let thrown: unknown;
		try {
			runWithOwner(owner, () => {
				try {
					returned = host.batch(() => {
						write(1);
						return "ok";
					});
				} catch (e) {
					thrown = e;
				}
			});
			expect(absorbed.map((e) => (e as Error).message)).toEqual([
				"computed-boom"
			]);
			expect(returned).toBe("unset");
			expect((thrown as Error).message).toMatch(/error boundary absorbed it/);
		} finally {
			disposeComputed();
			disposeBoundary();
		}
	});
	it("returns the callback's value when it does not throw", () => {
		expect(host.batch(() => 7)).toBe(7);
	});
});
