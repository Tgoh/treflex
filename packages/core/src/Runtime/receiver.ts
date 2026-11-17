import type { IPublishTopic } from "../Registries/IMessageRegistry";
import type { IReceivableResourceKey, IResourceDeliveryOf } from "../Registries/IResourceRegistry";
import type { ITimerKey, ITimerTickOf } from "../Registries/ITimerRegistry";
import type { IOpenGenerator } from "../Types/IAction";
import type { IEntity } from "../Types/IEntity";
import type { IHandleableKey, IMessageContext, IMessageOf, IReceiver, IReceiverId } from "../Types/IReceiver";

type MessageCase<T extends IEntity, P extends IPublishTopic> = (draft: T, message: IMessageOf<P>, ctx: IMessageContext) => IOpenGenerator;

type TimerCase<T extends IEntity, P extends ITimerKey> = (draft: T, tickData: ITimerTickOf<P>, ctx: IMessageContext) => IOpenGenerator;

type ResourceCase<T extends IEntity, P extends IReceivableResourceKey> = (
	draft: T,
	delivery: IResourceDeliveryOf<P>,
	ctx: IMessageContext
) => IOpenGenerator;

type Cases<T extends IEntity> = Partial<{
	[K in IHandleableKey]: K extends IPublishTopic
		? MessageCase<T, K>
		: K extends ITimerKey
			? TimerCase<T, K>
			: K extends IReceivableResourceKey
				? ResourceCase<T, K>
				: never;
}>;

// A cast computed key (`["X" as any]: fn`) gives the cases an index signature,
// which must not be mapped to never with the misspelt keys.
type LiteralKeys<K> = K extends unknown ? (string extends K ? never : number extends K ? never : K) : never;

// Symbol.for by the cross-module tag-symbol rule (see REGION_OP in open.ts).
const RECEIVER_CASE = Symbol.for("treflex.receiverCase");

type ICase = (draft: never, message: never, ctx: never) => IOpenGenerator;

export function caseOf(action: unknown, message: unknown): ICase | undefined {
	const lookup = typeof action === "function" ? (action as unknown as Record<symbol, unknown>)[RECEIVER_CASE] : undefined;
	if (typeof lookup !== "function" || typeof message !== "object" || message === null) {
		return undefined;
	}
	return (lookup as (type: unknown) => ICase | undefined)(
		(
			message as {
				Type?: unknown;
			}
		).Type
	);
}

// Curried because TypeScript cannot take T explicitly and infer C in one call.
export function receiver<T extends IEntity>(
	id: string
): <C extends Cases<T> & { [K in LiteralKeys<Exclude<keyof C, IHandleableKey>>]: never }>(
	cases: C
) => IReceiver<T, keyof C & IHandleableKey> {
	return <C extends Cases<T> & { [K in LiteralKeys<Exclude<keyof C, IHandleableKey>>]: never }>(
		cases: C
	): IReceiver<T, keyof C & IHandleableKey> => {
		const caseFor = (type: unknown): ((draft: T, message: any, ctx: any) => IOpenGenerator) | undefined =>
			typeof type === "string" && Object.hasOwn(cases, type)
				? (cases as Record<string, ((draft: T, message: any, ctx: any) => IOpenGenerator) | undefined>)[type]
				: undefined;
		const handle: IReceiver<T, keyof C & IHandleableKey>["handle"] = function* (draft, message, ctx) {
			const fn = caseFor(
				(
					message as {
						Type: string;
					}
				).Type
			);
			if (fn) {
				yield* fn(draft, message, ctx);
			}
		};
		Object.defineProperty(handle, RECEIVER_CASE, {
			value: caseFor
		});
		// Records name an action by its function name, and every receiver
		// built here would otherwise be called by whatever this local binding
		// is spelled.
		Object.defineProperty(handle, "name", {
			value: id
		});
		return {
			Id: id as IReceiverId<T>,
			Topics: Object.freeze(Object.keys(cases)),
			handle
		};
	};
}
