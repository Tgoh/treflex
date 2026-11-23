import type { IActionContext } from "../Types/IActionContext";
import type { IEffect } from "../Types/IEffect";
import { declare } from "../Runtime/effectDeclarations";
import { refuseReservedType } from "../Runtime/operations";

type IIsUnion<T, U = T> = T extends unknown
	? [
			U
		] extends [
			T
		]
		? false
		: true
	: never;

/** The descriptor's `Type`, when it is exactly one string literal; `never` otherwise. */
export type SingleType<E extends IEffect> = string extends E["Type"] ? never : true extends IIsUnion<E["Type"]> ? never : E["Type"];

type IDistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A creator's payload: the descriptor without its `Type`, kept per variant for a union. */
export type IEffectPayload<E extends IEffect> = IDistributiveOmit<E, "Type" | "treflex:open">;

type IHasNoFields<P> = P extends unknown
	? [
			keyof P
		] extends [
			never
		]
		? true
		: false
	: never;

type IPayloadArgs<E extends IEffect> = [
	IHasNoFields<IEffectPayload<E>>
] extends [
	true
]
	? []
	: {} extends IEffectPayload<E>
		? [
				payload?: IEffectPayload<E>
			]
		: [
				payload: IEffectPayload<E>
			];

export interface IEffectDeclarationOptions {
	settles?: "sync";
	redact?: boolean;
	returns?: "module";
	/**
	 * The server tolerates this request arriving twice, so an action a restore resumes at a wait on
	 * this type sends it again. See docs/reference/effects.md#options.
	 *
	 * @experimental
	 */
	idempotent?: boolean;
}

/** The creator `defineEffect` returns for a type that may suspend. */
export interface IEffectCreator<E extends IEffect, R> {
	(...args: IPayloadArgs<E>): Generator<E, R, any>;
	readonly Type: E["Type"];
	readonly settles?: never;
}

/** The creator `defineEffect` returns for a `settles: "sync"` type. */
export interface ISyncEffectCreator<E extends IEffect, R> {
	(...args: IPayloadArgs<E>): Generator<E, R, any>;
	readonly Type: E["Type"];
	readonly settles: "sync";
}

/** What `implementation` returns and `registerImplementation` takes. */
export interface IImplementationTag<E extends IEffect = IEffect, R = unknown> {
	readonly Type: E["Type"];
	readonly fn: (effect: E, action?: IActionContext) => R | PromiseLike<R>;
}

/** The compile error for an implementation of a `settles: "sync"` type that can return a promise. */
export interface ISyncImplementationReturnsAPromise {
	readonly "a settles: sync effect's implementation must not return a promise": never;
}

type ISyncReturnCheck<F extends (...args: any[]) => any> = 0 extends 1 & ReturnType<F>
	? unknown
	: [
				Extract<ReturnType<F>, PromiseLike<any>>
			] extends [
				never
			]
		? unknown
		: ISyncImplementationReturnsAPromise;

const OPTION_KEYS = new Set([
	"settles",
	"redact",
	"returns",
	"idempotent"
]);

function validate(type: unknown, options: unknown): IEffectDeclarationOptions {
	if (typeof type !== "string" || type.length === 0) {
		throw new TypeError(`[treflex] defineEffect: the effect type must be a non-empty string, not ${String(type)}.`);
	}
	refuseReservedType(type, `defineEffect("${type}")`);
	if (options === undefined) {
		return {};
	}
	if (options === null || typeof options !== "object") {
		throw new TypeError(`[treflex] defineEffect("${type}"): options must be an object.`);
	}
	const record = options as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!OPTION_KEYS.has(key)) {
			throw new TypeError(
				`[treflex] defineEffect("${type}"): unknown option "${key}". The options are settles, redact, returns and idempotent.`
			);
		}
	}
	if (record.settles !== undefined && record.settles !== "sync") {
		throw new TypeError(`[treflex] defineEffect("${type}"): settles must be "sync" or absent, not ${JSON.stringify(record.settles)}.`);
	}
	if (record.redact !== undefined && typeof record.redact !== "boolean") {
		throw new TypeError(`[treflex] defineEffect("${type}"): redact must be a boolean.`);
	}
	if (record.returns !== undefined && record.returns !== "module") {
		throw new TypeError(`[treflex] defineEffect("${type}"): returns must be "module" or absent, not ${JSON.stringify(record.returns)}.`);
	}
	if (record.idempotent !== undefined && typeof record.idempotent !== "boolean") {
		throw new TypeError(`[treflex] defineEffect("${type}"): idempotent must be a boolean.`);
	}
	return record as IEffectDeclarationOptions;
}

/**
 * Declares an effect type at module load and returns its typed creator. What
 * call sites and the record rely on belongs here, not on the implementation:
 * `settles: "sync"` (the yield gives up no event-loop turn), `redact: true`
 * (the record keeps only the Type), `returns: "module"` (the result is
 * exempt from the copy and may carry module-level functions), and
 * `idempotent: true` (a resumed action may send the request a second time).
 */
export function defineEffect<E extends IEffect, R>(
	type: SingleType<E>,
	options: {
		settles: "sync";
		redact?: boolean;
		returns?: "module";
	}
): ISyncEffectCreator<E, R>;
export function defineEffect<E extends IEffect, R>(
	type: SingleType<E>,
	options?: {
		settles?: never;
		redact?: boolean;
		returns?: "module";
		/** @experimental */
		idempotent?: boolean;
	}
): IEffectCreator<E, R>;
export function defineEffect(
	type: string,
	options?: IEffectDeclarationOptions
): IEffectCreator<IEffect, unknown> | ISyncEffectCreator<IEffect, unknown> {
	const valid = validate(type, options);
	declare(type, {
		settles: valid.settles,
		redact: valid.redact === true,
		returns: valid.returns,
		idempotent: valid.idempotent === true
	});
	const creator = function* (payload?: object): Generator<IEffect, unknown, any> {
		return yield {
			...payload,
			Type: type
		};
	};
	Object.defineProperty(creator, "Type", {
		value: type
	});
	if (valid.settles === "sync") {
		Object.defineProperty(creator, "settles", {
			value: "sync"
		});
	}
	return creator as unknown as IEffectCreator<IEffect, unknown>;
}

/**
 * Types an implementation against its declaration and returns the tag
 * `registerImplementation` takes. A `settles: "sync"` type's implementation
 * returns its result directly, never a promise.
 */
export function implementation<E extends IEffect, R, F extends (effect: E, action?: IActionContext) => R>(
	declaration: ISyncEffectCreator<E, R>,
	fn: F & ISyncReturnCheck<F>
): IImplementationTag<E, R>;
export function implementation<E extends IEffect, R>(
	declaration: IEffectCreator<E, R>,
	fn: (effect: E, action?: IActionContext) => R | PromiseLike<R>
): IImplementationTag<E, R>;
export function implementation(
	declaration: {
		Type: string;
	},
	fn: (effect: IEffect, action?: IActionContext) => unknown
): IImplementationTag {
	if (typeof fn !== "function") {
		throw new TypeError(`[treflex] implementation("${declaration.Type}"): the implementation must be a function.`);
	}
	return {
		Type: declaration.Type,
		fn
	};
}
