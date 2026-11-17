import type { IInFlightStub } from "../Runtime/arrivals";
import type { IEffectImplementation } from "../Runtime/createEffectRegistry";
import type { IResourceStubs } from "../Runtime/createResourceManager";
import type { IRuntime } from "../Runtime/createRuntime";
import type { IVerifyIndexMode } from "../Runtime/createWriteGateway";
import type { IRuntimeInternal } from "../Runtime/internals";
import type { IErrorHandler } from "../Runtime/processAction";
import type { IAction } from "../Types/IAction";
import type { IActionContext } from "../Types/IActionContext";
import type { IFailureEvent } from "../Types/IRuntimeEvent";
import { noImplementationMessage } from "../Runtime/createEffectRegistry";
import { createRuntime } from "../Runtime/createRuntime";
import { verifyModeFromEnv } from "../Runtime/createWriteGateway";
import { refuseReservedType } from "../Runtime/operations";
import { FAILED_ACTION } from "../Runtime/processAction";
import { report } from "./reports";

export type ITestRuntime<T extends object> = IRuntime<T>;

export interface ITestRuntimeOptions {
	/**
	 * Called with each failure that reaches the top, as `createRuntime`'s. A failure it takes still
	 * fails the test unless `allowFailures` allows it, and a throw out of it fails the test whatever
	 * is allowed. See docs/reference/testing.md#failures-and-diags-fail-the-test.
	 */
	onError?: IErrorHandler | undefined;
	/**
	 * The actions whose failures the test expects, matched by function identity, or `true` for every
	 * failure. Any other failure fails the test. See docs/reference/testing.md#failures-and-diags-fail-the-test.
	 */
	allowFailures?: true | readonly IAction<any, any, any>[] | undefined;
	/**
	 * The diag codes the test expects, or `true` for every code. Any other diag fails the test.
	 * See docs/reference/testing.md#failures-and-diags-fail-the-test.
	 */
	allowDiags?: true | readonly string[] | undefined;
	/**
	 * The index consistency walk, as `createRuntime`'s. Omitted, it is `"always"` unless the
	 * TREFLEX_VERIFY_INDEX environment variable names a mode. See docs/reference/testing.md#what-the-test-runtime-decides.
	 */
	verifyIndex?: boolean | IVerifyIndexMode | undefined;
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

export interface ITestRuntimeSite {
	call: "createTestRuntime" | "restoreTestRuntime";
	origin: Error;
	trimmed: boolean;
}

export function testRuntimeSite(call: ITestRuntimeSite["call"], above: Function): ITestRuntimeSite {
	const origin = new Error();
	const capture = (
		Error as unknown as {
			captureStackTrace?: (target: object, above: Function) => void;
		}
	).captureStackTrace;
	capture?.(origin, above);
	return {
		call,
		origin,
		trimmed: capture !== undefined
	};
}

// Read only when reporting: formatting a stack costs, and most runtimes report nothing.
function framesOf(site: ITestRuntimeSite): string {
	const stack = site.origin.stack ?? "";
	if (!site.trimmed) {
		return stack;
	}
	const header = stack.indexOf("\n");
	return header === -1 ? "" : stack.slice(header + 1);
}

const DOCS = "docs/reference/testing.md#failures-and-diags-fail-the-test";

function optOut(site: ITestRuntimeSite, option: string, where = ""): string {
	return site.call === "createTestRuntime"
		? `pass ${option} in createTestRuntime's options (${DOCS})${where}`
		: `pass options: { ${option} } to restoreTestRuntime (${DOCS})${where}`;
}

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function reportAt(site: ITestRuntimeSite, message: string, cause: unknown): void {
	const error = new Error(`[treflex] ${site.call}: ${message}`, {
		cause
	});
	const header = `${error.name}: ${error.message}`;
	const frames = framesOf(site);
	error.stack = frames === "" ? header : `${header}\n${frames}`;
	report(error);
}

const failedAction = (event: IFailureEvent): unknown => (event as unknown as Record<symbol, unknown>)[FAILED_ACTION];

// The key Runtime/receiver.ts sets on every receiver's handle.
const RECEIVER_CASE = Symbol.for("treflex.receiverCase");

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function allowHint(site: ITestRuntimeSite, event: IFailureEvent): string {
	const action = failedAction(event);
	if (typeof action === "function" && RECEIVER_CASE in action) {
		return optOut(site, "allowFailures: [Receiver.handle]", `, Receiver being the receiver "${event.Label}"`);
	}
	if (event.Label === null || !IDENTIFIER.test(event.Label)) {
		return optOut(site, "allowFailures: [action]", ", action being the function passed to dispatch or start, by reference");
	}
	return optOut(site, `allowFailures: [${event.Label}]`);
}

// state/view-write reaches every live runtime's bus, and the write already throws at the writer.
const UNOWNED = "state/view-write";

// Its failure event, Taken: false, reports the same throw.
const UNROUTED = "action/unrouted-throw";

export function createTestRuntime<T extends object>(
	initialState: T,
	effectStubs: Record<string, IEffectStub> = {},
	options?: ITestRuntimeOptions
): ITestRuntime<T> {
	return buildTestRuntime(initialState, effectStubs, options, testRuntimeSite("createTestRuntime", createTestRuntime));
}

export function buildTestRuntime<T extends object>(
	initialState: T,
	effectStubs: Record<string, IEffectStub>,
	options: ITestRuntimeOptions | undefined,
	site: ITestRuntimeSite
): ITestRuntime<T> {
	for (const type of Object.keys(effectStubs)) {
		refuseReservedType(type, `${site.call}'s stub map`);
	}
	const allowFailures = options?.allowFailures;
	const allowedActions = new Set<unknown>(allowFailures === true ? [] : allowFailures);
	const testOnError = options?.onError;
	const runtime = createRuntime<T>(initialState, {
		onError: (error, context) => {
			try {
				testOnError?.(error, context);
			} catch (thrown) {
				reportAt(
					site,
					`onError threw while taking the failure of action "${context.Name ?? context.Label ?? "(anonymous)"}" on "${context.EntityId}". The throw: ${said(thrown)}`,
					thrown
				);
			}
		},
		verifyIndex: options?.verifyIndex ?? verifyModeFromEnv() ?? "always",
		pauseTimers: true,
		pauseResources: true,
		implementations: {
			generateGuid: refuse("generateGuid"),
			...effectStubs
		}
	});
	const allowDiags = options?.allowDiags;
	const allowed = new Set(allowDiags === true ? [] : allowDiags);
	runtime.on("diag", (event) => {
		if (allowDiags === true || allowed.has(event.code) || event.code === UNOWNED || event.code === UNROUTED) {
			return;
		}
		reportAt(
			site,
			`an unexpected diag, "${event.code}". If the test expects it, ${optOut(site, `allowDiags: ["${event.code}"]`)}. The diag: ${event.message}`,
			event
		);
	});
	runtime.on("failure", (event) => {
		if (allowFailures === true || allowedActions.has(failedAction(event))) {
			return;
		}
		const how = event.Taken ? "failed" : `threw where no error boundary or onError can take it (${UNROUTED})`;
		reportAt(
			site,
			`action "${event.Name ?? event.Label ?? "(anonymous)"}" on "${event.EntityId}" ${how}. If the test expects it, ${allowHint(site, event)}. ` +
				`The failure: ${said(event.Error)}`,
			event.Error
		);
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
