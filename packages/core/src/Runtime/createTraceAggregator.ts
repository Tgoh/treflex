import type { IActionTrace, ITraceEntry } from "../Types/IActionTrace";
import type { IEventBus } from "./createEventBus";

type IObservable = {
	on: IEventBus["on"];
};

function traceName(name: string | null): string {
	return name ?? "(anonymous)";
}

export function createTraceAggregator(source: IObservable, onTrace: (trace: IActionTrace) => void): () => void {
	const inFlight = new Map<string, IActionTrace>();
	const openEffects = new Map<
		number,
		{
			actionId: string;
			startedAtT: number;
			entry: Extract<
				ITraceEntry,
				{
					type: "effect";
				}
			>;
		}
	>();

	const off = source.on("record", (record, live) => {
		switch (record.Kind) {
			case "action:start": {
				inFlight.set(record.ActionId, {
					actionId: record.ActionId,
					action: traceName(record.Name),
					args: [
						...record.Args
					],
					entityId: record.EntityId,
					entries: [],
					duration: 0
				});
				break;
			}
			case "effect": {
				const trace = inFlight.get(record.ActionId);
				if (!trace) return;
				openEffects.set(record.Seq, {
					actionId: record.ActionId,
					startedAtT: record.T,
					entry: {
						type: "effect",
						branchId: record.BranchId,
						effect: record.Descriptor as Record<string, unknown>,
						duration: 0
					}
				});
				break;
			}
			case "response": {
				const open = openEffects.get(record.ForSeq);
				if (!open) return;
				openEffects.delete(record.ForSeq);
				const trace = inFlight.get(open.actionId);
				if (!trace) return;
				const entry = open.entry;
				entry.duration = live?.duration ?? 0;
				if ("Error" in record) {
					// A redacted failure's extras carry no error, and undefined would read as success.
					entry.error = live !== undefined && "error" in live ? live.error : record.Error;
				} else {
					entry.result = live?.result;
				}
				trace.entries.push(entry);
				break;
			}
			case "step": {
				const trace = inFlight.get(record.ActionId);
				if (!trace) return;
				trace.entries.push({
					type: "step",
					branchId: record.BranchId,
					changes: [
						...record.Changes
					],
					...(record.InFlightAnswers === undefined
						? {}
						: {
								inFlightAnswers: record.InFlightAnswers
							})
				});
				break;
			}
			case "action:end": {
				const trace = inFlight.get(record.ActionId);
				if (!trace) return;
				inFlight.delete(record.ActionId);
				for (const [seq, open] of openEffects) {
					if (open.actionId === record.ActionId) {
						openEffects.delete(seq);
						// A silent cancel journals no response, so this is the
						// only entry that shows which effect was in flight.
						open.entry.aborted = true;
						open.entry.duration = record.T - open.startedAtT;
						trace.entries.push(open.entry);
					}
				}
				trace.duration = live?.duration ?? 0;
				if (record.Status === "cancelled") {
					trace.cancelled = true;
				} else if (record.Status === "dropped") {
					trace.dropped = true;
				} else if (record.Status === "errored") {
					trace.error = live?.error;
				}
				onTrace(trace);
				break;
			}
			default:
				break;
		}
	});

	return () => {
		off();
		inFlight.clear();
		openEffects.clear();
	};
}
