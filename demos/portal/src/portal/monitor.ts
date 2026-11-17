import type { IRuntime } from "treflex";
import type { IEntityLabel, IPortal } from "./Portal";
import { wallClock } from "./clock";
import { describeStep, labelIndex } from "./Portal";

export type IRecordTone = "" | "ask" | "end" | "stop" | "step";

export interface IRecordLine {
	Seq: number;
	At: number;
	What: string;
	Detail: string;
	EntityId: string;
	Tone: IRecordTone;
}

export interface IResolvedLine extends IRecordLine, IEntityLabel {}

export interface IMonitor {
	lines(): IResolvedLine[];
	ticks(): number;
	subscribe(listener: () => void): () => void;
}

const UNKNOWN: IEntityLabel = {
	Label: "entity",
	Lane: "portal",
	LaneName: "Portal"
};

function errorText(error: unknown): string {
	if (error && typeof error === "object" && "Message" in error && typeof error.Message === "string") return error.Message;
	return "error";
}

interface ITracked {
	Name: string;
	EntityId: string;
	Effects: number[];
	Tick: boolean;
}

export interface IMonitorOptions {
	receivers?: readonly string[];
	cap?: number;
	now?: () => number;
}

export function createMonitor(runtime: IRuntime<IPortal>, { receivers = [], cap = 80, now = wallClock }: IMonitorOptions = {}): IMonitor {
	const receiverNames = new Set(receivers);
	const deliveries = new Map<
		string,
		{
			Topic: string;
			Tick: boolean;
		}[]
	>();
	const lines: IRecordLine[] = [];
	const actions = new Map<string, ITracked>();
	const effects = new Map<number, string>();
	const labels = new Map<string, IEntityLabel>();
	const listeners = new Set<() => void>();
	let ticks = 0;
	let queued = false;

	const notify = (): void => {
		if (queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			for (const listener of listeners) listener();
		});
	};

	const push = (line: Omit<IRecordLine, "At">): void => {
		lines.push({
			...line,
			At: now()
		});
		if (lines.length > cap) lines.splice(0, lines.length - cap);
		notify();
	};

	const learn = (): void => {
		for (const [id, value] of labelIndex(runtime.state)) labels.set(id, value);
	};

	runtime.on("record", (record) => {
		switch (record.Kind) {
			case "action:start": {
				if (!labels.has(record.EntityId)) learn();
				const delivery =
					record.Receiver !== undefined && receiverNames.has(record.Receiver) ? deliveries.get(record.EntityId)?.shift() : undefined;
				actions.set(record.ActionId, {
					Name: delivery?.Topic ?? record.Name ?? record.Label ?? "action",
					EntityId: record.EntityId,
					Effects: [],
					Tick: delivery?.Tick ?? false
				});
				return;
			}
			case "step": {
				const action = actions.get(record.ActionId);
				if (!action || record.Changes.length === 0) return;
				if (action.Tick) {
					ticks++;
					notify();
					return;
				}
				const detail = describeStep(runtime.state, action.EntityId, record.Changes);
				push({
					Seq: record.Seq,
					What: action.Name,
					Detail: detail ?? `${record.Changes.length} ${record.Changes.length === 1 ? "write" : "writes"}`,
					EntityId: action.EntityId,
					Tone: detail ? "step" : ""
				});
				return;
			}
			case "effect": {
				const action = actions.get(record.ActionId);
				if (!action) return;
				action.Effects.push(record.Seq);
				effects.set(record.Seq, record.ActionId);
				if (record.Type === "ask") {
					const request = (
						record.Descriptor as
							| {
									Request?: {
										Title?: unknown;
									};
							  }
							| undefined
					)?.Request;
					push({
						Seq: record.Seq,
						What: action.Name,
						Detail: `ask open${typeof request?.Title === "string" ? ` · ${request.Title}` : ""}`,
						EntityId: action.EntityId,
						Tone: "ask"
					});
				}
				return;
			}
			case "response": {
				const actionId = effects.get(record.ForSeq);
				effects.delete(record.ForSeq);
				const action = actionId === undefined ? undefined : actions.get(actionId);
				if (!action || !("Error" in record)) return;
				push({
					Seq: record.Seq,
					What: action.Name,
					Detail: `failed · ${errorText(record.Error)}`,
					EntityId: action.EntityId,
					Tone: "stop"
				});
				return;
			}
			case "action:end": {
				const action = actions.get(record.ActionId);
				actions.delete(record.ActionId);
				if (!action) return;
				for (const seq of action.Effects) effects.delete(seq);
				if (action.Tick || record.Status === "dropped" || (record.Status === "completed" && action.Effects.length === 0)) return;
				push({
					Seq: record.Seq,
					What: action.Name,
					Detail: `ended · ${record.Status}`,
					EntityId: action.EntityId,
					Tone: record.Status === "completed" ? "end" : "stop"
				});
				return;
			}
			case "message:deliver": {
				const self = record.RecipientIds.length === 1 && record.RecipientIds[0] === record.PublisherId;
				for (const id of record.RecipientIds) {
					const queue = deliveries.get(id) ?? [];
					queue.push({
						Topic: record.Topic,
						Tick: self
					});
					deliveries.set(id, queue.slice(-20));
				}
				if (self || record.RecipientIds.length === 0) return;
				push({
					Seq: record.Seq,
					What: record.Topic,
					Detail: `to ${record.RecipientIds.length}`,
					EntityId: record.PublisherId,
					Tone: ""
				});
				return;
			}
			case "ask:answer":
				push({
					Seq: record.Seq,
					What: "ask",
					Detail: "answered",
					EntityId: record.OwnerId,
					Tone: "ask"
				});
				return;
			case "ask:abandon":
				push({
					Seq: record.Seq,
					What: "ask",
					Detail: `abandoned · ${record.Reason}`,
					EntityId: record.OwnerId,
					Tone: "stop"
				});
				return;
			case "entity:dispose":
				deliveries.delete(record.EntityId);
				push({
					Seq: record.Seq,
					What: "dispose",
					Detail: "left the tree",
					EntityId: record.EntityId,
					Tone: "stop"
				});
				return;
			default:
				return;
		}
	});

	const label = (entityId: string): IEntityLabel => {
		if (!labels.has(entityId)) learn();
		return labels.get(entityId) ?? UNKNOWN;
	};

	const resolved = new WeakMap<IRecordLine, IResolvedLine>();
	const resolve = (line: IRecordLine): IResolvedLine => {
		let out = resolved.get(line);
		if (out === undefined) {
			out = {
				...line,
				...label(line.EntityId)
			};
			resolved.set(line, out);
		}
		return out;
	};

	return {
		lines: () =>
			[
				...lines
			]
				.reverse()
				.map(resolve),
		ticks: () => ticks,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
}
