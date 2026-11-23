import { errorClassNameOf } from "./errorClasses";
import { jsonEquals } from "./jsonEquals";
import { cloneStrict } from "./valueCodec";

/**
 * What `Name` and `Message` carry when no usable value could be read off the error: the field was
 * absent, it answered undefined, or its getter threw. It reads as "no name was available", never as
 * a name to match.
 */
export const UNREADABLE = "(unreadable)";

export const NESTED_THROW_DEPTH = 8;

export const NESTED_THROW_COUNT = 100;

/**
 * How many prototypes a walk up a thrown value's chain reads. An error whose chain goes on past them, or
 * comes back to a prototype it passed, is rebuilt as an `Error`.
 */
export const PROTOTYPE_WALK_STEPS = 64;

/**
 * A native error type an error is rebuilt as, where the environment has it; where it doesn't, the error
 * is rebuilt as an `Error`. Absent from a serialized error, it is `Error`.
 */
export type INativeErrorName =
	| "TypeError"
	| "RangeError"
	| "SyntaxError"
	| "ReferenceError"
	| "EvalError"
	| "URIError"
	| "AggregateError"
	| "SuppressedError"
	| "InternalError"
	| "DOMException"
	| "WebAssembly.CompileError"
	| "WebAssembly.LinkError"
	| "WebAssembly.RuntimeError";

/**
 * A thrown value as data: what a `response` record, the `Action/Error` payload and diag data carry,
 * and the form an implementation's rejection is rebuilt from before an action is thrown it.
 * See docs/reference/failure.md#the-actionerror-payload.
 */
export type ISerializedThrow =
	| {
			Thrown: "error";
			/** `UNREADABLE` when no usable value was read. */
			Name: string;
			/** `UNREADABLE` when no usable value was read. */
			Message: string;
			/** Absent when the error had no stack, or reading it threw. */
			Stack?: string;
			/**
			 * The enumerable own string-keyed fields other than `name`, `message`, `stack` and `cause`, and
			 * other than `errors` on an `AggregateError` and `error` and `suppressed` on a `SuppressedError`,
			 * which are carried in `Errors`, `Error` and `Suppressed`. Each is its JSON round trip. Absent
			 * when none survives. An error named `"SuppressedError"` that has its own `error` and
			 * `suppressed`, as a compiler's helper makes where the engine has no `SuppressedError`, counts as
			 * a `SuppressedError` here.
			 */
			Fields?: Record<string, unknown>;
			/**
			 * The nearest native error type up the error's prototype chain, matched by prototype, or for an
			 * error from another realm by the name of a constructor built into that realm, so an app's class
			 * named after a native type is passed over; an error tagged `[object DOMException]` with a
			 * `DOMException` prototype up its chain is a `DOMException` where the environment has one.
			 * Absent, it is `Error`.
			 */
			Native?: INativeErrorName;
			/**
			 * The durable name, such as `"treflex/EntityGoneError"`, of the nearest of treflex's own error
			 * classes up the error's prototype chain: the error's class, or the one an app's class extends.
			 */
			Class?: string;
			/** The error's own `cause`, serialized the same way. */
			Cause?: ISerializedThrow;
			/** An `AggregateError`'s `errors`, serialized the same way. */
			Errors?: ISerializedThrow[];
			/** A `SuppressedError`'s `error`, serialized the same way. */
			Error?: ISerializedThrow;
			/** A `SuppressedError`'s `suppressed`, serialized the same way. */
			Suppressed?: ISerializedThrow;
	  }
	| {
			Thrown: "value";
			/** The value's JSON round trip. Absent for `undefined`, and for a value JSON can't carry at all. */
			Data?: unknown;
	  };

type ISerializedError = Extract<
	ISerializedThrow,
	{
		Thrown: "error";
	}
>;

export interface IThrowReading {
	/** False, no stack is read, and `originals` maps each error's form to the error it was read from. */
	readonly stacks: boolean;
	readonly originals?: Map<object, Error> | undefined;
	/**
	 * Collects the thrown error's own fields that the JSON round trip dropped or changed. A field holding
	 * `undefined` is dropped without being collected, and a field kept whose comparison couldn't run,
	 * such as one nested too deep for it, is not collected.
	 */
	readonly lostFields?: string[] | undefined;
	/** Whether a thrown value that isn't an error and has no exact JSON form is warned of on the console. */
	readonly warn?: boolean | undefined;
	/** Maps each error's form to the kind it was read as. */
	readonly kinds?: Map<object, IErrorKind> | undefined;
}

