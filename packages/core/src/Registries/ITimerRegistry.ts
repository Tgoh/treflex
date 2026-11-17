// Maps timer key → tick payload (the bits beyond the discriminator; the
// runtime injects `Type: K` from the key). See docs/reference/live-sources.md#timers.
//
// biome-ignore lint/suspicious/noEmptyInterface: declaration-merge target
export interface ITimerRegistry {}

export type ITimerKey = keyof ITimerRegistry & string;

export type ITimerTickOf<K extends ITimerKey> = {
	Type: K;
} & ITimerRegistry[K];

export type ITimerPayloadOf<K extends ITimerKey> = ITimerRegistry[K];
