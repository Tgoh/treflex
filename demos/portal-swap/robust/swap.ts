import "./swap.css";
import type { IRuntime } from "treflex";
import type { IPortal } from "../../portal/src/portal/Portal";
import type { ISessionStore, ITabDocument, ITabWindow } from "../../portal/src/portal/session";
import type { IBuild } from "../../portal/src/shell/builds";
import type { IPortalHost, IRendererSwap } from "../../portal/src/shell/host";
import { startPortal } from "../../portal/src/shell/start";

/** Mounts one renderer's portal view into `element` over a runtime that is already booted. Returns the unmount. */
export type IMount = (element: HTMLElement, runtime: IRuntime<IPortal>, host: IPortalHost) => () => void;

/** Mounts one renderer's card for a portal that couldn't start, whose Reset is `reset`. Returns the unmount. */
export type IFail = (element: HTMLElement, reset: () => void) => () => void;

export interface IRendererModule {
	mount: IMount;
	fail: IFail;
}

export interface ISwapStart {
	element: HTMLElement;
	/** Each renderer's module, loaded on first use. */
	renderers: Record<IBuild, () => Promise<IRendererModule>>;
	initial: IBuild;
	store: ISessionStore;
	document: ITabDocument;
	window: ITabWindow;
	reload(): void;
	/** Called when a swap settles on a mounted view whose renderer differs from the one it last reported. */
	onSwitch?(renderer: IBuild): void;
}

export interface ISwappedPortal {
	runtime: IRuntime<IPortal>;
	host: IPortalHost;
	swap: IRendererSwap;
	/** The live region, in a bar beside `element`, that says when a swap failed. */
	note: HTMLElement;
	/** The renderer whose view is mounted. */
	current(): IBuild | undefined;
	/** Resolves once the renderer last asked for is mounted, or the swap to it has failed. */
	switchTo(renderer: IBuild): Promise<void>;
	unmount(): void;
}

interface IMounted {
	renderer: IBuild;
	container: HTMLElement;
	unmount(): void;
}

const LOAD_FAILED = "The portal's view didn't load. Reload the page to try again.";

const NAMES: Record<IBuild, string> = {
	solid: "Solid",
	react: "React"
};

