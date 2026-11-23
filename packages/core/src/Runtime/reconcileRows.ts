import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";
import { entity, type IWithId } from "../Effects/entity";
import { errorClass } from "../Utility/errorClasses";
import { copyAtSender } from "./crossing";
import { isDraftNode, seat } from "./draftNode";
import { settlesSync } from "./effectDeclarations";
import { DRAFT_SCOPE, type IDraftScope } from "./recordingProxy";
import { TreflexRefusal } from "./refusal";
import { runningStep } from "./runningStep";
import { freezeAll, rawOf, unwrapValue } from "./viewProxy";

/** Names a row in a list. It's given live rows and incoming data alike, so it reads a field both have. */
export type IReconcileRowsKey<Row, Item> = (row: Row | Item) => string | number | null | undefined;

/** Names an incoming row for a refresh of a record, whose own keys name the rows it holds. */
export type IReconcileRowsItemKey<Item> = (item: Item) => string | number | null | undefined;

export interface IReconcileRowsUpdate<Row, Item> {
	/**
	 * Fills every row in the result, new or matched, in the parent's step, writing into the row directly. A matched row keeps
	 * whatever of its old contents `update` doesn't write, so `update: () => {}` keeps them all.
	 */
	update: (row: Row, item: Item) => unknown;
}

export interface IReconcileRowsOptions<Row, Item> extends IReconcileRowsUpdate<Row, Item> {
	/** Makes the default row for an item nothing matched, as a value or a generator such as `entity(...)`. `update` fills it. */
	add: (item: Item) => NoInfer<Row> | Generator<any, NoInfer<Row>, any>;
}

type IReconcileRowsGiven<Row, Item> =
	IWithId<Item> extends Row
		? IReconcileRowsUpdate<Row, Item> & Partial<IReconcileRowsOptions<Row, Item>>
		: IReconcileRowsOptions<Row, Item>;

type IReconcileRowsRowOf<Rows> = Rows extends readonly (infer Row)[] ? Row : Rows[keyof Rows];

type IReconcileRowsKeyOf<Rows, Item> = Rows extends readonly unknown[]
	? IReconcileRowsKey<IReconcileRowsRowOf<Rows>, Item>
	: IReconcileRowsItemKey<Item>;

type IReconcileRowsAnyOptions = IReconcileRowsUpdate<object, unknown> & Partial<IReconcileRowsOptions<object, unknown>>;

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

errorClass("treflex/ReconcileRowsKeyError", ReconcileRowsKeyError);
errorClass("treflex/ReconcileRowsWaitError", ReconcileRowsWaitError);

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refuseTarget(current: unknown): boolean {
	if (current === null || typeof current !== "object" || !isDraftNode(current)) {
		throw new TypeError(
			"[treflex] reconcileRows(): the rows have to be an array or a record on the draft. A getData or select result, an argument or a " +
				"view is a copy or read-only, so writing to it never reaches state."
		);
	}
	if (Array.isArray(current)) {
		return false;
	}
	if (Object.hasOwn(rawOf(current), "$Id")) {
		throw new TypeError(
			"[treflex] reconcileRows(): the record is an entity, and an entity's fields aren't rows. Keep the rows in a record of their own, " +
				"in a field of the entity."
		);
	}
	return true;
}

/**
 * Refreshes a list or a record of rows while keeping what's attached to them, for when rows have
 * running work, timers or resources that must survive. Otherwise, replace the rows. It takes one
 * level: a row's own collection is a `reconcileRows` inside `update`, naming its own key.
 *
 * A row whose key matches an incoming item keeps its node and id. An item nothing matched gets
 * a new row from `add`, or `entity(item)` without one. `update` then runs on every row in the
 * result, so one path fills both. A row no item matched leaves the tree as an ordinary removal.
 * `current` is the same array or record afterwards. A list ends in `incoming`'s order.
 *
 * A record's own keys name its rows, and the key function names only incoming items. Incoming
 * rows for a record are an array with a key function, or a record keyed the same way with none.
 * A matched row stays where it was in the record's key order. An incoming item keyed
 * `"__proto__"` is skipped.
 *
 * The whole refresh, with the writes around the call and any nested `reconcileRows`, lands in one
 * step: nothing yielded in `add` or `update` ends it, and a view sees the rows before or after.
 * That means they can only run sync effects, and anything else throws `ReconcileRowsWaitError`
 * at its yield. `add` runs before anything moves, so a throw there leaves the rows untouched.
 * A throw from `update` comes after the rows are arranged, and what landed stays.
 *
 * Throws `ReconcileRowsKeyError` before anything moves when an incoming item has no key, or when
 * two rows in either list share one. A current row with no key can't match, so it's removed.
 *
 * Returns the rows it added, as nodes on the draft, in `incoming`'s order.
 * See docs/reference/write-path.md#refreshing-rows.
 */
