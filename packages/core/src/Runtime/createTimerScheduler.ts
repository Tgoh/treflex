import type { ITimerRow, ITimerTable } from "./createTimerTable";
import type { IInternalDispatch, IRuntimeStoreReader } from "./processAction";
import { resolveDiag } from "./createDiagService";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/timerSchedule": ITimerSchedule;
	}
}

export interface ITimerLoadEntry {
	row: ITimerRow;
	// Wall clock, Date.now()'s scale.
	nextDue: number | undefined;
}

export interface ITimerSchedule {
	nextDue(key: string, ownerId: string): number | undefined;
	// A restore loads through this, never the timer table's own load, which arms every row a full interval out.
	load(entries: readonly ITimerLoadEntry[]): void;
}

export interface ITimerScheduler extends ITimerSchedule {
	dispose(): void;
}

export function createTimerScheduler(deps: {
	table: ITimerTable;
	get: IRuntimeStoreReader;
	dispatch: IInternalDispatch;
	pause?: boolean | undefined;
}): ITimerScheduler {
	const { table, get } = deps;
	const paused = deps.pause === true;
	const handles = new Map<string, ReturnType<typeof setTimeout>>();
	const due = new Map<string, number>();
	const ticking = new Set<string>();
	let loading: Map<string, number> | undefined;
	let disposed = false;

	const cellKey = (key: string, ownerId: string) => `${key} ${ownerId}`;

	function disarm(key: string, ownerId: string): void {
		const cell = cellKey(key, ownerId);
		const handle = handles.get(cell);
		if (handle !== undefined) {
			clearTimeout(handle);
			handles.delete(cell);
		}
		due.delete(cell);
	}

	function arm(row: ITimerRow): void {
		if (paused || disposed) return;
		disarm(row.Key, row.OwnerId);
		const cell = cellKey(row.Key, row.OwnerId);
		const now = Date.now();
		const interval = Math.max(1, row.IntervalMs);
		const saved = loading?.get(cell);
		const dueAt = saved === undefined ? now + interval : Math.min(Math.max(saved, now + 1), now + interval);
		handles.set(
			cell,
			// Fire-time state is re-read from the table — the armed row may
			// have been replaced or removed while the handle was pending.
			setTimeout(() => fire(row.Key, row.OwnerId), dueAt - now)
		);
		due.set(cell, dueAt);
	}

	function fire(key: string, ownerId: string): void {
		const cell = cellKey(key, ownerId);
		handles.delete(cell);
		due.delete(cell);
		if (paused || disposed) return;
		const row = table.get(key, ownerId);
		if (!row) return;

		const node = get("runtime/resolveOwner")(ownerId);
		if (!node) {
			// The cascade retracts rows when their owner leaves the tree, so a
			// live miss here is a stale row from outside the tree. Retract through
			// the table API, the journal's gateway, rather than silently disarming.
			table.stop(key, ownerId);
			return;
		}

		// Deduped per (key, owner, receiver), because a timer re-arms and would re-report
		// every interval, and cleared on a successful tick so a receiver that breaks again
		// reports again. That clear is why the key carries a producer tag: this namespace
		// is shared with fanOut, whose entries must survive it.
		const diag = resolveDiag(get);
		const dedupeKey = JSON.stringify([
			"timer",
			key,
			ownerId,
			row.ReceiverId
		]);
		const handle = get("runtime/receivers").get(row.ReceiverId);
		if (!handle) {
			diag.emitOnce(dedupeKey, {
				severity: "warn",
				code: "receiver/unresolved",
				message:
					`[treflex] timer "${key}" did not tick entity "${ownerId}": its receiver "${row.ReceiverId}" resolves to no ` +
					"registered handle. Register the receiver at startup with runtime.registerReceiver(Receiver). " +
					`The timer re-arms and heals on registration.`,
				data: {
					key,
					ownerId,
					receiverId: row.ReceiverId,
					kind: "timer"
				}
			});
			arm(row);
			return;
		}
		diag.clearOnce(dedupeKey);

		const journal = get("runtime/journal");
		if (journal.wants("message:deliver")) {
			journal.append({
				T: performance.now(),
				Kind: "message:deliver",
				Topic: key,
				PublisherId: ownerId,
				RecipientIds: [
					ownerId
				]
			});
		}

		const data = {
			Type: key,
			...(row.Payload ?? {})
		};
		ticking.add(cell);
		deps
			.dispatch(
				handle,
				node.getState,
				node.setState,
				() => ownerId,
				[
					data,
					{
						publisher: {
							Id: ownerId
						}
					}
				],
				{
					onStart: () => table.get(key, ownerId) !== undefined
				}
			)
			.catch((error: unknown) => {
				if (journal.wants("receiver:error")) {
					journal.append(
						{
							T: performance.now(),
							Kind: "receiver:error",
							Topic: key,
							RecipientId: ownerId,
							PublisherId: ownerId
						},
						{
							error
						}
					);
				}
			})
			.finally(() => {
				ticking.delete(cell);
				// Fixed delay: the next interval starts when this dispatch
				// settles — and only if the row survived it (the receiver may
				// have stopped its own timer, or the owner may have disposed).
				const current = table.get(key, ownerId);
				if (current) {
					arm(current);
				}
			});
	}

	table.watch((key, ownerId, row) => {
		if (paused || disposed) return;
		if (row) {
			arm(row);
		} else {
			disarm(key, ownerId);
		}
	});

	// Sync on construction so the derive contract doesn't depend on wiring
	// order.
	for (const row of table.entries()) {
		arm(row);
	}

	return {
		nextDue(key, ownerId) {
			const cell = cellKey(key, ownerId);
			return due.get(cell) ?? (ticking.has(cell) ? Date.now() : undefined);
		},
		load(entries) {
			loading = new Map();
			for (const { row, nextDue } of entries) {
				if (nextDue !== undefined) {
					loading.set(cellKey(row.Key, row.OwnerId), nextDue);
				}
			}
			try {
				table.load(entries.map((entry) => entry.row));
			} finally {
				loading = undefined;
			}
		},
		dispose() {
			disposed = true;
			for (const handle of handles.values()) {
				clearTimeout(handle);
			}
			handles.clear();
			due.clear();
			ticking.clear();
		}
	};
}
