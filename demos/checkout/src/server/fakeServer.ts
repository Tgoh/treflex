import type { IActionContext, IEffect } from "treflex";
import type {
	IAddressCheck,
	ICheckAddress,
	ICheckVoucher,
	IDeliveryOption,
	IFetchSuggestions,
	ILedger,
	IPay,
	IPaymentStatus,
	IPaymentStatusRequest,
	IQuoteDelivery,
	IReceipt,
	IReleaseStock,
	IReserveStock,
	ISuggestion,
	IVoucherCheck
} from "./effects";

export const CATALOGUE: readonly ISuggestion[] = [
	{
		Sku: "tea",
		Name: "Loose-leaf tea",
		Price: 1200
	},
	{
		Sku: "mug",
		Name: "Stoneware mug",
		Price: 1800
	},
	{
		Sku: "honey",
		Name: "Raw honey",
		Price: 950
	},
	{
		Sku: "shortbread",
		Name: "Shortbread",
		Price: 650
	},
	{
		Sku: "teapot",
		Name: "Cast-iron teapot",
		Price: 4200
	}
];

const VOUCHERS: Record<string, number> = {
	SAVE10: 10,
	HALF: 50
};

/** A stand-in for the shop's server. Each `pay` it receives is a charge: it doesn't dedupe by key. */
export interface IFakeServer {
	checkAddress(effect: ICheckAddress): IAddressCheck;
	quoteDelivery(effect: IQuoteDelivery): IDeliveryOption[];
	reserveStock(effect: IReserveStock): void;
	releaseStock(effect: IReleaseStock): void;
	pay(effect: IPay): IReceipt;
	paymentStatus(effect: IPaymentStatusRequest): IPaymentStatus;
	checkVoucher(effect: ICheckVoucher): IVoucherCheck;
	fetchSuggestions(effect: IFetchSuggestions): ISuggestion[];
	ledger(): ILedger;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function createFakeServer(saved?: ILedger, onChange?: (ledger: ILedger) => void): IFakeServer {
	const ledger: ILedger = saved
		? copy(saved)
		: {
				Orders: [],
				Charges: []
			};
	const changed = (): void => onChange?.(copy(ledger));
	const receiptOf = (key: string): IReceipt | undefined => {
		const charge = ledger.Charges.find((c) => c.Key === key);
		return (
			charge && {
				ChargeId: charge.Id,
				Key: charge.Key,
				Total: charge.Total
			}
		);
	};
	return {
		checkAddress: ({ Address }) => {
			const address = {
				Name: Address.Name.trim(),
				Street: Address.Street.trim(),
				Postcode: Address.Postcode.trim()
			};
			if (address.Name === "" || address.Street === "") {
				return {
					Valid: false,
					Error: "Give a name and a street."
				};
			}
			if (!/^\d{4}$/.test(address.Postcode)) {
				return {
					Valid: false,
					Error: "A postcode is four digits."
				};
			}
			return {
				Valid: true,
				Address: address
			};
		},
		quoteDelivery: ({ Postcode }) => {
			const remote = Postcode.startsWith("0") || Postcode.startsWith("7");
			return [
				{
					Id: "standard",
					Name: "Standard, three to five days",
					Price: remote ? 1200 : 600
				},
				{
					Id: "express",
					Name: "Express, next day",
					Price: remote ? 2400 : 1800
				}
			];
		},
		reserveStock: ({ OrderId, Lines }) => {
			const order = ledger.Orders.find((o) => o.OrderId === OrderId);
			if (order) {
				order.Lines = copy(Lines);
				order.Status = "reserved";
			} else {
				ledger.Orders.push({
					OrderId,
					Lines: copy(Lines),
					Status: "reserved"
				});
			}
			changed();
		},
		releaseStock: ({ OrderId }) => {
			const order = ledger.Orders.find((o) => o.OrderId === OrderId);
			if (!order || order.Status !== "reserved") return;
			order.Status = "released";
			changed();
		},
		pay: ({ OrderId, Key, Total }) => {
			const id = `charge-${ledger.Charges.length + 1}`;
			ledger.Charges.push({
				Id: id,
				OrderId,
				Key,
				Total
			});
			const order = ledger.Orders.find((o) => o.OrderId === OrderId);
			if (order) order.Status = "paid";
			changed();
			return {
				ChargeId: id,
				Key,
				Total
			};
		},
		paymentStatus: ({ Key }) => {
			const receipt = receiptOf(Key);
			return receipt
				? {
						Charged: true,
						Receipt: receipt
					}
				: {
						Charged: false
					};
		},
		checkVoucher: ({ Code }) => {
			const percent = VOUCHERS[Code.trim().toUpperCase()];
			return percent === undefined
				? {
						Valid: false
					}
				: {
						Valid: true,
						Percent: percent
					};
		},
		fetchSuggestions: ({ Skus }) => CATALOGUE.filter((item) => !Skus.includes(item.Sku)).slice(0, 2),
		ledger: () => copy(ledger)
	};
}

/** How long the server takes to answer a request of `type`, which the action's `signal` may cut short. */
export type IServerWait = (type: string, signal: AbortSignal | undefined) => Promise<void>;

/**
 * The server's effect implementations. Each request takes effect when it arrives and is answered after `wait`,
 * so a payment a reload cuts short has still been charged.
 */
export function serverImplementations(
	server: IFakeServer,
	wait: IServerWait
): Record<string, (effect: any, action?: IActionContext) => Promise<unknown>> {
	const answer =
		<E extends IEffect, R>(fn: (effect: E) => R) =>
		(effect: E, action?: IActionContext): Promise<R> => {
			const result = fn(effect);
			return wait(effect.Type, action?.signal).then(() => result);
		};
	return {
		"Server/CheckAddress": answer(server.checkAddress),
		"Server/QuoteDelivery": answer(server.quoteDelivery),
		"Server/ReserveStock": answer(server.reserveStock),
		"Server/ReleaseStock": answer(server.releaseStock),
		"Server/Pay": answer(server.pay),
		"Server/PaymentStatus": answer(server.paymentStatus),
		"Server/CheckVoucher": answer(server.checkVoucher),
		"Server/FetchSuggestions": answer(server.fetchSuggestions),
		"Server/ReadLedger": answer(server.ledger)
	};
}
