import type { IActionGenerator } from "treflex";
import type { IAquarium } from "../../portal/src/aquarium/Aquarium";
import type { IFish } from "../../portal/src/aquarium/Fish";
import type { IConversation } from "../../portal/src/chat/Conversation";
import type { IMessage } from "../../portal/src/chat/Message";
import type { IPortal } from "../../portal/src/portal/Portal";
import type { ISessionStore } from "../../portal/src/portal/session";
import type { IMountedPortal } from "./mount";
import { act } from "react";
import { entity, publish } from "treflex";
import { afterEach, describe, expect, it } from "vitest";
import { addFish } from "../../portal/src/aquarium/Aquarium";
import { SWIM_MS } from "../../portal/src/aquarium/Fish";
import { LETTER_FADE_MS } from "../../portal/src/chat/Message";
import { wallClock } from "../../portal/src/portal/clock";
import { openApp, ROOT_ID } from "../../portal/src/portal/Portal";
import { CARD_STAGGER_MS, CARD_TICK_MS, SPARK_COUNT, TICK_MS, TOTAL_TICK_DELAY_MS } from "../../portal/src/trips/flourish";
import { startTrip } from "../../portal/src/trips/Planner";
import { mountPortal } from "./mount";

function memoryStore(): ISessionStore & {
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

const mounted: IMountedPortal[] = [];

afterEach(() => {
	for (const each of mounted.splice(0)) {
		act(() => each.root.unmount());
		each.host.autosave.disable();
		each.runtime.dispose();
	}
	document.body.innerHTML = "";
});

async function mount(store: ISessionStore = memoryStore()): Promise<{
	element: HTMLElement;
	portal: IMountedPortal;
}> {
	const element = document.createElement("div");
	document.body.append(element);
	let portal: IMountedPortal | null = null;
	await act(async () => {
		portal = await mountPortal({
			element,
			store,
			document: {
				visibilityState: "visible",
				addEventListener: () => {}
			},
			window: {
				addEventListener: () => {}
			},
			reload: () => {}
		});
	});
	if (!portal) throw new Error("the portal didn't mount");
	mounted.push(portal);
	return {
		element,
		portal
	};
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function* arrive(draft: IConversation, text: string): IActionGenerator {
	const message = yield* entity<IMessage>({
		Conversation: draft.Key,
		From: "priya",
		Day: "Today",
		At: "9:41",
		Text: text,
		Streaming: true,
		Sent: true,
		Number: 0,
		Attempts: 0
	});
	draft.Messages.push(message);
}

function* grow(draft: IMessage, text: string, streaming: boolean): IActionGenerator {
	draft.Text += text;
	draft.Streaming = streaming;
}

function* setOff(draft: IFish, fromX: number, toX: number, ago: number): IActionGenerator {
	draft.FromX = fromX;
	draft.FromY = draft.Y;
	draft.X = toX;
	draft.SwamAt = wallClock() - ago;
}

function* giveVoucher(_draft: IPortal): IActionGenerator {
	yield* publish("Portal/VoucherApplied", {
		Percent: 10,
		From: "Marcus"
	});
}

describe("the chat's letters", () => {
	it("fade in only as they arrive on screen, and a finished message turns into plain text", async () => {
		const { element, portal } = await mount();
		const { runtime } = portal;
		await act(() => runtime.dispatch(openApp, ROOT_ID, "chat"));
		const conversation = runtime.state.Chat.OpenId!;
		expect(element.querySelectorAll(".msgs .letter")).toHaveLength(0);

		await act(() => runtime.dispatch(arrive, conversation, "Hi"));
		const last = () =>
			[
				...element.querySelectorAll(".msgs-in .m")
			].at(-1)!;
		const first = [
			...last().querySelectorAll(".letter")
		];
		expect(first.map((span) => span.textContent)).toEqual([
			"H",
			"i"
		]);

		const messageId = runtime.state.Chat.Conversations.find((c) => c.$Id === conversation)!.Messages.at(-1)!.$Id;
		await act(() => runtime.dispatch(grow, messageId, " you", true));
		const after = [
			...last().querySelectorAll(".letter")
		];
		expect(after).toHaveLength(6);
		expect(after.slice(0, 2)).toEqual(first);

		await act(() => runtime.dispatch(grow, messageId, "!", false));
		expect(last().querySelectorAll(".letter")).toHaveLength(7);
		await act(() => pause(LETTER_FADE_MS + 50));
		expect(last().querySelectorAll(".letter")).toHaveLength(0);
		expect(last().querySelector("p")?.textContent).toBe("Hi you!");
	});

	it("shows what a message held at once when it mounts mid-stream, and fades in the rest", async () => {
		const { element, portal } = await mount();
		const { runtime } = portal;
		await act(() => runtime.dispatch(openApp, ROOT_ID, "chat"));
		const conversation = runtime.state.Chat.OpenId!;
		await act(() => runtime.dispatch(arrive, conversation, "Hello"));
		await act(() => runtime.dispatch(openApp, ROOT_ID, "trips"));
		await act(() => runtime.dispatch(openApp, ROOT_ID, "chat"));

		const last = () =>
			[
				...element.querySelectorAll(".msgs-in .m")
			].at(-1)!;
		expect(last().querySelectorAll(".letter")).toHaveLength(0);
		expect(last().querySelector("p")?.textContent).toBe("Hello");

		const messageId = runtime.state.Chat.Conversations.find((c) => c.$Id === conversation)!.Messages.at(-1)!.$Id;
		await act(() => runtime.dispatch(grow, messageId, " there", true));
		expect(
			[
				...last().querySelectorAll(".letter")
			].map((span) => span.textContent)
		).toEqual([
			..." there"
		]);
	});
});

describe("the aquarium", () => {
	it("fades in only the fish added while it is on screen", async () => {
		const { element, portal } = await mount();
		const { runtime } = portal;
		await act(() => runtime.dispatch(openApp, ROOT_ID, "aquarium"));
		expect(element.querySelectorAll(".fish-slot").length).toBeGreaterThan(0);
		expect(element.querySelectorAll(".fish-slot.arriving")).toHaveLength(0);

		await act(() => runtime.dispatch(addFish, runtime.state.Aquarium.$Id, runtime.state.Aquarium.Schools[0].$Id));
		expect(element.querySelectorAll(".fish-slot.arriving")).toHaveLength(1);
	});

	it("carries a fish that was mid-swim on from where it had got to", async () => {
		const { element, portal } = await mount();
		const { runtime } = portal;
		const aquarium: IAquarium = runtime.state.Aquarium;
		const fishId = aquarium.Schools[0].Fish[0].$Id;
		await act(() => runtime.dispatch(setOff, fishId, 10, 80, 1000));

		await act(() => runtime.dispatch(openApp, ROOT_ID, "aquarium"));
		const slots = [
			...element.querySelectorAll<HTMLElement>(".fish-slot")
		];
		const moving = slots.filter((slot) => slot.style.transitionDelay !== "");
		expect(moving).toHaveLength(1);
		const slot = moving[0];
		expect(slot.classList.contains("holding")).toBe(false);
		expect(slot.style.getPropertyValue("--fish-x")).toBe("80");
		const delay = -Number.parseFloat(slot.style.transitionDelay);
		expect(delay).toBeGreaterThanOrEqual(1000);
		expect(delay).toBeLessThan(SWIM_MS);
	});
});

async function animationEnd(target: Element, pseudoElement = ""): Promise<void> {
	// jsdom has no AnimationEvent, so React listens for the webkit name there; it listens for one of the two.
	for (const type of [
		"animationend",
		"webkitAnimationEnd"
	]) {
		const event = new Event(type, {
			bubbles: true
		});
		// jsdom's event lacks pseudoElement, and endsFlourish reads undefined as a pseudo-element's.
		Object.defineProperty(event, "pseudoElement", {
			value: pseudoElement
		});
		await act(async () => {
			target.dispatchEvent(event);
			await pause(0);
		});
	}
}

function playedSaved(
	portal: IMountedPortal,
	saved: ISessionStore & {
		value: string | null;
	}
): boolean {
	portal.host.autosave.saveNow();
	const { Snapshot } = JSON.parse(saved.value ?? "{}");
	return typeof Snapshot === "string" && Snapshot.includes('"Played":true');
}

describe("the voucher's flourish", () => {
	it("plays once on the start screen: each card's pill, tickers that count down and stop, and the timeline's own end clears it", async () => {
		const saved = memoryStore();
		const { element, portal } = await mount(saved);
		const { runtime } = portal;
		await act(() => runtime.dispatch(giveVoucher, ROOT_ID));
		expect(element.querySelector(".cards.vdrop")).not.toBeNull();
		expect(element.querySelectorAll(".card .vpill")).toHaveLength(3);
		expect(element.querySelectorAll(".card .meta s")).toHaveLength(3);

		await act(() => pause(CARD_TICK_MS + TICK_MS / 2));
		expect(element.querySelectorAll(".card .tick").length).toBeGreaterThan(0);
		await act(() => pause(CARD_TICK_MS + 2 * CARD_STAGGER_MS + TICK_MS));
		expect(element.querySelectorAll(".card .tick")).toHaveLength(0);
		expect(element.querySelectorAll(".card .real.ticking")).toHaveLength(0);

		const cards = element.querySelector(".cards")!;
		await animationEnd(element.querySelector(".card .vpill")!);
		await animationEnd(cards, "::after");
		expect(element.querySelector(".cards.vdrop")).not.toBeNull();
		await animationEnd(cards);
		expect(element.querySelector(".cards.vdrop")).toBeNull();
		expect(runtime.state.Trips.Voucher?.Played).toBe(true);
		expect(playedSaved(portal, saved)).toBe(true);
	});

	it("plays once on a trip: the box lifts, the total ticks down, the pill sparkles, and the box's own end clears it", async () => {
		const saved = memoryStore();
		const { element, portal } = await mount(saved);
		const { runtime } = portal;
		await act(() => runtime.dispatch(startTrip, runtime.state.Trips.$Id, "lisbon"));
		for (let waited = 0; element.querySelector(".total b")?.textContent === "A$0" && waited < 15_000; waited += 100) {
			await act(() => pause(100));
		}
		expect(element.querySelector(".total b")?.textContent).not.toBe("A$0");
		await act(() => runtime.dispatch(giveVoucher, ROOT_ID));
		expect(element.querySelector(".hero.burst")).not.toBeNull();
		expect(element.querySelector(".total.vdrop")).not.toBeNull();
		expect(element.querySelectorAll(".total .vpill .sparks i")).toHaveLength(SPARK_COUNT);

		await act(() => pause(TOTAL_TICK_DELAY_MS + TICK_MS / 2));
		expect(element.querySelector(".total .tick")).not.toBeNull();

		const total = element.querySelector(".total")!;
		await animationEnd(element.querySelector(".total .vpill")!);
		await animationEnd(total, "::before");
		expect(element.querySelector(".total.vdrop")).not.toBeNull();
		await animationEnd(total);
		expect(element.querySelector(".total.vdrop")).toBeNull();
		expect(element.querySelector(".hero.burst")).toBeNull();
		expect(element.querySelector(".total .tick")).toBeNull();
		expect(runtime.state.Trips.Voucher?.Played).toBe(true);
		expect(playedSaved(portal, saved)).toBe(true);
	});
});
