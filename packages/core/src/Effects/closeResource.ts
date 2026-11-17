import type { IResourceKey } from "../Registries/IResourceRegistry";
import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";
import type { IEntity } from "../Types/IEntity";

export interface ICloseResourceEffect extends IEffect {
	Type: "closeResource";
	Id: string;
	Key: string;
}

export function* closeResource<T extends IEntity, K extends IResourceKey>(entity: T, key: K): IActionGenerator {
	yield {
		Type: "closeResource",
		Id: entity.$Id,
		Key: key
	};
}
