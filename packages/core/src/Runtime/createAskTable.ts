import type { IAskEntry } from "../Types/IAskEntry";
import type { IAskId } from "../Types/IAskId";
import type { IDiagEmitter } from "../Types/IRuntimeEvent";
import type { IJournal } from "./createJournal";
import { host } from "../Solid/host";
import { consoleDiag } from "../Types/IRuntimeEvent";
import { bumpLater } from "./arrivals";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/asks": IAskTable;
	}
}

export type IAskRowState = "pending";

export interface IAskRow {
	AskId: string;
	OwnerId: string;
	State: IAskRowState;
}

export type IAskAbandonReason = "disposed" | "cancelled";

export interface IAskTable {
	/** Opens the ask and answers with its wait, which settles with the answer, or `undefined` when it ends unanswered. */
	open(askId: string, ownerId: string, request: unknown): Promise<unknown>;
	answer(askId: string, value: unknown): void;
	abandon(askId: string, reason: IAskAbandonReason): void;
	ownerOf(askId: string): string | undefined;
	/** The pending asks whose owners are at or below `ownerId`, in opening order. Tracked. */
	under(ownerId: string): readonly IAskEntry[];
}

export interface IAskTableDeps {
	onDispose: (callback: (id: string) => void) => void;
	journal: IJournal;
	// Read tracked, so a listing re-runs when an owner moves.
	pathOf: (id: string) => readonly string[] | undefined;
	report?: IDiagEmitter;
}

interface IAskCell {
	row: IAskRow;
	entry: IAskEntry;
	resolve: (value: unknown) => void;
}

export function createAskTable(deps: IAskTableDeps): IAskTable {
	const cells = new Map<string, IAskCell>();
	const byOwner = new Map<string, Set<string>>();
	const listing = host.createVersion();
	const { journal } = deps;
	const report = deps.report ?? consoleDiag;

	function emit(askId: string, prev: IAskRow | null, value: IAskRow | null): void {
		if (journal.wants("table")) {
			journal.append({
				T: performance.now(),
				Kind: "table",
				Table: "asks",
				AskId: askId,
				Prev: prev
					? {
							...prev
						}
					: null,
				Value: value
					? {
							...value
						}
					: null
			});
		}
	}

	function drop(cell: IAskCell): void {
		const { AskId, OwnerId } = cell.row;
		cells.delete(AskId);
		const owned = byOwner.get(OwnerId);
		owned?.delete(AskId);
		if (owned?.size === 0) {
			byOwner.delete(OwnerId);
		}
		bumpLater(listing, report);
		emit(AskId, cell.row, null);
	}

	// The cell holds its resolver before the open's record goes out, so a tap that answers on that
	// record finds the wait already there.
	function open(askId: string, ownerId: string, request: unknown): Promise<unknown> {
		const row: IAskRow = {
			AskId: askId,
			OwnerId: ownerId,
			State: "pending"
		};
		let resolve!: (value: unknown) => void;
		const parked = new Promise<unknown>((r) => {
			resolve = r;
		});
		cells.set(askId, {
			row,
			entry: Object.freeze({
				Id: askId as IAskId<unknown>,
				OwnerId: ownerId,
				Request: request
			}),
			resolve
		});
		const owned = byOwner.get(ownerId);
		if (owned) {
			owned.add(askId);
		} else {
			byOwner.set(
				ownerId,
				new Set([
					askId
				])
			);
		}
		bumpLater(listing, report);
		emit(askId, null, row);
		return parked;
	}

	function answerAsk(askId: string, value: unknown): void {
		const cell = cells.get(askId);
		if (!cell) {
			return;
		}
		drop(cell);
		if (journal.wants("ask:answer")) {
			journal.append({
				T: performance.now(),
				Kind: "ask:answer",
				AskId: askId,
				OwnerId: cell.row.OwnerId
			});
		}
		cell.resolve(value);
	}

	function abandon(askId: string, reason: IAskAbandonReason): void {
		const cell = cells.get(askId);
		if (!cell) {
			return;
		}
		drop(cell);
		if (journal.wants("ask:abandon")) {
			journal.append({
				T: performance.now(),
				Kind: "ask:abandon",
				AskId: askId,
				OwnerId: cell.row.OwnerId,
				Reason: reason
			});
		}
		cell.resolve(undefined);
	}

	function under(ownerId: string): readonly IAskEntry[] {
		listing.track();
		const found: IAskEntry[] = [];
		for (const cell of cells.values()) {
			if (deps.pathOf(cell.row.OwnerId)?.includes(ownerId)) {
				found.push(cell.entry);
			}
		}
		return Object.freeze(found);
	}

	deps.onDispose((ownerId) => {
		const owned = byOwner.get(ownerId);
		if (!owned) {
			return;
		}
		for (const askId of [
			...owned
		]) {
			abandon(askId, "disposed");
		}
	});

	return {
		open,
		answer: answerAsk,
		abandon,
		ownerOf: (askId) => cells.get(askId)?.row.OwnerId,
		under
	};
}
