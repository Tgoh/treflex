import type { IInFlightStub } from "../Runtime/arrivals";
import type { IEffectImplementation } from "../Runtime/createEffectRegistry";
import type { IResourceStubs } from "../Runtime/createResourceManager";
import type { IRuntime } from "../Runtime/createRuntime";
import type { IRuntimeInternal } from "../Runtime/internals";
import type { IErrorHandler } from "../Runtime/processAction";
import type { IActionContext } from "../Types/IActionContext";
import { noImplementationMessage } from "../Runtime/createEffectRegistry";
import { createRuntime } from "../Runtime/createRuntime";
import { refuseReservedType } from "../Runtime/operations";

export type ITestRuntime<T extends object> = IRuntime<T>;

export interface ITestRuntimeOptions {
	onError?: IErrorHandler | undefined;
	/** The actions and work tags to count as in flight on an owner, for `inFlight` reads in actions and selectors alike. See docs/reference/testing.md#stubbing-inflight. */
	inFlight?: IInFlightStub | undefined;
	/** The resource stubs: method and supply answers, exposed values and statuses, by key. */
	resources?: IResourceStubs | undefined;
}

export type IEffectStub = (e: any, action?: IActionContext) => any;

const refuse =
	(type: string): IEffectImplementation =>
	() => {
		throw new Error(noImplementationMessage(type));
	};

/**
 * A `generateGuid` stub answering readable ids in order: `row-1`, `row-2`, which `entity()` makes
 * into the `$Id`s `~row-1`, `~row-2`. Take one per test, since each holds its own count:
 * `createTestRuntime(seed, { generateGuid: guids("row") })`.
 */
export function guids(prefix = "guid"): () => string {
	let minted = 0;
	return () => `${prefix}-${++minted}`;
}

/**
 * Resolves once no branch can make progress without something outside: every stub that has
 * answered has been heard, and microtasks have drained, started actions and published messages included.
 * A waiting ask, a stub's unresolved promise and a timer don't hold it up, so it always returns.
 * See docs/reference/testing.md#waiting-until-nothing-can-run.
 */
export function settled(): Promise<void> {
	return new Promise((resolve) => {
		// A task runs only when the microtask queue is empty, and fake timers leave this one alone.
		const { port1, port2 } = new MessageChannel();
		port1.onmessage = () => {
			port1.close();
			resolve();
		};
		port2.postMessage(null);
	});
}

export function createTestRuntime<T extends object>(
	initialState: T,
	effectStubs: Record<string, IEffectStub> = {},
	options?: ITestRuntimeOptions
): ITestRuntime<T> {
	for (const type of Object.keys(effectStubs)) {
		refuseReservedType(type, "createTestRuntime's stub map");
	}
	const runtime = createRuntime<T>(initialState, {
		onError: options?.onError,
		pauseTimers: true,
		pauseResources: true,
		implementations: {
			generateGuid: refuse("generateGuid"),
			...effectStubs
		}
	});
	// Always installed, empty or not: an unstubbed method or supply on a
	// cell with a row throws rather than resolving undefined from the pause.
	const resources = options?.resources;
	(runtime as IRuntimeInternal<T>).get("runtime/resources").setStubs({
		methods: resources?.methods,
		supplies: resources?.supplies,
		exposes: resources?.exposes,
		statuses: resources?.statuses
	});
	(runtime as IRuntimeInternal<T>).get("runtime/inFlightStub").stub(options?.inFlight);
	return runtime;
}
