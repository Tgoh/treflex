import type { Component } from "solid-js";
import type { IEntity } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import { buildContextProxy } from "./buildContextProxy";
import { entityFeatureRegistry, makeUse, resolveFeatureEntry } from "./hmrRegistry";
import { OwnerContext, useOwner } from "./OwnerContext";
import { runtimeFor } from "./TreflexContext";

type Action<Type> = Type extends (state: any, ...args: infer P) => Generator<any, infer R, any>
	? (...args: P) => Promise<R | undefined>
	: never;
type Selector<Type> = Type extends (state: any) => Generator<any, infer R, any> ? () => R : never;

export type IActions<Type> = {
	[Property in keyof Type]: Action<Type[Property]>;
};
export type ISelectors<Type> = {
	[Property in keyof Type]: Selector<Type[Property]>;
};

/** What a feature's `use()` returns: its entity's state, and its actions and selectors as calls. */
export type IFeature<T, A, S> = {
	state: T;
} & IActions<A> &
	ISelectors<S>;

// An `any` body declares nothing, and the providers must reach this through
// `NoInfer<P>`: a bare `any` type argument collapses the return type first.
export type IBodyProps<P> = 0 extends 1 & P ? {} : P;

export type IProviderProps<T, P> = IBodyProps<P> & {
	state: T;
};

export interface IEntityFeature<T, A extends Record<string, Function>, S extends Record<string, Function>> {
	provider: <P extends object = {}>(
		body: Component<
			P & {
				state: T;
			}
		>
	) => Component<IProviderProps<T, NoInfer<P>>>;
	use: () => IFeature<T, A, S>;
}

export function createEntityFeature<T extends IEntity>(
	id?: string
): <A extends Record<string, Function>, S extends Record<string, Function> = {}>(actions: A, selectors?: S) => IEntityFeature<T, A, S> {
	return <A extends Record<string, Function>, S extends Record<string, Function> = {}>(
		actions: A,
		selectors?: S
	): IEntityFeature<T, A, S> => {
		const effectiveSelectors = selectors ?? ({} as S);

		const { context: Context, actionsRef, selectorsRef } = resolveFeatureEntry(entityFeatureRegistry, id, actions, effectiveSelectors);

		return {
			provider: <P extends object = {}>(
				WrappedComponent: Component<
					P & {
						state: T;
					}
				>
			): Component<IProviderProps<T, NoInfer<P>>> => {
				return (props: IProviderProps<T, NoInfer<P>>) => {
					const treflex = runtimeFor("createEntityFeature's provider");
					const outer = useOwner();
					const gateway = (treflex as Partial<IRuntimeInternal<any>>).get?.("runtime/writeGateway");
					// An entity in ComponentState, a widget's own row, passes the outer owner on: mounts are flat.
					const ownerAccessor = () => {
						const id = props.state.$Id;
						return gateway?.rootNameOf(id) === "ComponentState" ? outer?.() : id;
					};
					const context = buildContextProxy<T, A, S>(() => props.state, actionsRef, selectorsRef, treflex);

					// The cast bridges the deferred conditional in IBodyProps to the
					// body's own P: the same props at every P but any, where the
					// body accepts anything anyway.
					const bodyProps = props as unknown as P & {
						state: T;
					};
					return (
						<OwnerContext value={ownerAccessor}>
							<Context value={context}>
								<WrappedComponent {...bodyProps}></WrappedComponent>
							</Context>
						</OwnerContext>
					);
				};
			},

			use: makeUse<IFeature<T, A, S>>(Context, "createEntityFeature", id)
		};
	};
}
