import type { ITimerKey } from "../Registries/ITimerRegistry";
import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";
import type { IEntity } from "../Types/IEntity";

export interface IStopTimerEffect extends IEffect {
	Type: "stopTimer";
	Id: string;
	Key: string;
}

export function* stopTimer<T extends IEntity, K extends ITimerKey>(entity: T, key: K): IActionGenerator {
	yield {
		Type: "stopTimer",
		Id: entity.$Id,
		Key: key
	};
}
