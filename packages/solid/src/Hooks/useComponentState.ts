import type { IAction, IEntity, IWithId } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import { createRenderEffect, createSignal, onCleanup, untrack } from "solid-js";
import { view } from "treflex/internal";
import { useOwner } from "../Context/OwnerContext";
import { useTreflexContext } from "../Context/TreflexContext";

export interface IUseComponentState<T extends object> {
	/** The component entity's $Id: dispatch to it, or pass it as an owner. */
	readonly id: string;
	readonly state: T;
	dispatch: <A extends any[], R>(action: IAction<T, A, R>, ...args: A) => Promise<R | undefined>;
}

export function mountComponentState<T extends object>(factory: () => object, where: string): IUseComponentState<T> {
	const runtime = useTreflexContext() as IRuntimeInternal<any> | undefined;
	if (!runtime?.seatComponent) {
		throw new Error(
			`[treflex] ${where}: no TreflexProvider with a runtime above this component, so there is no ComponentState to mount in.`
		);
	}
	const owner = useOwner();
	const seed = () => runtime.seedComponent(untrack(factory), where);
	let ownerId = owner ? untrack(owner) : undefined;
	let mounted = true;
	// The signal lands only at Solid's flush, so dispatch, the reseat and the cleanup read `current`.
	let current = seed();
	const [mount, setMount] = createSignal(current);
	runtime.seatComponent(ownerId, current.raw);
	if (owner) {
		// A render effect, not a watch: Solid holds its apply with the screen, so the entity doesn't move
		// under an owner the screen doesn't show yet.
		createRenderEffect(
			() => owner(),
			(next) => {
				if (next === ownerId) {
					return;
				}
				ownerId = next;
				if (!runtime.reseatComponent(current.id, next)) {
					current = seed();
					runtime.seatComponent(next, current.raw);
					setMount(current);
				}
			}
		);
	}
	onCleanup(() => {
		mounted = false;
		runtime.unmountComponent(current.id);
	});
	return {
		get id() {
			return mount().id;
		},
		get state() {
			return view(mount().raw) as T;
		},
		dispatch: (action, ...args) => {
			const { id, raw } = current;
			// A dispatch left over from the unmount starts, and the removal a microtask later stops it.
			if (!mounted && runtime.seatComponent(ownerId, raw)) {
				queueMicrotask(() => runtime.unmountComponent(id));
			}
			return runtime.dispatch(action, id, ...args);
		}
	};
}

/**
 * Mounts an entity in ComponentState for this component's lifetime, under the nearest tree entity's
 * provider (never another component's), and removes it at unmount or when that entity goes. When
 * the provider comes to show another entity, the state moves under it, or starts again from the
 * factory if the first entity took it. Under an entity already gone, it mounts nothing: `state`
 * reads the factory's values and a dispatch rejects. It is indexed and ruled as any entity in the
 * tree is, never saved, and changes only through its actions. `id` and `state` are read where
 * they're used, as props are. The factory holds no `$Id` at any depth, or it throws
 * `HandWrittenIdError`: an action makes a nested entity with `yield* entity()`.
 */
export function useComponentState<T extends object>(factory: () => T): IUseComponentState<IWithId<T>>;
export function useComponentState<T extends IEntity>(factory: () => Omit<T, "$Id">): IUseComponentState<T>;
export function useComponentState(factory: () => object): IUseComponentState<IEntity> {
	const mounted = mountComponentState<IEntity>(factory, "useComponentState");
	return {
		get id() {
			return mounted.id;
		},
		get state() {
			return mounted.state;
		},
		dispatch: mounted.dispatch
	};
}