const FULL: IThrowReading = {
	stacks: true,
	warn: true
};

/** A thrown value as data. It never throws. See docs/reference/failure.md#the-actionerror-payload. */
export function serializeThrow(thrown: unknown): ISerializedThrow {
	return readThrow(thrown, FULL);
}

export function readThrow(thrown: unknown, reading: IThrowReading): ISerializedThrow {
	const chain = errorChainOf(thrown);
	if (chain !== undefined) {
		return readError(
			thrown as Error,
			chain,
			reading,
			{
				path: [],
				nested: 0
			},
			0
		);
	}
	return readValue(thrown, reading.warn === true);
}

function readNested(thrown: unknown, reading: IThrowReading, walk: IWalk, depth: number, counted = false): ISerializedThrow | undefined {
	if (onPath(walk.path, thrown)) {
		return undefined;
	}
	const chain = errorChainOf(thrown);
	if (chain === undefined && !counted) {
		return readValue(thrown, false);
	}
	if (walk.nested >= NESTED_THROW_COUNT) {
		return undefined;
	}
	walk.nested++;
	return chain !== undefined ? readError(thrown as Error, chain, reading, walk, depth) : readValue(thrown, false);
}

interface IWalk {
	readonly path: object[];
	nested: number;
}

const NATIVE_NAMES: readonly string[] = [
	"Error",
	"TypeError",
	"RangeError",
	"SyntaxError",
	"ReferenceError",
	"EvalError",
	"URIError",
	"AggregateError",
	"SuppressedError",
	"InternalError",
	"DOMException",
	"WebAssembly.CompileError",
	"WebAssembly.LinkError",
	"WebAssembly.RuntimeError"
];

const nativeByName = new Map<string, new (...args: never[]) => Error>();
const nativeByPrototype = new Map<object, string>();
const nativeByConstructorName = new Map<string, string>();
const nativeConstructors = new Set<unknown>();
for (const name of NATIVE_NAMES) {
	const dot = name.indexOf(".");
	const native =
		dot < 0
			? (globalThis as Record<string, unknown>)[name]
			: ((globalThis as Record<string, unknown>)[name.slice(0, dot)] as Record<string, unknown> | undefined)?.[name.slice(dot + 1)];
	if (typeof native === "function") {
		nativeByName.set(name, native as new (...args: never[]) => Error);
		nativeByPrototype.set(native.prototype as object, name);
		nativeByConstructorName.set(name.slice(dot + 1), name);
		nativeConstructors.add(native);
	}
}

export function nativeErrorNamed(name: string): (new (...args: never[]) => Error) | undefined {
	return nativeByName.get(name);
}

export interface IErrorKind {
	readonly native: string;
	/** The durable name of the nearest of treflex's own classes up the chain. */
	readonly className?: string | undefined;
	/**
	 * Whether the error's own prototype is the one `className`, or else `native`, names, or it has no
	 * prototype. For an error from another realm other than a `DOMException`, the prototype `native`
	 * names is the one whose constructor is that realm's built-in of that name; this realm's built-ins
	 * count by their prototype alone. For a `DOMException`, it is a prototype whose own constructor is
	 * named `DOMException` and that inherits from no other such prototype. Where the environment has no
	 * `DOMException`, an error tagged as one with such a prototype up its chain is an exact `Error`, and
	 * so is an error whose prototype chain doesn't end within `PROTOTYPE_WALK_STEPS`.
	 */
	readonly exact: boolean;
}

interface IChain {
	/** Nearest first. */
	readonly prototypes: readonly object[];
	/** `"refused"` when a read threw, `"endless"` past `PROTOTYPE_WALK_STEPS` or at a prototype read before. */
	readonly end: "null" | "refused" | "endless";
}

function chainOf(value: object): IChain {
	const prototypes: object[] = [];
	try {
		for (let proto = Object.getPrototypeOf(value) as object | null; proto !== null; proto = Object.getPrototypeOf(proto) as object | null) {
			if (prototypes.length === PROTOTYPE_WALK_STEPS || prototypes.includes(proto)) {
				return {
					prototypes,
					end: "endless"
				};
			}
			prototypes.push(proto);
		}
	} catch {
		return {
			prototypes,
			end: "refused"
		};
	}
	return {
		prototypes,
		end: "null"
	};
}

