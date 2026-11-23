import type { IRuntime } from "treflex";
import type { IFakeServer } from "../server/fakeServer";
import type { IGates } from "../testing/gates";
import type { IShop } from "./shop";
import { guids, settled } from "treflex";
import { createSnapshot, restoreTestRuntime } from "treflex/snapshot";
import { describe, expect, it } from "vitest";
import { serverImplementations } from "../server/fakeServer";
import { ADA, askAt, bootShop, openAsk } from "../testing/boot";
import { createGates } from "../testing/gates";
import { checkingOut, PAID_BEFORE_RELOAD, RELOADED, repairRestore, VOUCHER_LOST } from "./repair";
import {
	ADDRESS,
	answerAddress,
	answerConfirm,
	answerDelivery,
	applyVoucher,
	CONFIRM,
	checkout,
	DELIVERY,
	dismiss,
	SHOP_ID,
	setQuantity,
	suggest
} from "./shop";

async function reload(before: IRuntime<IShop>, server: IFakeServer, gates: IGates = createGates([]), prefix = "after") {
	const json = createSnapshot(before);
	before.dispose();
	await settled();
	const restored = await restoreTestRuntime<IShop>(json, {
		rootId: SHOP_ID,
		effectStubs: {
			...serverImplementations(server, gates.wait),
			generateGuid: guids(prefix)
		},
		repair: repairRestore
	});
	await settled();
	return restored;
}

async function toConfirm(runtime: IRuntime<IShop>): Promise<void> {
	runtime.dispatch(checkout, "Order");
	await settled();
	await runtime.dispatch(answerAddress, "Order", askAt(runtime, ADDRESS), ADA);
	await settled();
	await runtime.dispatch(answerDelivery, "Order", askAt(runtime, DELIVERY), "standard");
	await settled();
}

