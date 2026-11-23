import type { ISnapshotInFlightEntry } from "../Snapshot/ISnapshot";
import type { IDeliveryAt, IHistory, IHistoryEntry, ISnapshotHistory, IUnlisted } from "./history";
import { mintedId } from "../Runtime/draftNode";
import { declarationOf, isRedacted } from "../Runtime/effectDeclarations";
import { actionNamed } from "../Runtime/named";
import { operationOf } from "../Runtime/operations";
import { isResumable } from "./resumable";

export type IDropReason =
	| "not-marked"
	| "resume-off"
	| "other-build"
	| "no-history"
	| "over-budget"
	| "unknown-name"
	| "not-idempotent"
	| "behind"
	| "unlisted"
	| "watched"
	| "off-list"
	| "diverged";

export interface IDrop {
	readonly reason: IDropReason;
	readonly detail?: string;
	/** On `not-idempotent`: the `Type` of the wait the snapshot caught. */
	readonly wait?: string;
	/** The drop is for what the action itself does: what its history holds, its arguments, or the wait it was caught at. */
	readonly ownDoing?: true;
}

/** A resource with a delivery in flight on a row's entity, above it or below it, when the snapshot was written. */
export interface IResourceWork {
	readonly key: string;
	readonly ownerId: string;
}

export type IPlan =
	| {
			readonly kind: "replay";
			readonly row: ISnapshotInFlightEntry;
			readonly fn: Function;
			readonly history: IHistory;
			readonly state: "holding" | "open";
			/** The `Type` of the wait the snapshot caught. */
			readonly wait: string;
			readonly resourceWork: readonly IResourceWork[];
	  }
	| {
			/**
			 * Put back in its entity's line once the replays are over if every row of `on` resumed or was
			 * put back, and otherwise dropped `behind`, the detail being `waits` and the first of `on` that wasn't.
			 */
			readonly kind: "queued";
			readonly row: ISnapshotInFlightEntry;
			readonly fn: Function;
			readonly history: IHistory;
			readonly on: readonly ISnapshotInFlightEntry[];
			readonly waits: string;
			readonly resourceWork: readonly IResourceWork[];
	  }
	| {
			/** Dropped once the replays are over: `off-list` with `ifResumed` when every row of `on` resumed, and `behind` with `ifNot` otherwise. */
			readonly kind: "behind";
			readonly row: ISnapshotInFlightEntry;
			readonly on: readonly ISnapshotInFlightEntry[];
			readonly ifResumed: string;
			readonly ifNot: string;
	  }
	| ({
			readonly kind: "drop";
			readonly row: ISnapshotInFlightEntry;
	  } & IDrop);

export interface IPlanInputs {
	readonly rows: readonly ISnapshotInFlightEntry[];
	readonly histories: readonly ISnapshotHistory[] | undefined;
	/** Whether the runtime keeps histories: its `resume` option. */
	readonly resume: boolean;
	readonly sameBuild: boolean;
	readonly isIdempotent: (type: string) => boolean;
	/** The `$Id`s from the root down to the entity, itself included, or undefined when it isn't in the tree. */
	readonly lineOf: (entityId: string) => readonly string[] | undefined;
	/** What a reactive scope has read that a prefix can change, or null when nothing has. Asked only when a replay is planned. */
	readonly watched: () => string | null;
}

const ANSWERED_OPERATIONS = new Set([
	"ask",
	"answer",
	"publish",
	"publishToNearest",
	"startTimer",
	"stopTimer"
]);

function typeOf(
	entry: IHistoryEntry & {
		Kind: "effect";
	}
): string | undefined {
	const type = (
		entry.Descriptor as {
			Type?: unknown;
		} | null
	)?.Type;
	return typeof type === "string" ? type : undefined;
}

function idsIn(value: unknown, into: Set<string>): void {
	if (value === null || typeof value !== "object") {
		return;
	}
	const id = (
		value as {
			$Id?: unknown;
		}
	).$Id;
	if (typeof id === "string") {
		into.add(id);
	}
	for (const child of Object.values(value)) {
		idsIn(child, into);
	}
}

function offListDrop(detail: string): IDrop {
	return {
		reason: "off-list",
		detail,
		ownDoing: true
	};
}

