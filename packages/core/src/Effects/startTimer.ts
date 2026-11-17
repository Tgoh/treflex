import type { ITimerKey, ITimerPayloadOf } from "../Registries/ITimerRegistry";
import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";
import type { IEntity } from "../Types/IEntity";
import type { IReceiver } from "../Types/IReceiver";

export interface IStartTimerEffect extends IEffect {
	Type: "startTimer";
	Id: string;
	Key: string;
	ReceiverId: string;
	IntervalMs: number;
	Payload: Record<string, unknown> | null;
}

export function* startTimer<T extends IEntity, K extends ITimerKey>(
	entity: T,
	key: K,
	receiver: IReceiver<T, K>,
	intervalMs: number,
	...args: keyof ITimerPayloadOf<K> extends never
		? []
		: [
				payload: ITimerPayloadOf<K>
			]
): IActionGenerator {
	yield {
		Type: "startTimer",
		Id: entity.$Id,
		Key: key,
		ReceiverId: receiver.Id,
		IntervalMs: intervalMs,
		Payload: (args[0] as Record<string, unknown> | undefined) ?? null
	};
}
