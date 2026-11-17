import type { IDataSourceKey, IDataSourceValue } from "../Registries/IDataSourceRegistry";
import type { IEntity } from "../Types/IEntity";
import type { IReadGenerator } from "../Types/ISelector";

export function* getData<K extends IDataSourceKey>(from: IEntity, key: K): IReadGenerator<IDataSourceValue<K> | undefined> {
	const result = yield {
		Type: "getData",
		Key: key,
		FromId: from.$Id
	};
	return result;
}

export function* getDataGlobal<K extends IDataSourceKey>(key: K): IReadGenerator<IDataSourceValue<K> | undefined> {
	const result = yield {
		Type: "getDataGlobal",
		Key: key
	};
	return result;
}
