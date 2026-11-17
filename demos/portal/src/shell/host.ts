import type { IMonitor } from "../portal/monitor";
import type { IAutosave } from "../portal/session";

export interface IPortalHost {
	autosave: IAutosave;
	monitor: IMonitor;
	restoredAt: number | null;
	reload(): void;
	reset(): void;
}