/** Boots the portal once, then mounts one renderer's view over it, and swaps it for the other's in place when its session card asks. */
export async function startSwap({
	element,
	renderers,
	initial,
	store,
	document,
	window,
	reload,
	onSwitch
}: ISwapStart): Promise<ISwappedPortal | null> {
	const modules = new Map<IBuild, Promise<IRendererModule>>();
	const load = (renderer: IBuild): Promise<IRendererModule> => {
		let module = modules.get(renderer);
		if (!module) {
			module = renderers[renderer]();
			modules.set(renderer, module);
			module.catch(() => modules.delete(renderer));
		}
		return module;
	};
	void load(initial);

	// React leaves listeners on the element it mounted into, so each view, and each fallback, gets a fresh one.
	const freshContainer = (): HTMLElement => {
		const container = element.ownerDocument.createElement("div");
		container.style.display = "contents";
		element.append(container);
		return container;
	};

	let swapped: ISwappedPortal | null = null;
	let ready: Promise<void> | undefined;
	await startPortal({
		store,
		document,
		window,
		reload,
		render: (runtime, host) => {
			let mounted: IMounted | undefined;
			let lastMounted: IBuild | undefined;
			let reported: IBuild | undefined;
			let wanted: IBuild | undefined;
			let busy = false;
			let waiting: (() => void)[] = [];
			let fallback: (() => void) | undefined;
			let failed: IBuild | null = null;
			let pending: IBuild | null = null;
			const listeners = new Set<(pending: IBuild | null) => void>();

			// Outside the swapped containers, so it stays put, and is announced, as views come and go.
			const doc = element.ownerDocument;
			const bar = doc.createElement("div");
			bar.className = "swap-bar idle";
			const note = doc.createElement("p");
			note.className = "swap-note";
			note.setAttribute("role", "status");
			const dismiss = doc.createElement("button");
			dismiss.type = "button";
			dismiss.textContent = "×";
			dismiss.setAttribute("aria-label", "Dismiss");
			bar.append(note, dismiss);
			element.before(bar);

			const showNote = (): void => {
				const text = failed && mounted ? `Couldn't switch to ${NAMES[failed]}. Try again.` : "";
				if (note.textContent !== text) note.textContent = text;
				bar.classList.toggle("idle", text === "");
			};

			dismiss.addEventListener("click", () => {
				failed = null;
				showNote();
				if (mounted) focusSegment(mounted.container);
			});

			const setStatus = (next: IBuild | null): void => {
				showNote();
				if (next === pending) return;
				pending = next;
				for (const listener of listeners) listener(pending);
			};

			const control: IRendererSwap = {
				pending: () => pending,
				onPendingChange: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				switchTo: (renderer) => {
					void switchTo(renderer);
				}
			};

			const clearFallback = (): void => {
				const stop = fallback;
				fallback = undefined;
				stop?.();
			};

			const showFallback = (module: IRendererModule | null): void => {
				clearFallback();
				const container = freshContainer();
				let stop = (): void => {};
				try {
					if (module) stop = module.fail(container, host.reset);
					else container.textContent = LOAD_FAILED;
				} catch (error) {
					console.error("[portal] the failed card failed too:", error);
					container.textContent = LOAD_FAILED;
				}
				fallback = () => {
					try {
						stop();
					} finally {
						container.remove();
					}
				};
			};

			const mountInto = (module: IRendererModule, renderer: IBuild): IMounted => {
				const container = freshContainer();
				let stop: () => void;
				try {
					stop = module.mount(container, runtime, {
						...host,
						swap: control
					});
				} catch (error) {
					container.remove();
					throw error;
				}
				return {
					renderer,
					container,
					unmount: () => {
						try {
							stop();
						} finally {
							container.remove();
						}
					}
				};
			};

			const unmountCurrent = (): void => {
				const old = mounted;
				mounted = undefined;
				try {
					old?.unmount();
				} catch (error) {
					console.error(`[portal] the ${old?.renderer} view failed to unmount:`, error);
				}
			};

			const focusSegment = (container: HTMLElement): void => {
				container.querySelector<HTMLElement>('.seg [aria-pressed="true"]')?.focus();
				if (!container.contains(doc.activeElement)) container.querySelector<HTMLElement>(".mobilebar .menu")?.focus();
			};

			const mountStep = async (
				renderer: IBuild,
				focus: {
					kept: boolean;
				}
			): Promise<void> => {
				const module = await load(renderer).catch((error: unknown) => {
					console.error(`[portal] the ${renderer} view didn't load:`, error);
					return null;
				});
				if (wanted !== renderer) return;
				if (!module) {
					failed = renderer;
					wanted = mounted?.renderer;
					if (!wanted) showFallback(null);
					return;
				}
				focus.kept ||= mounted?.container.contains(element.ownerDocument.activeElement) ?? false;
				unmountCurrent();
				try {
					mounted = mountInto(module, renderer);
				} catch (error) {
					console.error(`[portal] the ${renderer} view failed to mount:`, error);
					failed = renderer;
					if (lastMounted === renderer) lastMounted = undefined;
					wanted = lastMounted;
					if (!wanted) showFallback(module);
					return;
				}
				lastMounted = renderer;
				clearFallback();
				if (focus.kept) focusSegment(mounted.container);
			};

			const run = async (): Promise<void> => {
				busy = true;
				const focus = {
					kept: false
				};
				try {
					for (;;) {
						while (wanted && mounted?.renderer !== wanted) {
							const renderer = wanted;
							setStatus(renderer);
							await mountStep(renderer, focus);
						}
						setStatus(null);
						if (mounted && mounted.renderer !== reported) {
							reported = mounted.renderer;
							try {
								onSwitch?.(reported);
							} catch (error) {
								console.error("[portal] recording the renderer failed:", error);
							}
						}
						if (!wanted || mounted?.renderer === wanted) break;
					}
				} catch (error) {
					console.error("[portal] the renderer swap failed:", error);
					try {
						setStatus(null);
					} catch (again) {
						console.error("[portal] the renderer swap failed:", again);
					}
				} finally {
					const done = waiting;
					waiting = [];
					for (const resolve of done) resolve();
					busy = false;
				}
			};

			const switchTo = (renderer: IBuild): Promise<void> => {
				wanted = renderer;
				failed = null;
				const settled = new Promise<void>((resolve) => waiting.push(resolve));
				if (busy) setStatus(mounted?.renderer === renderer ? null : renderer);
				else void run();
				return settled;
			};

			swapped = {
				runtime,
				host,
				swap: control,
				note,
				current: () => mounted?.renderer,
				switchTo,
				unmount: () => {
					wanted = undefined;
					unmountCurrent();
					clearFallback();
					bar.remove();
				}
			};
			ready = switchTo(initial);
		},
		fail: (reset) => {
			load(initial).then(
				(module) => {
					element.textContent = "";
					module.fail(element, reset);
				},
				(error) => {
					console.error(`[portal] the ${initial} view didn't load:`, error);
					element.textContent = "The portal couldn't start. Reload the page to try again.";
				}
			);
		}
	});
	await ready;
	return swapped;
}
