import type { IBuild } from "../../portal/src/shell/builds";
import type { IRendererModule, ISwappedPortal } from "./swap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAWER_MEDIA } from "../../portal/src/shell/responsive";
import { resetMedia, setMedia } from "../../react-portal/src/testMedia";
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
const started: ISwappedPortal[] = [];

beforeEach(() => {
	element = document.createElement("div");
	document.body.append(element);
});

afterEach(() => {
	for (const each of started.splice(0)) {
		each.unmount();
		each.host.autosave.disable();
		each.runtime.dispose();
	}
	document.body.innerHTML = "";
});

async function start(renderers: Record<IBuild, () => Promise<IRendererModule>> = RENDERERS): Promise<ISwappedPortal> {
	let value: string | null = null;
	const swapped = await startSwap({
		element,
		renderers,
		initial: "solid",
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
		reload: () => {}
	});
	if (!swapped) throw new Error("the portal didn't start");
	started.push(swapped);
	await until(() => element.querySelector(".portal") !== null);
	return swapped;
}

const pressed = (): string | undefined => element.querySelector('.portal .seg [aria-pressed="true"]')?.textContent ?? undefined;

const note = (): string | null => document.querySelector(".swap-note")?.textContent ?? null;

const segmentButton = (label: string): HTMLButtonElement | undefined =>
	[
		...element.querySelectorAll<HTMLButtonElement>(".seg button")
	].find((button) => button.textContent === label);

const view = (swapped: ISwappedPortal) => ({
	renderer: swapped.current(),
	containers: element.childElementCount,
	portals: element.querySelectorAll(".portal").length,
	reactRoot: element.firstElementChild !== null && Object.keys(element.firstElementChild).some((key) => key.startsWith("__reactContainer"))
});

