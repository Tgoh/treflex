import type { IRuntime } from "treflex";
import type { IPortal } from "../../portal/src/portal/Portal";
import type { ISessionStore, ITabDocument, ITabWindow } from "../../portal/src/portal/session";
import type { IBuild } from "../../portal/src/shell/builds";
import type { IPortalHost, IRendererSwap } from "../../portal/src/shell/host";
import { startPortal } from "../../portal/src/shell/start";

/** Mounts one renderer's portal view into `element` over a runtime that is already booted. Returns the unmount. */
export type IMount = (element: HTMLElement, runtime: IRuntime<IPortal>, host: IPortalHost) => () => void;

/** Mounts one renderer's card for a portal that couldn't start, whose Reset is `reset`. */
export type IFail = (element: HTMLElement, reset: () => void) => void;

export interface IRendererModule {
	mount: IMount;
	fail: IFail;
}

export interface ISwapStart {
	element: HTMLElement;
	/** Each renderer's module, loaded on first use. */
	renderers: Record<IBuild, () => Promise<IRendererModule>>;
	store: ISessionStore;
	document: ITabDocument;
	window: ITabWindow;
	reload(): void;
}

export interface ISwappedPortal {
	runtime: IRuntime<IPortal>;
	host: IPortalHost;
	current(): IBuild;
	/** Resolves once this swap, and every one asked for before it, has settled. */
	switchTo(renderer: IBuild): Promise<void>;
	unmount(): void;
}

const QUERY = "renderer";

/** Boots the portal once, mounts the renderer the address names, and swaps it for the other in place when its session card asks. */
export async function startSwap({ element, renderers, ...start }: ISwapStart): Promise<ISwappedPortal | null> {
	const doc = element.ownerDocument;
	let current: IBuild = new URLSearchParams(location.search).get(QUERY) === "react" ? "react" : "solid";
	const first = await renderers[current]();

	let swapped: ISwappedPortal | null = null;
	await startPortal({
		...start,
		render: (runtime, host) => {
			let wanted = current;
			let queue = Promise.resolve();
			const listeners = new Set<(pending: IBuild | null) => void>();
			const pending = () => (wanted === current ? null : wanted);

			const swap: IRendererSwap = {
				pending,
				onPendingChange: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				switchTo: (renderer) => void switchTo(renderer)
			};

			// React leaves listeners on the element it mounted into, so each view gets a fresh one.
			const mountView = (mount: IMount) => {
				const container = doc.createElement("div");
				container.style.display = "contents";
				element.append(container);
				const unmount = mount(container, runtime, {
					...host,
					swap
				});
				return {
					container,
					unmount: () => {
						unmount();
						container.remove();
					}
				};
			};
			let view = mountView(first.mount);

			const settle = async (): Promise<void> => {
				const renderer = wanted;
				if (renderer === current) return;
				const { mount } = await renderers[renderer]();
				if (renderer !== wanted) return;

				const focused = view.container.contains(doc.activeElement);
				view.unmount();
				current = renderer;
				view = mountView(mount);
				if (focused) {
					view.container.querySelector<HTMLElement>('.seg [aria-pressed="true"]')?.focus();
					// In the drawer layout the toggle is in the closed drawer, which can't take focus.
					if (!view.container.contains(doc.activeElement)) view.container.querySelector<HTMLElement>(".mobilebar .menu")?.focus();
				}

				const url = new URL(location.href);
				if (renderer === "react") url.searchParams.set(QUERY, renderer);
				else url.searchParams.delete(QUERY);
				history.replaceState(history.state, "", url);
			};

			const switchTo = (renderer: IBuild): Promise<void> => {
				wanted = renderer;
				for (const listener of listeners) listener(pending());
				queue = queue.then(settle).catch((error: unknown) => {
					console.error("[portal] the swap failed, so the page reloads:", error);
					host.reload();
				});
				return queue;
			};

			swapped = {
				runtime,
				host,
				current: () => current,
				switchTo,
				unmount: () => view.unmount()
			};
		},
		fail: (reset) => {
			element.replaceChildren();
			first.fail(element, reset);
		}
	});
	return swapped;
}
