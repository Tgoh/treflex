import type { IReadHandler } from "../../src/Runtime/processSelector";
import type { ISelector, ISelectorGenerator } from "../../src/Types/ISelector";
import { describe, expect, it } from "vitest";
import { processSelector } from "../../src/Runtime/processSelector";

// Inline select helper for tests
function* select<S, R>(selector: ISelector<S, R>, accessor?: (state: any) => S): Generator<any, R, any> {
	const result = yield {
		Type: "select",
		Accessor: accessor,
		Selector: selector
	};
	return result;
}

function createTestReadHandler(): IReadHandler {
	const cache = new Map<Function, any>();

	const processor: IReadHandler = (yielded, context) => {
		if (yielded.Type === "select") {
			const selector = yielded.Selector;
			if (cache.has(selector)) {
				return cache.get(selector);
			}
			const accessor = yielded.Accessor;
			const result = processSelector(selector, context.getState, accessor, processor);
			cache.set(selector, result);
			return result;
		}
		throw new Error(`Unknown read type: ${yielded.Type}`);
	};

	return processor;
}

describe("processSelector", () => {
	it("runs a selector that returns a plain value (no select)", () => {
		function* getCount(draft: { count: number }): ISelectorGenerator<number> {
			return draft.count;
		}

		const state = {
			count: 42
		};
		const result = processSelector(getCount, () => state, undefined, createTestReadHandler());
		expect(result).toBe(42);
	});

	it("chains selectors via select — downstream gets upstream value", () => {
		function* base(draft: { items: number[] }): ISelectorGenerator {
			return draft.items.filter((x) => x > 2);
		}

		function* derived(_draft: { items: number[] }): ISelectorGenerator {
			const filtered: number[] = yield* select(base);
			return filtered.length;
		}

		const state = {
			items: [
				1,
				2,
				3,
				4,
				5
			]
		};
		const result = processSelector(derived, () => state, undefined, createTestReadHandler());
		expect(result).toBe(3);
	});

	it("reuses cached results on repeated calls", () => {
		let computeCount = 0;

		function* expensive(draft: { value: number }): ISelectorGenerator {
			computeCount++;
			return draft.value * 2;
		}

		function* consumer(_draft: { value: number }): ISelectorGenerator {
			return yield* select(expensive);
		}

		const state = {
			value: 5
		};
		const processor = createTestReadHandler();

		processSelector(consumer, () => state, undefined, processor);
		processSelector(consumer, () => state, undefined, processor);
		processSelector(consumer, () => state, undefined, processor);

		expect(computeCount).toBe(1);
	});

	it("throws on invalid yield (not a read)", () => {
		function* bad(draft: { value: number }): ISelectorGenerator {
			yield {
				NotAType: true
			} as any;
			return draft.value;
		}

		const state = {
			value: 1
		};
		expect(() => {
			processSelector(bad, () => state, undefined, createTestReadHandler());
		}).toThrow("Selectors can only yield read objects");
	});

	it("throws on undefined yield", () => {
		function* bad(_draft: object): ISelectorGenerator {
			yield undefined as any;
			return null;
		}

		expect(() => {
			processSelector(bad, () => ({}), undefined, createTestReadHandler());
		}).toThrow("Selectors can only yield read objects");
	});
});
