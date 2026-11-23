import type { Component } from "solid-js";
import type { IEntity } from "treflex";
import type { IBodyProps, IFeature } from "./createEntityFeature";
import { mountComponentState } from "../Hooks/useComponentState";
import { buildContextProxy } from "./buildContextProxy";
import { componentFeatureRegistry, makeUse, resolveFeatureEntry } from "./hmrRegistry";
import { useTreflexContext } from "./TreflexContext";

export interface IComponentFeature<T extends IEntity, A extends Record<string, Function>, S extends Record<string, Function>> {
	provider: <P extends object = {}>(body: Component<P>, factory: () => Omit<T, "$Id">) => Component<IBodyProps<NoInfer<P>>>;
	use: () => IFeature<T, A, S>;
}

/**
 * The component-bound sibling of `createEntityFeature`: the provider mounts an entity in
 * ComponentState from `factory`, as `useComponentState` does, and its body and the components
 * under it reach that entity's actions and selectors through `use()`.
 */
export function createComponentFeature<T extends IEntity>(
	id?: string
): <A extends Record<string, Function>, S extends Record<string, Function> = {}>(actions: A, selectors?: S) => IComponentFeature<T, A, S> {
	return <A extends Record<string, Function>, S extends Record<string, Function> = {}>(
		actions: A,
		selectors?: S
	): IComponentFeature<T, A, S> => {
		const effectiveSelectors = selectors ?? ({} as S);

		const { context: Context, actionsRef, selectorsRef } = resolveFeatureEntry(componentFeatureRegistry, id, actions, effectiveSelectors);

		return {
			provider: <P extends object = {}>(
				WrappedComponent: Component<P>,
				factory: () => Omit<T, "$Id">
			): Component<IBodyProps<NoInfer<P>>> => {
				return (props: IBodyProps<NoInfer<P>>) => {
					const treflex = useTreflexContext()!;
					const mounted = mountComponentState<T>(factory, "createComponentFeature");
					const context = buildContextProxy<T, A, S>(() => mounted.state, actionsRef, selectorsRef, {
						dispatch: (action, _target, ...args) => mounted.dispatch(action, ...args),
						runSelector: treflex.runSelector
					});

					// The cast bridges the deferred conditional in IBodyProps to the
					// body's own P: the same props at every P but any, where the
					// body accepts anything anyway.
					const bodyProps = props as unknown as P;
					return (
						<Context value={context}>
							<WrappedComponent {...bodyProps}></WrappedComponent>
						</Context>
					);
				};
			},

			use: makeUse<IFeature<T, A, S>>(Context, "createComponentFeature", id)
		};
	};
}
