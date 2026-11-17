import type { IMessagePayloadOf, IPublishTopic } from "../Registries/IMessageRegistry";
import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";

export interface IPublishEffect extends IEffect {
	Type: "publish";
	Data: any;
}

export function* publish<K extends IPublishTopic>(
	topic: K,
	...args: keyof IMessagePayloadOf<K> extends never
		? []
		: [
				data: IMessagePayloadOf<K>
			]
): IActionGenerator {
	yield {
		Type: "publish",
		Data: {
			Type: topic,
			...((args[0] as object) ?? {})
		}
	};
}