describe("the repair", () => {
	it("starts a checkout cut short at a question again at the first question, and says why", async () => {
		const { runtime, server } = bootShop();
		runtime.dispatch(checkout, "Order");
		await settled();
		await runtime.dispatch(answerAddress, "Order", askAt(runtime, ADDRESS), ADA);
		await settled();
		expect(openAsk(runtime)?.Request.Path).toBe(DELIVERY);

		const { runtime: after, result } = await reload(runtime, server);
		expect(
			result.dropped.map((d) => [
				d.name,
				d.state
			])
		).toEqual([
			[
				"Checkout/Checkout",
				"open"
			]
		]);
		expect(openAsk(after)?.Request.Path).toBe(ADDRESS);
		expect(after.state.Order.Notice).toBe(RELOADED);
		after.dispose();
	});

	it("forgets a payment key the server never charged, and starts again", async () => {
		const { runtime, server, gates } = bootShop([
			"Server/ReserveStock"
		]);
		runtime.dispatch(checkout, "Order");
		await settled();
		await runtime.dispatch(answerAddress, "Order", askAt(runtime, ADDRESS), ADA);
		await settled();
		await runtime.dispatch(answerDelivery, "Order", askAt(runtime, DELIVERY), "standard");
		await settled();
		expect(gates.waiting("Server/ReserveStock")).toBe(1);
		expect(runtime.state.Order.PaymentKey).toBe("key-1");

		const { runtime: after, result } = await reload(runtime, server);
		expect(
			result.dropped.map((d) => [
				d.name,
				d.state
			])
		).toEqual([
			[
				"Checkout/Checkout",
				"holding"
			]
		]);
		expect(after.state.Order.PaymentKey).toBeNull();
		expect(after.state.Order.Receipt).toBeNull();
		expect(openAsk(after)?.Request.Path).toBe(ADDRESS);
		expect(after.state.Order.Notice).toBe(RELOADED);
		expect(server.ledger().Charges).toEqual([]);
		expect(server.ledger().Orders.map((o) => o.Status)).toEqual([
			"released"
		]);
		after.dispose();
	});

	it("writes the receipt for a payment the server took before the reload, and doesn't ask again", async () => {
		const { runtime, server, gates } = bootShop([
			"Server/Pay"
		]);
		await toConfirm(runtime);
		await runtime.dispatch(answerConfirm, "Order", askAt(runtime, CONFIRM), true);
		await settled();
		expect(gates.waiting("Server/Pay")).toBe(1);
		expect(runtime.state.Order.Receipt).toBeNull();

		const { runtime: after, result } = await reload(runtime, server);
		expect(
			result.dropped.map((d) => [
				d.name,
				d.state
			])
		).toEqual([
			[
				"Checkout/Checkout",
				"holding"
			]
		]);
		expect(after.state.Order.Receipt).toEqual({
			ChargeId: "charge-1",
			Key: "key-1",
			Total: 5400
		});
		expect(after.state.Order.Notice).toBe(PAID_BEFORE_RELOAD);
		expect(after.processSelector(checkingOut, () => after.state.Order)).toBe(false);
		expect(server.ledger().Charges).toHaveLength(1);
		after.dispose();
	});

	it("charges once when a second reload lands while the first repair asks the server about the payment", async () => {
		const { runtime, server } = bootShop([
			"Server/Pay"
		]);
		await toConfirm(runtime);
		await runtime.dispatch(answerConfirm, "Order", askAt(runtime, CONFIRM), true);
		await settled();
		expect(server.ledger().Charges).toHaveLength(1);

		const statusHeld = createGates([
			"Server/PaymentStatus"
		]);
		const { runtime: between } = await reload(runtime, server, statusHeld);
		expect(statusHeld.waiting("Server/PaymentStatus")).toBe(1);
		expect(between.processSelector(checkingOut, () => between.state.Order)).toBe(true);

		const { runtime: after, result } = await reload(between, server, createGates([]), "again");
		expect(
			result.dropped.map((d) => [
				d.name,
				d.state
			])
		).toEqual([
			[
				"Checkout/RecoverOrder",
				"holding"
			]
		]);
		expect(after.state.Order.Receipt).toEqual({
			ChargeId: "charge-1",
			Key: "key-1",
			Total: 5400
		});
		expect(after.state.Order.Notice).toBe(PAID_BEFORE_RELOAD);
		expect(after.processSelector(checkingOut, () => after.state.Order)).toBe(false);
		expect(server.ledger().Charges).toHaveLength(1);
		after.dispose();
	});

	it("releases the stock a never-charged checkout reserved, so a restarted flow that is cancelled leaves nothing reserved", async () => {
		const { runtime, server } = bootShop();
		await toConfirm(runtime);
		expect(server.ledger().Orders.map((o) => o.Status)).toEqual([
			"reserved"
		]);

		const { runtime: after } = await reload(runtime, server);
		expect(after.state.Order.PaymentKey).toBeNull();
		expect(server.ledger().Orders.map((o) => o.Status)).toEqual([
			"released"
		]);
		await after.dispatch(dismiss, "Order", askAt(after, ADDRESS));
		await settled();
		expect(after.processSelector(checkingOut, () => after.state.Order)).toBe(false);
		expect(server.ledger().Orders.map((o) => o.Status)).toEqual([
			"released"
		]);
		expect(server.ledger().Charges).toEqual([]);
		after.dispose();
	});

	it("doesn't ask a paid order to apply its dropped voucher again", async () => {
		const { runtime, server } = bootShop([
			"Server/Pay"
		]);
		await toConfirm(runtime);
		await runtime.dispatch(answerConfirm, "Order", askAt(runtime, CONFIRM), true);
		await settled();
		runtime.dispatch(applyVoucher, "Order", "SAVE10");
		await settled();

		const { runtime: after, result } = await reload(runtime, server);
		expect(
			result.dropped.map((d) => [
				d.name,
				d.state
			])
		).toEqual([
			[
				"Checkout/Checkout",
				"holding"
			],
			[
				"Checkout/ApplyVoucher",
				"queued"
			]
		]);
		expect(after.state.Order.Receipt?.Total).toBe(5400);
		expect(after.state.Order.Voucher).toBeNull();
		expect(after.state.Order.Notice).toBe(PAID_BEFORE_RELOAD);
		after.dispose();
	});

	it("releases and forgets an unpaid key but doesn't start checkout again for an emptied basket", async () => {
		const { runtime, server } = bootShop();
		await toConfirm(runtime);
		await runtime.dispatch(setQuantity, "Order", "tea", 0);
		await runtime.dispatch(setQuantity, "Order", "mug", 0);
		expect(runtime.state.Order.PaymentKey).toBe("key-1");

		const { runtime: after } = await reload(runtime, server);
		expect(after.state.Order.PaymentKey).toBeNull();
		expect(server.ledger().Orders.map((o) => o.Status)).toEqual([
			"released"
		]);
		expect(after.state.Order.Notice).toBeNull();
		expect(openAsk(after)).toBeUndefined();
		expect(after.processSelector(checkingOut, () => after.state.Order)).toBe(false);
		after.dispose();
	});

	it("fetches dropped suggestions again", async () => {
		const { runtime, server } = bootShop([
			"Server/FetchSuggestions"
		]);
		runtime.dispatch(suggest, "Suggestions", [
			"tea"
		]);
		await settled();

		const { runtime: after, result } = await reload(runtime, server);
		expect(result.dropped.map((d) => d.name)).toEqual([
			"Checkout/Suggest"
		]);
		expect(after.state.Suggestions.Items.map((item) => item.Sku)).toEqual([
			"honey",
			"shortbread"
		]);
		expect(after.state.Order.Notice).toBeNull();
		after.dispose();
	});

	it("asks for a dropped voucher again, and starts a checkout queued behind it", async () => {
		const { runtime, server } = bootShop([
			"Server/CheckVoucher"
		]);
		runtime.dispatch(applyVoucher, "Order", "SAVE10");
		runtime.dispatch(checkout, "Order");
		await settled();

		const { runtime: after, result } = await reload(runtime, server);
		expect(
			result.dropped.map((d) => [
				d.name,
				d.state
			])
		).toEqual([
			[
				"Checkout/ApplyVoucher",
				"holding"
			],
			[
				"Checkout/Checkout",
				"queued"
			]
		]);
		expect(after.state.Order.Voucher).toBeNull();
		expect(after.state.Order.Notice).toBe(`${RELOADED} ${VOUCHER_LOST}`);
		expect(openAsk(after)?.Request.Path).toBe(ADDRESS);
		after.dispose();
	});
});
