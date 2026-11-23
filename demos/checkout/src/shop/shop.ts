import type { IActionGenerator, IAskEntry, IAskId, IEntity, ISelectorGenerator } from "treflex";
import type { IAddress, ICharge, IDeliveryOption, ILedger, ILedgerOrder, ILineRequest, IReceipt, ISuggestion } from "../server/effects";
import { answer, ask, generateGuid, latest, leading, named, open, pendingAsks, resumable } from "treflex";
import {
	checkAddress,
	checkVoucher,
	fetchSuggestions,
	pay,
	quoteDelivery,
	readLedger,
	releaseStock,
	reserveStock
} from "../server/effects";

export const SHOP_ID = "Shop";
export const ORDER_ID = "Order";

export const ADDRESS = "Checkout/Address";
export const DELIVERY = "Checkout/Delivery";
export const CONFIRM = "Checkout/Confirm";

export const CHECKOUT_NAME = "Checkout/Checkout";
export const APPLY_VOUCHER_NAME = "Checkout/ApplyVoucher";
export const SUGGEST_NAME = "Checkout/Suggest";
export const SET_QUANTITY_NAME = "Checkout/SetQuantity";

export interface ILine {
	Sku: string;
	Name: string;
	Price: number;
	Quantity: number;
}

export interface IVoucher {
	Code: string;
	Percent: number;
}

/** What the server holds about one order, as `readServer` last read it. */
export interface IAtServer {
	/** Null while the server holds no reservation for the order. */
	Status: ILedgerOrder["Status"] | null;
	Lines: ILineRequest[];
	Charges: ICharge[];
}

export interface IOrder extends IEntity {
	Lines: ILine[];
	Voucher: IVoucher | null;
	PaymentKey: string | null;
	Receipt: IReceipt | null;
	Notice: string | null;
	Server: IAtServer;
}

export interface ISuggestions extends IEntity {
	Items: ISuggestion[];
}

export interface IShop extends IEntity {
	Order: IOrder;
	Suggestions: ISuggestions;
}

export interface IAddressRequest {
	Path: typeof ADDRESS;
}

export interface IDeliveryRequest {
	Path: typeof DELIVERY;
	Options: IDeliveryOption[];
}

export interface IConfirmRequest {
	Path: typeof CONFIRM;
	Address: IAddress;
	Delivery: IDeliveryOption;
	Total: number;
}

export type ICheckoutRequest = IAddressRequest | IDeliveryRequest | IConfirmRequest;

export function getDefaultState(): IShop {
	return {
		$Id: SHOP_ID,
		Order: {
			$Id: ORDER_ID,
			Lines: [
				{
					Sku: "tea",
					Name: "Loose-leaf tea",
					Price: 1200,
					Quantity: 1
				},
				{
					Sku: "mug",
					Name: "Stoneware mug",
					Price: 1800,
					Quantity: 2
				}
			],
			Voucher: null,
			PaymentKey: null,
			Receipt: null,
			Notice: null,
			Server: atServerOf(
				{
					Orders: [],
					Charges: []
				},
				ORDER_ID
			)
		},
		Suggestions: {
			$Id: "Suggestions",
			Items: []
		}
	};
}

export function atServerOf(ledger: ILedger, orderId: string): IAtServer {
	const order = ledger.Orders.find((o) => o.OrderId === orderId);
	return {
		Status: order?.Status ?? null,
		Lines: order?.Lines ?? [],
		Charges: ledger.Charges.filter((charge) => charge.OrderId === orderId)
	};
}

export const linesOf = (order: IOrder): ILineRequest[] =>
	order.Lines.filter((line) => line.Quantity > 0).map((line) => ({
		Sku: line.Sku,
		Quantity: line.Quantity
	}));

const sameLines = (a: readonly ILineRequest[], b: readonly ILineRequest[]): boolean => JSON.stringify(a) === JSON.stringify(b);

export const subtotalOf = (order: IOrder): number => order.Lines.reduce((sum, line) => sum + line.Price * line.Quantity, 0);

export const discountOf = (order: IOrder): number => Math.round((subtotalOf(order) * (order.Voucher?.Percent ?? 0)) / 100);

export const totalOf = (order: IOrder, delivery: IDeliveryOption): number => subtotalOf(order) - discountOf(order) + delivery.Price;