function namesDOMException(proto: object): boolean {
	try {
		if (!Object.hasOwn(proto, "constructor")) {
			return false;
		}
		const made = (proto as Record<string, unknown>).constructor;
		return (
			typeof made === "function" &&
			(
				made as {
					name?: unknown;
				}
			).name === "DOMException"
		);
	} catch {
		return false;
	}
}

function isDOMExceptionPrototype(proto: object): boolean {
	return nativeByPrototype.get(proto) === "DOMException" || namesDOMException(proto);
}

function errorKindOf(error: object, chain: IChain): IErrorKind {
	if (chain.end === "endless") {
		return {
			native: "Error",
			exact: true
		};
	}
	const { prototypes } = chain;
	const tag = tagOf(error);
	// Under jsdom the global DOMException is jsdom's, while the platform's own (an AbortController's
	// reason) inherits this realm's Error.prototype, so the prototype walk would call it an Error.
	if (tag === "[object DOMException]" && prototypes.some(isDOMExceptionPrototype)) {
		if (!nativeByName.has("DOMException")) {
			return {
				native: "Error",
				exact: true
			};
		}
		if (chain.end === "null") {
			const [proto, ...below] = prototypes;
			return {
				native: "DOMException",
				exact: isDOMExceptionPrototype(proto!) && !below.some(namesDOMException)
			};
		}
	}
	let className: string | undefined;
	let exact = false;
	try {
		for (let depth = 0; depth < prototypes.length; depth++) {
			const proto = prototypes[depth]!;
			if (className === undefined) {
				className = errorClassNameOf(proto);
				exact = depth === 0;
			}
			const native = nativeByPrototype.get(proto);
			if (native !== undefined) {
				return {
					native,
					className,
					exact: className === undefined ? depth === 0 : exact
				};
			}
		}
		// An error from another realm reaches none of this realm's prototypes.
		for (let depth = 0; depth < prototypes.length; depth++) {
			const proto = prototypes[depth]!;
			const native = Object.hasOwn(proto, "constructor") ? builtInNativeFor((proto as Record<string, unknown>).constructor) : undefined;
			if (native !== undefined) {
				return {
					native,
					className,
					exact: className === undefined ? depth === 0 : exact
				};
			}
		}
	} catch {}
	return {
		native: "Error",
		className,
		exact: chain.end === "null" && prototypes.length === 0
	};
}

function nativeNamedFor(made: unknown): string | undefined {
	if (typeof made !== "function") {
		return undefined;
	}
	const name = (
		made as {
			name?: unknown;
		}
	).name;
	return typeof name === "string" ? nativeByConstructorName.get(name) : undefined;
}

// A bound function or a proxy also prints as native code, but without the name it answers to.
const BUILT_IN_SOURCE = /^function (\S+)\(\) \{\s*\[native code\]\s*\}$/;

function builtInNativeFor(made: unknown): string | undefined {
	const native = nativeNamedFor(made);
	if (native === undefined || nativeConstructors.has(made)) {
		return undefined;
	}
	return printsAsBuiltIn(made) ? native : undefined;
}

function printsAsBuiltIn(made: unknown): boolean {
	try {
		return BUILT_IN_SOURCE.exec(Function.prototype.toString.call(made))?.[1] === (made as Function).name;
	} catch {
		return false;
	}
}

function isGlobalUnderOwnName(made: unknown): boolean {
	try {
		const name = (
			made as {
				name?: unknown;
			}
		).name;
		return typeof name === "string" && name !== "" && (globalThis as Record<string, unknown>)[name] === made;
	} catch {
		return false;
	}
}

/**
 * Whether `made`, the constructor of an error that arrives as the native type `arrivesAs`, is the
 * platform's rather than one an app or a library defined: this realm's own constructor for `arrivesAs`,
 * or a constructor other than this realm's natives whose source is native code or that is a global
 * under its own name.
 */
