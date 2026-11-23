import type { IDiagService } from "./createDiagService";
import { DEV } from "../Utility/devMode";
import { errorClassNamed } from "../Utility/errorClasses";
import {
	type IErrorKind,
	type ISerializedThrow,
	isPlatformClass,
	NESTED_KEYS,
	nativeErrorNamed,
	readErrorText,
	readThrow
} from "../Utility/serializeThrow";
import { cloneStrict } from "../Utility/valueCodec";
import { isRefusal } from "./refusal";

type ISerializedError = Extract<
	ISerializedThrow,
	{
		Thrown: "error";
	}
>;

const refusalRoots = new WeakMap<object, object>();

/**
 * In a development build, the refusal a copy was made from, through every copy between; in a
 * production build, and for anything else, the value itself.
 */
export function refusalRoot<T>(error: T): T {
	return (refusalRoots.get(error as object) as T | undefined) ?? error;
}

const actionFailures = new WeakSet<object>();

export function noteActionFailure(error: unknown): void {
	if (DEV && ((error !== null && typeof error === "object") || typeof error === "function")) {
		actionFailures.add(error);
	}
}

function isActionFailure(thrown: unknown): boolean {
	return thrown !== null && (typeof thrown === "object" || typeof thrown === "function") && actionFailures.has(thrown);
}

/**
 * The value an action is thrown for a serialized throw. `originals`, from the live run's reading,
 * gives each rebuilt error the original's stack when it is first read.
 */
export function rebuildThrow(form: ISerializedThrow, originals?: ReadonlyMap<object, Error>): unknown {
	return form.Thrown === "error" ? rebuildError(form, originals) : form.Data;
}

const AggregateErrorClass = nativeErrorNamed("AggregateError");
const SuppressedErrorClass = nativeErrorNamed("SuppressedError");
const DOMExceptionClass = nativeErrorNamed("DOMException");

// The constructor iterates its list, and an empty array would go through a patchable
// Array.prototype[Symbol.iterator].
const NO_ERRORS: Iterable<never> = Object.freeze({
	[Symbol.iterator]: () => ({
		next: () => ({
			done: true as const,
			value: undefined as never
		})
	})
});

const RESERVED = [
	"name",
	"message",
	"stack",
	"cause"
];

function rebuildError(form: ISerializedError, originals: ReadonlyMap<object, Error> | undefined): Error {
	const native = (form.Native === undefined ? undefined : nativeErrorNamed(form.Native)) ?? Error;
	const target = (form.Class === undefined ? undefined : errorClassNamed(form.Class)) ?? native;
	const nested = (native === Error ? undefined : NESTED_KEYS[form.Native!]) ?? [];
	const rebuild = (item: ISerializedThrow | undefined): unknown => (item === undefined ? undefined : rebuildThrow(item, originals));
	const args =
		native === AggregateErrorClass
			? [
					NO_ERRORS,
					form.Message
				]
			: native === SuppressedErrorClass
				? [
						rebuild(form.Error),
						rebuild(form.Suppressed),
						form.Message
					]
				: native === DOMExceptionClass
					? [
							form.Message,
							form.Name
						]
					: [
							form.Message
						];
	const error = constructWithoutStack(native, args, target);
	if (native === AggregateErrorClass) {
		const items = form.Errors ?? [];
		const errors: unknown[] = [];
		for (let i = 0; i < items.length; i++) {
			errors[i] = rebuildThrow(items[i]!, originals);
		}
		hidden(error, "errors", errors);
	}
	if (native === SuppressedErrorClass) {
		// The form leaves out what it didn't read, and the constructor always defines both.
		const suppressed = error as {
			error?: unknown;
			suppressed?: unknown;
		};
		if (form.Error === undefined) {
			delete suppressed.error;
		}
		if (form.Suppressed === undefined) {
			delete suppressed.suppressed;
		}
	} else {
		if (form.Error !== undefined) {
			field(error, "error", rebuildThrow(form.Error, originals));
		}
		if (form.Suppressed !== undefined) {
			field(error, "suppressed", rebuildThrow(form.Suppressed, originals));
		}
	}
	if (readErrorText(error, "name") !== form.Name) {
		hidden(error, "name", form.Name);
	}
	if (form.Fields !== undefined) {
		for (const key of Object.keys(form.Fields)) {
			if (RESERVED.includes(key) || nested.includes(key)) {
				continue;
			}
			field(error, key, form.Fields[key]);
		}
	}
	if (form.Cause !== undefined) {
		hidden(error, "cause", rebuildThrow(form.Cause, originals));
	}
	const original = originals?.get(form);
	if (original === undefined) {
		hidden(error, "stack", form.Stack);
	} else {
		lazyStack(error, original);
	}
	return error;
}

