import type { IDataSourceValue, ITreeDataSourceKey } from "../Registries/IDataSourceRegistry";
import type { IEntity } from "../Types/IEntity";
import type { IReadGenerator } from "../Types/ISelector";

export interface IGetDataPathResult<V> {
	value: V | undefined;
	ancestors: string[];
}

export function* getDataPath<K extends ITreeDataSourceKey>(from: IEntity, key: K): IReadGenerator<IGetDataPathResult<IDataSourceValue<K>>> {
	const result = yield {
		Type: "getDataPath",
		Key: key,
		FromId: from.$Id
	};
	return result;
}
