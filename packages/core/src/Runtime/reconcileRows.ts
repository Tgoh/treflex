import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";
import { entity } from "../Effects/entity";
import { copyAtSender } from "./crossing";
import { isDraftNode, seat } from "./draftNode";
import { settlesSync } from "./effectDeclarations";
import { DRAFT_SCOPE, type IDraftScope } from "./recordingProxy";
import { TreflexRefusal } from "./refusal";
import { runningStep } from "./runningStep";
import { freezeAll, rawOf, unwrapValue } from "./viewProxy";

/** Names a row. It's given live rows and incoming data alike, so it reads a field both have. */
export type IReconcileRowsKey<Row, Item> = (row: Row | Item) => string | number | null | undefined;

export interface IReconcileRowsUpdate<Row, Item> {
	/**
	 * Fills every row in the list, new or matched, in the parent's step, writing into the row directly. A matched row keeps
	 * whatever of its old contents `update` doesn't write, so `update: () => {}` keeps them all.
	 */
	update: (row: Row, item: Item) => unknown;
}

export interface IReconcileRowsOptions<Row, Item> extends IReconcileRowsUpdate<Row, Item> {
	/** Makes the default row for an item nothing matched, as a value or a generator such as `entity(...)`. `update` fills it. */
	add: (item: Item) => NoInfer<Row> | Generator<any, NoInfer<Row>, any>;
}

export class ReconcileRowsKeyError extends Error {
	constructor(problem: string) {
		super(`[treflex] reconcileRows(): ${problem} Nothing moved.`);
		this.name = "ReconcileRowsKeyError";
	}
}

export class ReconcileRowsWaitError extends TreflexRefusal {
	constructor(where: "add" | "update", what: string) {
		super(
			`[treflex] reconcileRows(): ${where} yielded ${what}, and a refresh lands in one step. Only a settles: "sync" effect ` +
				`such as entity() can run there. Do the wait or the read before reconcileRows (docs/reference/write-path.md#keys-and-the-refresh-step).`
		);
		this.name = "ReconcileRowsWaitError";
	}
}

function normalizeKey(value: unknown): string | undefined {
	return value === undefined || value === null || value === "" ? undefined : String(value);
}

function runInStep<R>(made: R | Generator<unknown, R, unknown>, where: "add" | "update"): R {
	const tag = Object.prototype.toString.call(made);
	if (tag === "[object Promise]" || tag === "[object AsyncGenerator]") {
		throw new ReconcileRowsWaitError(where, "an async result");
	}
	if (tag !== "[object Generator]") {
		return made as R;
	}
	const generator = made as Generator<unknown, R, unknown>;
	const answer = runningStep.answer();
	let next = generator.next();
	while (!next.done) {
		const type = (next.value as Partial<IEffect> | null | undefined)?.Type;
		let value: unknown;
		try {
			if (!answer || typeof type !== "string" || !settlesSync(type)) {
				throw new ReconcileRowsWaitError(where, typeof type === "string" ? `"${type}"` : "something that isn't an effect");
			}
			value = answer(next.value as IEffect);
		} catch (error) {
			next = generator.throw(error);
			continue;
		}
		next = generator.next(value);
	}
	return next.value;
}

function refuseTarget(current: unknown): void {
	if (!Array.isArray(current) || !isDraftNode(current)) {
		throw new TypeError(
			"[treflex] reconcileRows(): the rows have to be an array on the draft. A getData or select result, an argument or a view is a copy or " +
				"read-only, so writing to it never reaches state."
		);
	}
}

/**
 * Refreshes a list while keeping what's attached to its rows, for when rows have running work,
 * timers or resources that must survive. Otherwise, replace the rows. It takes one level: a row's
 * own collection is a `reconcileRows` inside `update`, naming its own key.
 *
 * A row whose key matches an incoming item keeps its node and id. An item nothing matched gets
 * a new row from `add`, or `entity(item)` without one. `update` then runs on every row in the
 * list, so one path fills both. A row no item matched leaves the tree as an ordinary removal,
 * and the list ends in `incoming`'s order. `current` is the same array afterwards.
 *
 * The whole refresh, with the writes around the call and any nested `reconcileRows`, lands in one
 * step: nothing yielded in `add` or `update` ends it, and a view sees the list before or after.
 * That means they can only run sync effects, and anything else throws `ReconcileRowsWaitError`
 * at its yield. `add` runs before anything moves, so a throw there leaves the list untouched.
 * A throw from `update` comes after the list is arranged, and what landed stays.
 *
 * Throws `ReconcileRowsKeyError` before anything moves when an incoming item has no key, or when
 * two rows in either list share one. A current row with no key can't match, so it's removed.
 * Throws `TypeError` before anything moves when `update` is missing, or when `add` returns
 * something that isn't a row.
 *
 * Returns the rows it added, as nodes on the draft, in the list's order.
 * See docs/reference/write-path.md#refreshing-rows.
 */
