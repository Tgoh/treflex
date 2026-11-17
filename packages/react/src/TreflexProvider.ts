import type { ReactNode } from "react";
import type { IAction, IDispatchTarget, IEntity, ILocation, IRuntime } from "treflex";
import type { IFrames } from "./createFrames";
import type { IEntityRef, IEntityView } from "./IEntityView";
import { createContext, createElement, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { getFrames, nodeOf } from "./createFrames";

export interface ITreflexReact {
	runtime: IRuntime<any>;
	frames: IFrames;
}

const TreflexContext = createContext<ITreflexReact | null>(null);

export function TreflexProvider(props: { value: IRuntime<any>; children?: ReactNode }): ReactNode {
	const runtime = props.value;
	const value = useMemo(
		() => ({
			runtime,
			frames: getFrames(runtime)
		}),
		[
			runtime
		]
	);
	return createElement(
		TreflexContext.Provider,
		{
			value
		},
		props.children
	);
}

export function useTreflex(caller: string): ITreflexReact {
	const treflex = useContext(TreflexContext);
	if (!treflex) {
		throw new Error(`[treflex-react] ${caller} called outside a TreflexProvider.`);
	}
	return treflex;
}

// A ref holds only the `$Id`, so one no frames instance built (a hand-written `{ $Id }`) is that id.
// Anything else unmapped goes to core as it is, which refuses a copy.
export function targetOf(handle: IDispatchTarget | IEntityRef): IDispatchTarget {
	const node = nodeOf(handle) as IEntity | undefined;
	if (node) {
		return node;
	}
	if (typeof handle === "object" && handle !== null) {
		const keys = Object.keys(handle);
		if (keys.length === 1 && keys[0] === "$Id") {
			return handle.$Id;
		}
	}
	return handle as IDispatchTarget;
}

export type IDispatch = <S, A extends any[], R>(
	action: IAction<S, A, R>,
	target: IDispatchTarget | IEntityRef,
	...args: A
) => Promise<R | undefined>;

/** `runtime.dispatch` for a component: the target is an id, a ref, or a view of the entity. */
export function useDispatch(): IDispatch {
	const { runtime } = useTreflex("useDispatch");
	return useCallback<IDispatch>(
		(action, target, ...args) => runtime.dispatch(action, targetOf(target), ...args),
		[
			runtime
		]
	);
}

/** `runtime.locate` for a component, over a view: where the node it was built from stands. */
export function useLocate(): (view: unknown) => ILocation | undefined {
	const { runtime } = useTreflex("useLocate");
	return useCallback(
		(view: unknown) => runtime.locate(nodeOf(view) ?? view),
		[
			runtime
		]
	);
}

export function useRoot<T>(): IEntityView<T> {
	const { frames } = useTreflex("useRoot");
	return useSyncExternalStore(frames.subscribe, frames.root) as IEntityView<T>;
}

export function useEntity<T extends IEntity>(id: string): IEntityView<T> | undefined {
	const { frames } = useTreflex("useEntity");
	const read = useCallback(
		() => frames.entity(id),
		[
			frames,
			id
		]
	);
	return useSyncExternalStore(frames.subscribe, read) as IEntityView<T> | undefined;
}
