import type { IAction } from "../Types/IAction";
import type { IExternalSource } from "../Types/IExternalSource";
import type { IMessageContext } from "../Types/IReceiver";
import type { IResolvedOwner } from "./createResourceManager";
import type { IActionOutcome, IInternalDispatch, IRuntimeStoreReader } from "./processAction";
import { resolveDiag } from "./createDiagService";
import { copyAtSender } from "./crossing";

export interface IFanOutOptions {
	topic: string;
	data: Record<string, unknown>;
	publisherId: string;
}

export interface IFanOutContext {
	get: IRuntimeStoreReader;
	dispatch: IInternalDispatch;
}

/** Dispatches held back at their gates, each arrived and recorded, until `beginArrivals`. */
export interface IArrivals {
	begun: boolean;
	readonly starts: (() => void)[];
}

export function createArrivals(): IArrivals {
	return {
		begun: false,
		starts: []
	};
}

/** Lets the held arrivals start, in the order they arrived, each once nothing holds its entity or waits ahead of it. */
export function beginArrivals(arrivals: IArrivals): void {
	arrivals.begun = true;
	for (const start of arrivals.starts.splice(0)) {
		start();
	}
}

interface IDelivery {
	ownerId: string;
	owner: IResolvedOwner;
	handle: IAction<any>;
}

function deliveryTo(context: IFanOutContext, ownerId: string, handle: IAction<any>): IDelivery[] {
	const owner = context.get("runtime/resolveOwner")(ownerId);
	return owner
		? [
				{
					ownerId,
					owner,
					handle
				}
			]
		: [];
}

const ERROR_TOPIC = "Action/Error";

// The key is JSON because ids and topics are arbitrary text, and it carries a
// producer tag because the timer scheduler shares this emitOnce namespace.
function emitUnresolvedSource(context: IFanOutContext, topic: string, sourceId: string): void {
	resolveDiag(context.get).emitOnce(
		JSON.stringify([
			"fanOut",
			"source",
			topic,
			sourceId
		]),
		{
			severity: "warn",
			code: "receiver/unresolved",
			message:
				`[treflex] "${topic}" was not delivered to external source "${sourceId}": it declares the topic in Topics ` +
				"but implements no receivePublish. The message is lost.",
			data: {
				topic,
				ownerId: sourceId,
				receiverId: sourceId,
				kind: "source"
			}
		}
	);
}

function deliver(
	context: IFanOutContext,
	topic: string,
	publisherId: string,
	data: Record<string, unknown>,
	deliveries: readonly IDelivery[],
	sources: readonly IExternalSource[],
	unresolvedIds: readonly string[],
	arrivals: IArrivals
): void {
	const journal = context.get("runtime/journal");

	const deliverableSources: {
		source: IExternalSource;
		receive: NonNullable<IExternalSource["receivePublish"]>;
	}[] = [];
	const unresolved = [
		...unresolvedIds
	];
	for (const source of sources) {
		if (source.receivePublish) {
			deliverableSources.push({
				source,
				receive: source.receivePublish.bind(source)
			});
			continue;
		}
		unresolved.push(source.Id);
		emitUnresolvedSource(context, topic, source.Id);
	}

	if (journal.wants("message:deliver")) {
		const recipientIds = [
			...deliveries.map((entry) => entry.ownerId),
			...deliverableSources.map((entry) => entry.source.Id)
		];
		journal.append(
			unresolved.length > 0
				? {
						T: performance.now(),
						Kind: "message:deliver",
						Topic: topic,
						PublisherId: publisherId,
						RecipientIds: recipientIds,
						UnresolvedIds: unresolved
					}
				: {
						T: performance.now(),
						Kind: "message:deliver",
						Topic: topic,
						PublisherId: publisherId,
						RecipientIds: recipientIds
					}
		);
	}

	// Re-read at error time: receivers settle asynchronously.
	const journalReceiverError = (recipientId: string, error: unknown): void => {
		if (!journal.wants("receiver:error")) {
			return;
		}
		journal.append(
			{
				T: performance.now(),
				Kind: "receiver:error",
				Topic: topic,
				RecipientId: recipientId,
				PublisherId: publisherId
			},
			{
				error
			}
		);
	};

	const ctx = copyAtSender(
		{
			publisher: {
				Id: publisherId
			}
		},
		`publish "${topic}": the context`
	) as IMessageContext;
	for (const { ownerId, owner, handle } of deliveries) {
		context
			.dispatch(
				handle,
				owner.getState,
				owner.setState,
				() => ownerId,
				[
					data,
					ctx
				],
				{
					arrivals
				}
			)
			.catch((error: unknown) => {
				journalReceiverError(ownerId, error);
			});
	}

	for (const { source, receive } of deliverableSources) {
		try {
			Promise.resolve(receive(data, ctx)).catch((error: unknown) => {
				journalReceiverError(source.Id, error);
			});
		} catch (error) {
			journalReceiverError(source.Id, error);
		}
	}
}

export function fanOut(context: IFanOutContext, options: IFanOutOptions, arrivals: IArrivals): void {
	const { topic, publisherId } = options;
	const data = copyAtSender(options.data, `publish "${topic}": the payload`) as Record<string, unknown>;
	const receivers = context.get("runtime/receivers");
	const bindings = context.get("runtime/bindings");

	const deliveries: IDelivery[] = [];
	for (const receiverId of receivers.handling(topic)) {
		const handle = receivers.get(receiverId)!;
		for (const ownerId of bindings.boundTo(receiverId)) {
			deliveries.push(...deliveryTo(context, ownerId, handle));
		}
	}
	deliver(
		context,
		topic,
		publisherId,
		data,
		deliveries,
		context.get("runtime/externalSources").getSubscribers(topic),
		bindings.boundToUnregistered(),
		arrivals
	);
}