export function reconcileRows<Row extends object, Item>(
	current: Record<string, Row>,
	incoming: readonly Item[],
	key: IReconcileRowsItemKey<Item>,
	options: IReconcileRowsOptions<Row, Item>
): IActionGenerator<Row[]>;
export function reconcileRows<Row extends object, Item extends Omit<Row, "$Id">>(
	current: Record<string, Row>,
	incoming: readonly Item[],
	key: IReconcileRowsItemKey<Item>,
	options: IReconcileRowsUpdate<Row, Item>
): IActionGenerator<Row[]>;
export function reconcileRows<Row extends object, Item>(
	current: Record<string, Row>,
	incoming: Readonly<Record<string, Item>>,
	options: IReconcileRowsOptions<Row, Item>
): IActionGenerator<Row[]>;
export function reconcileRows<Row extends object, Item extends Omit<Row, "$Id">>(
	current: Record<string, Row>,
	incoming: Readonly<Record<string, Item>>,
	options: IReconcileRowsUpdate<Row, Item>
): IActionGenerator<Row[]>;
export function reconcileRows<Row extends object, Item>(
	current: Record<string, Row>,
	incoming: Readonly<Record<string, Item>>,
	options: IReconcileRowsGiven<Row, Item>
): IActionGenerator<Row[]>;
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
export function reconcileRows<Rows extends object[] | Record<string, object>, Item>(
	current: Rows,
	incoming: readonly Item[],
	key: IReconcileRowsKeyOf<Rows, Item>,
	options: IReconcileRowsGiven<IReconcileRowsRowOf<Rows>, Item>
): IActionGenerator<IReconcileRowsRowOf<Rows>[]>;
export function* reconcileRows(
	current: object,
	incoming: unknown,
	keyOrOptions: IReconcileRowsKey<object, unknown> | IReconcileRowsAnyOptions,
	listOptions?: IReconcileRowsAnyOptions
): IActionGenerator<object[]> {
	const toRecord = refuseTarget(current);
	const fromRecord = toRecord && isRecord(incoming);
	if (!Array.isArray(incoming) && !fromRecord) {
		throw new TypeError(
			toRecord
				? "[treflex] reconcileRows(): the incoming rows have to be an array or a record."
				: "[treflex] reconcileRows(): the incoming rows for a list have to be an array, since a list ends in their order."
		);
	}
	if (fromRecord && typeof keyOrOptions === "function") {
		throw new TypeError(
			"[treflex] reconcileRows(): an incoming record names its rows by its own keys, so it takes no key function. Nothing moved."
		);
	}
	const key = (fromRecord ? undefined : keyOrOptions) as IReconcileRowsKey<object, unknown>;
	const options = (fromRecord ? keyOrOptions : listOptions) as IReconcileRowsAnyOptions | undefined;
	const update = options?.update;
	if (typeof update !== "function") {
		throw new TypeError(
			"[treflex] reconcileRows(): update is required, and it fills every row, new or matched. To keep a matched row's contents, " +
				"pass update: () => {}. Nothing moved."
		);
	}
	const copied = copyAtSender(incoming, "reconcileRows(): the incoming rows");

	const matchable = new Map<string, object>();
	if (toRecord) {
		const rows = current as Record<string, object>;
		for (const rowKey of Object.keys(rows)) {
			if (normalizeKey(rowKey) !== undefined) {
				matchable.set(rowKey, rows[rowKey]!);
			}
		}
	} else {
		for (const row of current as object[]) {
			const rowKey = normalizeKey(key(row));
			if (rowKey !== undefined) {
				if (matchable.has(rowKey)) {
					throw new ReconcileRowsKeyError(`two current rows share the key "${rowKey}", so work attached to one could stay with the other.`);
				}
				matchable.set(rowKey, row);
			}
		}
	}

	const items: unknown[] = [];
	const itemKeys: string[] = [];
	if (fromRecord) {
		for (const [itemKey, item] of Object.entries(copied as Record<string, unknown>)) {
			if (normalizeKey(itemKey) === undefined) {
				throw new ReconcileRowsKeyError(`the incoming record has the key "", and every incoming row has to name itself.`);
			}
			items.push(item);
			itemKeys.push(itemKey);
		}
	} else {
		const keys = new Set<string>();
		(copied as readonly unknown[]).forEach((item, i) => {
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
			if (toRecord && itemKey === "__proto__") {
				return;
			}
			items.push(item);
			itemKeys.push(itemKey);
		});
	}

	const raw = rawOf(current) as Record<string, unknown>;
	const gateway = (
		current as unknown as {
			[DRAFT_SCOPE]: IDraftScope;
		}
	)[DRAFT_SCOPE].ctx.gateway;
	const refuseCrossing = gateway?.refuseCrossing;
	const onLive = refuseCrossing && ((live: object) => refuseCrossing(raw, live));
	const add = options?.add ?? ((item: unknown) => entity(item as object));
	const walked: object[] = [];
	const added: number[] = [];
	// Every refusal a new row can raise comes here, ahead of the first write, because
	// stopping partway through the writes below would drop rows not yet seated.
	const seated = items.map((item, i) => {
		const itemKey = itemKeys[i]!;
		const matched = matchable.get(itemKey);
		if (matched) {
			return rawOf(matched);
		}
		const written = unwrapValue(runInStep(add(item), "add"), [], toRecord ? itemKey : i, walked, undefined, onLive);
		if (written === null || typeof written !== "object" || Array.isArray(written)) {
			throw new TypeError(
				`[treflex] reconcileRows(): add has to return a row, and for the incoming row ${toRecord ? JSON.stringify(itemKey) : `at [${i}]`} ` +
					"it didn't. Nothing moved."
			);
		}
		gateway?.refuseReplacement?.(raw, written, true);
		added.push(i);
		return written;
	});

	const places: (string | number)[] = toRecord ? itemKeys : items.map((_, i) => i);
	if (toRecord) {
		const kept = new Set(itemKeys);
		for (const rowKey of Object.keys(raw)) {
			if (!kept.has(rowKey)) {
				delete (current as Record<string, unknown>)[rowKey];
			}
		}
	}
	seated.forEach((row, i) => {
		const place = places[i]!;
		if (rawOf(raw[place]) !== row) {
			seat(current, place, row, true);
		}
	});
	if (!toRecord && (current as object[]).length > seated.length) {
		(current as object[]).length = seated.length;
	}
	freezeAll(walked);

	const nodes = places.map((place) => (current as Record<string | number, object>)[place]!);
	nodes.forEach((node, i) => {
		runInStep(update(node, items[i]), "update");
	});
	return added.map((i) => nodes[i]!);
}
