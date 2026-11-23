import { createRenderEffect, createRoot, flush } from "solid-js";
import { createRuntime, type IActionGenerator, type IEntity, type ISelectorGenerator } from "treflex";
import { type IRuntimeInternal, watch } from "treflex/internal";
import { describe, expect, it } from "vitest";

interface IRoot extends IEntity {
	N: number;
}

function* setN(draft: IRoot, n: number): IActionGenerator {
	draft.N = n;
}

function* doubled(state: IRoot): ISelectorGenerator<number> {
	return state.N * 2;
}

function view(read: () => number): {
	seen: number[];
	dispose: () => void;
} {
	const seen: number[] = [];
	const dispose = createRoot((d) => {
		createRenderEffect(read, (value) => {
			seen.push(value);
		});
		return d;
	});
	flush();
	return {
		seen,
		dispose
	};
}

describe("14. registration after the runtime", () => {
	it("bridges a runtime, and a selector memo a watch built, made before treflex-solid registered", async () => {
		const runtime = createRuntime<IRoot>({
			$Id: "root",
			N: 0
		}) as IRuntimeInternal<IRoot>;
		const watched: number[] = [];
		const stop = watch(
			() => void runtime.runSelector(doubled, () => runtime.state),
			() => watched.push(runtime.runSelector(doubled, () => runtime.state))
		);
		const before = view(() => runtime.state.N);
		await runtime.dispatch(setN, "root", 1);
		flush();
		expect(before.seen).toEqual([
			0
		]);
		await import("../../src/Context/TreflexContext");
		const field = view(() => runtime.state.N);
		const selector = view(() => runtime.runSelector(doubled, () => runtime.state));
		await runtime.dispatch(setN, "root", 2);
		flush();
		expect(field.seen).toEqual([
			1,
			2
		]);
		expect(selector.seen).toEqual([
			2,
			4
		]);
		expect(watched).toEqual([
			2,
			4
		]);
		stop();
		before.dispose();
		field.dispose();
		selector.dispose();
		runtime.dispose();
	});
});
