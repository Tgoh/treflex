import type { IBuild } from "../../portal/src/shell/builds";
import type { IRendererModule, ISwappedPortal } from "./swap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openApp, ROOT_ID } from "../../portal/src/portal/Portal";
import { CARD_TICK_MS } from "../../portal/src/trips/flourish";
import { PlannerReceiver, startTrip } from "../../portal/src/trips/Planner";
import { RENDERERS } from "./renderers";
import { startSwap } from "./swap";

async function until(check: () => boolean, tries = 1000): Promise<void> {
	for (let tried = 0; !check(); tried++) {
		if (tried === tries) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Counts the listeners added to `target` and not yet removed, until `restore`. */
function countListeners(target: EventTarget): {
	count(): number;
	restore(): void;
} {
	const live = new Set<string>();
	const ids = new WeakMap<object, number>();
	let next = 0;
	const key = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
		if (!listener) return null;
		if (!ids.has(listener)) ids.set(listener, next++);
		const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
		return `${type}:${capture}:${ids.get(listener)}`;
	};
	const add = target.addEventListener;
	const remove = target.removeEventListener;
	target.addEventListener = function (type, listener, options) {
		const k = key(type, listener, options);
		if (k) live.add(k);
		return add.call(this, type, listener, options);
	};
	target.removeEventListener = function (type, listener, options) {
		const k = key(type, listener, options);
		if (k) live.delete(k);
		return remove.call(this, type, listener, options);
	};
	return {
		count: () => live.size,
		restore: () => {
			target.addEventListener = add;
			target.removeEventListener = remove;
		}
	};
}

let element: HTMLElement;
let reload: ReturnType<typeof vi.fn<() => void>>;
const started: ISwappedPortal[] = [];

beforeEach(() => {
	element = document.createElement("div");
	document.body.append(element);
	reload = vi.fn();
});

afterEach(() => {
	for (const each of started.splice(0)) {
		each.unmount();
		each.host.autosave.disable();
		each.runtime.dispose();
	}
	document.body.innerHTML = "";
	history.replaceState(null, "", "/");
	vi.restoreAllMocks();
});

async function start(renderers: Record<IBuild, () => Promise<IRendererModule>> = RENDERERS): Promise<ISwappedPortal> {
	let value: string | null = null;
	const swapped = await startSwap({
		element,
		renderers,
		store: {
			read: () => value,
			write: (next) => {
				value = next;
			},
			clear: () => {
				value = null;
			}
		},
		document: {
			visibilityState: "visible",
			addEventListener: () => {}
		},
		window: {
			addEventListener: () => {}
		},
		reload
	});
	if (!swapped) throw new Error("the portal didn't start");
	started.push(swapped);
	await until(() => element.querySelector(".portal") !== null);
	return swapped;
}

const label = (renderer: IBuild) => (renderer === "solid" ? "Solid" : "React");

const pressed = (): string | undefined => element.querySelector('.portal .seg [aria-pressed="true"]')?.textContent ?? undefined;

const segmentButton = (text: string): HTMLButtonElement | undefined =>
	[
		...element.querySelectorAll<HTMLButtonElement>(".seg button")
	].find((button) => button.textContent === text);

const view = (swapped: ISwappedPortal) => ({
	renderer: swapped.current(),
	containers: element.childElementCount,
	portals: element.querySelectorAll(".portal").length,
	reactRoot: element.firstElementChild !== null && Object.keys(element.firstElementChild).some((key) => key.startsWith("__reactContainer"))
});

async function swapTo(swapped: ISwappedPortal, renderer: IBuild) {
	await swapped.switchTo(renderer);
	await until(() => pressed() === label(renderer));
	return view(swapped);
}

/** RENDERERS, counting each renderer's mounts, with React's load held until `gate` settles. */
function counted(gate?: Promise<void>) {
	const mounts = {
		solid: 0,
		react: 0
	};
	const wrap = (renderer: IBuild) => async (): Promise<IRendererModule> => {
		if (renderer === "react") await gate;
		const module = await RENDERERS[renderer]();
		return {
			...module,
			mount: (...args) => {
				mounts[renderer]++;
				return module.mount(...args);
			}
		};
	};
	return {
		mounts,
		renderers: {
			solid: wrap("solid"),
			react: wrap("react")
		}
	};
}

describe("the renderer swap", () => {
	it("keeps the runtime's work running across Solid to React to Solid, with one view mounted at a time", async () => {
		const documentListeners = countListeners(document);
		const windowListeners = countListeners(window);
		const swapped = await start();
		const { runtime, host } = swapped;
		expect(view(swapped)).toEqual({
			renderer: "solid",
			containers: 1,
			portals: 1,
			reactRoot: false
		});

		await runtime.dispatch(startTrip, "Trips", "lisbon");
		const checked = () => runtime.state.Trips.Trips[0].Legs.reduce((sum, leg) => sum + leg.Checked, 0);
		await until(() => checked() > 0);

		const rows = () => ({
			timers: runtime
				.timers()
				.map((row) => `${row.Key}@${row.OwnerId}`)
				.sort(),
			resources: runtime
				.resources()
				.map((row) => `${row.Key}@${row.OwnerId}`)
				.sort()
		});
		const listeners: Record<string, number>[] = [];
		const progress: number[] = [];
		for (const renderer of [
			"react",
			"solid",
			"react",
			"solid"
		] as const) {
			const before = rows();
			progress.push(checked());
			expect(await swapTo(swapped, renderer)).toEqual({
				renderer,
				containers: 1,
				portals: 1,
				reactRoot: renderer === "react"
			});
			const after = rows();
			expect(after).toEqual(before);
			expect(new Set(after.timers).size).toBe(after.timers.length);
			expect(new Set(after.resources).size).toBe(after.resources.length);
			listeners.push({
				document: documentListeners.count(),
				window: windowListeners.count()
			});
			const reached = checked();
			await until(() => checked() > reached);
		}
		expect(progress).toEqual(
			[
				...progress
			].sort((a, b) => a - b)
		);
		expect(new Set(progress).size).toBe(progress.length);
		expect(listeners[2]).toEqual(listeners[0]);
		expect(listeners[3]).toEqual(listeners[1]);

		const seqs = host.monitor.lines().map((line) => line.Seq);
		expect(seqs.length).toBeGreaterThan(0);
		expect(new Set(seqs).size).toBe(seqs.length);
		documentListeners.restore();
		windowListeners.restore();
	}, 60_000);

	it("ends on the renderer last asked for, mounting it once, when clicks arrive while a view loads", async () => {
		let release!: () => void;
		const { mounts, renderers } = counted(
			new Promise<void>((resolve) => {
				release = resolve;
			})
		);
		const swapped = await start(renderers);

		segmentButton("React")!.click();
		expect(segmentButton("React")!.getAttribute("aria-busy")).toBe("true");
		await new Promise((resolve) => setTimeout(resolve, 20));
		segmentButton("Solid")!.click();
		expect(segmentButton("React")!.getAttribute("aria-busy")).toBe("false");
		segmentButton("React")!.click();
		const settled = swapped.switchTo("solid");
		release();
		await settled;
		expect(mounts).toEqual({
			solid: 1,
			react: 0
		});
		expect(view(swapped).renderer).toBe("solid");

		await Promise.all([
			swapped.switchTo("react"),
			swapped.switchTo("solid"),
			swapped.switchTo("react")
		]);
		expect(mounts).toEqual({
			solid: 1,
			react: 1
		});
		expect(view(swapped)).toEqual({
			renderer: "react",
			containers: 1,
			portals: 1,
			reactRoot: true
		});
		expect(segmentButton("Solid")!.getAttribute("aria-busy")).toBe("false");

		await Promise.all([
			swapped.switchTo("solid"),
			swapped.switchTo("react"),
			swapped.switchTo("solid")
		]);
		expect(mounts).toEqual({
			solid: 2,
			react: 1
		});
		expect(view(swapped)).toEqual({
			renderer: "solid",
			containers: 1,
			portals: 1,
			reactRoot: false
		});
		expect(reload).not.toHaveBeenCalled();
	}, 30_000);

	it("reloads the page, in the renderer it was in, when the other renderer's view doesn't load or its mount throws", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		let failLoad = true;
		const swapped = await start({
			solid: RENDERERS.solid,
			react: async () => {
				if (failLoad) throw new Error("blocked");
				return {
					...(await RENDERERS.react()),
					mount: () => {
						throw new Error("mount refused");
					}
				};
			}
		});

		await swapped.switchTo("react");
		expect(reload).toHaveBeenCalledTimes(1);
		expect(swapped.current()).toBe("solid");
		expect(location.search).toBe("");

		failLoad = false;
		await swapped.switchTo("react");
		expect(reload).toHaveBeenCalledTimes(2);
		expect(location.search).toBe("");
		expect(error).toHaveBeenCalledTimes(2);
	}, 30_000);

	it("writes the renderer to the address on each swap, and opens in the one it names", async () => {
		const swapped = await start();
		expect(location.search).toBe("");
		await swapTo(swapped, "react");
		expect(location.search).toBe("?renderer=react");
		await swapTo(swapped, "solid");
		expect(location.search).toBe("");

		history.replaceState(null, "", "/?renderer=react");
		element = document.createElement("div");
		document.body.append(element);
		const reopened = await start();
		expect(view(reopened)).toEqual({
			renderer: "react",
			containers: 1,
			portals: 1,
			reactRoot: true
		});
	}, 30_000);

	it("swaps from a labelled group of pressed buttons on the card, keeping a keyboard user's focus on it", async () => {
		const swapped = await start();
		const segment = () =>
			[
				...element.querySelectorAll(".seg button")
			].map((button) => [
				button.textContent,
				button.getAttribute("aria-pressed")
			]);
		expect(element.querySelector(".seg")?.tagName).toBe("FIELDSET");
		expect(element.querySelector(".seg")?.getAttribute("aria-label")).toBe("Renderer");
		expect(segment()).toEqual([
			[
				"Solid",
				"true"
			],
			[
				"React",
				"false"
			]
		]);

		segmentButton("React")!.focus();
		segmentButton("React")!.click();
		await until(() => pressed() === "React");
		expect(view(swapped).renderer).toBe("react");
		expect(document.activeElement).toBe(segmentButton("React"));

		segmentButton("Solid")!.focus();
		segmentButton("Solid")!.click();
		await until(() => pressed() === "Solid");
		expect(document.activeElement).toBe(segmentButton("Solid"));

		segmentButton("Solid")!.blur();
		segmentButton("React")!.click();
		await until(() => pressed() === "React");
		expect(document.activeElement).toBe(document.body);
	}, 30_000);

	it("moves focus to the new view's menu button when the toggle it swapped from sits in the closed drawer", async () => {
		const swapped = await start();
		const focus = HTMLElement.prototype.focus;
		vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
			if (!this.closest(".seg")) focus.call(this, options);
		});
		element.querySelector<HTMLElement>(".mobilebar .menu")!.focus();
		await swapTo(swapped, "react");
		expect(document.activeElement).toBe(element.querySelector(".mobilebar .menu"));
		expect(element.firstElementChild!.contains(document.activeElement)).toBe(true);
	}, 30_000);

	it("stops calling a swapped-out view's pending listener", async () => {
		const calls: number[] = [];
		let views = 0;
		const listened = (renderer: IBuild) => async (): Promise<IRendererModule> => {
			const module = await RENDERERS[renderer]();
			return {
				...module,
				mount: (container, runtime, host) => {
					const view = ++views;
					const swap = host.swap!;
					return module.mount(container, runtime, {
						...host,
						swap: {
							...swap,
							onPendingChange: (listener) =>
								swap.onPendingChange((pending) => {
									calls.push(view);
									listener(pending);
								})
						}
					});
				}
			};
		};
		const swapped = await start({
			solid: listened("solid"),
			react: listened("react")
		});
		await swapTo(swapped, "react");
		await swapTo(swapped, "solid");
		calls.length = 0;

		const settled = swapped.switchTo("react");
		expect(calls.length).toBeGreaterThan(0);
		expect(new Set(calls)).toEqual(
			new Set([
				3
			])
		);
		await settled;
	}, 30_000);

	it.each([
		"solid",
		"react"
	] as const)("doesn't replay a flourish that a swap from %s cuts short, and shows the settled price", async (from) => {
		if (from === "react") history.replaceState(null, "", "/?renderer=react");
		const swapped = await start();
		const { runtime } = swapped;
		await runtime.dispatch(
			PlannerReceiver.handle,
			"Trips",
			{
				Type: "Portal/VoucherApplied",
				Percent: 10,
				From: "Marcus"
			},
			{
				publisher: {
					Id: "Chat"
				}
			}
		);
		await until(() => element.querySelector(".start .tick") !== null);
		expect(element.querySelector(".cards.vdrop")).not.toBeNull();
		expect(runtime.state.Trips.Voucher?.Played).toBe(true);

		await swapTo(swapped, from === "solid" ? "react" : "solid");
		expect(element.querySelector(".cards")).not.toBeNull();
		expect(element.querySelector(".cards.vdrop")).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, CARD_TICK_MS + 100));
		expect(element.querySelector(".start .tick")).toBeNull();
		expect(element.querySelector(".start .real.ticking")).toBeNull();
		expect(element.querySelectorAll(".start .vpill")).toHaveLength(3);
	}, 30_000);

	it("lets the Solid planner play the flourish the first time it is shown, end it on its timeline's end, and not again when it remounts", async () => {
		const swapped = await start();
		const { runtime } = swapped;
		await runtime.dispatch(openApp, ROOT_ID, "chat");
		await runtime.dispatch(
			PlannerReceiver.handle,
			"Trips",
			{
				Type: "Portal/VoucherApplied",
				Percent: 10,
				From: "Marcus"
			},
			{
				publisher: {
					Id: "Chat"
				}
			}
		);
		expect(runtime.state.Trips.Voucher?.Played).toBe(false);

		await runtime.dispatch(openApp, ROOT_ID, "trips");
		await until(() => element.querySelector(".cards") !== null);
		expect(element.querySelector(".cards.vdrop")).not.toBeNull();
		await until(() => runtime.state.Trips.Voucher?.Played === true);

		const cards = element.querySelector(".cards")!;
		const end = new Event("animationend", {
			bubbles: true
		});
		Object.defineProperty(end, "pseudoElement", {
			value: ""
		});
		cards.dispatchEvent(end);
		expect(cards.classList.contains("vdrop")).toBe(false);

		await runtime.dispatch(openApp, ROOT_ID, "chat");
		await runtime.dispatch(openApp, ROOT_ID, "trips");
		await until(() => element.querySelector(".cards") !== null);
		expect(element.querySelector(".cards.vdrop")).toBeNull();
	}, 30_000);
});
