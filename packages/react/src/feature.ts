import type { ComponentType, FunctionComponent, ReactNode } from "react";
import type { IAction, IEntity, ISelector } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import type { IEntityRef, IEntityView, ISelected } from "./IEntityView";
import { createElement, memo, useCallback, useContext, useEffect, useInsertionEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { watch } from "treflex/internal";
import { OwnerContext } from "./ownerContext";
import { resolveFeatureEntry } from "./registry";
import { targetOf, useTreflex } from "./TreflexProvider";
import { useComponentEntity } from "./useComponentState";

type Action<F> = F extends (state: any, ...args: infer P) => Generator<any, infer R, any> ? (...args: P) => Promise<R | undefined> : never;
type Selector<F> = F extends (state: any) => Generator<any, infer R, any> ? () => ISelected<R> : never;

export type IActions<A> = {
	[K in keyof A]: Action<A[K]>;
};
export type ISelectors<S> = {
	[K in keyof S]: Selector<S[K]>;
};

// An `any` body declares nothing, and the providers must reach this through
// `NoInfer<P>`: a bare `any` type argument collapses the return type first.
export type IBodyProps<P> = 0 extends 1 & P ? {} : P;

export type IProviderProps<T extends IEntity, P> = IBodyProps<P> & {
	state: IEntityRef<T>;
};

export type IFeature<T extends IEntity, A, S> = IActions<A> &
	ISelectors<S> & {
		state: IEntityView<T>;
	};

export interface IEntityFeature<T extends IEntity, A, S> {
	provider: <P extends object = {}>(
		body: ComponentType<
			P & {
				state: IEntityRef<T>;
			}
		>
	) => ComponentType<IProviderProps<T, NoInfer<P>>>;
	use: () => IFeature<T, A, S>;
}

export interface IComponentFeature<T extends IEntity, A, S> {
	provider: <P extends object = {}>(body: ComponentType<P>, factory: () => Omit<T, "$Id">) => ComponentType<IBodyProps<NoInfer<P>>>;
	use: () => IFeature<T, A, S>;
}

interface IInstance {
	id: string;
	getState: () => unknown;
	frame: () => unknown;
	live: () => boolean;
	dispatch: (action: IAction<any, any[], any>, ...args: any[]) => Promise<any>;
	// The nearest entity in AppState or TransientState, which component state below mounts under.
	owner?: string | undefined;
}

interface IHeld {
	actions: Record<string, Function>;
	selectors: Record<string, Function>;
	state: unknown;
	values: Map<string, unknown>;
	value: Record<string, unknown>;
}

function where(factory: string, id: string | undefined): string {
	return id ? `${factory} (${id})` : factory;
}

function featureParts(factory: string, id: string | undefined, actions: Record<string, Function>, selectors: Record<string, Function>) {
	const entry = resolveFeatureEntry<IInstance>(factory, id, actions, selectors);
	const Context = entry.context;

	function wrap(body: ComponentType<any>, Provider: FunctionComponent<any>): ComponentType<any> {
		Provider.displayName = `${factory}(${id ? `${id}: ` : ""}${body.displayName || body.name || "Feature"})`;
		return memo(Provider);
	}

	function render(instance: IInstance, body: ComponentType<any>, props: object): ReactNode {
		const provided = createElement(
			Context.Provider,
			{
				value: instance
			},
			createElement(body, props)
		);
		return instance.owner === undefined
			? provided
			: createElement(
					OwnerContext.Provider,
					{
						value: instance.owner
					},
					provided
				);
	}

	function useFeature(): Record<string, unknown> {
		const found = useContext(Context);
		const { runtime, frames } = useTreflex(`${factory} use()`);
		if (!found) {
			throw new Error(
				`[treflex-react] ${where(factory, id)} use() called outside the matching provider. ` +
					`Ensure the calling component is rendered inside the corresponding ${factory} provider.`
			);
		}
		const instance = found;
		const bound = useMemo(
			() => ({
				instance,
				methods: new Map<string, Function>(),
				readsState: false,
				used: new Set<string>(),
				watches: new Map<
					string,
					{
						selector: Function;
						stop: () => void;
					}
				>(),
				onChange: null as (() => void) | null,
				held: {
					current: null as IHeld | null
				}
			}),
			[
				instance
			]
		);
		// Every start of selector work checks instance.live(): a memo built for an
		// entity that has left is never swept.
		const run = (name: string) =>
			(runtime as IRuntimeInternal<any>).runSelector(entry.selectors.current[name] as ISelector<any, any>, instance.getState);
		const compute = (name: string) => (instance.live() ? frames.select(run(name)) : bound.held.current?.values.get(name));
		// A selector can read what no tree write announces, a data source or an
		// external value, so each one a component has called is also watched itself.
		const syncWatches = () => {
			const onChange = bound.onChange;
			if (!onChange) {
				return;
			}
			let added = false;
			for (const [name, watched] of bound.watches) {
				if (!bound.used.has(name) || watched.selector !== entry.selectors.current[name]) {
					watched.stop();
					bound.watches.delete(name);
				}
			}
			for (const name of bound.used) {
				if (!bound.watches.has(name)) {
					bound.watches.set(name, {
						selector: entry.selectors.current[name]!,
						stop: watch(() => {
							if (instance.live() && typeof entry.selectors.current[name] === "function") {
								run(name);
							}
						}, onChange)
					});
					added = true;
				}
			}
			if (added) {
				onChange();
			}
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: syncWatches is rebuilt each render over the same bound, so a resubscribe per render would buy nothing
		const subscribe = useCallback(
			(onChange: () => void) => {
				bound.onChange = onChange;
				const stopFrames = frames.subscribe(onChange);
				syncWatches();
				return () => {
					stopFrames();
					bound.onChange = null;
					for (const watched of bound.watches.values()) {
						watched.stop();
					}
					bound.watches.clear();
				};
			},
			[
				frames,
				bound
			]
		);
		const read = () => {
			const held = bound.held.current;
			const state = instance.live() ? instance.frame() : undefined;
			if (state === undefined) {
				if (held) {
					return held.value;
				}
				throw new Error(
					`[treflex-react] ${where(factory, id)}: no entity "${instance.id}" in the state tree. ` +
						`Mount the provider with the ref or view of an entity the tree holds, and gate a slot that holds none.`
				);
			}
			const actionsNow = entry.actions.current;
			const selectorsNow = entry.selectors.current;
			const values = new Map<string, unknown>();
			for (const name of bound.used) {
				if (typeof selectorsNow[name] !== "function") {
					bound.used.delete(name);
					continue;
				}
				values.set(name, compute(name));
			}
			if (
				held &&
				held.actions === actionsNow &&
				held.selectors === selectorsNow &&
				(!bound.readsState || held.state === state) &&
				[
					...values
				].every(([name, value]) => held.values.get(name) === value)
			) {
				return held.value;
			}
			const value: Record<string, unknown> = {};
			for (const name of Object.keys(actionsNow)) {
				let method = bound.methods.get(name);
				if (!method) {
					method = (...args: unknown[]) => {
						const action = entry.actions.current[name];
						if (typeof action !== "function") {
							return Promise.reject(new Error(`[treflex-react] ${where(factory, id)}: no action named "${name}".`));
						}
						return bound.instance.dispatch(action as IAction<any, any[], any>, ...args);
					};
					bound.methods.set(name, method);
				}
				value[name] = method;
			}
			for (const name of Object.keys(selectorsNow)) {
				value[name] = () => {
					const fresh = compute(name);
					if (!values.has(name)) {
						bound.used.add(name);
						values.set(name, fresh);
					}
					return fresh;
				};
			}
			Object.defineProperty(value, "state", {
				enumerable: true,
				get() {
					bound.readsState = true;
					return instance.frame() ?? state;
				}
			});
			bound.held.current = {
				actions: actionsNow,
				selectors: selectorsNow,
				state,
				values,
				value
			};
			return value;
		};
		const value = useSyncExternalStore(subscribe, read);
		useEffect(syncWatches);
		return value;
	}

	return {
		Context,
		wrap,
		render,
		useFeature
	};
}

/**
 * Turns a feature's actions and selectors into a provider over an entity in the tree and
 * the `use()` its components read. `id` names the feature in error messages.
 */
export function createEntityFeature<T extends IEntity>(
	id?: string
): <A extends Record<string, Function>, S extends Record<string, Function> = {}>(actions: A, selectors?: S) => IEntityFeature<T, A, S> {
	return <A extends Record<string, Function>, S extends Record<string, Function> = {}>(
		actions: A,
		selectors?: S
	): IEntityFeature<T, A, S> => {
		const parts = featureParts("createEntityFeature", id, actions, selectors ?? {});
		return {
			provider: (body) =>
				parts.wrap(body, function FeatureProvider(props: { state: IEntityRef<T> }) {
					const { runtime, frames } = useTreflex("createEntityFeature provider");
					const entityId = props.state.$Id;
					const outer = useContext(OwnerContext);
					// An entity in ComponentState, a widget's own row, passes the outer owner on: mounts are flat.
					const inComponentState = (runtime as IRuntimeInternal<any>).get("runtime/writeGateway").rootNameOf(entityId) === "ComponentState";
					const owner = inComponentState ? outer : entityId;
					// Committed, not rendered: a render React discards must not change what a dispatch targets.
					const handle = useRef(props.state);
					useInsertionEffect(() => {
						handle.current = props.state;
					});
					const instance = useMemo<IInstance>(
						() => ({
							id: entityId,
							getState: () => frames.node(entityId),
							frame: () => frames.entity(entityId),
							live: () => frames.node(entityId) !== undefined,
							// The handle follows the provider to whatever entity it shows now; an instance a
							// handler still holds belongs to the one it was made for.
							dispatch: (action, ...args) =>
								runtime.dispatch(action, handle.current.$Id === entityId ? targetOf(handle.current) : entityId, ...args),
							owner
						}),
						[
							runtime,
							frames,
							entityId,
							owner
						]
					);
					return parts.render(instance, body, props);
				}),
			use: parts.useFeature as () => IFeature<T, A, S>
		};
	};
}

/**
 * The component-bound sibling of `createEntityFeature`: the provider mounts an
 * entity in ComponentState from `factory`, as `useComponentState` does.
 */
export function createComponentFeature<T extends IEntity>(
	id?: string
): <A extends Record<string, Function>, S extends Record<string, Function> = {}>(actions: A, selectors?: S) => IComponentFeature<T, A, S> {
	return <A extends Record<string, Function>, S extends Record<string, Function> = {}>(
		actions: A,
		selectors?: S
	): IComponentFeature<T, A, S> => {
		const parts = featureParts("createComponentFeature", id, actions, selectors ?? {});
		return {
			provider: (body, factory) =>
				parts.wrap(body, function ComponentFeatureProvider(props: object) {
					const treflex = useTreflex("createComponentFeature provider");
					const entity = useComponentEntity<T>(treflex, factory, "createComponentFeature");
					const { frames } = treflex;
					const entityId = entity.id;
					const instance = useMemo<IInstance>(
						() => ({
							id: entityId,
							getState: () => entity.view,
							frame: () => entity.frame(frames),
							live: () => entity.live(frames),
							dispatch: entity.dispatch
						}),
						[
							frames,
							entity,
							entityId
						]
					);
					return parts.render(instance, body, props);
				}),
			use: parts.useFeature as () => IFeature<T, A, S>
		};
	};
}
