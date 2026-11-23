import type { IOrder, ISuggestions } from "../shop/shop";
import { createEntityFeature } from "treflex-solid";
import { checkingOut } from "../shop/repair";
import {
	answerAddress,
	answerConfirm,
	answerDelivery,
	applyVoucher,
	checkout,
	currentAsk,
	dismiss,
	dismissNotice,
	setQuantity,
	suggest
} from "../shop/shop";

export const Order = createEntityFeature<IOrder>("Checkout/Order")(
	{
		checkout,
		answerAddress,
		answerDelivery,
		answerConfirm,
		dismiss,
		setQuantity,
		applyVoucher,
		dismissNotice
	},
	{
		currentAsk,
		checkingOut
	}
);

export const Suggestions = createEntityFeature<ISuggestions>("Checkout/Suggestions")({
	suggest
});
