import type { IDataSourceKey, IDataSourceValue } from "../Registries/IDataSourceRegistry";
import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";
import type { IEntity } from "../Types/IEntity";

export interface IRegisterDataSourceEffect extends IEffect {
	Type: "registerDataSource";
	Key: string;
	OwnerId: string;
	DataId: string;
}

export function registerDataSource<K extends IDataSourceKey>(entity: IEntity & IDataSourceValue<K>, key: K): IActionGenerator;
export function registerDataSource<K extends IDataSourceKey>(owner: IEntity, key: K, data: IEntity & IDataSourceValue<K>): IActionGenerator;
export function* registerDataSource<K extends IDataSourceKey>(owner: IEntity, key: K, data?: IEntity): IActionGenerator {
	yield {
		Type: "registerDataSource",
		Key: key,
		OwnerId: owner.$Id,
		DataId: (data ?? owner).$Id
	};
}
