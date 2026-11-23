import type { IAskEntry, IAskId } from "treflex";
import type { IAddress } from "../server/effects";
import type { IConfirmRequest, IDeliveryRequest } from "../shop/shop";
import { createSignal, For, Show } from "solid-js";
import { Order } from "./contexts";
import { money } from "./money";

export function AddressPage(props: { entry: IAskEntry }) {
	const order = Order.use();
	const [name, setName] = createSignal("");
	const [street, setStreet] = createSignal("");
	const [postcode, setPostcode] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	const [checking, setChecking] = createSignal(false);
	const submit = async (event: SubmitEvent): Promise<void> => {
		event.preventDefault();
		setChecking(true);
		const refused = await order.answerAddress(props.entry.Id as IAskId<IAddress>, {
			Name: name(),
			Street: street(),
			Postcode: postcode()
		});
		setChecking(false);
		setError(refused ?? null);
	};
	return (
		<form class="page address" onSubmit={(event) => void submit(event)}>
			<h2>Where should it go?</h2>
			<label>
				Name
				<input name="name" value={name()} onInput={(event) => setName(event.currentTarget.value)} />
			</label>
			<label>
				Street
				<input name="street" value={street()} onInput={(event) => setStreet(event.currentTarget.value)} />
			</label>
			<label>
				Postcode
				<input name="postcode" value={postcode()} onInput={(event) => setPostcode(event.currentTarget.value)} />
			</label>
			<Show when={error()}>
				<p class="error">{error()}</p>
			</Show>
			<div class="actions">
				<button type="submit" disabled={checking()}>
					{checking() ? "Checking…" : "Continue"}
				</button>
				<button type="button" class="quiet" disabled={checking()} onClick={() => void order.dismiss(props.entry.Id)}>
					Cancel
				</button>
			</div>
		</form>
	);
}

export function DeliveryPage(props: { entry: IAskEntry; request: IDeliveryRequest }) {
	const order = Order.use();
	return (
		<div class="page delivery">
			<h2>How fast?</h2>
			<For each={props.request.Options}>
				{(option) => (
					<button type="button" class="option" onClick={() => void order.answerDelivery(props.entry.Id as IAskId<string>, option.Id)}>
						<span>{option.Name}</span>
						<span>{money(option.Price)}</span>
					</button>
				)}
			</For>
			<div class="actions">
				<button type="button" class="quiet" onClick={() => void order.dismiss(props.entry.Id)}>
					Cancel
				</button>
			</div>
		</div>
	);
}

export function ConfirmPage(props: { entry: IAskEntry; request: IConfirmRequest }) {
	const order = Order.use();
	const id = () => props.entry.Id as IAskId<boolean>;
	return (
		<div class="page confirm">
			<h2>Pay {money(props.request.Total)}?</h2>
			<p>
				To {props.request.Address.Name}, {props.request.Address.Street}, {props.request.Address.Postcode}.
			</p>
			<p>{props.request.Delivery.Name}.</p>
			<div class="actions">
				<button type="button" onClick={() => void order.answerConfirm(id(), true)}>
					Pay
				</button>
				<button type="button" class="quiet" onClick={() => void order.answerConfirm(id(), false)}>
					Cancel
				</button>
			</div>
		</div>
	);
}
