import type { IJournal, IRecordKind } from "../Runtime/createJournal";
import type { IStateIdLookup } from "../Runtime/createWriteGateway";
import type { IUnlistedWork } from "../Runtime/processAction";
import type { IRecord, IRecordChange, IRecordLanding, IRecordRoot } from "../Types/IRecord";
import type { IDiagEmitter } from "../Types/IRuntimeEvent";
import type { IStretch } from "./fold";
import type { IDeliveryAt, IHistory, IHistoryEntry, ISnapshotHistory, IUnlistedAt, IUnusableHistory } from "./history";
import { actionNamed } from "../Runtime/named";
import { rawOf } from "../Runtime/viewProxy";
import { jsonEquals } from "../Utility/jsonEquals";
import { appendOther } from "./fold";
import { isResumable } from "./resumable";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/resume": IKeeper | null;
	}
}

/**
 * `true`, or `{ budget, total }`: `budget` in bytes of one action's history as JSON, and `total` in
 * bytes across the histories of one snapshot. `false` is off, as leaving it out is.
 */
export type IResumeOption =
	| boolean
	| {
			budget?: number;
			total?: number;
	  };

export interface IWithResume {
	resume?: IResumeOption | undefined;
}

export const DEFAULT_HISTORY_BUDGET = 64 * 1024;

export const DEFAULT_HISTORY_TOTAL = 512 * 1024;

export const MAX_HISTORY_ENTRIES = 10_000;

const KINDS: readonly IRecordKind[] = [
	"action:start",
	"step",
	"effect",
	"response",
	"action:end"
];

export interface IKeeper {
	/**
	 * The histories of the marked actions among `actionIds`, or undefined when none is kept. A history
	 * for which `tooDeep` is true is left out and marked.
	 */
	section(actionIds: readonly string[], tooDeep: (value: unknown) => boolean): ISnapshotHistory[] | undefined;
	/**
	 * Keeps the history of the resumed action `actionId` from now, before its start is heard, which then
	 * joins it: from the one a snapshot carried, renumbering the carried yields -1, -2, … so no live
	 * `Seq` can equal one. The history ends at the caught wait, whose next effect record takes that
	 * entry's place.
	 */
	carry(actionId: string, name: string, entityId: string, history: IHistory): void;
}

export interface IKeeperDeps {
	journal: IJournal;
	lookup: () => IStateIdLookup;
	rootNameOf: (id: string) => IRecordRoot | undefined;
	frameOpen: () => boolean;
	/** `unlistedWork` in `processAction.ts`. */
	unlisted: () => IUnlistedWork;
	emitDiag: IDiagEmitter;
}

interface IKept extends IStretch {
	readonly actionId: string;
	readonly name: string;
	readonly entityId: string;
	readonly args: unknown[];
	readonly argsExact: boolean;
	entries: IHistoryEntry[] | null;
	begun: boolean;
	unusable: IUnusableHistory["Unusable"] | null;
	readonly effects: Set<number>;
	resend: number | null;
}

function isNode(value: unknown): value is object {
	return value !== null && typeof value === "object";
}

function entityIdsIn(value: unknown): Set<string> {
	const ids = new Set<string>();
	const pending: unknown[] = [
		value
	];
	while (pending.length > 0) {
		const node = pending.pop();
		if (!isNode(node)) {
			continue;
		}
		const id = (
			node as {
				$Id?: unknown;
			}
		).$Id;
		if (typeof id === "string") {
			ids.add(id);
		}
		for (const child of Object.values(node)) {
			if (isNode(child)) {
				pending.push(child);
			}
		}
	}
	return ids;
}

