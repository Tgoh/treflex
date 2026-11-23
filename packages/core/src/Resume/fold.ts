import type { IRecordChange, IRecordLanding } from "../Types/IRecord";
import type { IHistoryEntry } from "./history";

/**
 * The places another writer's plain sets have entries for since the history's last own entry or
 * other kind of kept change, each the index of its entry. Null when it must be found again from the
 * entries, as after a history is carried through a restore.
 */
export interface IStretch {
	places: Map<string, number> | null;
}

type IOtherEntry = Extract<
	IHistoryEntry,
	{
		Kind: "other";
	}
>;

function isSet(change: IRecordChange): boolean {
	return change.Deleted === undefined && change.Created === undefined && change.GrewFrom === undefined;
}

function isScalar(value: unknown): boolean {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isPlainSet(change: IRecordChange): boolean {
	return isSet(change) && isScalar(change.Prev) && isScalar(change.Value);
}

function samePlace(a: IRecordLanding, b: IRecordLanding): boolean {
	if (a.EntityId !== b.EntityId || a.Path.length !== b.Path.length) {
		return false;
	}
	for (let at = 0; at < a.Path.length; at++) {
		if (a.Path[at] !== b.Path[at]) {
			return false;
		}
	}
	return true;
}

function placeKey(landing: IRecordLanding): string {
	return JSON.stringify([
		landing.EntityId,
		...landing.Path.map(String)
	]);
}

function placesIn(entries: readonly IHistoryEntry[]): Map<string, number> {
	const places = new Map<string, number>();
	for (let at = entries.length - 1; at >= 0; at--) {
		const entry = entries[at]!;
		if (entry.Kind !== "other" || !isPlainSet(entry.Change) || entry.Change.Landing === undefined) {
			break;
		}
		const key = placeKey(entry.Change.Landing);
		if (!places.has(key)) {
			places.set(key, at);
		}
	}
	return places;
}

function merged(
	first: IRecordChange,
	change: IRecordChange & {
		Landing: IRecordLanding;
	}
): IHistoryEntry {
	return {
		Kind: "other",
		Change: {
			...change,
			Prev: first.Prev
		}
	};
}

/**
 * Appends another writer's change. A plain set merges into the stretch's entry for its place, and
 * any set folds into the last entry when that is a set of the same place; any other change forgets
 * the stretch's places. Returns whether an entry was added.
 */
export function appendOther(
	entries: IHistoryEntry[],
	change: IRecordChange & {
		Landing: IRecordLanding;
	},
	stretch: IStretch
): boolean {
	stretch.places ??= placesIn(entries);
	const places = stretch.places;
	const plain = isPlainSet(change);
	const key = plain ? placeKey(change.Landing) : "";
	const at = plain ? places.get(key) : undefined;
	if (at !== undefined) {
		entries[at] = merged((entries[at] as IOtherEntry).Change, change);
		return false;
	}
	const last = entries[entries.length - 1];
	if (last?.Kind === "other" && isSet(change) && isSet(last.Change) && samePlace(last.Change.Landing!, change.Landing)) {
		entries[entries.length - 1] = merged(last.Change, change);
		if (!plain) {
			places.clear();
		}
		return false;
	}
	entries.push({
		Kind: "other",
		Change: change
	});
	if (plain) {
		places.set(key, entries.length - 1);
	} else {
		places.clear();
	}
	return true;
}
