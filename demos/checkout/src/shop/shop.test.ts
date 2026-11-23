import type { IAskId } from "treflex";
import type { IAddress } from "../server/effects";
import { settled } from "treflex";
import { describe, expect, it } from "vitest";
import { ADA, askAt, bootShop, openAsk } from "../testing/boot";
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
	dismissNotice,
	setQuantity
} from "./shop";

describe("checkout", () => {
	it("asks for an address, a delivery option and a confirmation, then pays", async () => {
		const { runtime, server } = bootShop();
		const flow = runtime.dispatch(checkout, "Order");
		await settled();
		expect(openAsk(runtime)?.Request).toEqual({
			Path: ADDRESS
		});

		expect(await runtime.dispatch(answerAddress, "Order", askAt(runtime, ADDRESS), ADA)).toBeUndefined();
		await settled();
		expect(openAsk(runtime)?.Request).toEqual({
			Path: DELIVERY,
			Options: [
				{
					Id: "standard",
					Name: "Standard, three to five days",
					Price: 600
				},
				{
					Id: "express",
					Name: "Express, next day",
					Price: 1800
				}
			]
		});

		await runtime.dispatch(answerDelivery, "Order", askAt(runtime, DELIVERY), "standard");
		await settled();
		expect(openAsk(runtime)?.Request).toEqual({
			Path: CONFIRM,
			Address: ADA,
			Delivery: {
				Id: "standard",
				Name: "Standard, three to five days",
				Price: 600
			},
			Total: 5400
		});
		expect(runtime.state.Order.PaymentKey).toBe("key-1");
		expect(server.ledger().Orders).toEqual([
			{
				OrderId: "Order",
				Lines: [
					{
						Sku: "tea",
						Quantity: 1
					},
					{
						Sku: "mug",
						Quantity: 2
					}
				],
				Status: "reserved"
			}
		]);

		await runtime.dispatch(answerConfirm, "Order", askAt(runtime, CONFIRM), true);
		await flow;
		expect(runtime.state.Order.Receipt).toEqual({
			ChargeId: "charge-1",
			Key: "key-1",
			Total: 5400
		});
		expect(server.ledger()).toMatchObject({
			Orders: [
				{
					Status: "paid"
				}
			],
			Charges: [
				{
					Id: "charge-1",
					OrderId: "Order",
					Key: "key-1",
					Total: 5400
				}
			]
		});
		expect(openAsk(runtime)).toBeUndefined();
	});

	it("ends with nothing reserved or charged when the address or the delivery question is dismissed", async () => {
		for (const at of [
			ADDRESS,
			DELIVERY
		] as const) {
			const { runtime, server } = bootShop();
			const flow = runtime.dispatch(checkout, "Order");
			await settled();
			if (at === DELIVERY) {
				await runtime.dispatch(answerAddress, "Order", askAt(runtime, ADDRESS), ADA);
				await settled();
			}
			await runtime.dispatch(dismiss, "Order", askAt(runtime, at));
			await flow;
			expect(openAsk(runtime)).toBeUndefined();
			expect(runtime.state.Order.PaymentKey).toBeNull();
			expect(server.ledger()).toEqual({
				Orders: [],
				Charges: []
			});
		}
	});

	it("releases the reservation and forgets the key when the confirmation is declined or dismissed", async () => {
		for (const decline of [
			"no",
			"dismiss"
		] as const) {
			const { runtime, server } = bootShop();
			const flow = runtime.dispatch(checkout, "Order");
			await settled();
			await runtime.dispatch(answerAddress, "Order", askAt(runtime, ADDRESS), ADA);
			await settled();
			await runtime.dispatch(answerDelivery, "Order", askAt(runtime, DELIVERY), "standard");
			await settled();
			if (decline === "no") await runtime.dispatch(answerConfirm, "Order", askAt(runtime, CONFIRM), false);
			else await runtime.dispatch(dismiss, "Order", askAt(runtime, CONFIRM));
			await flow;
			expect(runtime.state.Order.PaymentKey).toBeNull();
			expect(runtime.state.Order.Receipt).toBeNull();
			expect(server.ledger().Orders.map((o) => o.Status)).toEqual([
				"released"
			]);
			expect(server.ledger().Charges).toEqual([]);
		}
	});

	it("asks again with the new total when a quantity changes while the confirmation is open, and reserves the new lines", async () => {
		const { runtime, server } = bootShop();
		const flow = runtime.dispatch(checkout, "Order");
		await settled();
		await runtime.dispatch(answerAddress, "Order", askAt(runtime, ADDRESS), ADA);
		await settled();
		await runtime.dispatch(answerDelivery, "Order", askAt(runtime, DELIVERY), "standard");
		await settled();
		const first = askAt<boolean>(runtime, CONFIRM);
		await runtime.dispatch(setQuantity, "Order", "tea", 3);
		await runtime.dispatch(answerConfirm, "Order", first, true);
		await settled();

		const again = openAsk(runtime)!;
		expect(again.Id).not.toBe(first);
		expect(again.Request).toMatchObject({
			Path: CONFIRM,
			Total: 7800
		});
		expect(server.ledger().Orders[0]!.Lines).toEqual([
			{
				Sku: "tea",
				Quantity: 3
			},
			{
				Sku: "mug",
				Quantity: 2
			}
		]);
		expect(server.ledger().Charges).toEqual([]);

		await runtime.dispatch(answerConfirm, "Order", again.Id as IAskId<boolean>, true);
		await flow;
		expect(runtime.state.Order.Receipt?.Total).toBe(7800);
	});

	it("takes a voucher off the total, and says so when the code isn't known", async () => {
		const { runtime } = bootShop();
		await runtime.dispatch(applyVoucher, "Order", "nope");
		expect(runtime.state.Order.Notice).toBe("nope isn't a voucher this shop knows.");
		expect(runtime.state.Order.Voucher).toBeNull();

		const flow = runtime.dispatch(checkout, "Order");
		await settled();
		await runtime.dispatch(answerAddress, "Order", askAt(runtime, ADDRESS), ADA);
		await settled();
		await runtime.dispatch(applyVoucher, "Order", "save10");
		expect(runtime.state.Order.Voucher).toEqual({
			Code: "SAVE10",
			Percent: 10
		});
		await runtime.dispatch(answerDelivery, "Order", askAt(runtime, DELIVERY), "standard");
		await settled();
		expect(openAsk(runtime)?.Request).toMatchObject({
			Total: 4800 - 480 + 600
		});
		await runtime.dispatch(answerConfirm, "Order", askAt(runtime, CONFIRM), true);
		await flow;
		expect(runtime.state.Order.Receipt?.Total).toBe(4920);
	});

	it("hands an address the server refuses back to the dialog and keeps the question open", async () => {
		const { runtime } = bootShop();
		const flow = runtime.dispatch(checkout, "Order");
		await settled();
		const id = askAt<IAddress>(runtime, ADDRESS);
		expect(
			await runtime.dispatch(answerAddress, "Order", id, {
				...ADA,
				Postcode: "30"
			})
		).toBe("A postcode is four digits.");
		expect(
			await runtime.dispatch(answerAddress, "Order", id, {
				...ADA,
				Street: " "
			})
		).toBe("Give a name and a street.");
		await settled();
		expect(openAsk(runtime)?.Id).toBe(id);

		expect(
			await runtime.dispatch(answerAddress, "Order", id, {
				...ADA,
				Name: " Ada "
			})
		).toBeUndefined();
		await settled();
		expect(openAsk(runtime)?.Request.Path).toBe(DELIVERY);
		await runtime.dispatch(dismiss, "Order", askAt(runtime, DELIVERY));
		await flow;
	});

	it("holds the order while it pays, so a quantity change waits and then finds the order paid", async () => {
		const { runtime, server, gates } = bootShop([
			"Server/Pay"
		]);
		const flow = runtime.dispatch(checkout, "Order");
		await settled();
		await runtime.dispatch(answerAddress, "Order", askAt(runtime, ADDRESS), ADA);
		await settled();
		await runtime.dispatch(answerDelivery, "Order", askAt(runtime, DELIVERY), "standard");
		await settled();
		await runtime.dispatch(answerConfirm, "Order", askAt(runtime, CONFIRM), true);
		await settled();
		expect(gates.waiting("Server/Pay")).toBe(1);

		let changed = false;
		const change = runtime.dispatch(setQuantity, "Order", "tea", 5).then(() => {
			changed = true;
		});
		await settled();
		expect(changed).toBe(false);
		expect(runtime.state.Order.Lines[0]!.Quantity).toBe(1);

		gates.release("Server/Pay");
		await flow;
		await change;
		expect(runtime.state.Order.Receipt?.Total).toBe(5400);
		expect(runtime.state.Order.Lines[0]!.Quantity).toBe(1);
		expect(server.ledger().Charges).toHaveLength(1);
	});

	it("ignores a voucher sent during the payment, which waits and then finds the order paid", async () => {
		const { runtime, gates } = bootShop([
			"Server/Pay"
		]);
		const flow = runtime.dispatch(checkout, "Order");
		await settled();
		await runtime.dispatch(answerAddress, "Order", askAt(runtime, ADDRESS), ADA);
		await settled();
		await runtime.dispatch(answerDelivery, "Order", askAt(runtime, DELIVERY), "standard");
		await settled();
		await runtime.dispatch(answerConfirm, "Order", askAt(runtime, CONFIRM), true);
		await settled();
		const voucher = runtime.dispatch(applyVoucher, "Order", "SAVE10");
		await settled();

		gates.release("Server/Pay");
		await flow;
		await voucher;
		expect(runtime.state.Order.Receipt?.Total).toBe(5400);
		expect(runtime.state.Order.Voucher).toBeNull();
		expect(runtime.state.Order.Notice).toBeNull();

		await runtime.dispatch(applyVoucher, "Order", "SAVE10");
		expect(runtime.state.Order.Voucher).toBeNull();
	});

	it("dismisses only the notice the person saw, so a dismiss that waited behind a hold leaves a newer notice", async () => {
		const { runtime, gates } = bootShop([
			"Server/CheckVoucher"
		]);
		const first = runtime.dispatch(applyVoucher, "Order", "first");
		await settled();
		gates.release("Server/CheckVoucher");
		await first;
		const seen = "first isn't a voucher this shop knows.";
		expect(runtime.state.Order.Notice).toBe(seen);

		const checking = runtime.dispatch(applyVoucher, "Order", "second");
		await settled();
		const dismissing = runtime.dispatch(dismissNotice, "Order", seen);
		await settled();
		gates.release("Server/CheckVoucher");
		await checking;
		await dismissing;
		expect(runtime.state.Order.Notice).toBe("second isn't a voucher this shop knows.");

		await runtime.dispatch(dismissNotice, "Order", "second isn't a voucher this shop knows.");
		expect(runtime.state.Order.Notice).toBeNull();
	});

	it("drops a second checkout while one runs", async () => {
		const { runtime } = bootShop();
		const flow = runtime.dispatch(checkout, "Order");
		await settled();
		const first = askAt(runtime, ADDRESS);
		expect(await runtime.dispatch(checkout, "Order")).toBeUndefined();
		await settled();
		expect(openAsk(runtime)?.Id).toBe(first);
		await runtime.dispatch(dismiss, "Order", first);
		await flow;
	});
});
