import type { IRuntime } from "treflex";
import type { IMonitor } from "../portal/monitor";
import type { IPortal } from "../portal/Portal";
import type { IAutosave, ISessionStore, ITabDocument, ITabWindow } from "../portal/session";
import type { IPortalHost } from "./host";
import { wallClock } from "../portal/clock";
import { createMonitor } from "../portal/monitor";
import { boot, createAutosave, RECEIVER_IDS, watchTabs } from "../portal/session";

export interface IPortalStart {
	store: ISessionStore;
	document: ITabDocument;
	window: ITabWindow;
	reload(): void;
	/** Mounts the portal's view. Only a synchronous throw from it reaches `fail`; a view that fails while rendering is its error boundary's. */
	render(runtime: IRuntime<IPortal>, host: IPortalHost): void;
	/** Mounts the card for a portal that couldn't start, whose Reset is `reset`. */
	fail(reset: () => void): void;
}

/**
 * Boots the portal from the store, with its autosave created paused and the record monitor attached, then hands
 * the tab to `watchTabs` and mounts the view. Both builds start through this, so they share the store's key and
 * envelope.
 */
export function startPortal({ store, document, window, reload, render, fail }: IPortalStart): Promise<void> {
	let autosave: IAutosave | undefined;
	let monitor: IMonitor | undefined;

	const reset = (): void => {
		autosave?.disable();
		store.clear();
		reload();
	};

	return boot(store, {
		options: {
			onError: (error) => console.error("[portal] action failed:", error),
			requireNames: true,
			build: import.meta.env.VITE_BUILD_ID
		},
		attach: (runtime) => {
			autosave = createAutosave(runtime, store, {
				paused: true
			});
			monitor = createMonitor(runtime, {
				receivers: RECEIVER_IDS
			});
		}
	})
		.then(({ runtime, restored, read }) => {
			if (!autosave || !monitor) throw new Error("[portal] setup did not run");
			const session = autosave;
			const host: IPortalHost = {
				autosave: session,
				monitor,
				restoredAt: restored ? wallClock() : null,
				reload: () => {
					session.saveNow();
					reload();
				},
				reset
			};
			watchTabs({
				document,
				window,
				autosave: session,
				store,
				read,
				reload
			});
			render(runtime, host);
		})
		.catch((error) => {
			console.error("[portal] boot failed:", error);
			fail(reset);
		});
}
