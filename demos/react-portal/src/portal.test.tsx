import type { ISessionStore } from "../../portal/src/portal/session";
import type { IMountedPortal } from "./mount";
import { act } from "react";
import { settled } from "treflex";
import { afterEach, describe, expect, it } from "vitest";
import { APP_VERSION, boot, createAutosave } from "../../portal/src/portal/session";
import { startTrip } from "../../portal/src/trips/Planner";
import { mountPortal } from "./mount";

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