export function isPlatformClass(made: unknown, arrivesAs: string | undefined): boolean {
	if (typeof made !== "function") {
		return false;
	}
	if (nativeConstructors.has(made)) {
		return arrivesAs !== undefined && nativeByName.get(arrivesAs) === made;
	}
	return printsAsBuiltIn(made) || isGlobalUnderOwnName(made);
}

function readError(error: Error, chain: IChain, reading: IThrowReading, walk: IWalk, depth: number): ISerializedError {
	// V8 formats `stack` lazily, which reads `message` again, so each read can fault on its own.
	const form: ISerializedError = {
		Thrown: "error",
		Name: readErrorText(error, "name") ?? UNREADABLE,
		Message: readErrorText(error, "message") ?? UNREADABLE
	};
	if (reading.stacks) {
		const stack = readErrorText(error, "stack");
		if (stack !== undefined) {
			form.Stack = stack;
		}
	} else {
		reading.originals?.set(form, error);
	}
	const kind = errorKindOf(error, chain);
	reading.kinds?.set(form, kind);
	if (kind.native !== "Error") {
		form.Native = kind.native as INativeErrorName;
	}
	if (kind.className !== undefined) {
		form.Class = kind.className;
	}
	const helperMade = kind.native !== "SuppressedError" && isHelperSuppressedError(error, form.Name);
	const nested = [
		...(NESTED_KEYS[kind.native] ?? NO_NESTED_KEYS),
		...(helperMade ? NESTED_KEYS.SuppressedError! : NO_NESTED_KEYS)
	];
	const fields = readFields(error, nested, depth === 0 ? reading.lostFields : undefined);
	if (fields !== undefined) {
		form.Fields = fields;
	}
	if (depth >= NESTED_THROW_DEPTH) {
		return form;
	}
	walk.path.push(error);
	try {
		const cause = readOwn(error, "cause");
		const causeForm = cause.has ? readNested(cause.value, reading, walk, depth + 1) : undefined;
		if (causeForm !== undefined) {
			form.Cause = causeForm;
		}
		if (kind.native === "AggregateError") {
			form.Errors = readErrors(error, reading, walk, depth + 1);
		}
		if (kind.native === "SuppressedError" || helperMade) {
			const inner = readOwn(error, "error");
			const innerForm = inner.has ? readNested(inner.value, reading, walk, depth + 1) : undefined;
			if (innerForm !== undefined) {
				form.Error = innerForm;
			}
			const suppressed = readOwn(error, "suppressed");
			const suppressedForm = suppressed.has ? readNested(suppressed.value, reading, walk, depth + 1) : undefined;
			if (suppressedForm !== undefined) {
				form.Suppressed = suppressedForm;
			}
		}
	} finally {
		walk.path.pop();
	}
	return form;
}

const NO_NESTED_KEYS: readonly string[] = [];

/** The own properties a native type carries in a field of the form other than `Fields`, by native name. */
export const NESTED_KEYS: Readonly<Record<string, readonly string[]>> = {
	AggregateError: [
		"errors"
	],
	SuppressedError: [
		"error",
		"suppressed"
	]
};

function isHelperSuppressedError(error: Error, name: string): boolean {
	try {
		return name === "SuppressedError" && Object.hasOwn(error, "error") && Object.hasOwn(error, "suppressed");
	} catch {
		return false;
	}
}

function onPath(path: readonly object[], value: unknown): boolean {
	return value !== null && typeof value === "object" && path.includes(value);
}

function readOwn(
	error: Error,
	key: string
):
	| {
			has: true;
			value: unknown;
	  }
	| {
			has: false;
	  } {
	try {
		if (Object.hasOwn(error, key)) {
			return {
				has: true,
				value: (error as unknown as Record<string, unknown>)[key]
			};
		}
	} catch {}
	return {
		has: false
	};
}

function readErrors(error: Error, reading: IThrowReading, walk: IWalk, depth: number): ISerializedThrow[] {
	const out: ISerializedThrow[] = [];
	try {
		const errors = (
			error as {
				errors?: unknown;
			}
		).errors;
		if (Array.isArray(errors)) {
			// An item on the path is left out uncounted, as a rebuilt copy holds none, so the index needs a
			// bound of its own.
			const length = Math.min(errors.length, NESTED_THROW_COUNT);
			for (let i = 0; i < length && walk.nested < NESTED_THROW_COUNT; i++) {
				const form = readNested(errors[i], reading, walk, depth, true);
				if (form !== undefined) {
					out.push(form);
				}
			}
		}
	} catch {}
	return out;
}