function offList(
	history: IHistory,
	isIdempotent: (type: string) => boolean
):
	| IDrop
	| {
			readonly caught: string;
	  } {
	let waiting:
		| (IHistoryEntry & {
				Kind: "effect";
		  })
		| null = null;
	const minted = new Set<string>();
	const written = new Set<string>();
	for (const entry of history.Entries) {
		switch (entry.Kind) {
			case "effect": {
				if (waiting !== null) {
					return offListDrop("a yield is recorded before the one ahead of it was answered");
				}
				const type = typeOf(entry);
				if (type === undefined) {
					return offListDrop("a yield is recorded with no type");
				}
				if (isRedacted(type)) {
					return offListDrop(`"${type}" is redacted, so the history holds none of it`);
				}
				if (declarationOf(type)?.returns === "module") {
					return offListDrop(`"${type}" returns a module, which the history holds only as data`);
				}
				if (operationOf(entry.Descriptor) !== undefined && !ANSWERED_OPERATIONS.has(type)) {
					return offListDrop(`"${type}" is a runtime operation the replay doesn't answer`);
				}
				waiting = entry;
				break;
			}
			case "response": {
				if (waiting === null || entry.ForSeq !== waiting.Seq) {
					return offListDrop("an answer is recorded with no yield waiting for it");
				}
				if ("Error" in entry && entry.Error.Thrown === "redacted") {
					return offListDrop(`"${typeOf(waiting)}" rejected with a redacted error`);
				}
				if (typeOf(waiting) === "generateGuid" && "Value" in entry && typeof entry.Value === "string") {
					minted.add(entry.Value);
					minted.add(mintedId(entry.Value));
				}
				waiting = null;
				break;
			}
			case "step": {
				if (waiting !== null) {
					return offListDrop("a step is recorded while a yield waits");
				}
				for (const change of entry.Changes) {
					if (change.Landing === undefined) {
						return offListDrop("a step's change has no landing, so the replay can't place it");
					}
					idsIn(change.Value, written);
				}
				if (entry.ExternalAnswers?.some((answer) => answer.Redacted)) {
					return offListDrop("an external read is redacted");
				}
				break;
			}
		}
	}
	for (const id of written) {
		if (minted.has(id)) {
			return offListDrop(`"${id}" is a child made with entity()`);
		}
	}
	if (waiting === null) {
		return offListDrop("the history ends at no wait");
	}
	const type = typeOf(waiting)!;
	if (type === "ask") {
		return {
			caught: type
		};
	}
	if (operationOf(waiting.Descriptor) !== undefined) {
		return offListDrop(`the wait the snapshot caught is "${type}", which can't be sent again`);
	}
	return isIdempotent(type)
		? {
				caught: type
			}
		: {
				reason: "not-idempotent",
				detail: `the wait the snapshot caught is "${type}", which isn't declared idempotent`,
				wait: type,
				ownDoing: true
			};
}

function related(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === undefined || b === undefined) {
		return false;
	}
	return a.includes(b[b.length - 1]!) || b.includes(a[a.length - 1]!);
}

/** How a drop's detail names a row. */
export function nameOf(row: ISnapshotInFlightEntry): string {
	return `"${row.Name ?? row.Label ?? row.ActionId}"`;
}

function isDelivery(value: unknown): value is IDeliveryAt {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const { Key, OwnerId, EntityId, At } = value as Record<string, unknown>;
	return (
		typeof Key === "string" &&
		typeof OwnerId === "string" &&
		typeof EntityId === "string" &&
		(At === "holding" || At === "in-line" || At === "open")
	);
}

function deliveriesIn(history: ISnapshotHistory): readonly IDeliveryAt[] | null {
	const deliveries: unknown = history.Deliveries;
	return Array.isArray(deliveries) && deliveries.every(isDelivery) ? deliveries : null;
}

// A missing or unknown value, or deliveries that can't be read, are taken as work holding the entity
// that can't be named: a writer that didn't know the field can't say there was none.
function unlistedOf(rows: readonly ISnapshotInFlightEntry[], histories: ReadonlyMap<string, ISnapshotHistory>): IUnlisted {
	for (const row of rows) {
		const history = histories.get(row.ActionId);
		if (history === undefined) {
			continue;
		}
		if (deliveriesIn(history) === null) {
			return "holding";
		}
		const unlisted: unknown = history.Unlisted;
		if (unlisted === "holding" || unlisted === "in-line") {
			return unlisted;
		}
		if (unlisted !== "none") {
			return "holding";
		}
	}
	return "none";
}