function limitsOf(option: IResumeOption): {
	budget: number;
	total: number;
} {
	if (option === true) {
		return {
			budget: DEFAULT_HISTORY_BUDGET,
			total: DEFAULT_HISTORY_TOTAL
		};
	}
	const given =
		option !== null && typeof option === "object" && !Array.isArray(option)
			? (option as {
					budget?: unknown;
					total?: unknown;
				})
			: null;
	const bytes = (value: unknown, fallback: number): number | null =>
		value === undefined ? fallback : typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
	const budget = given === null ? null : bytes(given.budget, DEFAULT_HISTORY_BUDGET);
	const total = given === null ? null : bytes(given.total, DEFAULT_HISTORY_TOTAL);
	if (budget === null || total === null) {
		throw new TypeError(
			"[treflex] createRuntime(): resume is true, false, or { budget, total } with each given a positive number of bytes, " +
				`not ${typeof option === "object" ? JSON.stringify(option) : String(option)}.`
		);
	}
	return {
		budget,
		total
	};
}

function byteLength(json: string): number {
	return new TextEncoder().encode(json).byteLength;
}

/** Keeps the history of every in-flight `resumable` action, tapping the records from construction. */
export function createKeeper(option: IResumeOption, deps: IKeeperDeps): IKeeper {
	const { budget, total } = limitsOf(option);
	const kept = new Map<string, IKept>();
	const byEffect = new Map<number, IKept>();
	// An effect's Seq until a microtask after its record: a response heard meanwhile came in the same turn.
	const sameTurn = new Set<number>();

	const reported = new Set<string>();

	function overBudget(entry: IKept, passed: string, limit: "budget" | "total" | "entries"): void {
		entry.entries = null;
		entry.unusable = "over-budget";
		if (reported.has(entry.name)) {
			return;
		}
		reported.add(entry.name);
		deps.emitDiag({
			severity: "warn",
			code: "resume/over-budget",
			message:
				`[treflex] resume: the history of "${entry.name}" on "${entry.entityId}" passed ${passed}, so it is no longer kept, ` +
				`and a restore drops this run with over-budget. Raise resume's budget or total, or keep less on the entity while it runs.`,
			data: {
				name: entry.name,
				actionId: entry.actionId,
				entityId: entry.entityId,
				limit
			}
		});
	}

	function counted(entry: IKept): void {
		if (entry.entries !== null && entry.entries.length > MAX_HISTORY_ENTRIES) {
			overBudget(entry, `${MAX_HISTORY_ENTRIES} entries`, "entries");
		}
	}

	function own(entry: IKept, item: IHistoryEntry): void {
		if (entry.entries === null) {
			return;
		}
		entry.begun = true;
		entry.entries.push(item);
		entry.places?.clear();
		counted(entry);
	}

	// Whether a change was in the entity is decided as the tree stood when it was made: from the lookup
	// after the step, walked back through the step's own moves, each change counting the entities it
	// took out of a place in the entity (`Prev`) and the ones it put there (`Value`).
	function others(actionId: string, changes: readonly IRecordChange[]): void {
		const takers: IKept[] = [];
		for (const entry of kept.values()) {
			if (entry.actionId !== actionId && entry.begun && entry.entries !== null) {
				takers.push(entry);
			}
		}
		if (takers.length === 0) {
			return;
		}
		const cells = rawOf(deps.lookup());
		const moves = changes.some((change) => isNode(change.Prev) || isNode(change.Value))
			? changes.map((change) => ({
					out: entityIdsIn(change.Prev),
					in: entityIdsIn(change.Value)
				}))
			: null;
		for (const entry of takers) {
			const places = new Map<string, number>();
			const inside = (id: string): boolean => {
				const counted = places.get(id);
				if (counted !== undefined) {
					return counted > 0;
				}
				return cells[id]?.path.includes(entry.entityId) === true && deps.rootNameOf(id) === "AppState";
			};
			const keep: boolean[] = [];
			for (let at = changes.length - 1; at >= 0; at--) {
				const landing = changes[at]!.Landing;
				keep[at] = landing !== undefined && inside(landing.EntityId);
				if (!keep[at] || moves === null) {
					continue;
				}
				const move = moves[at]!;
				for (const id of move.in) {
					places.set(id, (places.get(id) ?? (inside(id) ? 1 : 0)) - 1);
				}
				for (const id of move.out) {
					places.set(id, (places.get(id) ?? (inside(id) ? 1 : 0)) + 1);
				}
			}
			for (let at = 0; at < changes.length; at++) {
				if (
					keep[at] &&
					entry.entries !== null &&
					appendOther(
						entry.entries,
						changes[at] as IRecordChange & {
							Landing: IRecordLanding;
						},
						entry
					)
				) {
					counted(entry);
				}
			}
		}
	}

	function adopt(entry: IKept, history: IHistory): void {
		const renumbered = new Map<number, number>();
		const entries = history.Entries.map((carried): IHistoryEntry => {
			if (carried.Kind === "effect") {
				const seq = -(renumbered.size + 1);
				renumbered.set(carried.Seq, seq);
				return {
					...carried,
					Seq: seq
				};
			}
			if (carried.Kind === "response") {
				return {
					...carried,
					ForSeq: renumbered.get(carried.ForSeq) ?? 0
				};
			}
			return carried;
		});
		entry.entries = entries;
		entry.places = null;
		entry.begun = entries.some((carried) => carried.Kind !== "other");
		let last: number | null = null;
		entries.forEach((carried, at) => {
			if (carried.Kind === "effect") {
				last = at;
			}
		});
		entry.resend = last;
		counted(entry);
	}

	function fresh(actionId: string, name: string, entityId: string, args: unknown[]): IKept {
		return {
			actionId,
			name,
			entityId,
			args,
			argsExact: !args.includes(undefined),
			entries: [],
			places: new Map(),
			begun: false,
			unusable: null,
			effects: new Set(),
			resend: null
		};
	}

	function hear(record: IRecord): void {
		switch (record.Kind) {
			case "action:start": {
				if (
					record.Root !== "AppState" ||
					record.Name === null ||
					record.Receiver !== undefined ||
					record.Origin !== undefined ||
					!isResumable(actionNamed(record.Name))
				) {
					return;
				}
				if (!kept.has(record.ActionId)) {
					kept.set(record.ActionId, fresh(record.ActionId, record.Name, record.EntityId, record.Args));
				}
				return;
			}
			case "action:end": {
				const entry = kept.get(record.ActionId);
				if (entry) {
					kept.delete(record.ActionId);
					for (const seq of entry.effects) {
						byEffect.delete(seq);
					}
				}
				return;
			}
			case "effect": {
				const entry = kept.get(record.ActionId);
				if (entry) {
					entry.effects.add(record.Seq);
					byEffect.set(record.Seq, entry);
					const seq = record.Seq;
					sameTurn.add(seq);
					queueMicrotask(() => sameTurn.delete(seq));
					const resent = entry.resend === null ? undefined : entry.entries?.[entry.resend];
					entry.resend = null;
					if (resent?.Kind === "effect" && jsonEquals(resent.Descriptor, record.Descriptor)) {
						resent.Seq = record.Seq;
						return;
					}
					own(entry, {
						Kind: "effect",
						Seq: record.Seq,
						Descriptor: record.Descriptor
					});
				}
				return;
			}
			case "response": {
				const entry = byEffect.get(record.ForSeq);
				if (entry) {
					byEffect.delete(record.ForSeq);
					entry.effects.delete(record.ForSeq);
					const sync = sameTurn.has(record.ForSeq)
						? {
								Sync: true as const
							}
						: {};
					own(
						entry,
						"Error" in record
							? {
									Kind: "response",
									ForSeq: record.ForSeq,
									Error: record.Error,
									...sync
								}
							: "Value" in record
								? {
										Kind: "response",
										ForSeq: record.ForSeq,
										Value: record.Value,
										...sync
									}
								: {
										Kind: "response",
										ForSeq: record.ForSeq,
										...sync
									}
					);
				}
				return;
			}
			case "step": {
				const entry = kept.get(record.ActionId);
				if (entry) {
					own(entry, {
						Kind: "step",
						Changes: record.Changes,
						...(record.InFlightAnswers === undefined
							? {}
							: {
									InFlightAnswers: record.InFlightAnswers
								}),
						...(record.ExternalAnswers === undefined
							? {}
							: {
									ExternalAnswers: record.ExternalAnswers
								})
					});
				}
				others(record.ActionId, record.Changes);
				return;
			}
		}
	}

	deps.journal.tap(
		(record) => {
			if (kept.size === 0 && record.Kind !== "action:start") {
				return;
			}
			try {
				hear(record);
			} catch (error) {
				for (const entry of kept.values()) {
					entry.entries = null;
					entry.unusable = "not-whole";
				}
				throw error;
			}
		},
		KINDS,
		true
	);

	return {
		section(actionIds, tooDeep) {
			if (!actionIds.some((actionId) => kept.has(actionId))) {
				return undefined;
			}
			const midStep = deps.frameOpen();
			const work = deps.unlisted();
			const cells = work.unnamed.size === 0 && work.deliveries.length === 0 ? null : rawOf(deps.lookup());
			const near = (entityId: string, id: string): boolean => {
				if (cells === null || id === entityId) {
					return false;
				}
				return cells[entityId]?.path.includes(id) === true || cells[id]?.path.includes(entityId) === true;
			};
			const lineageOf = (entityId: string): IUnlistedAt[] => {
				const lineage: IUnlistedAt[] = [];
				for (const [id, unlisted] of work.unnamed) {
					if (near(entityId, id)) {
						lineage.push({
							EntityId: id,
							Unlisted: unlisted
						});
					}
				}
				return lineage;
			};
			const deliveriesOf = (entityId: string): IDeliveryAt[] =>
				work.deliveries
					.filter((delivery) => delivery.EntityId === entityId || near(entityId, delivery.EntityId))
					.map((delivery) => ({
						...delivery
					}));
			const written: {
				readonly entry: IKept;
				readonly marks: Pick<IUnusableHistory, "ActionId" | "Unlisted" | "UnlistedLineage" | "Deliveries">;
				history: IHistory | null;
				readonly size: number;
			}[] = [];
			for (const actionId of actionIds) {
				const entry = kept.get(actionId);
				if (!entry) {
					continue;
				}
				const marks: Pick<IUnusableHistory, "ActionId" | "Unlisted" | "UnlistedLineage" | "Deliveries"> = {
					ActionId: actionId,
					Unlisted: work.unnamed.get(entry.entityId) ?? "none",
					UnlistedLineage: lineageOf(entry.entityId),
					Deliveries: deliveriesOf(entry.entityId)
				};
				if (entry.entries === null || midStep) {
					written.push({
						entry,
						marks,
						history: null,
						size: 0
					});
					continue;
				}
				const history: IHistory = {
					ActionId: actionId,
					Args: entry.args,
					ArgsExact: entry.argsExact,
					Entries: entry.entries,
					Unlisted: marks.Unlisted,
					UnlistedLineage: marks.UnlistedLineage,
					Deliveries: marks.Deliveries
				};
				let size = 0;
				if (
					tooDeep([
						history
					])
				) {
					entry.entries = null;
					entry.unusable = "too-deep";
				} else {
					size = byteLength(JSON.stringify(history));
					if (size > budget) {
						overBudget(entry, `its budget of ${budget} bytes at ${size}`, "budget");
					}
				}
				written.push({
					entry,
					marks,
					history: entry.entries === null ? null : history,
					size
				});
			}
			let sum = 0;
			for (const item of written) {
				sum += item.history === null ? 0 : item.size;
			}
			// Equal sizes leave the later row out first, keeping the one the planner meets first.
			const largest = written
				.map((item, at) => ({
					item,
					at
				}))
				.filter(({ item }) => item.history !== null)
				.sort((a, b) => b.item.size - a.item.size || b.at - a.at);
			for (const { item } of largest) {
				if (sum <= total) {
					break;
				}
				sum -= item.size;
				overBudget(item.entry, `its share of the snapshot's total of ${total} bytes, being the largest left at ${item.size}`, "total");
				item.history = null;
			}
			const histories = written.map(
				({ entry, marks, history }): ISnapshotHistory =>
					history ?? {
						...marks,
						Unusable: entry.unusable ?? "not-whole"
					}
			);
			return histories.length === 0 ? undefined : histories;
		},
		carry(actionId, name, entityId, history) {
			const entry = fresh(actionId, name, entityId, history.Args);
			if (history.Entries.length > 0) {
				adopt(entry, history);
			}
			kept.set(actionId, entry);
		}
	};
}
