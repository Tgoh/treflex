import type { IStore } from "./session";
import { settled } from "treflex";
import { expect, it } from "vitest";
import { createFakeServer } from "./server/fakeServer";
import { autosave, boot, unwrap } from "./session";
import { RELOADED } from "./shop/repair";
import { checkout, currentAsk, setQuantity } from "./shop/shop";

function memoryStore(): IStore & {
	value: string | null;
} {
	const store = {
		value: null as string | null,
		read: () => store.value,
		write: (value: string) => {
			store.value = value;
		},
		clear: () => {
			store.value = null;
		}
	};
	return store;
}

const answerAtOnce = () => Promise.resolve();

it("boots fresh, saves, and on the next boot restores the save and starts the dropped checkout again", async () => {
	const store = memoryStore();
	const server = createFakeServer();
	const first = await boot(store, server, answerAtOnce);
	expect(first.restored).toBeNull();
	const saving = autosave(first.runtime, store);
	await first.runtime.dispatch(setQuantity, "Order", "tea", 4);
	first.runtime.dispatch(checkout, "Order");
	await settled();
	saving.save();
	saving.stop();
	first.runtime.dispose();

	const second = await boot(store, server, answerAtOnce);
	await settled();
	expect(second.restored?.dropped.map((d) => d.name)).toEqual([
		"Checkout/Checkout"
	]);
	expect(second.runtime.state.Order.Lines[0]!.Quantity).toBe(4);
	expect(second.runtime.state.Order.Notice).toBe(RELOADED);
	expect(second.runtime.processSelector(currentAsk, () => second.runtime.state.Order)?.Request.Path).toBe("Checkout/Address");
	second.runtime.dispose();
});

it("discards a save of another version and boots fresh", async () => {
	const store = memoryStore();
	store.value = JSON.stringify({
		AppVersion: 0,
		Snapshot: "{}"
	});
	expect(unwrap(store.value)).toBeNull();
	const booted = await boot(store, createFakeServer(), answerAtOnce);
	expect(booted.restored).toBeNull();
	expect(store.value).toBeNull();
	booted.runtime.dispose();
});