// A missing or malformed value is taken as some, as `unlistedOf` takes one.
function unlistedNear(rows: readonly ISnapshotInFlightEntry[], histories: ReadonlyMap<string, ISnapshotHistory>): string | null {
	for (const row of rows) {
		const history = histories.get(row.ActionId);
		if (history === undefined) {
			continue;
		}
		const lineage: unknown = history.UnlistedLineage;
		if (Array.isArray(lineage) && lineage.length === 0) {
			continue;
		}
		const { EntityId: entityId, Unlisted: unlisted } = ((Array.isArray(lineage) ? lineage[0] : null) ?? {}) as {
			EntityId?: unknown;
			Unlisted?: unknown;
		};
		return typeof entityId === "string" && (unlisted === "holding" || unlisted === "in-line")
			? `work the snapshot's rows don't list and can't name ${unlisted === "holding" ? "holds" : "stands in the line of"} "${entityId}", above or below its entity, and nothing resumes beside it`
			: "work the snapshot's rows don't list and can't name may be on an entity above or below its own, and nothing resumes beside it";
	}
	return null;
}

function resourceWorkOf(deliveries: readonly IDeliveryAt[]): IResourceWork[] {
	const work: IResourceWork[] = [];
	for (const delivery of deliveries) {
		if (!work.some((seen) => seen.key === delivery.Key && seen.ownerId === delivery.OwnerId)) {
			work.push({
				key: delivery.Key,
				ownerId: delivery.OwnerId
			});
		}
	}
	return work;
}

interface IOwn {
	readonly fn: Function;
	readonly history: IHistory;
	readonly wait: string | undefined;
}

function dropOf(row: ISnapshotInFlightEntry, drop: IDrop): IPlan {
	return {
		kind: "drop",
		row,
		...drop
	};
}

/**
 * A plan for each in-flight row, in row order, made from what the rows, the histories and the named
 * functions state. Work that stood in a line is never put back ahead of what it waited behind.
 */