function readValue(thrown: unknown, warn: boolean): ISerializedThrow {
	let data: unknown;
	let carried = true;
	try {
		const text = JSON.stringify(thrown);
		data = text === undefined ? undefined : JSON.parse(text);
	} catch {
		data = undefined;
		carried = false;
	}
	if (warn && (carried ? !sameAfterRoundTrip(thrown, data) : thrown !== undefined)) {
		try {
			console.warn(
				"[treflex] journal: a non-Error throw does not survive JSON serialization — its records (and the Action/Error " +
					"payload an error boundary hears) carry a different value than the live run saw. Throw an Error or plain data.",
				thrown
			);
		} catch {}
	}
	if (data === undefined) {
		return {
			Thrown: "value"
		};
	}
	return {
		Thrown: "value",
		Data: data
	};
}

/** Whether `parsed`, the JSON round trip of `value`, is the same data; true when the comparison can't run. */
function sameAfterRoundTrip(value: unknown, parsed: unknown): boolean {
	try {
		return jsonEquals(value, parsed);
	} catch {
		return true;
	}
}

const isErrorBuiltin = (
	Error as {
		isError?: (value: unknown) => boolean;
	}
).isError;

function tagOf(value: object): string | undefined {
	try {
		return Object.prototype.toString.call(value);
	} catch {
		return undefined;
	}
}

// Error.isError's test where it is missing: the tag shows the error slot only when no
// Symbol.toStringTag is defined up the chain, so an object tagged "Error" fails it.
function isErrorBySlot(value: object): boolean {
	if (tagOf(value) !== "[object Error]") {
		return false;
	}
	try {
		return !(Symbol.toStringTag in value);
	} catch {
		return false;
	}
}

/** The prototype chain of `thrown`, read once, when it is an error; undefined for any other value. */
function errorChainOf(thrown: unknown): IChain | undefined {
	if (thrown === null || typeof thrown !== "object") {
		return undefined;
	}
	let builtIn = false;
	if (isErrorBuiltin !== undefined) {
		// A polyfill can read the tag, whose getter can throw.
		try {
			builtIn = isErrorBuiltin(thrown) === true;
		} catch {}
	}
	const chain = chainOf(thrown);
	if (builtIn || chain.prototypes.includes(Error.prototype)) {
		return chain;
	}
	if (tagOf(thrown) === "[object DOMException]") {
		return chain.prototypes.some(namesDOMException) ? chain : undefined;
	}
	return isErrorBuiltin === undefined && isErrorBySlot(thrown) ? chain : undefined;
}

export function readErrorText(error: Error, key: "name" | "message" | "stack"): string | undefined {
	try {
		const value = error[key];
		if (value === undefined) {
			return undefined;
		}
		return typeof value === "string" ? value : String(value);
	} catch {
		return undefined;
	}
}

function readFields(error: Error, nested: readonly string[], lost: string[] | undefined): Record<string, unknown> | undefined {
	let fields: Record<string, unknown> | undefined;
	let keys: string[];
	try {
		keys = Object.keys(error);
	} catch {
		return undefined;
	}
	for (const key of keys) {
		if (key === "name" || key === "message" || key === "stack" || key === "cause" || nested.includes(key)) {
			continue;
		}
		let value: unknown;
		let parsed: unknown;
		try {
			value = (error as unknown as Record<string, unknown>)[key];
			const text = JSON.stringify(value);
			if (text === undefined) {
				if (value !== undefined) {
					lost?.push(key);
				}
				continue;
			}
			parsed = JSON.parse(text);
		} catch {
			lost?.push(key);
			continue;
		}
		fields ??= {};
		Object.defineProperty(fields, key, {
			value: parsed,
			enumerable: true,
			writable: true,
			configurable: true
		});
		if (lost !== undefined && changedByRoundTrip(value, parsed)) {
			lost.push(key);
		}
	}
	return fields;
}

/** Whether a kept field's JSON round trip `parsed` differs from `value`; false when the check can't run. */
function changedByRoundTrip(value: unknown, parsed: unknown): boolean {
	try {
		return !(cloneStrict(value).ok && jsonEquals(value, parsed));
	} catch {
		return false;
	}
}
