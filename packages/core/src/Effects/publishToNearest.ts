import type { IMessagePayloadOf, IPublishTopic } from "../Registries/IMessageRegistry";
import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";
import type { IEntity } from "../Types/IEntity";

export interface IPublishToNearestEffect extends IEffect {
	Id: string;
	Type: "publishToNearest";
	Data: any;
}

export function* publishToNearest<T extends IEntity, K extends IPublishTopic>(
	entity: T,
	topic: K,
	...args: keyof IMessagePayloadOf<K> extends never
		? []
		: [
				data: IMessagePayloadOf<K>
			]
): IActionGenerator {
	yield {
		Id: entity.$Id,
		Type: "publishToNearest",
		Data: {
			Type: topic,
			...((args[0] as object) ?? {})
		}
	};
}
