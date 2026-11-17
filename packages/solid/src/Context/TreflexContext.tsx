import type { JSX } from "solid-js";
import type { IAction, IDispatchTarget, ILocation, IRuntime } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import { $TRACK, catchError, createContext, useContext } from "solid-js";
import { solidTrack } from "treflex/internal";

export type ITreflexContextValue = IRuntimeInternal<any>;

// Each copy of solid-js mints its own `$TRACK`. The range is the solid-js peer and dependency in
// packages/solid/package.json and packages/core/package.json.
function assertOneSolid(): void {
	if (solidTrack !== $TRACK) {
		throw new Error(
			"[treflex] Two copies of solid-js are loaded: treflex's runtime runs on one and this app's Solid components on " +
				"the other, so views would not update on the runtime's writes. treflex needs solid-js ^1.9.7. Dedupe " +
				"solid-js (npm dedupe, pnpm dedupe, yarn dedupe), and if two copies remain, force one version that ^1.9.7 " +
				"covers: overrides in package.json for npm, pnpm.overrides for pnpm, resolutions for yarn."
		);
	}
}

const TreflexContext = createContext<ITreflexContextValue>();

// A cached read rethrows one held error to every view reading it, so each object is raised once.
const raised = new WeakSet<object>();

// Not rethrown from the handler: a throw there escapes the flush, failing the writing action and
// discarding the views queued behind.
function raiseViewCrash(error: unknown): void {
	if (error !== null && (typeof error === "object" || typeof error === "function")) {
		if (raised.has(error)) {
			return;
		}
		raised.add(error);
	}
	void Promise.reject(error);
}

/**
 * Puts the runtime in context for every feature, hook and component below. A view's throw below it,
 * mounting included, is raised uncaught, and never fails an action. Throws when treflex and the app
 * loaded different copies of solid-js.
 */
export function TreflexProvider(props: { value: IRuntime<any>; children?: JSX.Element }): JSX.Element {
	assertOneSolid();
	return (
		<TreflexContext.Provider value={props.value as ITreflexContextValue}>
			{catchError(() => props.children, raiseViewCrash)}
		</TreflexContext.Provider>
	);
}

export const useTreflexContext = (): ITreflexContextValue | undefined => useContext(TreflexContext);

export function runtimeFor(caller: string): ITreflexContextValue {
	const runtime = useTreflexContext();
	if (!runtime) {
		throw new Error(`[treflex] ${caller} called outside a TreflexProvider.`);
	}
	return runtime;
}

export type IDispatch = <S, A extends any[], R>(action: IAction<S, A, R>, target: IDispatchTarget, ...args: A) => Promise<R | undefined>;

/** `runtime.dispatch` for a component: the target is an entity's `$Id` or its node. */
export function useDispatch(): IDispatch {
	const runtime = runtimeFor("useDispatch");
	return (action, target, ...args) => runtime.dispatch(action, target, ...args);
}

/** `runtime.locate` for a component: where a node of the tree stands, as an entity to dispatch on. */
export function useLocate(): (node: unknown) => ILocation | undefined {
	const runtime = runtimeFor("useLocate");
	return (node) => runtime.locate(node);
}
