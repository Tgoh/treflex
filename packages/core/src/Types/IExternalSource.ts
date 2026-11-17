import type { IMessageContext } from "./IReceiver";

// A participant addressable by Id that lives outside runtime.state: an activity log,
// a WebSocket bridge, a worker.
export interface IExternalSource {
	readonly Id: string;

	readonly DataSourceKeys?: readonly string[];

	readonly Topics?: readonly string[];

	// Reads through the source's own Solid store so getData's memo tracks
	// it. Returns undefined for a key the source does not serve.
	getData?(key: string): unknown;

	receivePublish?(data: Record<string, unknown>, ctx: IMessageContext): void | Promise<void>;

	dispose?(): void;
}
