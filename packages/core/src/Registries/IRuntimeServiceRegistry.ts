// Maps service key → value type stored under that key. The framework reserves
// the `runtime/*` prefix for its own internal data stores. See
// docs/reference/runtime.md#runtime-services.
//
// biome-ignore lint/suspicious/noEmptyInterface: declaration-merge target
export interface IRuntimeServiceRegistry {}

export type IRuntimeServiceKey = keyof IRuntimeServiceRegistry & string;

export type IRuntimeServiceValue<K extends IRuntimeServiceKey> = IRuntimeServiceRegistry[K];
