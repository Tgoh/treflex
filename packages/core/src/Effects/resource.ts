import type { IResourceKey, IResourceMethodsOf } from "../Registries/IResourceRegistry";
import type { IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";
import type { IEntity } from "../Types/IEntity";

export interface IResourceMethodEffect extends IEffect {
	Type: "resource";
	Key: string;
	OwnerId: string;
	Method: string;
	Args: unknown[];
}

// Each method yields its declared result, or undefined when nothing can
// answer: no row, an unregistered type or receiver, the pause, an
// instance that retired first, or a method the type did not register.
// A type with no Methods gets a handle with no methods: a mapped type over
// `keyof never` would accept any name.
export type IResourceHandle<K extends IResourceKey> = [
	IResourceMethodsOf<K>
] extends [
	never
]
	? {}
	: IResourceHandleMethods<K>;

type IResourceHandleMethods<K extends IResourceKey> = {
	readonly [O in keyof IResourceMethodsOf<K> & string]: IResourceMethodsOf<K>[O] extends (...args: infer A) => infer R
		? (...args: A) => IActionGenerator<Awaited<R> | undefined>
		: never;
};

export function resource<K extends IResourceKey>(target: IEntity | string, key: K): IResourceHandle<K> {
	const ownerId = typeof target === "string" ? target : target.$Id;
	return new Proxy(
		{},
		{
			get(_target, method) {
				// Not a method: a handle must not read as a thenable or
				// serialise as one.
				if (typeof method !== "string" || method === "then" || method === "toJSON") {
					return undefined;
				}
				return function* (...args: unknown[]): IActionGenerator<unknown> {
					return yield {
						Type: "resource",
						Key: key,
						OwnerId: ownerId,
						Method: method,
						Args: args
					};
				};
			}
		}
	) as IResourceHandle<K>;
}