export function reconcileRows<Row extends object, Item>(
	current: Row[],
	incoming: readonly Item[],
	key: IReconcileRowsKey<Row, Item>,
	options: IReconcileRowsOptions<Row, Item>
): IActionGenerator<Row[]>;
export function reconcileRows<Row extends object, Item extends Omit<Row, "$Id">>(
	current: Row[],
	incoming: readonly Item[],
	key: IReconcileRowsKey<Row, Item>,
	options: IReconcileRowsUpdate<Row, Item>
): IActionGenerator<Row[]>;
export function* reconcileRows(
	current: object[],
	incoming: readonly unknown[],
	key: IReconcileRowsKey<object, unknown>,
	options: IReconcileRowsUpdate<object, unknown> & Partial<IReconcileRowsOptions<object, unknown>>
): IActionGenerator<object[]> {
	refuseTarget(current);
	if (!Array.isArray(incoming)) {
		throw new TypeError("[treflex] reconcileRows(): the incoming rows have to be an array.");
	}
	const update = options?.update;
	if (typeof update !== "function") {
		throw new TypeError(
			"[treflex] reconcileRows(): update is required, and it fills every row, new or matched. To keep a matched row's contents, " +
				"pass update: () => {}. Nothing moved."
		);
	}
	const items = copyAtSender(incoming, "reconcileRows(): the incoming rows") as readonly unknown[];

	const matchable = new Map<string, object>();
	for (const row of current) {
		const rowKey = normalizeKey(key(row));
		if (rowKey !== undefined) {
			if (matchable.has(rowKey)) {
				throw new ReconcileRowsKeyError(`two current rows share the key "${rowKey}", so work attached to one could stay with the other.`);
			}
			matchable.set(rowKey, row);
		}
	}
	const keys = new Set<string>();
	const itemKeys = items.map((item, i) => {
		const itemKey = normalizeKey(key(item));
		if (itemKey === undefined) {
			throw new ReconcileRowsKeyError(
				`the key function found no key on the incoming row at [${i}], and every incoming row has to name itself.`
			);
		}
		if (keys.has(itemKey)) {
			throw new ReconcileRowsKeyError(`two incoming rows share the key "${itemKey}", so work attached to one could land on the other.`);
		}
		keys.add(itemKey);
		return itemKey;
	});

	const raw = rawOf(current);
	const gateway = (
		current as unknown as {
			[DRAFT_SCOPE]: IDraftScope;
		}
	)[DRAFT_SCOPE].ctx.gateway;
	const refuseCrossing = gateway?.refuseCrossing;
	const onLive = refuseCrossing && ((live: object) => refuseCrossing(raw, live));
	const add = options.add ?? ((item: unknown) => entity(item as object));
	const walked: object[] = [];
	const added: number[] = [];
	// Every refusal a new row can raise comes here, ahead of the first write, because
	// stopping partway through the writes below would drop rows not yet seated.
	const seated = items.map((item, i) => {
		const matched = matchable.get(itemKeys[i]!);
		if (matched) {
			return rawOf(matched);
		}
		const written = unwrapValue(runInStep(add(item), "add"), [], i, walked, undefined, onLive);
		if (written === null || typeof written !== "object" || Array.isArray(written)) {
			throw new TypeError(
				`[treflex] reconcileRows(): add has to return a row, and for the incoming row at [${i}] it didn't. Nothing moved.`
			);
		}
		gateway?.refuseReplacement?.(raw, written, true);
		added.push(i);
		return written;
	});

	seated.forEach((row, i) => {
		if (rawOf(raw[i]) !== row) {
			seat(current, i, row, true);
		}
	});
	if (current.length > seated.length) {
		current.length = seated.length;
	}
	freezeAll(walked);

	const nodes = items.map((_, i) => current[i]!);
	nodes.forEach((node, i) => {
		runInStep(update(node, items[i]), "update");
	});
	return added.map((i) => nodes[i]!);
}
