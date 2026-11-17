// Maps external key → the value its provider gives. See docs/reference/derived-reads.md#outside-values.
//
// biome-ignore lint/suspicious/noEmptyInterface: declaration-merge target
export interface IExternalRegistry {}

export type IExternalKey = keyof IExternalRegistry & string;

export type IExternalValue<K extends IExternalKey> = IExternalRegistry[K];
