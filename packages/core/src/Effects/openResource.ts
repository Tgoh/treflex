import type {
	IResourceKey,
	IResourceKeyEmits,
	IResourceMessageOf,
	IResourceMessageRuleHolds,
	IResourceParamsOf,
	IResourceRequiresResume,
	IResourceTypeEmits
} from "../Registries/IResourceRegistry";
import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";
import type { IEntity } from "../Types/IEntity";
import type { IHandleableKey, IReceiver } from "../Types/IReceiver";

export interface IOpenResourceEffect extends IEffect {
	Type: "openResource";
	Id: string;
	Key: string;
	ReceiverId: string | null;
	Params: {
		Type: string;
	} & Record<string, unknown>;
	ResumeFrom: string | null;
}

// The owner's top-level scalar fields: what a ResumeFrom cursor can name.
export type IResumeFieldOf<T> = {
	[P in keyof T]-?: T[P] extends string | number | boolean | null | undefined ? P : never;
}[keyof T] &
	string;

// A key whose Message breaks the message rule gets this in place of its
// params, so every open of it fails to compile with the rule's name.
export type IResourceParamsArg<K extends IResourceKey> =
	IResourceMessageRuleHolds<IResourceMessageOf<K>> extends true
		? IResourceParamsOf<K>
		: {
				$MessageMustBePlainObjectWithoutType: K;
			};

type IOptionsTail<T, K extends IResourceKey> =
	IResourceRequiresResume<K> extends true
		? [
				options: {
					ResumeFrom: IResumeFieldOf<T>;
				}
			]
		: [
				options?: {
					ResumeFrom?: IResumeFieldOf<T>;
				}
			];

type IWithReceiver<T extends IEntity, K extends IResourceKey> = [
	receiver: IReceiver<T, K & IHandleableKey>,
	params: IResourceParamsArg<K>,
	...IOptionsTail<T, K>
];
type IWithoutReceiver<T extends IEntity, K extends IResourceKey> = [
	params: IResourceParamsArg<K>,
	...IOptionsTail<T, K>
];

// A required element cannot follow an optional one, so the optional
// receiver of a type that never emits is two branches.
export type IOpenResourceRest<T extends IEntity, K extends IResourceKey> =
	IResourceKeyEmits<K> extends true
		? IWithReceiver<T, K>
		: IResourceTypeEmits<K> extends true
			? IWithoutReceiver<T, K>
			: IWithoutReceiver<T, K> | IWithReceiver<T, K>;

export function* openResource<T extends IEntity, K extends IResourceKey>(
	entity: T,
	key: K,
	...rest: IOpenResourceRest<T, K>
): IActionGenerator {
	const args = rest as unknown[];
	// Told apart by shape: a receiver is { Id, handle }; params carry Type.
	const first = args[0] as
		| {
				Id?: unknown;
				handle?: unknown;
		  }
		| undefined;
	const hasReceiver = typeof first?.handle === "function" && typeof first?.Id === "string";
	const receiver = hasReceiver ? (first as IReceiver) : null;
	const params = (hasReceiver ? args[1] : args[0]) as IOpenResourceEffect["Params"];
	const options = (hasReceiver ? args[2] : args[1]) as
		| {
				ResumeFrom?: string;
		  }
		| undefined;
	yield {
		Type: "openResource",
		Id: entity.$Id,
		Key: key,
		ReceiverId: receiver ? receiver.Id : null,
		Params: params,
		ResumeFrom: options?.ResumeFrom ?? null
	};
}