function field(error: Error, key: string, value: unknown): void {
	Object.defineProperty(error, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true
	});
}

function hidden(error: Error, key: string, value: unknown): void {
	Object.defineProperty(error, key, {
		value,
		enumerable: false,
		writable: true,
		configurable: true
	});
}

// An accessor that never redefines itself, since the action may have frozen the copy before reading it.
function lazyStack(error: Error, original: Error): void {
	let from: Error | undefined = original;
	let stack: unknown;
	Object.defineProperty(error, "stack", {
		get() {
			if (from !== undefined) {
				stack = readErrorText(from, "stack");
				from = undefined;
			}
			return stack;
		},
		set(value: unknown) {
			from = undefined;
			stack = value;
		},
		enumerable: false,
		configurable: true
	});
}

const errorStatics = Error as {
	stackTraceLimit?: unknown;
};

function constructWithoutStack(native: Function, args: unknown[], target: Function): Error {
	let limit: unknown;
	try {
		limit = errorStatics.stackTraceLimit;
		if (typeof limit === "number") {
			errorStatics.stackTraceLimit = 0;
		}
	} catch {
		limit = undefined;
	}
	try {
		return Reflect.construct(native, args, target) as Error;
	} finally {
		if (typeof limit === "number") {
			try {
				errorStatics.stackTraceLimit = limit;
			} catch {}
		}
	}
}

export interface IRejectionSite {
	readonly where: string;
	readonly data: Readonly<Record<string, string>>;
}

/** It never throws. */
export function crossRejection(thrown: unknown, site: IRejectionSite, diag: () => IDiagService): unknown {
	const originals = new Map<object, Error>();
	const lostFields: string[] | undefined = DEV ? [] : undefined;
	const kinds = DEV ? new Map<object, IErrorKind>() : undefined;
	const form = readThrow(thrown, {
		stacks: false,
		originals,
		lostFields,
		kinds
	});
	let copy: unknown;
	try {
		copy = rebuildThrow(form, originals);
	} catch {
		copy = form.Thrown === "error" ? plainError(form) : undefined;
	}
	if (DEV) {
		if (isRefusal(thrown) && copy !== null && typeof copy === "object") {
			refusalRoots.set(copy, refusalRoot(thrown));
		}
		try {
			if (form.Thrown === "error") {
				reportLoss(thrown as Error, form, kinds!.get(form)!, lostFields!, site, diag);
			} else {
				reportNonPlain(thrown, form, site, diag);
			}
		} catch {}
	}
	return copy;
}

function plainError(form: ISerializedError): Error {
	const error = new Error(form.Message);
	if (form.Name !== "Error") {
		hidden(error, "name", form.Name);
	}
	return error;
}

