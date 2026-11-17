import type { IActionGenerator, IEntity, IRuntimeOptions } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import { createRuntime, NonPlainDataError } from "treflex";
import { describe, expect, it, vi } from "vitest";
import { buildContextProxy } from "../src/Context/buildContextProxy";
import { unhandledDuring } from "./unhandledDuring";

interface IState extends IEntity {
	Saved?: any;
}

function build(runtimeOptions?: IRuntimeOptions) {
	const onError = vi.fn();
	const runtime = createRuntime<IState>(
		{
			$Id: "root"
		},
		runtimeOptions ?? {
			onError
		}
	) as IRuntimeInternal<IState>;
	const got: unknown[] = [];
	const actions = {
		*take(draft: IState, arg: unknown): IActionGenerator {
			got.push(arg);
			draft.Saved = arg;
		},
		*takeTwo(_draft: IState, a: unknown, b: unknown): IActionGenerator {
			got.push(a, b);
		}
	};
	const context = buildContextProxy<IState, typeof actions, Record<string, Function>>(
		() => runtime.state,
		{
			current: actions
		},
		{
			current: {}
		},
		runtime
	) as unknown as {
		take(arg: unknown): Promise<void>;
		takeTwo(a: unknown, b: unknown): Promise<void>;
	};
	return {
		runtime,
		context,
		got,
		onError
	};
}

describe("a view call", () => {
	it("hands the action a frozen copy that writes into the draft as its own node", async () => {
		const { runtime, context, got } = build();
		const sent = {
			Deep: {
				V: 1
			}
		};
		await context.take(sent);
		expect(got[0]).toEqual(sent);
		expect(got[0]).not.toBe(sent);
		expect(Object.isFrozen((got[0] as typeof sent).Deep)).toBe(true);
		expect(Object.isFrozen(sent)).toBe(false);
		expect(runtime.state.Saved).toEqual(sent);
	});

	it("copies a view of the state as plain data", async () => {
		const { runtime, context, got } = build();
		await context.take({
			V: 1
		});
		await context.take(runtime.state.Saved);
		expect(got[1]).toEqual({
			V: 1
		});
		expect(Object.isFrozen(got[1])).toBe(true);
	});

	it("delivers a positional undefined with the later argument intact", async () => {
		const { context, got } = build();
		await context.takeTwo(undefined, "later");
		expect(got).toEqual([
			undefined,
			"later"
		]);
	});

	it("rejects a non-plain argument, naming it, and runtime.onError hears it once", async () => {
		const { context, got, onError } = build();
		const refusal = await context.take(new Date(0)).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(NonPlainDataError);
		expect((refusal as Error).message).toContain('action "take": an argument is not plain: Date at [0]');
		expect(got).toEqual([]);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0]).toBe(refusal);
	});

	describe("that fails and is discarded", () => {
		it("is no unhandled rejection when the runtime's onError heard it", async () => {
			const { context, onError } = build();
			const unhandled = await unhandledDuring(() => {
				context.take(new Date(0));
			});
			expect(unhandled).toEqual([]);
			expect(onError).toHaveBeenCalledTimes(1);
		});

		it("stays unhandled with no onError", async () => {
			const { context } = build({});
			const unhandled = await unhandledDuring(() => {
				context.take(new Date(0));
			});
			expect(unhandled).toHaveLength(1);
		});
	});
});
