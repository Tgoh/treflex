import type { IDataSourceKey } from "../Registries/IDataSourceRegistry";
import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";
import type { IEntity } from "../Types/IEntity";

export interface IUnregisterDataSourceEffect extends IEffect {
	Type: "unregisterDataSource";
	Key: string;
	OwnerId: string;
}

export function* unregisterDataSource<K extends IDataSourceKey>(owner: IEntity, key: K): IActionGenerator {
	yield {
		Type: "unregisterDataSource",
		Key: key,
		OwnerId: owner.$Id
	};
}
