import type { IActionGenerator, IFailureEvent, IRuntime } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import { createComputed, createEffect, createRoot } from "solid-js";
import { createRuntime } from "treflex";
import { describe, expect, it } from "vitest";
import { TreflexProvider } from "../src/Context/TreflexContext";
import { unhandledDuring } from "./unhandledDuring";

interface IRoot {
	$Id: string;
	N: number;
}

function* setN(draft: IRoot, n: number): IActionGenerator {
	draft.N = n;
}

function* nOf(state: IRoot) {
	if (state.N === 1) {
		throw new Error("view crash");
	}
	return state.N;
}

function build() {
	const runtime = createRuntime<IRoot>({
		$Id: "root",
		N: 0
	});
	const failures: IFailureEvent[] = [];
	runtime.on("failure", (event) => failures.push(event));
	return {
		runtime,
		failures
	};
}

function mountViews(runtime: IRuntime<IRoot>, views: (() => void)[]): () => void {
	return createRoot((dispose) => {
		const Views = (): null => {
			for (const run of views) {
				createEffect(run);
			}
			return null;
		};
		void (
			<TreflexProvider value={runtime}>
				<Views />
			</TreflexProvider>
		);
		return dispose;
	});
}

describe("a view that throws under the provider", () => {
	it("fails no action, leaves the views queued behind it running, and is raised uncaught", async () => {
		const { runtime, failures } = build();
		const seen: number[] = [];
		const dispose = mountViews(runtime, [
			() => {
				if (runtime.state.N === 1) {
					throw new Error("view crash");
				}
			},
			() => {
				seen.push(runtime.state.N);
			}
		]);
		let outcome: unknown = "pending";
		const heard = await unhandledDuring(() => {
			runtime.dispatch(setN, "root", 1).then(
				() => {
					outcome = "resolved";
				},
				(error: unknown) => {
					outcome = error;
				}
			);
		});
		expect(outcome).toBe("resolved");
		expect(failures).toEqual([]);
		expect(heard.map(String)).toEqual([
			"Error: view crash"
		]);
		await runtime.dispatch(setN, "root", 2);
		expect(seen).toEqual([
			0,
			1,
			2
		]);
		dispose();
	});

	it("fails on the view's own read of a cached selector first built outside it, not in the writing action's flush", async () => {
		const { runtime, failures } = build();
		const internal = runtime as IRuntimeInternal<IRoot>;
		const read = () => internal.runSelector(nOf, () => runtime.state);
		read();
		const dispose = mountViews(runtime, [
			read
		]);
		let outcome: unknown = "pending";
		const heard = await unhandledDuring(() => {
			runtime.dispatch(setN, "root", 1).then(
				() => {
					outcome = "resolved";
				},
				(error: unknown) => {
					outcome = error;
				}
			);
		});
		expect(outcome).toBe("resolved");
		expect(failures).toEqual([]);
		expect(heard.map(String)).toEqual([
			"Error: view crash"
		]);
		dispose();
	});

	it("raises a cached selector's throw once however many views read it, each view failing", async () => {
		const { runtime } = build();
		const internal = runtime as IRuntimeInternal<IRoot>;
		const failed: number[] = [];
		const reader = (view: number) => () => {
			try {
				internal.runSelector(nOf, () => runtime.state);
			} catch (error) {
				failed.push(view);
				throw error;
			}
		};
		const dispose = mountViews(runtime, [
			reader(1),
			reader(2),
			reader(3)
		]);
		const heard = await unhandledDuring(() => {
			void runtime.dispatch(setN, "root", 1);
		});
		expect(failed).toEqual([
			1,
			2,
			3
		]);
		expect(heard.map(String)).toEqual([
			"Error: view crash"
		]);
		dispose();
	});
});

describe("a view outside any provider", () => {
	it("still fails the writing action, its throw escaping the flush", async () => {
		const { runtime } = build();
		const dispose = createRoot((d) => {
			createComputed(() => {
				if (runtime.state.N === 1) {
					throw new Error("view crash");
				}
			});
			return d;
		});
		await expect(runtime.dispatch(setN, "root", 1)).rejects.toThrow("view crash");
		dispose();
	});
});
