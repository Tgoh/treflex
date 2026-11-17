import type { IEntity } from "treflex";

declare const refOf: unique symbol;

/** What a view holds in place of a child entity: its `$Id` and nothing else. */
export interface IEntityRef<T extends IEntity = IEntity> {
	readonly $Id: string;
	// Type-only. It keeps one entity type's ref from typechecking as another's.
	readonly [refOf]?: T;
}

type IPrimitive = string | number | boolean | bigint | symbol | null | undefined;

type IViewField<V> = V extends IPrimitive
	? V
	: V extends IEntity
		? IEntityRef<V>
		: V extends readonly (infer E)[]
			? readonly IViewField<E>[]
			: {
					readonly [K in keyof V]: IViewField<V[K]>;
				};

/** A tree node's view: a read-only copy in which every child entity is an `IEntityRef`. */
export type IEntityView<T> = T extends readonly (infer E)[]
	? readonly IViewField<E>[]
	: {
			readonly [K in keyof T]: IViewField<T[K]>;
		} & (T extends IEntity
			? {
					readonly [refOf]?: T;
				}
			: unknown);

/** A selector's result as a component receives it: every entity in it is that entity's `IEntityView`. */
export type ISelected<R> = R extends IPrimitive
	? R
	: R extends IEntity
		? IEntityView<R>
		: R extends readonly (infer E)[]
			? readonly ISelected<E>[]
			: {
					readonly [K in keyof R]: ISelected<R[K]>;
				};
