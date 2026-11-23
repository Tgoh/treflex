import type { IActionGenerator, IRuntime, ISelectorGenerator } from "treflex";
import type { IRestoreDrop, IRestoreResult } from "treflex/snapshot";
import type { IOrder, IShop } from "./shop";
import { inFlight, named, start } from "treflex";
import { paymentStatus, releaseStock } from "../server/effects";
import { APPLY_VOUCHER_NAME, CHECKOUT_NAME, checkout, linesOf, SET_QUANTITY_NAME, SHOP_ID, SUGGEST_NAME, suggest } from "./shop";

export const RELOADED = "The page reloaded, so checkout starts again.";
export const PAID_BEFORE_RELOAD = "The page reloaded during payment, and the payment had gone through.";
export const VOUCHER_LOST = "The page reloaded before the voucher was checked, so apply it again.";
export const QUANTITY_LOST = "The page reloaded before a quantity change was applied, so change it again.";

/** The order's notice as the view shows it: once the order has a receipt, the notes asking to redo a lost change are left out. */
export function shownNotice(order: IOrder): string | null {
	if (order.Notice === null || order.Receipt === null) return order.Notice;
	const shown = [
		VOUCHER_LOST,
		QUANTITY_LOST
	]
		.reduce((text, note) => text.replace(note, ""), order.Notice)
		.replace(/\s+/g, " ")
		.trim();
	return shown === "" ? null : shown;
}

export interface IOrderDrops {
	Checkout: boolean;
	Voucher: boolean;
	Quantity: boolean;
}

export const RECOVER_ORDER_NAME = "Checkout/RecoverOrder";

export function* recoverOrder(draft: IOrder, dropped: IOrderDrops): IActionGenerator {
	const notes: string[] = [];
	if (dropped.Checkout) {
		if (draft.PaymentKey !== null && draft.Receipt === null) {
			const status = yield* paymentStatus({
				Key: draft.PaymentKey
			});
			if (status.Charged) {
				draft.Receipt = status.Receipt;
				notes.push(PAID_BEFORE_RELOAD);
			} else {
				yield* releaseStock({
					OrderId: draft.$Id
				});
				draft.PaymentKey = null;
			}
		}
		if (draft.Receipt === null && linesOf(draft).length > 0) {
			notes.push(RELOADED);
			yield* start(checkout, draft);
		}
	}
	if (dropped.Voucher && draft.Receipt === null) notes.push(VOUCHER_LOST);
	if (dropped.Quantity && draft.Receipt === null) notes.push(QUANTITY_LOST);
	if (notes.length > 0) draft.Notice = notes.join(" ");
}
named(recoverOrder, RECOVER_ORDER_NAME);

export function* recover(draft: IShop, dropped: IRestoreDrop[]): IActionGenerator {
	const orders = new Map<string, IOrderDrops>();
	const suggestions = new Set<string>();
	for (const entry of dropped) {
		if (entry.state === "stopping") continue;
		if (entry.name === SUGGEST_NAME) suggestions.add(entry.entityId);
		const isCheckout = entry.name === CHECKOUT_NAME || entry.name === RECOVER_ORDER_NAME;
		if (!isCheckout && entry.name !== APPLY_VOUCHER_NAME && entry.name !== SET_QUANTITY_NAME) continue;
		const order = orders.get(entry.entityId) ?? {
			Checkout: false,
			Voucher: false,
			Quantity: false
		};
		if (isCheckout) order.Checkout = true;
		else if (entry.name === APPLY_VOUCHER_NAME) order.Voucher = true;
		else order.Quantity = true;
		orders.set(entry.entityId, order);
	}
	for (const [id, order] of orders) yield* start(recoverOrder, id, order);
	const skus = linesOf(draft.Order).map((line) => line.Sku);
	for (const id of suggestions) yield* start(suggest, id, skus);
}
named(recover, "Checkout/Recover");

/** Whether the flow, or the repair's check on it, is running on the order. */
export function* checkingOut(draft: IOrder): ISelectorGenerator<boolean> {
	return yield* inFlight(
		[
			checkout,
			recoverOrder
		],
		draft
	);
}

/** The restore's repair. It starts the recovery without waiting for it, since the recovery waits on the server. */
export async function repairRestore(runtime: IRuntime<IShop>, result: IRestoreResult): Promise<void> {
	await runtime.dispatch(recover, SHOP_ID, result.dropped);
}
