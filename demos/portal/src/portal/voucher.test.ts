import type { IRuntime } from "treflex";
import type { IMessage } from "../chat/Message";
import type { IPortal } from "./Portal";
import { createRuntime, settled } from "treflex";
import { createSnapshot, restoreRuntime } from "treflex/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { registerFakeBackend } from "../backend/fakeBackend";
import { applyVoucher, ChatReceiver, init } from "../chat/Chat";
import { voucherButton } from "../chat/Message";
import { money } from "../text";
import { callsForFlourish } from "../trips/flourish";
import { flourishPlayed, priced, startTrip, tickerText, voucher } from "../trips/Planner";
import { soFar } from "../trips/Trip";
import { applyToastVoucher, getDefaultState, openApp, ROOT_ID, toast, toastVoucher } from "./Portal";
import { registerReceivers, repairRestore } from "./session";

const instant = () => Promise.resolve();

const runtimes: IRuntime<IPortal>[] = [];

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

async function flush(rounds = 6): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await settled();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

const setup = (runtime: IRuntime<IPortal>): void => {
	registerReceivers(runtime);
	registerFakeBackend(runtime, {
		wait: instant,
		chatWait: instant
	});
};

async function portal(): Promise<IRuntime<IPortal>> {
	const runtime = createRuntime<IPortal>(getDefaultState(), {
		pauseTimers: true
	});
	setup(runtime);
	runtimes.push(runtime);
	await runtime.dispatch(init, "Chat");
	await flush();
	return runtime;
}

async function reload(before: IRuntime<IPortal>): Promise<IRuntime<IPortal>> {
	const json = createSnapshot(before);
	before.dispose();
	const { runtime } = await restoreRuntime<IPortal>(json, {
		rootId: ROOT_ID,
		options: {
			pauseTimers: true
		},
		setup,
		repair: repairRestore
	});
	runtimes.push(runtime);
	await flush();
	return runtime;
}

const voucherMessage = (runtime: IRuntime<IPortal>): IMessage | undefined =>
	runtime.state.Chat.Conversations.find((c) => c.Key === "dm-marcus")?.Messages.find((m) => m.Voucher !== undefined);

const quiet = (runtime: IRuntime<IPortal>) => runtime.state.Chat.Conversations.every((c) => c.Reply === null);

/** Plays the script's first two cues one after another, so Marcus's voucher, the second, finishes last. */
async function cueThroughVoucher(runtime: IRuntime<IPortal>): Promise<void> {
	for (let i = 0; i < 2; i++) {
		await runtime.dispatch(
			ChatReceiver.handle,
			"Chat",
			{
				Type: "Chat/Cue"
			},
			{
				publisher: {
					Id: "Chat"
				}
			}
		);
		await flush(1);
		for (let n = 0; n < 200 && !quiet(runtime); n++) await flush(1);
	}
	expect(voucherMessage(runtime)?.Streaming).toBe(false);
}

const button = (runtime: IRuntime<IPortal>) => voucherButton(voucherMessage(runtime)!, runtime.state.Chat.VoucherApplied);
const voucherOf = (runtime: IRuntime<IPortal>) => runtime.processSelector(voucher, () => runtime.state.Trips);
const totalOf = (runtime: IRuntime<IPortal>, index: number) =>
	priced(
		runtime.processSelector(soFar, () => runtime.state.Trips.Trips[index]),
		voucherOf(runtime)
	);

async function plan(runtime: IRuntime<IPortal>, destination: "lisbon" | "kyoto"): Promise<void> {
	await runtime.dispatch(startTrip, "Trips", destination);
	await flush();
}

