import type { ISaveState } from "./session";

export interface ISessionStatus {
	Saved: boolean;
	Title: string;
	Meta: string;
}

function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

const RESTORED_LABEL_MS = 15_000;

export function sessionStatus(state: ISaveState, restoredAt: number | null, now: number): ISessionStatus {
	if (state.Failing) {
		return {
			Saved: false,
			Title: "This browser can't save",
			Meta: "A reload goes back to the last save, if there is one"
		};
	}
	const last = state.Last;
	if (!last) {
		return {
			Saved: false,
			Title: "Not saved yet",
			Meta: ""
		};
	}
	const lead =
		restoredAt !== null && now - restoredAt < RESTORED_LABEL_MS ? `Restored ${ago(now - restoredAt)}` : `Snapshot ${ago(now - last.At)}`;
	return {
		Saved: true,
		Title: "Saved in this browser",
		Meta: `${lead} · ${last.Entities} entities · ${Math.max(1, Math.round(last.Bytes / 1024))} KB`
	};
}
