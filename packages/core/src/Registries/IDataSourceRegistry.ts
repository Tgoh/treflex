// Maps data-source key → registered state shape. See docs/reference/lookup.md.
//
// biome-ignore lint/suspicious/noEmptyInterface: declaration-merge target
export interface IDataSourceRegistry {}

export type IDataSourceKey = keyof IDataSourceRegistry & string;

export type IDataSourceValue<K extends IDataSourceKey> = IDataSourceRegistry[K];
