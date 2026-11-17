import type { ISessionStore } from "../../portal/src/portal/session";
import type { IMountedPortal } from "./mount";
import { act } from "react";
import { settled } from "treflex";
import { afterEach, describe, expect, it } from "vitest";
import { openConversation } from "../../portal/src/chat/Chat";
import { openApp, PortalReceiver, ROOT_ID, toggleRecords } from "../../portal/src/portal/Portal";
import { APP_VERSION, boot, createAutosave } from "../../portal/src/portal/session";
import { DRAWER_MEDIA, PHONE_MEDIA, RECORDS_REPLACE_MEDIA } from "../../portal/src/shell/responsive";
import { startTrip } from "../../portal/src/trips/Planner";
import { mountPortal } from "./mount";
import { resetMedia, setMedia } from "./testMedia";

function memoryStore(initial: string | null = null): ISessionStore & {
	value: string | null;
} {
	const store = {
		value: initial,
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

const tab = {
	document: {
		visibilityState: "visible",
		addEventListener: () => {}
	},
	window: {
		addEventListener: () => {}
	}
};

const mounted: IMountedPortal[] = [];

afterEach(() => {
	for (const each of mounted.splice(0)) {
		act(() => each.root.unmount());
		each.host.autosave.disable();
		each.runtime.dispose();
	}
	document.body.innerHTML = "";
});

async function mount(store: ISessionStore): Promise<{
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
			...tab,
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

describe("the React portal", () => {
	it("boots fresh and renders the start screen, marked as the React build", async () => {
		const { element } = await mount(memoryStore());
		expect(element.querySelector(".start h1")?.textContent).toBe("Where to next?");
		expect(element.querySelector(".seg [aria-current]")?.textContent).toBe("React");
		expect(element.querySelector(".tour")).not.toBeNull();
	});

	it("restores a session the shared session code saved, as the Solid build saves it", async () => {
		const store = memoryStore();
		const before = await boot(store);
		const autosave = createAutosave(before.runtime, store);
		await before.runtime.dispatch(startTrip, "Trips", "lisbon");
		await settled();
		autosave.saveNow();
		autosave.disable();
		before.runtime.dispose();
		expect(JSON.parse(store.value ?? "{}").AppVersion).toBe(APP_VERSION);

		const { element, portal } = await mount(store);
		expect(portal.host.restoredAt).not.toBeNull();
		expect(element.querySelector(".restored h4")?.textContent).toBe("Came back from the snapshot");
		expect(element.querySelector(".hero h1")?.textContent).toContain("Lisbon");
	});
});

describe("the narrow layouts", () => {
	afterEach(() => resetMedia());

	const pressEscape = () =>
		document.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape"
			})
		);
	const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

	it("open the drawer over an inert main, and close it on Escape and when the window leaves the drawer layout", async () => {
		setMedia((query) => query === DRAWER_MEDIA);
		const { element } = await mount(memoryStore());
		const portal = element.querySelector(".portal")!;
		const menu = element.querySelector<HTMLButtonElement>(".mobilebar .menu")!;
		const main = element.querySelector("main")!;

		await act(async () => menu.click());
		expect(portal.classList.contains("drawer-open")).toBe(true);
		expect(main.hasAttribute("inert")).toBe(true);
		expect(document.activeElement).toBe(element.querySelector(".side .app"));

		await act(async () => pressEscape());
		expect(portal.classList.contains("drawer-open")).toBe(false);
		expect(main.hasAttribute("inert")).toBe(false);
		expect(document.activeElement).toBe(menu);

		await act(async () => menu.click());
		await act(async () => setMedia(() => false));
		expect(portal.classList.contains("drawer-open")).toBe(false);
		expect(menu.getAttribute("aria-expanded")).toBe("false");
		expect(main.hasAttribute("inert")).toBe(false);
	});

	it("show a conversation opened from anywhere but its row, on a phone showing chat's list", async () => {
		setMedia((query) => query === PHONE_MEDIA || query === DRAWER_MEDIA);
		const { element, portal } = await mount(memoryStore());
		const { runtime } = portal;
		await act(() => runtime.dispatch(openApp, ROOT_ID, "chat"));
		const chat = element.querySelector(".chat")!;

		await act(async () => element.querySelector<HTMLButtonElement>(".pback")!.click());
		expect(chat.classList.contains("show-pane")).toBe(false);

		const other = runtime.state.Chat.Conversations.find((c) => c.$Id !== runtime.state.Chat.OpenId)!;
		await act(() => runtime.dispatch(openConversation, runtime.state.Chat.$Id, other.$Id));
		await act(() => frame());
		expect(chat.classList.contains("show-pane")).toBe(true);
		expect(document.activeElement).toBe(element.querySelector(".ptitle"));
	});

	const phone = (query: string) => query === PHONE_MEDIA || query === DRAWER_MEDIA || query === RECORDS_REPLACE_MEDIA;
	const tap = (element: HTMLElement, selector: string, text?: string) =>
		act(async () => {
			const all = [
				...element.querySelectorAll<HTMLElement>(selector)
			];
			(text === undefined ? all[0] : all.find((each) => each.textContent?.includes(text)))!.click();
		});

	it("close the drawer from its scrim and its buttons, but not from its empty space", async () => {
		setMedia(phone);
		const { element } = await mount(memoryStore());
		const open = () => element.querySelector(".portal")!.classList.contains("drawer-open");
		await tap(element, ".mobilebar .menu");
		await tap(element, ".scrim");
		expect(open()).toBe(false);

		await tap(element, ".mobilebar .menu");
		await tap(element, ".side .brand");
		expect(open()).toBe(true);
		await tap(element, ".side .app", "Aquarium");
		expect(open()).toBe(false);
		expect(element.querySelector(".records")).toBeNull();
	});

	it("show chat's pane on a phone when the list's row for the open conversation is tapped", async () => {
		setMedia(phone);
		const { element, portal } = await mount(memoryStore());
		await act(() => portal.runtime.dispatch(openApp, ROOT_ID, "chat"));
		const chat = element.querySelector(".chat")!;
		await tap(element, ".pback");
		expect(chat.classList.contains("show-pane")).toBe(false);
		await tap(element, ".ch.on");
		expect(chat.classList.contains("show-pane")).toBe(true);
	});

	it("leave focus alone on a desktop when the open conversation changes", async () => {
		const { element, portal } = await mount(memoryStore());
		const { runtime } = portal;
		await act(() => runtime.dispatch(openApp, ROOT_ID, "chat"));
		const row = element.querySelector<HTMLElement>(".ch")!;
		row.focus();
		const other = runtime.state.Chat.Conversations.find((c) => c.$Id !== runtime.state.Chat.OpenId)!;
		await act(() => runtime.dispatch(openConversation, runtime.state.Chat.$Id, other.$Id));
		await act(() => frame());
		expect(document.activeElement).toBe(row);
	});

	it("on a desktop, move focus to the Record stream toggle when the close button closes the panel with focus on it, and not when the toggle closes it with focus elsewhere", async () => {
		const { element, portal } = await mount(memoryStore());
		await act(() => portal.runtime.dispatch(toggleRecords, ROOT_ID));
		element.querySelector<HTMLElement>(".rclose")!.focus();
		await tap(element, ".rclose");
		await act(() => frame());
		expect(document.activeElement).toBe(element.querySelector(".session .toggle"));

		await act(() => portal.runtime.dispatch(toggleRecords, ROOT_ID));
		const card = element.querySelector<HTMLElement>(".card .btn")!;
		card.focus();
		await tap(element, ".session .toggle");
		await act(() => frame());
		expect(element.querySelector(".records")).toBeNull();
		expect(document.activeElement).toBe(card);
	});

	it("put the record panel in main's place on a phone, and close it from its close button", async () => {
		setMedia(phone);
		const { element, portal } = await mount(memoryStore());
		await act(() => portal.runtime.dispatch(toggleRecords, ROOT_ID));
		await act(() => frame());
		expect(element.querySelector(".portal")!.classList.contains("with-records")).toBe(true);
		expect(document.activeElement).toBe(element.querySelector(".rclose"));

		await tap(element, ".rclose");
		await act(() => frame());
		expect(element.querySelector(".records")).toBeNull();
		expect(document.activeElement).toBe(element.querySelector(".mobilebar .menu"));
	});

	function notify(runtime: IMountedPortal["runtime"]) {
		const other = runtime.state.Chat.Conversations.find((c) => c.$Id !== runtime.state.Chat.OpenId)!;
		return act(() =>
			runtime.dispatch(
				PortalReceiver.handle,
				ROOT_ID,
				{
					Type: "Portal/Finished",
					App: "chat",
					Target: other.$Id,
					Title: "Priya Shah in #design",
					Text: "",
					Link: "Open #design"
				},
				{
					publisher: {
						Id: ROOT_ID
					}
				}
			)
		);
	}

	async function withNotice(media: (query: string) => boolean) {
		setMedia(media);
		const mounted = await mount(memoryStore());
		await act(() => mounted.portal.runtime.dispatch(toggleRecords, ROOT_ID));
		await act(() => frame());
		await notify(mounted.portal.runtime);
		return mounted;
	}

	it("close the record panel where it replaces main when a notice's link or an app is opened, but not for other buttons", async () => {
		const { element, portal } = await withNotice(phone);
		await tap(element, ".toast .x");
		expect(element.querySelector(".toast")).toBeNull();
		expect(element.querySelector(".records")).not.toBeNull();

		await notify(portal.runtime);
		await tap(element, ".toast .link");
		await act(() => frame());
		expect(element.querySelector(".records")).toBeNull();
		expect(document.activeElement).toBe(element.querySelector(".ptitle"));

		await act(async () => element.querySelector<HTMLElement>(".session .toggle")!.click());
		expect(element.querySelector(".records")).not.toBeNull();
		await tap(element, ".side .app", "Aquarium");
		expect(element.querySelector(".records")).toBeNull();
	});

	it("keep the record panel open on a desktop when a notice's link or an app is opened", async () => {
		const { element } = await withNotice(() => false);
		await tap(element, ".toast .link");
		await tap(element, ".side .app", "Aquarium");
		expect(element.querySelector(".records")).not.toBeNull();
	});

	it("close the record panel beside a coarse tablet's sidebar when a trip is planned, and return focus to the Record stream toggle", async () => {
		setMedia((query) => query === RECORDS_REPLACE_MEDIA);
		const { element, portal } = await mount(memoryStore());
		const { runtime } = portal;
		await act(() => runtime.dispatch(startTrip, "Trips", "lisbon"));
		await act(() => runtime.dispatch(toggleRecords, ROOT_ID));
		await act(() => frame());
		expect(document.activeElement).toBe(element.querySelector(".rclose"));

		await tap(element, ".side .newtrip");
		await act(() => frame());
		expect(element.querySelector(".records")).toBeNull();
		expect(document.activeElement).toBe(element.querySelector(".session .toggle"));
	});
});
