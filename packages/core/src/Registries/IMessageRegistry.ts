import type { ISerializedThrow } from "../Utility/serializeThrow";

export interface IMessageRegistry {
	/**
	 * Framework-reserved: the runtime delivers it to the nearest error boundary above an entity whose action failed.
	 * An error boundary passes the failure on up by rethrowing this payload. See docs/reference/failure.md#error-boundaries.
	 */
	"Action/Error": {
		/** The throw, serialized to data. */
		Error: ISerializedThrow;
		/** The durable name of the action that failed, or null. */
		Name: string | null;
		/** The function's own name, for display, or null. An error boundary's own failure carries its receiver's id. */
		Label: string | null;
		/** On an error boundary's own failure, the failure it was handling. */
		Cause?: ISerializedThrow;
	};
}

export type IPublishTopic = keyof IMessageRegistry & string;

export type IMessagePayloadOf<K extends IPublishTopic> = IMessageRegistry[K];
