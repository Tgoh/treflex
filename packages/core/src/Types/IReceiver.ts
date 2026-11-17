import type { IMessageRegistry, IPublishTopic } from "../Registries/IMessageRegistry";
import type { IReceivableResourceKey, IResourceDeliveryOf } from "../Registries/IResourceRegistry";
import type { ITimerKey, ITimerTickOf } from "../Registries/ITimerRegistry";
import type { IOpenGenerator } from "./IAction";
import type { IEntity } from "./IEntity";

declare const RECEIVER_STATE: unique symbol;

// A resource key whose Message is overridden to never takes no receiver and is
// not here.
export type IHandleableKey = IPublishTopic | ITimerKey | IReceivableResourceKey;

// Distributes over union K, so a multi-key receiver gets the union of per-key message shapes.
export type IMessageOf<K extends IHandleableKey> = K extends IPublishTopic
	? {
			Type: K;
		} & IMessageRegistry[K]
	: K extends ITimerKey
		? ITimerTickOf<K>
		: K extends IReceivableResourceKey
			? IResourceDeliveryOf<K>
			: never;

export type IPublisherRef = {
	Id: string;
};

export type IMessageContext = {
	publisher: IPublisherRef;
};

/**
 * A receiver's id, branded with the state it handles, so `$Receiver: Receiver.Id` on a value
 * is checked as `bind` is. A plain string at runtime.
 */
export type IReceiverId<T = any> = string & {
	readonly [RECEIVER_STATE]: (draft: T) => void;
};

export interface IReceiver<T extends IEntity = IEntity, K extends IHandleableKey = IHandleableKey> {
	readonly Id: IReceiverId<T>;
	/** The keys it has cases for. A bound entity hears the topics among them. */
	readonly Topics: readonly string[];
	readonly handle: (draft: T, message: IMessageOf<K>, ctx: IMessageContext) => IOpenGenerator;
}
