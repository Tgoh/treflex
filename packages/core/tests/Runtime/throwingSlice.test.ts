import type { IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it } from "vitest";
import { host } from "../../src/Reactive/host";
import { createRuntime } from "../../src/Runtime/createRuntime";
import * as reactive from "../reactive";

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
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ILoading>(makeState());
				const seen: number[] = [];
				reactive.effect(() => seen.push(runtime.state.IsLoading));
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
		await reactive.root(async (dispose) => {
			try {
				const runtime = createRuntime<ILoading>(makeState());
				runtime.registerImplementation("throwingSlice/park", async () => {});
				const seen: number[] = [];
				reactive.effect(() => seen.push(runtime.state.IsLoading));
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
});

describe("host.batch", () => {
	function observe(read: () => number): {
		seen: number[];
		dispose: () => void;
	} {
		const seen: number[] = [];
		const dispose = reactive.root((d) => {
			reactive.effect(() => seen.push(read()));
			return d;
		});
		return {
			seen,
			dispose
		};
	}

	it("flushes the batch's writes before rethrowing its callback's error", () => {
		const [read, write] = reactive.signal(0);
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
		const [read, write] = reactive.signal(0);
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

	it("returns the callback's value when it does not throw", () => {
		expect(host.batch(() => 7)).toBe(7);
	});
});
