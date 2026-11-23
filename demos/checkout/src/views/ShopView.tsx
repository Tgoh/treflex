import type { IAtServer, IConfirmRequest, IDeliveryRequest, IOrder, IShop } from "../shop/shop";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { useInFlight } from "treflex-solid";
import { shownNotice } from "../shop/repair";
import { ADDRESS, applyVoucher, CONFIRM, DELIVERY, discountOf, linesOf, subtotalOf, suggest } from "../shop/shop";
import { Order, Suggestions } from "./contexts";
import { AddressPage, ConfirmPage, DeliveryPage } from "./FlowPages";
import { money } from "./money";

function Flow() {
	const order = Order.use();
	const entryAt = (path: string) => {
		const entry = order.currentAsk();
		return entry?.Request.Path === path ? entry : undefined;
	};
	return (
		<section class="flow">
			<Switch
				fallback={
					<button type="button" disabled={linesOf(order.state).length === 0} onClick={() => void order.checkout()}>
						Check out
					</button>
				}
			>
				<Match when={entryAt(ADDRESS)} keyed>
					{(entry) => <AddressPage entry={entry} />}
				</Match>
				<Match when={entryAt(DELIVERY)} keyed>
					{(entry) => <DeliveryPage entry={entry} request={entry.Request as IDeliveryRequest} />}
				</Match>
				<Match when={entryAt(CONFIRM)} keyed>
					{(entry) => <ConfirmPage entry={entry} request={entry.Request as IConfirmRequest} />}
				</Match>
				<Match when={order.checkingOut()}>
					<p class="busy">Waiting for the shop…</p>
				</Match>
				<Match when={order.state.Receipt} keyed>
					{(receipt) => (
						<p class="paid">
							Paid {money(receipt.Total)}, receipt {receipt.ChargeId}.
						</p>
					)}
				</Match>
			</Switch>
		</section>
	);
}

const OrderView = Order.provider(() => {
	const order = Order.use();
	const checkingVoucher = useInFlight(applyVoucher, () => order.state);
	const [code, setCode] = createSignal("");
	return (
		<>
			<Show when={shownNotice(order.state)} keyed>
				{(notice) => (
					<p class="notice">
						{notice}
						<button type="button" class="quiet" onClick={() => void order.dismissNotice(order.state.Notice!)}>
							Dismiss
						</button>
					</p>
				)}
			</Show>
			<section class="basket">
				<h2>Basket</h2>
				<For each={order.state.Lines}>
					{(line) => (
						<div class="line">
							<span>{line.Name}</span>
							<span class="quantity">
								<button type="button" onClick={() => void order.setQuantity(line.Sku, line.Quantity - 1)}>
									−
								</button>
								{line.Quantity}
								<button type="button" onClick={() => void order.setQuantity(line.Sku, line.Quantity + 1)}>
									+
								</button>
							</span>
							<span>{money(line.Price * line.Quantity)}</span>
						</div>
					)}
				</For>
				<div class="line total">
					<span>Subtotal</span>
					<span />
					<span>{money(subtotalOf(order.state))}</span>
				</div>
				<Show when={order.state.Voucher} keyed>
					{(voucher) => (
						<div class="line">
							<span>
								{voucher.Code}, {voucher.Percent}% off
							</span>
							<span />
							<span>−{money(discountOf(order.state))}</span>
						</div>
					)}
				</Show>
				<form
					class="voucher"
					onSubmit={(event) => {
						event.preventDefault();
						void order.applyVoucher(code());
					}}
				>
					<input
						placeholder="Voucher code"
						disabled={order.state.Receipt !== null}
						value={code()}
						onInput={(event) => setCode(event.currentTarget.value)}
					/>
					<button type="submit" disabled={checkingVoucher() || order.state.Receipt !== null}>
						{checkingVoucher() ? "Checking…" : "Apply"}
					</button>
				</form>
			</section>
			<Flow />
		</>
	);
});

const SuggestionsView = Suggestions.provider<{
	order: IOrder;
}>((props) => {
	const suggestions = Suggestions.use();
	const fetching = useInFlight(suggest, () => suggestions.state);
	return (
		<section class="suggestions">
			<h2>You might like</h2>
			<For each={suggestions.state.Items} fallback={<p class="quiet">Nothing yet.</p>}>
				{(item) => (
					<div class="line">
						<span>{item.Name}</span>
						<span />
						<span>{money(item.Price)}</span>
					</div>
				)}
			</For>
			<button type="button" disabled={fetching()} onClick={() => void suggestions.suggest(linesOf(props.order).map((line) => line.Sku))}>
				{fetching() ? "Looking…" : "Suggest"}
			</button>
		</section>
	);
});

function ServerPanel(props: { orderId: string; atServer: IAtServer }) {
	return (
		<aside class="server">
			<h2>At the server</h2>
			<h3>Orders</h3>
			<Show when={props.atServer.Status} fallback={<p class="quiet">None.</p>}>
				{(status) => (
					<p>
						{props.orderId}: {status()}, {props.atServer.Lines.map((line) => `${line.Quantity} × ${line.Sku}`).join(", ")}
					</p>
				)}
			</Show>
			<h3>Charges</h3>
			<For each={props.atServer.Charges} fallback={<p class="quiet">None.</p>}>
				{(charge) => (
					<p>
						{charge.Id}: {money(charge.Total)} on {charge.OrderId}, key {charge.Key}
					</p>
				)}
			</For>
		</aside>
	);
}

export function ShopView(props: { shop: IShop; onReset?: () => void }) {
	return (
		<main class="shop">
			<header>
				<h1>Checkout</h1>
				<Show when={props.onReset}>
					{(reset) => (
						<button type="button" class="quiet" onClick={() => reset()()}>
							Start over
						</button>
					)}
				</Show>
			</header>
			<div class="columns">
				<div>
					<OrderView state={props.shop.Order} />
					<SuggestionsView state={props.shop.Suggestions} order={props.shop.Order} />
				</div>
				<ServerPanel orderId={props.shop.Order.$Id} atServer={props.shop.Order.Server} />
			</div>
		</main>
	);
}