describe("the robust renderer swap, when a swap fails", () => {
	it("marks the other button busy while its view loads, says when it failed, and retries on the next click", async () => {
		let release!: () => void;
		let gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let failNext = true;
		const swapped = await start({
			solid: RENDERERS.solid,
			react: async () => {
				await gate;
				if (failNext) {
					failNext = false;
					throw new Error("blocked");
				}
				return RENDERERS.react();
			}
		});
		const errors: unknown[] = [];
		const error = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		const busy = () => segmentButton("React")?.getAttribute("aria-busy");
		try {
			expect(note()).toBe("");
			expect(document.querySelector(".swap-note")?.getAttribute("role")).toBe("status");

			segmentButton("React")!.click();
			await until(() => busy() === "true");
			segmentButton("Solid")!.click();
			expect(busy()).toBe("false");
			expect(swapped.swap.pending()).toBeNull();

			segmentButton("React")!.click();
			expect(busy()).toBe("true");
			release();
			await until(() => note() !== "");
			expect(note()).toBe("Couldn't switch to React. Try again.");
			expect(busy()).toBe("false");
			expect(view(swapped).renderer).toBe("solid");
			expect(errors).toHaveLength(1);

			segmentButton("Solid")!.click();
			expect(note()).toBe("");

			failNext = true;
			segmentButton("React")!.click();
			await until(() => note() !== "");
			gate = Promise.resolve();
			segmentButton("React")!.click();
			await until(() => pressed() === "React");
			expect(note()).toBe("");
			expect(swapped.swap.pending()).toBeNull();
		} finally {
			console.error = error;
		}
	}, 30_000);

	it("puts the Solid view back when the React view fails while mounting, above its error boundaries", async () => {
		const swapped = await start();
		const errors: unknown[] = [];
		const error = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		const methods = [
			"appendChild",
			"insertBefore"
		] as const;
		const originals = methods.map((name) => Node.prototype[name]);
		let throws = 1;
		for (const [index, name] of methods.entries()) {
			const original = originals[index] as (...args: unknown[]) => Node;
			Object.defineProperty(Node.prototype, name, {
				configurable: true,
				writable: true,
				value: function (this: Node, ...args: unknown[]) {
					if (throws > 0 && this instanceof HTMLDivElement && this.parentElement === element && this.style.display === "contents") {
						throws--;
						throw new Error("provoked insert throw");
					}
					return original.apply(this, args);
				}
			});
		}
		try {
			segmentButton("React")!.focus();
			segmentButton("React")!.click();
			await until(() => note() !== "");
			expect(note()).toBe("Couldn't switch to React. Try again.");
			expect(view(swapped)).toEqual({
				renderer: "solid",
				containers: 1,
				portals: 1,
				reactRoot: false
			});
			expect(pressed()).toBe("Solid");
			expect(document.activeElement).toBe(segmentButton("Solid"));
			expect(errors.some((args) => String((args as unknown[])[1]).includes("provoked insert throw"))).toBe(true);

			segmentButton("React")!.click();
			await until(() => pressed() === "React");
			expect(view(swapped).reactRoot).toBe(true);
			expect(note()).toBe("");
		} finally {
			for (const [index, name] of methods.entries()) {
				Object.defineProperty(Node.prototype, name, {
					configurable: true,
					writable: true,
					value: originals[index]
				});
			}
			console.error = error;
		}
	}, 30_000);

	it("leaves a React view failure that its error boundary catches to the boundary, as a mounted view", async () => {
		const errors: unknown[] = [];
		const error = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const swapped = await start({
				solid: RENDERERS.solid,
				react: async () => {
					const module = await RENDERERS.react();
					return {
						...module,
						mount: (container, runtime, host) =>
							module.mount(
								container,
								runtime,
								new Proxy(host, {
									get: (target, key) => {
										if (key === "autosave") throw new Error("provoked view throw");
										return target[key as keyof typeof target];
									}
								})
							)
					};
				}
			});
			await swapped.switchTo("react");
			expect(swapped.current()).toBe("react");
			expect(swapped.swap.pending()).toBeNull();
			expect(note()).toBe("");
			expect(element.textContent).toContain("view failed.");
			expect(element.childElementCount).toBe(1);
		} finally {
			console.error = error;
		}
	}, 30_000);

	it("says a swap failed in one live region outside the views, changing its text in place after a load and a mount failure", async () => {
		let failLoad = true;
		const swapped = await start({
			solid: RENDERERS.solid,
			react: async () => {
				if (failLoad) {
					failLoad = false;
					throw new Error("blocked");
				}
				const module = await RENDERERS.react();
				let throws = 1;
				return {
					...module,
					mount: (...args) => {
						if (throws-- > 0) throw new Error("mount refused");
						return module.mount(...args);
					}
				};
			}
		});
		const error = console.error;
		console.error = () => {};
		try {
			const region = swapped.note;
			expect(region.getAttribute("role")).toBe("status");
			expect(region.textContent).toBe("");
			expect(element.contains(region)).toBe(false);
			const bar = region.parentElement!;
			expect(bar.parentElement).toBe(element.parentElement);
			expect(bar.nextElementSibling).toBe(element);
			expect(bar.classList.contains("idle")).toBe(true);

			await swapped.switchTo("react");
			expect(document.querySelectorAll(".swap-note")).toHaveLength(1);
			expect(document.querySelector(".swap-note")).toBe(region);
			expect(region.textContent).toBe("Couldn't switch to React. Try again.");
			expect(bar.classList.contains("idle")).toBe(false);

			const dismiss = bar.querySelector<HTMLButtonElement>("button")!;
			expect(dismiss.getAttribute("aria-label")).toBe("Dismiss");
			expect(region.contains(dismiss)).toBe(false);
			segmentButton("React")!.focus();
			dismiss.focus();
			dismiss.click();
			expect(region.textContent).toBe("");
			expect(bar.classList.contains("idle")).toBe(true);
			expect(document.activeElement).toBe(segmentButton("Solid"));

			await swapped.switchTo("react");
			expect(swapped.current()).toBe("solid");
			expect(document.querySelector(".swap-note")).toBe(region);
			expect(region.textContent).toBe("Couldn't switch to React. Try again.");

			await swapped.switchTo("solid");
			expect(region.textContent).toBe("");

			await swapped.switchTo("react");
			expect(swapped.current()).toBe("react");
			expect(document.querySelector(".swap-note")).toBe(region);
			expect(region.textContent).toBe("");
		} finally {
			console.error = error;
		}
	}, 30_000);

	it("leaves no timer or listener behind from a Solid view whose insert threw", async () => {
		const swapped = await start();
		const live = new Set<unknown>();
		const set = globalThis.setInterval;
		const clear = globalThis.clearInterval;
		vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
			const id = set(...args);
			live.add(id);
			return id;
		}) as typeof setInterval);
		vi.spyOn(globalThis, "clearInterval").mockImplementation((id) => {
			live.delete(id);
			clear(id);
		});
		const documentListeners = countListeners(document);
		const windowListeners = countListeners(window);
		try {
			const module = await RENDERERS.solid();
			const host = {
				...swapped.host,
				swap: swapped.swap
			};
			for (let i = 0; i < 5; i++) {
				const container = document.createElement("div");
				container.appendChild = () => {
					throw new Error("provoked insert throw");
				};
				container.insertBefore = container.appendChild;
				expect(() => module.mount(container, swapped.runtime, host)).toThrow("provoked insert throw");
			}
			expect(live.size).toBe(0);
			expect(documentListeners.count()).toBe(0);
			expect(windowListeners.count()).toBe(0);

			const container = document.createElement("div");
			const unmount = module.mount(container, swapped.runtime, host);
			expect(live.size).toBe(1);
			unmount();
			expect(live.size).toBe(0);
			expect(container.childNodes).toHaveLength(0);
		} finally {
			documentListeners.restore();
			windowListeners.restore();
			vi.restoreAllMocks();
		}
	}, 30_000);

	it("says a failure from the phone drawer outside the drawer, which the toggle tap closed", async () => {
		setMedia((query) => query === DRAWER_MEDIA);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const error = console.error;
		console.error = () => {};
		try {
			const swapped = await start({
				solid: RENDERERS.solid,
				react: async () => {
					await gate;
					throw new Error("blocked");
				}
			});
			const portal = () => element.querySelector(".portal")!;
			element.querySelector<HTMLButtonElement>(".mobilebar .menu")!.click();
			expect(portal().classList.contains("drawer-open")).toBe(true);

			segmentButton("React")!.click();
			expect(portal().classList.contains("drawer-open")).toBe(false);

			release();
			await until(() => note() !== "");
			expect(note()).toBe("Couldn't switch to React. Try again.");
			expect(view(swapped).renderer).toBe("solid");
			expect(swapped.note.closest(".side, .portal")).toBeNull();
		} finally {
			console.error = error;
			resetMedia();
		}
	}, 30_000);
});
