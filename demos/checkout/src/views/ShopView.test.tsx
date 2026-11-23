// @vitest-environment jsdom
import type { IActionGenerator } from "treflex";
import type { IReceipt } from "../server/effects";
import type { IOrder } from "../shop/shop";
import { render } from "@solidjs/web";
import { createTestRuntime, named, settled } from "treflex";
import { TreflexProvider } from "treflex-solid";
import { expect, it } from "vitest";
import { QUANTITY_LOST, RELOADED, VOUCHER_LOST } from "../shop/repair";
import { getDefaultState } from "../shop/shop";
import { ADA, bootShop, openAsk } from "../testing/boot";
import { ShopView } from "./ShopView";

const type = (host: HTMLElement, name: string, value: string): void => {
	const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
	input.value = value;
	input.dispatchEvent(
		new InputEvent("input", {
			bubbles: true
		})
	);
};

const buttonNamed = (host: HTMLElement, text: string): HTMLButtonElement =>
	[
		...host.querySelectorAll("button")
	].find((button) => button.textContent?.trim() === text)!;

it("shows the address page, keeps Cancel off while the address is checked, then shows the delivery page and cancels from it", async () => {
	const { runtime, gates } = bootShop([
		"Server/CheckAddress"
	]);
	const host = document.body.appendChild(document.createElement("div"));
	const dispose = render(
		() => (
			<TreflexProvider value={runtime}>
				<ShopView shop={runtime.state} />
			</TreflexProvider>
		),
		host
	);

	buttonNamed(host, "Check out").click();
	await settled();
	expect(host.querySelector("form.address h2")?.textContent).toBe("Where should it go?");
	expect(buttonNamed(host, "Check out")).toBeUndefined();

	type(host, "name", ADA.Name);
	type(host, "street", ADA.Street);
	type(host, "postcode", "30");
	await settled();
	buttonNamed(host, "Continue").click();
	await settled();
	expect(buttonNamed(host, "Checking…").disabled).toBe(true);
	expect(buttonNamed(host, "Cancel").disabled).toBe(true);
	gates.release("Server/CheckAddress");
	await settled();
	expect(host.querySelector(".address .error")?.textContent).toBe("A postcode is four digits.");
	expect(buttonNamed(host, "Cancel").disabled).toBe(false);

	type(host, "postcode", ADA.Postcode);
	await settled();
	buttonNamed(host, "Continue").click();
	await settled();
	gates.release("Server/CheckAddress");
	await settled();
	expect(host.querySelector("form.address")).toBeNull();
	expect(
		[
			...host.querySelectorAll(".delivery .option")
		].map((option) => option.textContent)
	).toEqual([
		"Standard, three to five days$6.00",
		"Express, next day$18.00"
	]);

	buttonNamed(host, "Cancel").click();
	await settled();
	expect(openAsk(runtime)).toBeUndefined();
	expect(buttonNamed(host, "Check out")).toBeDefined();

	dispose();
	host.remove();
});

const RECEIPT: IReceipt = {
	ChargeId: "charge-1",
	Key: "key-1",
	Total: 5400
};

function* pays(draft: IOrder): IActionGenerator {
	draft.Receipt = RECEIPT;
}
named(pays, "Test/Pays");

function shopWithNotice(notice: string, receipt: IReceipt | null = null) {
	const state = getDefaultState();
	state.Order.Notice = notice;
	state.Order.Receipt = receipt;
	const runtime = createTestRuntime(state);
	const host = document.body.appendChild(document.createElement("div"));
	const dispose = render(
		() => (
			<TreflexProvider value={runtime}>
				<ShopView shop={runtime.state} />
			</TreflexProvider>
		),
		host
	);
	return {
		runtime,
		host,
		shown: () => host.querySelector(".notice")?.firstChild?.textContent ?? null,
		close: () => {
			dispose();
			host.remove();
		}
	};
}

it("leaves out the notes asking to redo a lost voucher or quantity once the order is paid, keeping the notice in state, and dismisses it", async () => {
	const notice = `${RELOADED} ${VOUCHER_LOST} ${QUANTITY_LOST}`;
	const shop = shopWithNotice(notice);
	expect(shop.shown()).toBe(notice);

	await shop.runtime.dispatch(pays, "Order");
	await settled();
	expect(shop.shown()).toBe(RELOADED);
	expect(shop.runtime.state.Order.Notice).toBe(notice);

	buttonNamed(shop.host, "Dismiss").click();
	await settled();
	expect(shop.runtime.state.Order.Notice).toBeNull();
	expect(shop.host.querySelector(".notice")).toBeNull();
	shop.close();
});

it("shows no notice on a paid order whose only note asks for a lost voucher again", () => {
	const shop = shopWithNotice(VOUCHER_LOST, RECEIPT);
	expect(shop.host.querySelector(".notice")).toBeNull();
	expect(shop.runtime.state.Order.Notice).toBe(VOUCHER_LOST);
	shop.close();
});
