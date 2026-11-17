import type { IEntity } from "treflex";
import { describe, expect, it, vi } from "vitest";
import { buildContextProxy } from "../src/Context/buildContextProxy";

interface State extends IEntity {
	Value: number;
}

function makeRuntimeStub() {
	const dispatch = vi.fn(async (action, target, ...args) => {
		const gen = action(target, ...args);
		let next = gen.next();
		while (!next.done) {
			next = gen.next(undefined);
		}
		return next.value;
	});
	const runSelector = vi.fn((selector, getState) => {
		const generator = selector(getState());
		let next = generator.next();
		while (!next.done) {
			next = generator.next(undefined);
		}
		return next.value;
	});
	return {
		dispatch,
		runSelector
	};
}

type IAny = Record<string, Function>;

describe("buildContextProxy", () => {
	it("exposes state via the accessor (reactive read pass-through), and no setState", () => {
		const state: State = {
			$Id: "x",
			Value: 7
		};
		const proxy = buildContextProxy<State, IAny, IAny>(
			() => state,
			{
				current: {}
			},
			{
				current: {}
			},
			makeRuntimeStub()
		);

		expect((proxy as any).state).toBe(state);
		expect((proxy as any).state.Value).toBe(7);
		expect((proxy as any).setState).toBeUndefined();
	});

	it("dispatches an existing action with the state as its target", async () => {
		const state: State = {
			$Id: "x",
			Value: 0
		};
		const add = function* (s: State, n: number) {
			s.Value += n;
			return s.Value;
		};
		const runtime = makeRuntimeStub();

		const proxy = buildContextProxy<State, IAny, IAny>(
			() => state,
			{
				current: {
					add
				}
			},
			{
				current: {}
			},
			runtime
		);

		const result = await (proxy as any).add(3);
		expect(result).toBe(3);
		expect(state.Value).toBe(3);
		expect(runtime.dispatch).toHaveBeenCalledTimes(1);
		const callArgs = runtime.dispatch.mock.calls[0]!;
		expect(callArgs[0]).toBe(add);
		expect(callArgs[1]).toBe(state);
		expect(callArgs[2]).toBe(3);
	});

	it("memoises bound action functions across reads", () => {
		const proxy = buildContextProxy<State, IAny, IAny>(
			() => ({
				$Id: "x",
				Value: 0
			}),
			{
				current: {
					add: function* () {}
				}
			},
			{
				current: {}
			},
			makeRuntimeStub()
		);

		const first = (proxy as any).add;
		const second = (proxy as any).add;
		expect(first).toBe(second);
	});

	it("picks up actions added to the ref after construction (HMR add)", () => {
		const actionsRef = {
			current: {
				add: function* () {}
			} as IAny
		};
		const proxy = buildContextProxy<State, IAny, IAny>(
			() => ({
				$Id: "x",
				Value: 0
			}),
			actionsRef,
			{
				current: {}
			},
			makeRuntimeStub()
		);

		expect((proxy as any).archive).toBeUndefined();

		actionsRef.current.archive = function* () {};

		expect(typeof (proxy as any).archive).toBe("function");
	});

	it("returns undefined for a key that's been removed from the ref", () => {
		const actionsRef = {
			current: {
				add: function* () {},
				remove: function* () {}
			} as IAny
		};
		const proxy = buildContextProxy<State, IAny, IAny>(
			() => ({
				$Id: "x",
				Value: 0
			}),
			actionsRef,
			{
				current: {}
			},
			makeRuntimeStub()
		);

		expect(typeof (proxy as any).remove).toBe("function");

		delete actionsRef.current.remove;

		expect((proxy as any).remove).toBeUndefined();
	});

	it("routes a selector through runSelector by the function itself, with no name", () => {
		const state: State = {
			$Id: "x",
			Value: 5
		};
		const doubled = function* (s: State) {
			return s.Value * 2;
		};
		const runtime = makeRuntimeStub();

		const proxy = buildContextProxy<State, IAny, IAny>(
			() => state,
			{
				current: {}
			},
			{
				current: {
					doubled
				}
			},
			runtime
		);

		const result = (proxy as any).doubled();
		expect(result).toBe(10);
		expect(runtime.runSelector).toHaveBeenCalledTimes(1);
		const callArgs = runtime.runSelector.mock.calls[0]!;
		expect(callArgs[0]).toBe(doubled);
		expect(callArgs).toHaveLength(2);
	});

	it("prefers an action over a selector with the same name", () => {
		const runtime = makeRuntimeStub();
		const proxy = buildContextProxy<State, IAny, IAny>(
			() => ({
				$Id: "x",
				Value: 0
			}),
			{
				current: {
					same: function* () {}
				}
			},
			{
				current: {
					same: function* () {
						return 1;
					}
				}
			},
			runtime
		);

		(proxy as any).same();
		expect(runtime.dispatch).toHaveBeenCalled();
		expect(runtime.runSelector).not.toHaveBeenCalled();
	});
});
