import type { JSX } from "@solidjs/web";
import type { IAction, IDispatchTarget, ILocation, IRuntime } from "treflex";
import type { IMirror, IOutsideGraph, IRuntimeInternal } from "treflex/internal";
import { $TRACK, createContext, createSignal, getObserver, getOwner, runWithOwner, untrack, useContext } from "solid-js";
import { registerOutsideGraph } from "treflex/internal";

export type ITreflexContextValue = IRuntimeInternal<any>;

// The range is the solid-js peer in packages/solid/package.json.
const ONE_COPY =
	"treflex-solid needs solid-js ^2.0.3. Dedupe solid-js and @solidjs/signals (npm dedupe, pnpm dedupe, yarn dedupe), and if " +
	"two copies remain, force one version that ^2.0.3 covers: overrides in package.json for npm, pnpm.overrides for pnpm, " +
	"resolutions for yarn.";

export const solidGraph: IOutsideGraph = {
	TRACK: $TRACK,
	isReading: () => getObserver() !== null,
	createMirror(): IMirror {
		const [read, write] = runWithOwner(null, () =>
			createSignal(0, {
				equals: false,
				ownedWrite: true
			})
		);
		return {
			track: read,
			write: () => write(0)
		};
	},
	untrack
};

// Top level, and listed in package.json's sideEffects: a bundler that drops it leaves every view unsubscribed.
if (!registerOutsideGraph(solidGraph)) {
	throw new Error(
		"[treflex] Two copies of solid-js are loaded, each with a copy of treflex-solid, and the runtime serves only the first, " +
			`so views on the second would never update. ${ONE_COPY}`
	);
}

const TreflexContext = createContext<ITreflexContextValue | null>(null);

/**
 * Puts the runtime in context for every feature, hook and component below. A view's throw below it is
 * Solid's, for an app's own `<Errored>`, and never fails an action. Throws when it finds no Solid owner:
 * the app renders with another copy of solid-js than treflex-solid's, or it was called outside a render.
 */
export function TreflexProvider(props: { value: IRuntime<any>; children?: JSX.Element }): JSX.Element {
	if (getOwner() === null) {
		throw new Error(
			"[treflex] TreflexProvider found no Solid owner on the copy of solid-js that treflex-solid imports. Either the app " +
				"renders with a second copy of solid-js, so no view would update on the runtime's writes, or TreflexProvider was " +
				`called outside a render. ${ONE_COPY}`
		);
	}
	return <TreflexContext value={props.value as ITreflexContextValue}>{props.children}</TreflexContext>;
}

export const useTreflexContext = (): ITreflexContextValue | undefined => useContext(TreflexContext) ?? undefined;

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
