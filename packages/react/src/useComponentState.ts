import type { IAction, IEntity, IWithId } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import type { IFrames } from "./createFrames";
import type { IEntityView } from "./IEntityView";
import type { ITreflexReact } from "./TreflexProvider";
import { useContext, useInsertionEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { view } from "treflex/internal";
import { getFrames } from "./createFrames";
import { OwnerContext } from "./ownerContext";
import { useTreflex } from "./TreflexProvider";

export interface IUseComponentState<T extends object> {
	/** The component entity's $Id: dispatch to it, or pass it as an owner. */
	id: string;
	state: IEntityView<T>;
	dispatch: <A extends any[], R>(action: IAction<T, A, R>, ...args: A) => Promise<R | undefined>;
}

export interface IComponentEntity<T extends object> {
	readonly id: string;
	readonly view: T;
	dispatch: IUseComponentState<T>["dispatch"];
	seat(): void;
	frame(frames: IFrames): unknown;
	// False once the entity has left, by unmount or with its owner: selector work for the id would
	// rebuild a memo its removal has already swept.
	live(frames: IFrames): boolean;
	mount(): () => void;
}

function frozenCopy(value: unknown): unknown {
	if (value === null || typeof value !== "object") {
		return value;
	}
	const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? value.map(frozenCopy) : {};
	if (!Array.isArray(value)) {
		for (const key of Object.keys(value)) {
			(copy as Record<string, unknown>)[key] = frozenCopy((value as Record<string, unknown>)[key]);
		}
	}
	return Object.freeze(copy);
}

/**
 * Seated on demand and removed late. Whatever needs the entity seats it, under the tree owner the
 * last commit saw: this component's mount, a dispatch, and an owner change. An unmount, and a seat
 * while unmounted, remove it a microtask later unless the component is mounted again by then, as
 * StrictMode's remount is. The render reads the seed's copy until the first seat, and the last
 * frame once it has left.
 */
export function createComponentEntity<T extends IEntity>(
	runtime: IRuntimeInternal<any>,
	factory: () => Omit<T, "$Id">,
	owner: () => string | undefined = () => undefined,
	where = "useComponentState",
	onReplaced: () => void = () => {}
): IComponentEntity<T> {
	let current = runtime.seedComponent(factory(), where);
	let last: unknown = frozenCopy(current.raw);
	let mounted = false;
	// Seated by this binding and not since removed by it: a seat that finds it gone then knows
	// the owner's cascade took it, and starts from the factory.
	let held = false;
	// A seat under the last owner failed: that owner is gone, and its cascade would have taken
	// the node, so the next seat starts from the factory too.
	let orphaned = false;
	let everSeated = false;
	// The owner of the last seat, or of the last failed one under a new owner. A node this binding
	// removed goes back under whichever owner stands, though the one it left may have gone since,
	// where Solid starts fresh: docs/reference/views.md#component-state-in-react.
	let seatedUnder: string | undefined;
	let checking = false;
	const removeUnlessMounted = () => {
		if (checking) {
			return;
		}
		checking = true;
		queueMicrotask(() => {
			checking = false;
			if (!mounted && runtime.unmountComponent(current.id)) {
				held = false;
			}
		});
	};
	const replace = (seed: typeof current, seated: boolean) => {
		current = seed;
		last = frozenCopy(seed.raw);
		everSeated = seated;
		onReplaced();
	};
	const seat = () => {
		const next = owner();
		if (runtime.reseatComponent(current.id, next)) {
			seatedUnder = next;
			return;
		}
		const seed = everSeated && (held || orphaned) ? runtime.seedComponent(factory(), where) : current;
		if (runtime.seatComponent(next, seed.raw)) {
			if (seed !== current) {
				replace(seed, true);
			}
			held = true;
			orphaned = false;
			everSeated = true;
			seatedUnder = next;
			if (!mounted) {
				removeUnlessMounted();
			}
			return;
		}
		// Under the same owner, the last frame; under a new one already gone, the factory's values.
		if (next === seatedUnder) {
			orphaned = true;
			return;
		}
		held = false;
		orphaned = false;
		seatedUnder = next;
		if (everSeated) {
			replace(seed !== current ? seed : runtime.seedComponent(factory(), where), false);
		}
	};
	return {
		get id() {
			return current.id;
		},
		get view() {
			return view(current.raw) as T;
		},
		seat,
		dispatch: (action, ...args) => {
			try {
				seat();
			} catch (error) {
				return Promise.reject(error);
			}
			return runtime.dispatch(action, current.id, ...args);
		},
		frame(frames) {
			last = frames.entity(current.id) ?? last;
			return last;
		},
		live: (frames) => !everSeated || frames.node(current.id) !== undefined,
		mount() {
			mounted = true;
			seat();
			return () => {
				mounted = false;
				last = getFrames(runtime).entity(current.id) ?? last;
				removeUnlessMounted();
			};
		}
	};
}

export function useComponentEntity<T extends IEntity>(
	treflex: ITreflexReact,
	factory: () => Omit<T, "$Id">,
	where: string
): IComponentEntity<T> {
	const owner = useContext(OwnerContext);
	const latestFactory = useRef(factory);
	const latestOwner = useRef(owner);
	// Not during render: a render React throws away, a transition that suspends, must not move a
	// dispatch from the committed view under its owner. This runs before every layout effect of
	// the commit, so a dispatch from any of them already sees the committed owner.
	useInsertionEffect(() => {
		latestOwner.current = owner;
		latestFactory.current = factory;
	});
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	const [entity] = useState(() =>
		createComponentEntity<T>(
			treflex.runtime as IRuntimeInternal<any>,
			() => latestFactory.current(),
			() => latestOwner.current,
			where,
			rerender
		)
	);
	useLayoutEffect(
		() => entity.mount(),
		[
			entity
		]
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the seat reads the owner through its ref, and this effect runs it when the owner changes
	useLayoutEffect(() => {
		entity.seat();
	}, [
		entity,
		owner
	]);
	return entity;
}

/**
 * Mounts an entity in ComponentState for this component's lifetime, under the nearest tree
 * entity's provider (never another component's), and removes it at unmount or when that entity goes. When the provider comes to show
 * another entity, the state moves under it, or starts again from the factory if the first entity
 * took it. Under an entity already gone, it mounts nothing: `state` reads the factory's values and
 * a dispatch rejects. It changes only through its actions, and its entity view holds a nested entity as
 * an entity ref, as any tree entity view does. The factory holds no `$Id` at any depth, or it throws `HandWrittenIdError`:
 * an action makes a nested entity with `yield* entity()`.
 */
export function useComponentState<T extends object>(factory: () => T): IUseComponentState<IWithId<T>>;
export function useComponentState<T extends IEntity>(factory: () => Omit<T, "$Id">): IUseComponentState<T>;
export function useComponentState(factory: () => object): IUseComponentState<IEntity> {
	const treflex = useTreflex("useComponentState");
	const entity = useComponentEntity<IEntity>(treflex, factory, "useComponentState");
	const { frames } = treflex;
	const state = useSyncExternalStore(frames.subscribe, () => entity.frame(frames)) as IEntityView<IEntity>;
	const id = entity.id;
	return useMemo(
		() => ({
			id,
			state,
			dispatch: entity.dispatch
		}),
		[
			id,
			state,
			entity
		]
	);
}
