// Maps data-source key → registered state shape. See docs/reference/lookup.md.
//
// biome-ignore lint/suspicious/noEmptyInterface: declaration-merge target
export interface IDataSourceRegistry {}

export type IDataSourceKey = keyof IDataSourceRegistry & string;

// ActivityLog is served by the built-in external source, which only getDataGlobal reaches.
export type ITreeDataSourceKey = Exclude<IDataSourceKey, "ActivityLog">;

export type IDataSourceValue<K extends IDataSourceKey> = IDataSourceRegistry[K];