function reportLoss(
	thrown: Error,
	form: ISerializedError,
	kind: IErrorKind,
	lostFields: readonly string[],
	site: IRejectionSite,
	diag: () => IDiagService
): void {
	if (
		!kind.exact &&
		!isActionFailure(thrown) &&
		!isPlatformClass(constructorOf(thrown), kind.className === undefined ? kind.native : undefined) &&
		!isNodeAbortError(thrown, form)
	) {
		const className = constructorNameOf(thrown) ?? form.Name;
		const arrivedAs = kind.className?.replace(/^treflex\//, "") ?? kind.native;
		diag().emitOnce(
			JSON.stringify([
				"effect/class-rejection",
				className
			]),
			{
				severity: "warn",
				code: "effect/class-rejection",
				message:
					`[treflex] ${site.where}: the implementation rejected with an instance of ${className}, and the action was thrown a copy that is ` +
					`${arrivedAs}, not ${className}. A copy is rebuilt as a native error type or one of treflex's, so instanceof ${className} is false ` +
					`for it. Answer a failure the app handles with data, and throw ${className} from a yield* helper in the action ` +
					`(docs/reference/effects.md#a-failure-the-app-handles).`,
				data: {
					...site.data,
					className,
					arrivedAs
				}
			}
		);
	}
	for (const field of lostFields) {
		diag().emitOnce(
			JSON.stringify([
				"effect/rejection-field-lost",
				form.Name,
				field
			]),
			{
				severity: "warn",
				code: "effect/rejection-field-lost",
				message:
					`[treflex] ${site.where}: the implementation rejected with ${form.Name}, whose field "${field}" is not plain data, so the action's ` +
					`copy of the error lost it or holds it changed. Carry it as plain data: epoch milliseconds for a Date, entries for a Map ` +
					`(docs/reference/write-path.md#what-crosses-into-an-action).`,
				data: {
					...site.data,
					name: form.Name,
					field
				}
			}
		);
	}
}

function reportNonPlain(thrown: unknown, form: ISerializedThrow, site: IRejectionSite, diag: () => IDiagService): void {
	if (isActionFailure(thrown)) {
		return;
	}
	let strict: ReturnType<typeof cloneStrict> | undefined;
	try {
		strict = cloneStrict(thrown);
	} catch {
		if (form.Thrown === "value" && form.Data !== undefined) {
			return;
		}
	}
	if (strict?.ok) {
		return;
	}
	const className =
		thrown === null || typeof thrown !== "object"
			? typeof thrown
			: strict?.path.length === 0
				? strict.kind
				: (constructorNameOf(thrown) ?? "Object");
	const what =
		thrown === null || typeof thrown !== "object"
			? `a ${className}`
			: strict === undefined
				? className === "Object"
					? "an object"
					: `an instance of ${className}`
				: strict.path.length === 0
					? `an instance of ${className}`
					: `${className === "Object" ? "an object" : `an instance of ${className}`} holding a ${strict.kind} at [${strict.path.map(String).join(".")}]`;
	diag().emitOnce(
		JSON.stringify([
			"effect/class-rejection",
			className
		]),
		{
			severity: "warn",
			code: "effect/class-rejection",
			message:
				`[treflex] ${site.where}: the implementation rejected with ${what}, which is neither an error nor plain data, and the action ` +
				`was thrown its JSON form. Answer a failure the app handles with data, and reject with an Error only for what the ` +
				`implementation didn't expect (docs/reference/effects.md#a-failure-the-app-handles).`,
			data: {
				...site.data,
				className,
				arrivedAs: "JSON"
			}
		}
	);
}

function constructorOf(error: object): unknown {
	try {
		return (
			Object.getPrototypeOf(error) as {
				constructor?: unknown;
			} | null
		)?.constructor;
	} catch {
		return undefined;
	}
}

function constructorNameOf(error: object): string | undefined {
	try {
		const name = (
			constructorOf(error) as
				| {
						name?: unknown;
				  }
				| undefined
		)?.name;
		return typeof name === "string" && name !== "" ? name : undefined;
	} catch {
		return undefined;
	}
}

// Node's internal AbortError is a JavaScript class that isn't a global.
function isNodeAbortError(error: Error, form: ISerializedError): boolean {
	try {
		return form.Name === "AbortError" && Object.hasOwn(error, "code") && (error as unknown as Record<string, unknown>).code === "ABORT_ERR";
	} catch {
		return false;
	}
}