export function deliverToNearest(
	publisherId: string,
	data: {
		Type: string;
	} & Record<string, unknown>,
	context: IFanOutContext,
	arrivals: IArrivals
): void {
	const lookup = context.get("runtime/stateIdLookup")();
	const receivers = context.get("runtime/receivers");
	const bindings = context.get("runtime/bindings");
	const topic = data.Type;

	const publisherState = lookup[publisherId];
	if (!publisherState) {
		console.warn(
			`[treflex] publishToNearest called from $Id "${publisherId}" which is not in the state tree — ` +
				`the publisher must be a state node in the tree for ancestry routing to work.`
		);
		return;
	}
	const payload = copyAtSender(data, `publish "${topic}": the payload`) as Record<string, unknown>;

	const ancestors = publisherState.path.slice(0, -1).reverse();
	const deliveries: IDelivery[] = [];
	const unresolvedIds: string[] = [];
	let stoppedAt: {
		ownerId: string;
		receiverId: string;
	} | null = null;
	for (const ownerId of ancestors) {
		const receiverId = bindings.receiverOf(ownerId);
		if (receiverId === undefined) {
			continue;
		}
		const handle = receivers.get(receiverId);
		if (!handle) {
			unresolvedIds.push(ownerId);
			// Falling through would deliver to a scope that may not have claimed the topic.
			stoppedAt = {
				ownerId,
				receiverId
			};
			break;
		}
		if (receivers.handles(receiverId, topic)) {
			deliveries.push(...deliveryTo(context, ownerId, handle));
			break;
		}
	}

	if (stoppedAt) {
		const above = ancestors.slice(ancestors.indexOf(stoppedAt.ownerId) + 1).find((ownerId) => {
			const receiverId = bindings.receiverOf(ownerId);
			return receiverId !== undefined && receivers.handles(receiverId, topic);
		});
		resolveDiag(context.get).emitOnce(
			JSON.stringify([
				"scoped",
				topic,
				stoppedAt.ownerId,
				stoppedAt.receiverId
			]),
			{
				severity: "warn",
				code: "receiver/unresolved",
				message:
					`[treflex] publishToNearest "${topic}" from "${publisherId}" stopped at "${stoppedAt.ownerId}", whose receiver ` +
					`"${stoppedAt.receiverId}" isn't registered, so nothing heard it` +
					(above === undefined ? "." : `. "${above}" above it handles the topic and was not reached.`) +
					" Register the receiver at startup.",
				data: {
					topic,
					ownerId: stoppedAt.ownerId,
					receiverId: stoppedAt.receiverId,
					shadowedId: above ?? null,
					kind: "publish"
				}
			}
		);
	}

	deliver(context, topic, publisherId, payload, deliveries, [], unresolvedIds, arrivals);
}

export interface IErrorBoundary extends IDelivery {
	/** The ancestors passed on the way, each bound to a receiver that isn't registered. */
	passed: readonly string[];
}

/** The nearest ancestor of the entity, where it is now, bound to a registered receiver with an `Action/Error` case. */
export function errorBoundaryAbove(context: IFanOutContext, entityId: string): IErrorBoundary | null {
	const path = context.get("runtime/stateIdLookup")()[entityId]?.path;
	if (!path) {
		return null;
	}
	const receivers = context.get("runtime/receivers");
	const bindings = context.get("runtime/bindings");
	const passed: string[] = [];
	for (const ownerId of path.slice(0, -1).reverse()) {
		const receiverId = bindings.receiverOf(ownerId);
		if (receiverId === undefined) {
			continue;
		}
		const handle = receivers.get(receiverId);
		if (!handle) {
			passed.push(ownerId);
			continue;
		}
		if (receivers.handles(receiverId, ERROR_TOPIC)) {
			const [delivery] = deliveryTo(context, ownerId, handle);
			if (delivery) {
				return {
					...delivery,
					passed
				};
			}
		}
	}
	return null;
}

/** Delivers `Action/Error` to one error boundary, starting it straight after arrival, and hands `settled` how its action ended. */
export function deliverFailure(
	context: IFanOutContext,
	errorBoundary: IErrorBoundary,
	publisherId: string,
	payload: Record<string, unknown>,
	settled: (outcome: IActionOutcome, actionId: string) => void
): void {
	const journal = context.get("runtime/journal");
	if (journal.wants("message:deliver")) {
		journal.append({
			T: performance.now(),
			Kind: "message:deliver",
			Topic: ERROR_TOPIC,
			PublisherId: publisherId,
			RecipientIds: [
				errorBoundary.ownerId
			],
			...(errorBoundary.passed.length > 0
				? {
						UnresolvedIds: [
							...errorBoundary.passed
						]
					}
				: {})
		});
	}
	const arrivals = createArrivals();
	context
		.dispatch(
			errorBoundary.handle,
			errorBoundary.owner.getState,
			errorBoundary.owner.setState,
			() => errorBoundary.ownerId,
			[
				payload,
				{
					publisher: {
						Id: publisherId
					}
				}
			],
			{
				arrivals,
				settled
			}
		)
		.catch((error: unknown) => {
			if (error !== payload && journal.wants("receiver:error")) {
				journal.append(
					{
						T: performance.now(),
						Kind: "receiver:error",
						Topic: ERROR_TOPIC,
						RecipientId: errorBoundary.ownerId,
						PublisherId: publisherId
					},
					{
						error
					}
				);
			}
		});
	beginArrivals(arrivals);
}
