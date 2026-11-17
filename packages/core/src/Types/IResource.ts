import type {
	IResourceTypeMessageOf,
	IResourceTypeMethodsOf,
	IResourceTypeName,
	IResourceTypeParamsOf,
	IResourceTypeSupplyOf,
	IResourceTypeSupplyResponseOf,
	IResourceTypeValueOf
} from "../Registries/IResourceRegistry";
import type { ISerializedThrow } from "../Utility/serializeThrow";

export interface IEnded {
	Reason: string;
	Error?: ISerializedThrow;
}

export function isEnded<E extends object>(
	e: E
): e is Extract<
	E,
	{
		$Ended: IEnded;
	}
> {
	return "$Ended" in e;
}

export type IResourceStatus =
	| {
			State: "none";
	  }
	| {
			State: "pending";
			Waiting: "setup" | "paused" | "type" | "receiver";
	  }
	| {
			State: "live";
			Detail?: string;
	  }
	| {
			State: "ended";
			Reason: string;
			Error?: ISerializedThrow;
	  };

export type IResourceRetireReason = "replaced" | "closed" | "ended" | "disposed";

export interface IResourceTypeOptions {
	/**
	 * A receiver's throw ends the instance with "receiver-failed", dropping the messages
	 * queued behind it, rather than failing that one message and delivering the next.
	 */
	endOnReceiverFailure?: boolean;
}

export interface IResourceMethodContext {
	signal: AbortSignal;
}

// A type with no Methods accepts no handler names: a mapped type over
// `keyof never` would accept any. An empty object type would too, since it
// skips the excess-property check, so the no-methods form maps every name
// to never.
export type IResourceMethodHandlers<T extends IResourceTypeName> = [
	IResourceTypeMethodsOf<T>
] extends [
	never
]
	? {
			[name: string]: never;
		}
	: {
			[O in keyof IResourceTypeMethodsOf<T>]: IResourceTypeMethodsOf<T>[O] extends (...args: infer A) => infer R
				? (ctx: IResourceMethodContext, ...args: A) => R | Promise<R>
				: never;
		};

export interface IResourceContext<T extends IResourceTypeName = IResourceTypeName> {
	/** Resolves once the message is queued, never on its delivery. */
	emit(message: IResourceTypeMessageOf<T>): Promise<void>;
	/** Calls back once, from the manager's drain, when none of this instance's messages is queued or being delivered. */
	onIdle(callback: () => void): void;
	methods(handlers: IResourceMethodHandlers<T>): void;
	onSupply(
		handler: (value: IResourceTypeSupplyOf<T>) => IResourceTypeSupplyResponseOf<T> | Promise<IResourceTypeSupplyResponseOf<T>>
	): void;
	expose(value: IResourceTypeValueOf<T>, release?: (value: IResourceTypeValueOf<T>) => void): void;
	run<R>(effect: Generator<unknown, R, any>): Promise<R>;
	status(detail?: string): void;
	readonly resumeFrom: string | number | boolean | null | undefined;
	end(reason?: string): void;
	readonly signal: AbortSignal;
	readonly ownerId: string;
	readonly key: string;
}

// Setup is the synchronous part of the call: it ends at the first await or
// the return. A rejection ends the instance with "failed"; any other return
// value means nothing.
export type IResourceImplementation<T extends IResourceTypeName = IResourceTypeName> = (
	params: IResourceTypeParamsOf<T>,
	r: IResourceContext<T>
) => unknown;

// The manager's view of any type's surface and implementation. The typed
// forms above are what registration checks; the runtime holds them erased.
export interface IUntypedResourceContext {
	emit(message: unknown): Promise<void>;
	onIdle(callback: () => void): void;
	methods(handlers: Record<string, (ctx: IResourceMethodContext, ...args: any[]) => unknown>): void;
	onSupply(handler: (value: any) => unknown): void;
	expose(value: unknown, release?: (value: any) => void): void;
	run<R>(effect: Generator<unknown, R, any>): Promise<R>;
	status(detail?: string): void;
	readonly resumeFrom: string | number | boolean | null | undefined;
	end(reason?: string): void;
	readonly signal: AbortSignal;
	readonly ownerId: string;
	readonly key: string;
}

export type IUntypedResourceImplementation = (params: any, r: IUntypedResourceContext) => unknown;