describe("the travel voucher from the chat", () => {
	it("arrives in Marcus's direct message and offers its button only once the message has finished streaming", async () => {
		const runtime = await portal();
		expect(voucherMessage(runtime)).toBeUndefined();
		await runtime.dispatch(applyVoucher, "Chat");
		expect(runtime.state.Chat.VoucherApplied).toBe(false);

		await cueThroughVoucher(runtime);
		const message = voucherMessage(runtime)!;
		expect(message).toMatchObject({
			From: "marcus",
			Voucher: 10
		});
		expect(message.Text).toMatch(/travel voucher: 10% off trips/);
		expect(
			voucherButton(
				{
					...message,
					Streaming: true
				},
				false
			)
		).toBeNull();
		expect(button(runtime)).toEqual({
			Label: "Apply to my trips",
			Disabled: false
		});
	});

	it("discounts every existing trip and any trip started afterwards", async () => {
		const runtime = await portal();
		await plan(runtime, "lisbon");
		const lisbon = runtime.processSelector(soFar, () => runtime.state.Trips.Trips[0]);
		expect(lisbon).toBeGreaterThan(0);
		expect(totalOf(runtime, 0).Was).toBeNull();

		await runtime.dispatch(openApp, ROOT_ID, "chat");
		await cueThroughVoucher(runtime);
		await runtime.dispatch(applyVoucher, "Chat");
		await flush();

		expect(voucherOf(runtime)?.Pill).toBe("−10% · Marcus's voucher");
		expect(totalOf(runtime, 0)).toEqual({
			Amount: Math.round(lisbon * 0.9),
			Now: money(Math.round(lisbon * 0.9)),
			Full: lisbon,
			Was: money(lisbon)
		});

		await plan(runtime, "kyoto");
		const kyoto = runtime.processSelector(soFar, () => runtime.state.Trips.Trips[1]);
		expect(kyoto).toBeGreaterThan(0);
		expect(totalOf(runtime, 1)).toEqual({
			Amount: Math.round(kyoto * 0.9),
			Now: money(Math.round(kyoto * 0.9)),
			Full: kyoto,
			Was: money(kyoto)
		});
	});

	it("can't be applied twice, from the message or the toast", async () => {
		const runtime = await portal();
		let applied = 0;
		runtime.on("record", (record) => {
			if (record.Kind === "message:deliver" && record.Topic === "Portal/VoucherApplied") applied++;
		});
		await runtime.dispatch(openApp, ROOT_ID, "aquarium");
		await cueThroughVoucher(runtime);
		expect(runtime.processSelector(toastVoucher, () => runtime.state)).toBe("Apply to my trips");

		await Promise.all([
			runtime.dispatch(applyVoucher, "Chat"),
			runtime.dispatch(applyVoucher, "Chat")
		]);
		await runtime.dispatch(applyVoucher, "Chat");
		await flush();
		expect(applied).toBe(1);
		expect(button(runtime)).toEqual({
			Label: "Applied",
			Disabled: true
		});
		expect(runtime.processSelector(toastVoucher, () => runtime.state)).toBeNull();

		await runtime.dispatch(applyToastVoucher, ROOT_ID);
		await flush();
		expect(applied).toBe(1);
		expect(runtime.state.Trips.Voucher?.Percent).toBe(10);
	});

	it("survives a reload, applied and still applying to the trips", async () => {
		const before = await portal();
		await plan(before, "lisbon");
		await before.dispatch(openApp, ROOT_ID, "chat");
		await cueThroughVoucher(before);
		await before.dispatch(applyVoucher, "Chat");
		await flush();

		const runtime = await reload(before);
		expect(runtime.state.Chat.VoucherApplied).toBe(true);
		expect(button(runtime)?.Label).toBe("Applied");
		expect(voucherOf(runtime)?.Percent).toBe(10);
		expect(totalOf(runtime, 0).Was).not.toBeNull();
	});
});

describe("the voucher's flourish", () => {
	const calls = (runtime: IRuntime<IPortal>) => callsForFlourish(voucherOf(runtime));

	it("calls for the flourish once applied, wherever the planner is, until a view marks it played, and not again after a reload", async () => {
		const runtime = await portal();
		expect(calls(runtime)).toBe(false);
		await runtime.dispatch(openApp, ROOT_ID, "chat");
		await cueThroughVoucher(runtime);
		await runtime.dispatch(applyVoucher, "Chat");
		await flush();
		expect(runtime.state.Trips.Voucher).toEqual({
			Percent: 10,
			From: "Marcus",
			Played: false
		});
		expect(calls(runtime)).toBe(true);

		await runtime.dispatch(openApp, ROOT_ID, "trips");
		await runtime.dispatch(openApp, ROOT_ID, "chat");
		await flush();
		expect(calls(runtime)).toBe(true);

		await runtime.dispatch(flourishPlayed, "Trips");
		expect(runtime.state.Trips.Voucher?.Played).toBe(true);
		expect(calls(runtime)).toBe(false);

		const back = await reload(runtime);
		expect(back.state.Trips.Voucher?.Played).toBe(true);
		expect(calls(back)).toBe(false);
	});

	it("marks it played idempotently, and not before a voucher is applied", async () => {
		const runtime = await portal();
		await runtime.dispatch(flourishPlayed, "Trips");
		expect(runtime.state.Trips.Voucher).toBeNull();

		await cueThroughVoucher(runtime);
		await runtime.dispatch(applyToastVoucher, ROOT_ID);
		await flush();
		expect(runtime.state.Trips.Voucher?.Played).toBe(false);
		await runtime.dispatch(flourishPlayed, "Trips");
		expect(runtime.state.Trips.Voucher?.Played).toBe(true);
		const played = createSnapshot(runtime);
		await runtime.dispatch(flourishPlayed, "Trips");
		expect(createSnapshot(runtime)).toBe(played);
	});

	it("calls for it when the voucher is applied from the toast over the planner", async () => {
		const runtime = await portal();
		expect(runtime.state.ActiveApp).toBe("trips");
		await cueThroughVoucher(runtime);
		expect(runtime.processSelector(toast, () => runtime.state)?.Voucher).toBe(true);

		await runtime.dispatch(applyToastVoucher, ROOT_ID);
		await flush();
		expect(runtime.processSelector(toast, () => runtime.state)).toBeNull();
		expect(runtime.state.Chat.VoucherApplied).toBe(true);
		expect(calls(runtime)).toBe(true);
	});

	it("ticks from the full price down to the discounted one, every step formatted as the total is", () => {
		const price = priced(4321, {
			Percent: 10,
			Pill: "",
			Played: true
		});
		expect(tickerText(price, 0)).toBe("A$4,321");
		expect(tickerText(price, 1)).toBe(price.Now);
		expect(price.Now).toBe("A$3,889");
		const steps = [
			0.1,
			0.3,
			0.5,
			0.7,
			0.9
		].map((t) => tickerText(price, t));
		for (const step of steps) expect(step).toMatch(/^A\$\d,\d{3}$/);
		const amounts = steps.map((step) => Number(step.replace(/\D/g, "")));
		expect(amounts).toEqual(
			[
				...amounts
			].sort((a, b) => b - a)
		);
		expect(amounts.every((a) => a <= 4321 && a >= 3889)).toBe(true);
	});
});
