import type { IMonitor } from "../portal/monitor";
import type { IAutosave } from "../portal/session";
import type { IBuild } from "./builds";

/** Swaps the renderer under a running portal, keeping its runtime. Only the swap build offers it. */
export interface IRendererSwap {
	/** The renderer a swap is loading, or null. */
	pending(): IBuild | null;
	onPendingChange(listener: (pending: IBuild | null) => void): () => void;
	/** Mounts `renderer`'s view in place of the current one. */
	switchTo(renderer: IBuild): void;
}

export interface IPortalHost {
	autosave: IAutosave;
	monitor: IMonitor;
	restoredAt: number | null;
	reload(): void;
	reset(): void;
	swap?: IRendererSwap;
}