export function* checkout(draft: IOrder) {
	if (draft.Receipt !== null || linesOf(draft).length === 0) return;
	const address = yield* open(
		ask<IAddress>(draft, {
			Path: ADDRESS
		} satisfies IAddressRequest)
	);
	if (address === undefined) return;
	const options = yield* open(
		quoteDelivery({
			Postcode: address.Postcode
		})
	);
	const optionId = yield* open(
		ask<string>(draft, {
			Path: DELIVERY,
			Options: options
		} satisfies IDeliveryRequest)
	);
	const delivery = options.find((option) => option.Id === optionId);
	if (delivery === undefined || draft.Receipt !== null || linesOf(draft).length === 0) return;
	const key = yield* generateGuid();
	draft.PaymentKey = key;
	let reserved = linesOf(draft);
	yield* reserveStock({
		OrderId: draft.$Id,
		Lines: reserved
	});
	let total = totalOf(draft, delivery);
	for (;;) {
		const confirmed = yield* open(
			ask<boolean>(draft, {
				Path: CONFIRM,
				Address: address,
				Delivery: delivery,
				Total: total
			} satisfies IConfirmRequest)
		);
		if (confirmed !== true || linesOf(draft).length === 0) {
			yield* releaseStock({
				OrderId: draft.$Id
			});
			draft.PaymentKey = null;
			return;
		}
		const lines = linesOf(draft);
		if (!sameLines(lines, reserved)) {
			reserved = lines;
			yield* reserveStock({
				OrderId: draft.$Id,
				Lines: reserved
			});
		}
		const now = totalOf(draft, delivery);
		if (now === total) break;
		total = now;
	}
	draft.Receipt = yield* pay({
		OrderId: draft.$Id,
		Key: key,
		Total: total
	});
}
named(checkout, CHECKOUT_NAME);
leading(checkout);
resumable(checkout);

export function* answerAddress(_draft: IOrder, askId: IAskId<IAddress>, address: IAddress): IActionGenerator<string | undefined> {
	const check = yield* checkAddress({
		Address: address
	});
	if (!check.Valid) return check.Error;
	yield* answer(askId, check.Address);
	return undefined;
}
named(answerAddress, "Checkout/AnswerAddress");

export function* answerDelivery(_draft: IOrder, askId: IAskId<string>, optionId: string): IActionGenerator {
	yield* answer(askId, optionId);
}
named(answerDelivery, "Checkout/AnswerDelivery");

export function* answerConfirm(_draft: IOrder, askId: IAskId<boolean>, confirmed: boolean): IActionGenerator {
	yield* answer(askId, confirmed);
}
named(answerConfirm, "Checkout/AnswerConfirm");

export function* dismiss(_draft: IOrder, askId: IAskId<unknown>): IActionGenerator {
	yield* answer(askId);
}
named(dismiss, "Checkout/Dismiss");

export function* setQuantity(draft: IOrder, sku: string, quantity: number): IActionGenerator {
	const line = draft.Lines.find((l) => l.Sku === sku);
	if (!line || draft.Receipt !== null) return;
	line.Quantity = Math.max(0, Math.floor(quantity));
}
named(setQuantity, SET_QUANTITY_NAME);

export function* applyVoucher(draft: IOrder, code: string): IActionGenerator {
	if (draft.Receipt !== null) return;
	const check = yield* checkVoucher({
		Code: code
	});
	if (!check.Valid) {
		draft.Notice = `${code} isn't a voucher this shop knows.`;
		return;
	}
	draft.Voucher = {
		Code: code.trim().toUpperCase(),
		Percent: check.Percent
	};
}
named(applyVoucher, APPLY_VOUCHER_NAME);

export function* dismissNotice(draft: IOrder, text: string): IActionGenerator {
	if (draft.Notice === text) draft.Notice = null;
}
named(dismissNotice, "Checkout/DismissNotice");

export function* suggest(draft: ISuggestions, skus: string[]): IActionGenerator {
	draft.Items = yield* fetchSuggestions({
		Skus: skus
	});
}
named(suggest, SUGGEST_NAME);

export function* readServer(draft: IOrder): IActionGenerator {
	draft.Server = atServerOf(yield* readLedger(), draft.$Id);
}
named(readServer, "Checkout/ReadServer");
latest(readServer);

const isCheckoutRequest = (request: unknown): request is ICheckoutRequest => {
	const path = (
		request as {
			Path?: unknown;
		} | null
	)?.Path;
	return path === ADDRESS || path === DELIVERY || path === CONFIRM;
};

/** The flow's open question, if it has one. */
export function* currentAsk(draft: IOrder): ISelectorGenerator<
	| (IAskEntry & {
			Request: ICheckoutRequest;
	  })
	| undefined
> {
	return (yield* pendingAsks(draft)).find(
		(
			entry
		): entry is IAskEntry & {
			Request: ICheckoutRequest;
		} => isCheckoutRequest(entry.Request)
	);
}
