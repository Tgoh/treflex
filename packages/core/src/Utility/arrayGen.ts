type IEachGenerator<T, Y, R> = (item: T, index: number) => Generator<Y, R, any>;

/**
 * `items.map(fn)` for a callback that yields: `yield* mapGen(rows, (row) => entity(row))`. The
 * callback is a generator function, or a function returning a generator, and gets the item and its
 * index. Each item's callback runs to its end before the next starts. Generic over what the callback
 * yields, so a selector's callback yields reads and an action's yields what an action may. See
 * docs/reference/derived-reads.md#yields-inside-a-callback.
 */
export function* mapGen<T, Y, R>(
	items: readonly T[],
	fn: (item: T, index: number) => Generator<Y, R extends Iterator<unknown> ? "mapGen: delegate with yield*" : R, any>
): Generator<Y, R[], any> {
	const length = items.length;
	const out = new Array<R>(length);
	for (let i = 0; i < length; i++) {
		if (i in items) {
			out[i] = (yield* fn(items[i]!, i)) as R;
		}
	}
	return out;
}

/** `items.filter(pred)` for a predicate that yields: `yield* filterGen(rows, (row) => inFlight(save, row))`. As `mapGen`. */
export function* filterGen<T, Y>(items: readonly T[], pred: IEachGenerator<T, Y, boolean>): Generator<Y, T[], any> {
	const length = items.length;
	const out: T[] = [];
	for (let i = 0; i < length; i++) {
		if (i in items) {
			const item = items[i]!;
			if (yield* pred(item, i)) {
				out.push(item);
			}
		}
	}
	return out;
}

/**
 * `items.some(pred)` for a predicate that yields: `if (yield* someGen(rows, (row) => inFlight(save, row)))`.
 * Stops at the first `true`, so later items' callbacks don't run. As `mapGen`.
 */
export function* someGen<T, Y>(items: readonly T[], pred: IEachGenerator<T, Y, boolean>): Generator<Y, boolean, any> {
	const length = items.length;
	for (let i = 0; i < length; i++) {
		if (i in items && (yield* pred(items[i]!, i))) {
			return true;
		}
	}
	return false;
}
