import type { IRecord, IRecordExtras, IRecordTapListener } from "../Types/IRecord";
import type { IRuntimeEventListener, IRuntimeEventName, IRuntimeEventOf } from "../Types/IRuntimeEvent";
import type { IRecordKind } from "./createJournal";
import { callbackThrew, consoleDiag, type IDiagEmitter } from "../Types/IRuntimeEvent";

export interface IRecordTapOptions<K extends IRecordKind> {
	/** The kinds this tap hears. */
	kinds: readonly K[];
}

export interface IEventBus {
	on<K extends IRecordKind>(
		event: "record",
		handler: (
			record: Extract<
				IRecord,
				{
					Kind: K;
				}
			>,
			live?: IRecordExtras
		) => void,
		options: IRecordTapOptions<K>
	): () => void;
	on(event: "record", handler: IRecordTapListener): () => void;
	on<E extends IRuntimeEventName>(event: E, handler: IRuntimeEventListener<E>): () => void;
}

export interface IEventBusInternal extends IEventBus {
	emit<E extends IRuntimeEventName>(event: E, data: IRuntimeEventOf<E>): void;
}

/** `report` hears a subscriber's throw, which stops only that subscriber. A diag subscriber's throw goes to the console alone. */
export function createEventBus(
	tapRecords?: (listener: IRecordTapListener, kinds?: readonly IRecordKind[]) => () => void,
	report: IDiagEmitter = consoleDiag
): IEventBusInternal {
	const listeners = new Map<IRuntimeEventName, IRuntimeEventListener<any>[]>();

	function on(event: any, handler: any, options?: IRecordTapOptions<IRecordKind>): () => void {
		if (event === "record") {
			if (!tapRecords) {
				throw new Error(
					'[treflex] this event bus was constructed without a journal tap — "record" subscriptions need createRuntime\'s wiring.'
				);
			}
			return tapRecords(handler, options?.kinds);
		}
		let arr = listeners.get(event);
		if (!arr) {
			arr = [];
			listeners.set(event, arr);
		}
		arr.push(handler);
		return () => {
			const current = listeners.get(event);
			if (!current) return;
			const idx = current.indexOf(handler);
			if (idx < 0) return;
			const next = current.slice(0, idx).concat(current.slice(idx + 1));
			if (next.length === 0) {
				listeners.delete(event);
			} else {
				listeners.set(event, next);
			}
		};
	}

	function emit<E extends IRuntimeEventName>(event: E, data: IRuntimeEventOf<E>): void {
		const arr = listeners.get(event);
		if (arr) {
			// Snapshot before walking so subscription/unsubscription
			// during dispatch affects the next emit, not this one.
			const snapshot = arr.slice();
			for (const handler of snapshot) {
				try {
					handler(data);
				} catch (error) {
					(event === "diag" ? consoleDiag : report)(callbackThrew(`A "${event}" subscriber`, error));
				}
			}
		}
	}

	return {
		on,
		emit
	};
}
