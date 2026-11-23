import type { IEffect } from "treflex";
import { defineEffect } from "treflex";

export interface IAddress {
	Name: string;
	Street: string;
	Postcode: string;
}

export interface ILineRequest {
	Sku: string;
	Quantity: number;
}

export interface IDeliveryOption {
	Id: string;
	Name: string;
	Price: number;
}

export interface IReceipt {
	ChargeId: string;
	Key: string;
	Total: number;
}

export interface ISuggestion {
	Sku: string;
	Name: string;
	Price: number;
}

export interface ILedgerOrder {
	OrderId: string;
	Lines: ILineRequest[];
	Status: "reserved" | "released" | "paid";
}

export interface ICharge {
	Id: string;
	OrderId: string;
	Key: string;
	Total: number;
}

/** What the server holds, as the page reads it. */
export interface ILedger {
	Orders: ILedgerOrder[];
	Charges: ICharge[];
}

export type IAddressCheck =
	| {
			Valid: true;
			Address: IAddress;
	  }
	| {
			Valid: false;
			Error: string;
	  };

export type IVoucherCheck =
	| {
			Valid: true;
			Percent: number;
	  }
	| {
			Valid: false;
	  };

export type IPaymentStatus =
	| {
			Charged: true;
			Receipt: IReceipt;
	  }
	| {
			Charged: false;
	  };

export interface ICheckAddress extends IEffect {
	Type: "Server/CheckAddress";
	Address: IAddress;
}

export interface IQuoteDelivery extends IEffect {
	Type: "Server/QuoteDelivery";
	Postcode: string;
}

export interface IReserveStock extends IEffect {
	Type: "Server/ReserveStock";
	OrderId: string;
	Lines: ILineRequest[];
}

export interface IReleaseStock extends IEffect {
	Type: "Server/ReleaseStock";
	OrderId: string;
}

export interface IPay extends IEffect {
	Type: "Server/Pay";
	OrderId: string;
	Key: string;
	Total: number;
}

export interface IPaymentStatusRequest extends IEffect {
	Type: "Server/PaymentStatus";
	Key: string;
}

export interface ICheckVoucher extends IEffect {
	Type: "Server/CheckVoucher";
	Code: string;
}

export interface IFetchSuggestions extends IEffect {
	Type: "Server/FetchSuggestions";
	Skus: string[];
}

export interface IReadLedger extends IEffect {
	Type: "Server/ReadLedger";
}

export const checkAddress = defineEffect<ICheckAddress, IAddressCheck>("Server/CheckAddress");
export const quoteDelivery = defineEffect<IQuoteDelivery, IDeliveryOption[]>("Server/QuoteDelivery", {
	idempotent: true
});
export const reserveStock = defineEffect<IReserveStock, void>("Server/ReserveStock", {
	idempotent: true
});
export const releaseStock = defineEffect<IReleaseStock, void>("Server/ReleaseStock");
export const pay = defineEffect<IPay, IReceipt>("Server/Pay");
export const paymentStatus = defineEffect<IPaymentStatusRequest, IPaymentStatus>("Server/PaymentStatus");
export const checkVoucher = defineEffect<ICheckVoucher, IVoucherCheck>("Server/CheckVoucher");
export const fetchSuggestions = defineEffect<IFetchSuggestions, ISuggestion[]>("Server/FetchSuggestions");
export const readLedger = defineEffect<IReadLedger, ILedger>("Server/ReadLedger");