export function planResume(inputs: IPlanInputs): IPlan[] {
	const histories = new Map(
		(inputs.histories ?? []).map((history) => [
			history.ActionId,
			history
		])
	);
	const own = inputs.rows.map((row): IOwn | IPlan => {
		const drop = (reason: IDropReason, detail?: string): IPlan =>
			dropOf(row, {
				reason,
				...(detail === undefined
					? {}
					: {
							detail
						})
			});
		if (!inputs.resume) {
			return drop("resume-off");
		}
		if (!inputs.sameBuild) {
			return drop("other-build");
		}
		if (row.Receiver !== undefined || row.Name === null) {
			return drop("not-marked", row.Receiver !== undefined ? "a delivery" : "the action has no durable name");
		}
		const fn = actionNamed(row.Name);
		if (fn === undefined) {
			return drop("unknown-name", `no one function is named "${row.Name}"`);
		}
		if (!isResumable(fn)) {
			return drop("not-marked");
		}
		const history = histories.get(row.ActionId);
		if (history === undefined) {
			return drop("no-history", "the snapshot carries no history for it");
		}
		if ("Unusable" in history) {
			return history.Unusable === "over-budget" ? drop("over-budget") : drop("no-history", `its history is ${history.Unusable}`);
		}
		if (!history.ArgsExact) {
			return dropOf(row, offListDrop("its arguments hold an undefined before a set argument, which the history can't give back"));
		}
		if (inputs.lineOf(row.EntityId) === undefined) {
			return drop("off-list", `its entity "${row.EntityId}" is not in the restored tree`);
		}
		if (row.State === "stopping") {
			return drop("off-list", "the runtime had stopped it");
		}
		if (row.State !== "queued" && row.State !== "regaining" && row.State !== "holding" && row.State !== "open") {
			return drop("off-list", "the row says nothing of what it was doing");
		}
		if (row.State === "queued" && history.Entries.length > 0) {
			return drop("off-list", "a queued action's history holds entries");
		}
		let wait: string | undefined;
		if (row.State === "holding" || row.State === "open") {
			const off = offList(history, inputs.isIdempotent);
			if ("reason" in off) {
				return dropOf(row, off);
			}
			wait = off.caught;
		}
		return {
			fn,
			history,
			wait
		};
	});

	const onEntity = new Map<string, ISnapshotInFlightEntry[]>();
	for (const row of inputs.rows) {
		const rows = onEntity.get(row.EntityId) ?? [];
		rows.push(row);
		onEntity.set(row.EntityId, rows);
	}
	const placeOf = (row: ISnapshotInFlightEntry): number => row.Place ?? 0;

	const plans = inputs.rows.map((row, at): IPlan => {
		const mine = own[at]!;
		if ("kind" in mine) {
			return mine;
		}
		const { fn, history } = mine;
		const drop = (reason: IDropReason, detail: string): IPlan =>
			dropOf(row, {
				reason,
				detail
			});
		const rows = onEntity.get(row.EntityId)!;
		const unlisted = unlistedOf(rows, histories);
		if (unlisted !== "none") {
			return drop(
				"unlisted",
				`work the snapshot's rows don't list and can't name ${unlisted === "holding" ? "holds its entity" : "stands in its entity's line"}, and nothing resumes beside it`
			);
		}
		const near = unlistedNear(rows, histories);
		if (near !== null) {
			return drop("unlisted", near);
		}
		const deliveries = deliveriesIn(history)!;
		const resourceWork = resourceWorkOf(deliveries);
		const holding = rows.find((other) => other.State === "holding");
		const holders =
			holding !== undefined
				? [
						holding
					]
				: rows.filter((other) => other.State === "stopping");
		switch (row.State) {
			case "holding":
				return {
					kind: "replay",
					row,
					fn,
					history,
					state: "holding",
					wait: mine.wait!,
					resourceWork
				};
			case "open": {
				const replayedHolder = holding !== undefined && !("kind" in own[inputs.rows.indexOf(holding)]!) ? holding : undefined;
				if (replayedHolder !== undefined) {
					return {
						kind: "behind",
						row,
						on: [
							replayedHolder
						],
						ifResumed: `its entity's holder ${nameOf(replayedHolder)} is resumed, and only one action per entity is replayed`,
						ifNot: `its entity's holder ${nameOf(replayedHolder)} was the one action on it planned for replay, and did not resume`
					};
				}
				return {
					kind: "replay",
					row,
					fn,
					history,
					state: "open",
					wait: mine.wait!,
					resourceWork
				};
			}
			case "queued": {
				const ahead = deliveries.find((delivery) => delivery.EntityId === row.EntityId && delivery.At !== "open");
				if (ahead !== undefined) {
					return drop(
						"behind",
						`a delivery of the resource "${ahead.Key}" on "${ahead.OwnerId}" ${ahead.At === "holding" ? "holds its entity" : "stands in its entity's line"}, and it could be put back ahead of it`
					);
				}
				if (holders.length === 0) {
					return drop("behind", "nothing holds its entity, and a line is put back only behind its replayed holder");
				}
				const before = rows
					.filter((other) => (other.State === "queued" || other.State === "regaining") && placeOf(other) < placeOf(row))
					.sort((a, b) => placeOf(a) - placeOf(b));
				return {
					kind: "queued",
					row,
					fn,
					history,
					on: [
						...holders,
						...before
					],
					waits: "it waits in its entity's line behind",
					resourceWork
				};
			}
			default:
				return drop("off-list", "it waits in its entity's line for its hold back, and replaying a regain is not built");
		}
	});

	const replayed: (readonly string[] | undefined)[] = [];
	return plans.map((plan) => {
		if (plan.kind !== "replay") {
			return plan;
		}
		const watched = inputs.watched();
		if (watched !== null) {
			return dropOf(plan.row, {
				reason: "watched",
				detail: `a reactive scope has read ${watched}, and would see the replay`
			});
		}
		const line = inputs.lineOf(plan.row.EntityId);
		if (replayed.some((earlier) => related(earlier, line))) {
			return dropOf(plan.row, {
				reason: "off-list",
				detail: "a replay is planned ahead of it, in row order, on its entity, an ancestor or a descendant"
			});
		}
		replayed.push(line);
		return plan;
	});
}
