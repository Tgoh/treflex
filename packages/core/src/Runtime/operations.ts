import type { IAnswerEffect } from "../Effects/answer";
import type { IAskEffect } from "../Effects/ask";
import type { ICloseResourceEffect } from "../Effects/closeResource";
import type { IOpenResourceEffect } from "../Effects/openResource";
import type { IParallelEffect } from "../Effects/parallel";
import type { IBranchOutcome, IParallelSettledEffect } from "../Effects/parallelSettled";
import type { IPublishEffect } from "../Effects/publish";
import type { IPublishToNearestEffect } from "../Effects/publishToNearest";
import type { IRegisterDataSourceEffect } from "../Effects/registerDataSource";
import type { IResourceMethodEffect } from "../Effects/resource";
import type { IStartTimerEffect } from "../Effects/startTimer";
import type { IStopTimerEffect } from "../Effects/stopTimer";
import type { IUnregisterDataSourceEffect } from "../Effects/unregisterDataSource";
import type { IEffect } from "../Types/IEffect";
import type { IRead } from "../Types/ISelector";
import type { IBranchEnd, IStartBranch } from "./branches";
import type { IFiber } from "./Fiber";
import type { IFiberContext } from "./processAction";
import { v4 as uuidv4 } from "uuid";
import { type IStartEffect, START_TARGET_NODE } from "../Effects/start";
import { serializeThrow } from "../Utility/serializeThrow";
import { clone, isFrozenCopy } from "../Utility/valueCodec";
import { AnswerOutsideOwnerError, AskRefusedError } from "./askErrors";
import { runFanOut } from "./branches";
import { resolveDiag } from "./createDiagService";
import { copyAtSender, copyEffectInput, copyListAtSender } from "./crossing";
import { EntityGoneError } from "./entityGoneError";
import { fiberSignal } from "./Fiber";
import { beginArrivals, createArrivals, deliverToNearest, fanOut, type IFanOutContext } from "./fanOut";
import { TreflexRefusal } from "./refusal";

/** What the fiber driver carries out itself. Nothing is registered for these, and nothing can replace one. */
export type IRuntimeOperation =
	| IStartEffect
	| IParallelEffect
	| IParallelSettledEffect
	| IPublishEffect
	| IPublishToNearestEffect
	| IStartTimerEffect
	| IStopTimerEffect
	| IRegisterDataSourceEffect
	| IUnregisterDataSourceEffect
	| IOpenResourceEffect
	| ICloseResourceEffect
	| IResourceMethodEffect
	| IAskEffect
	| IAnswerEffect;

type IOperationType = IRuntimeOperation["Type"];

type IOperationOf<K extends IOperationType> = Extract<
	IRuntimeOperation,
	{
		Type: K;
	}
>;

export interface IOperationDriver {
	readonly startBranch: IStartBranch;
	/** Runs `then` once the fiber has resumed past this yield's park. */
	afterResume(then: () => void): void;
	settle(end: IBranchEnd): void;
}

interface IOperationCase<O extends IRuntimeOperation> {
	/** What the fiber parks on: a value, or a promise it waits for. With `settles: "sync"`, the value it resumes with at once. */
	run(operation: O, ctx: IFiberContext<unknown>, driver: IOperationDriver): unknown;
	/** The yield gives up no turn, as a `settles: "sync"` effect's doesn't. */
	settles?: "sync";
	/** `run` returns nothing to park on: the fiber parks until `driver.settle`. */
	settledByDriver?: true;
	/** The input copy. Absent, the whole descriptor is copied and frozen, as an effect's is. */
	copy?(operation: O): O;
	/** The effect record's descriptor. Absent, it is the copied descriptor. */
	descriptor?(operation: O): unknown;
	/** The response record's value. Absent, it is a copy of the result. */
	response?(operation: O, result: unknown): unknown;
	/** What the generator resumes with. Absent, a strict clone of the result. */
	settle?(value: unknown): unknown;
	/** Rejects only with a throw of the action's own code, never with a stop's consequence, so a rejection after a stop is still a failure. */
	rejectsWithOwnFailure?: true;
}

function refuseInRun(ctx: IFiberContext<unknown>, type: string): void {
	const origin = ctx.origin;
	if (origin?.Kind === "resource:run") {
		throw new TreflexRefusal(
			`[treflex] r.run: resource "${origin.Key}" on "${origin.OwnerId}" yielded "${type}", which r.run refuses — a resource's ` +
				`own work is one-shot effects against its owner. Open, close and schedule from the owner's actions instead.`
		);
	}
}

// At the park rather than the yield, so an ask its own refusal stops never reports.
function reportDeliveryPark(ctx: IFiberContext<unknown>, type: string): void {
	const origin = ctx.origin;
	if (origin?.Kind !== "resource:deliver") {
		return;
	}
	resolveDiag(ctx.env.runtimeStoreReader).emitOnce(
		JSON.stringify([
			"resource/receiver-waiting",
			origin.Key,
			origin.OwnerId,
			type
		]),
		{
			severity: "warn",
			code: "resource/receiver-waiting",
			message:
				`[treflex] the receiver for resource "${origin.Key}" on "${origin.OwnerId}" waited on "${type}" — every later ` +
				`delivery to the cell waits behind it. Yield it through start from the receiver instead.`,
			data: {
				key: origin.Key,
				ownerId: origin.OwnerId,
				effectType: type
			}
		}
	);
}

function refuseAsk(ctx: IFiberContext<unknown>, ownerId: string): void {
	const origin = ctx.origin;
	if (origin?.Kind === "resource:run") {
		throw new AskRefusedError("in-run", origin.Key, origin.OwnerId, ownerId);
	}
	const step = ctx.step;
	if (step.fiber.branch) {
		throw new AskRefusedError("in-branch", step.name, step.hold?.entityId ?? ctx.env.entityId, ownerId);
	}
	if (step.hold && !step.fiber.open) {
		throw new AskRefusedError("outside-open", step.hold.actionName, step.hold.entityId, ownerId);
	}
}

// Queued, so an owner's disposal in the same task reads as that, ahead of this cancellation.
function abandonOnStop(fiber: IFiber, parked: Promise<unknown>, abandon: () => void): void {
	const listener = (): void => {
		queueMicrotask(abandon);
	};
	if (fiber.stopped) {
		listener();
		return;
	}
	fiber.stopListeners ??= new Set();
	fiber.stopListeners.add(listener);
	const remove = (): void => {
		fiber.stopListeners?.delete(listener);
	};
	parked.then(remove, remove);
}

function copyArgs<
	O extends IRuntimeOperation & {
		Args: unknown[];
	}
>(operation: O): O {
	return Object.freeze({
		...operation,
		Args: copyListAtSender(operation.Args, `${operation.Type}: the input`)
	});
}

function deliveryContext(ctx: IFiberContext<unknown>): IFanOutContext {
	return {
		get: ctx.env.runtimeStoreReader,
		dispatch: ctx.env.dispatchInternal
	};
}

function cloneBranchValue(value: unknown): unknown {
	return value === undefined ? undefined : clone(value);
}

const branchCase = {
	copy: <O>(operation: O): O => operation,
	descriptor: (operation: IParallelEffect | IParallelSettledEffect) => ({
		Type: operation.Type,
		Branches: operation.Generators.length
	}),
	settle: (value: unknown): unknown => value,
	settledByDriver: true as const,
	run: (operation: IParallelEffect | IParallelSettledEffect, ctx: IFiberContext<unknown>, driver: IOperationDriver) =>
		runFanOut(
			operation,
			driver.startBranch,
			(error) => {
				if (!ctx.fiber.stopped) {
					ctx.env.refusalIn(error);
				}
			},
			driver.settle
		)
};

const OPERATIONS: {
	readonly [K in IOperationType]: IOperationCase<IOperationOf<K>>;
} = {
	start: {
		copy: copyArgs,
		descriptor: (operation) => ({
			Type: operation.Type,
			EntityId: operation.EntityId,
			// Build-dependent, like action:start's Name: a minifier rewrites it.
			ActionName: operation.Action.name || null,
			Args: operation.Args
		}),
		run(operation, ctx) {
			refuseInRun(ctx, operation.Type);
			const env = ctx.env;
			const target = env.runtimeStoreReader("runtime/resolveOwner")(operation.EntityId, operation[START_TARGET_NODE]);
			if (!target) {
				env.runtimeStoreReader("runtime/diag").emit({
					severity: "warn",
					code: "dispatch/unresolved-entity",
					message:
						`[treflex] start: no entity "${operation.EntityId}" in the state tree — the action was not started. ` +
						`Start it only after the entity has been added to state.`,
					data: {
						entityId: operation.EntityId
					}
				});
				return undefined;
			}
			// Its failure takes the route, which raises it as uncaught when nothing takes it.
			env
				.dispatchInternal(operation.Action, target.getState, target.setState, () => operation.EntityId, operation.Args, {
					startedBy: env.actionId
				})
				.catch(() => {});
			return undefined;
		}
	},
	parallel: {
		...branchCase,
		rejectsWithOwnFailure: true,
		// A void branch settles as undefined, which has no JSON form in an array.
		response: (_operation, result) => (result as unknown[]).map((branch) => (branch === undefined ? null : cloneBranchValue(branch)))
	},
	parallelSettled: {
		...branchCase,
		response: (_operation, result) =>
			(result as IBranchOutcome<unknown>[]).map((branch) => {
				if (!branch.ok) {
					return {
						Ok: false,
						Error: serializeThrow(branch.error)
					};
				}
				return branch.value === undefined
					? {
							Ok: true
						}
					: {
							Ok: true,
							Value: cloneBranchValue(branch.value)
						};
			})
	},
	publish: {
		run(operation, ctx, driver) {
			const arrivals = createArrivals();
			fanOut(
				deliveryContext(ctx),
				{
					topic: operation.Data.Type,
					data: operation.Data,
					publisherId: ctx.env.entityId
				},
				arrivals
			);
			driver.afterResume(() => beginArrivals(arrivals));
		}
	},
	publishToNearest: {
		run(operation, ctx, driver) {
			const arrivals = createArrivals();
			deliverToNearest(operation.Id, operation.Data, deliveryContext(ctx), arrivals);
			driver.afterResume(() => beginArrivals(arrivals));
		}
	},
	startTimer: {
		run(operation, ctx) {
			refuseInRun(ctx, operation.Type);
			const get = ctx.env.runtimeStoreReader;
			if (!get("runtime/stateIdLookup")()[operation.Id]) {
				console.warn(
					`[treflex] startTimer called from $Id "${operation.Id}" (key "${operation.Key}") which is not in the state tree — ` +
						`the timer will never be cleaned up because the dispose cascade has nothing to fire on.`
				);
			}
			get("runtime/timers").start({
				Key: operation.Key,
				OwnerId: operation.Id,
				ReceiverId: operation.ReceiverId,
				IntervalMs: operation.IntervalMs,
				Payload: operation.Payload
					? (copyAtSender(operation.Payload, `startTimer "${operation.Key}": the payload`) as Record<string, unknown>)
					: null
			});
		}
	},
	stopTimer: {
		run(operation, ctx) {
			ctx.env.runtimeStoreReader("runtime/timers").stop(operation.Key, operation.Id);
		}
	},
	// The data id is late-bound, dereferenced at read time, so only the owner, whose lifetime the
	// registration follows, has to be in the tree.
	registerDataSource: {
		run(operation, ctx) {
			const get = ctx.env.runtimeStoreReader;
			if (!get("runtime/stateIdLookup")()[operation.OwnerId]) {
				console.warn(
					`[treflex] registerDataSource("${operation.Key}", ...) — owner $Id "${operation.OwnerId}" is not in the state tree. ` +
						`The registration is anchored to the owner's lifetime, so the dispose cascade has nothing to fire on ` +
						`and it will leak. Register with an owner that is a live state-tree entity.`
				);
			}
			get("runtime/dataSources").add(operation.Key, operation.OwnerId, operation.DataId);
		}
	},
	unregisterDataSource: {
		run(operation, ctx) {
			ctx.env.runtimeStoreReader("runtime/dataSources").remove(operation.Key, operation.OwnerId);
		}
	},
	openResource: {
		run(operation, ctx) {
			refuseInRun(ctx, operation.Type);
			const get = ctx.env.runtimeStoreReader;
			// Refused before any row is written: nothing could ever close a row whose owner the cascade cannot reach.
			if (!get("runtime/resolveOwner")(operation.Id)) {
				throw new EntityGoneError(
					operation.Id,
					`[treflex] openResource: "${operation.Id}" (key "${operation.Key}") is not in the state tree, so nothing could ever close ` +
						`the resource. Open it from an entity that has been added to state.`
				);
			}
			const params: unknown = operation.Params;
			if (
				params === null ||
				typeof params !== "object" ||
				Array.isArray(params) ||
				typeof (params as Record<string, unknown>).Type !== "string"
			) {
				throw new TreflexRefusal(
					`[treflex] openResource: the params for "${operation.Key}" must be a plain-data object carrying the resource's Type. ` +
						`Rows are journalled and snapshotted, so params are copies of plain data, and never credentials.`
				);
			}
			get("runtime/resources").open({
				Key: operation.Key,
				OwnerId: operation.Id,
				Params: operation.Params,
				ReceiverId: operation.ReceiverId,
				ResumeFrom: operation.ResumeFrom
			});
		}
	},
	closeResource: {
		run(operation, ctx) {
			refuseInRun(ctx, operation.Type);
			ctx.env.runtimeStoreReader("runtime/resources").close(operation.Key, operation.Id);
		}
	},
	resource: {
		copy: copyArgs,
		run(operation, ctx) {
			const origin = ctx.origin;
			const get = ctx.env.runtimeStoreReader;
			const resources = get("runtime/resources");
			if (
				origin?.Kind === "resource:deliver" &&
				origin.Key === operation.Key &&
				origin.OwnerId === operation.OwnerId &&
				resources.awaitsDelivery(operation.Key, operation.OwnerId)
			) {
				throw new TreflexRefusal(
					`[treflex] resource "${operation.Key}" on "${operation.OwnerId}": its own receiver called method "${operation.Method}" ` +
						`before the reopened instance was set up, and that setup waits for this delivery to end, so the call would never ` +
						`be answered. Call it from an action the receiver starts: yield* start(...).`
				);
			}
			// Ancestors only, which rules out cycles between resources.
			if (origin?.Kind === "resource:run") {
				const path = get("runtime/stateIdLookup")()[origin.OwnerId]?.path ?? [];
				if (!path.slice(0, -1).includes(operation.OwnerId)) {
					throw new TreflexRefusal(
						`[treflex] r.run: resource "${origin.Key}" on "${origin.OwnerId}" called method "${operation.Method}" on ` +
							`"${operation.Key}" of "${operation.OwnerId}", which is not an ancestor of its owner. From r.run, methods ` +
							`reach only the owner's ancestors.`
					);
				}
			}
			const parked = resources.call(operation, fiberSignal(ctx.fiber));
			reportDeliveryPark(ctx, operation.Type);
			return parked;
		}
	},
	ask: {
		settle: (value) => copyAtSender(value, "ask: the answer"),
		run(operation, ctx) {
			refuseAsk(ctx, operation.OwnerId);
			const get = ctx.env.runtimeStoreReader;
			if (!get("runtime/writeGateway").addressLive(operation.OwnerId)) {
				throw new EntityGoneError(
					operation.OwnerId,
					`[treflex] ask: no entity "${operation.OwnerId}" in the state tree, or it is leaving, so nothing could end this ask. The owner has to be ` +
						`attached when the ask opens: an entity added in this step is, by the ask's yield. An unknown id, a removed entity or a value with no $Id is not.`
				);
			}
			const asks = get("runtime/asks");
			// A guid, not a counter: an id copied into saved state outlives the session, and one reused by a
			// later session would let that stale copy answer a new ask.
			const askId = uuidv4();
			const parked = asks.open(askId, operation.OwnerId, operation.Request);
			abandonOnStop(ctx.fiber, parked, () => {
				asks.abandon(askId, "cancelled");
			});
			reportDeliveryPark(ctx, operation.Type);
			return parked;
		}
	},
	answer: {
		settles: "sync",
		run(operation, ctx) {
			const get = ctx.env.runtimeStoreReader;
			const asks = get("runtime/asks");
			const ownerId = asks.ownerOf(operation.AskId);
			// Its entityId is the entity the action's gate holds, which the action's own entityId isn't for a form over part of one.
			const answererId = ctx.step.hold?.entityId;
			if (ownerId !== undefined && answererId !== undefined) {
				const line = get("runtime/stateIdLookup")()[answererId]?.path ?? [
					answererId
				];
				if (!line.includes(ownerId)) {
					throw new AnswerOutsideOwnerError(ownerId, answererId);
				}
			}
			asks.answer(operation.AskId, copyAtSender(operation.Data, "answer: the data"));
		}
	}
};

const READS: {
	readonly [K in IRead["Type"]]: true;
} = {
	getData: true,
	getDataGlobal: true,
	getDataPath: true,
	select: true,
	transient: true,
	inFlight: true,
	pendingAsks: true
};

export function isRead(type: unknown): boolean {
	return typeof type === "string" && Object.hasOwn(READS, type);
}

export function operationOf(yielded: unknown): IOperationCase<IRuntimeOperation> | undefined {
	const type = (yielded as Partial<IEffect> | null | undefined)?.Type;
	return typeof type === "string" && Object.hasOwn(OPERATIONS, type)
		? (OPERATIONS[type as IOperationType] as unknown as IOperationCase<IRuntimeOperation>)
		: undefined;
}

export function copyYield(yielded: IEffect): IEffect {
	const operation = operationOf(yielded);
	return operation?.copy ? operation.copy(yielded as IRuntimeOperation) : copyEffectInput(yielded);
}

export function journalDescriptor(effect: IEffect, redact: boolean): unknown {
	if (redact) {
		return {
			Type: effect.Type
		};
	}
	const operation = operationOf(effect);
	return operation?.descriptor ? operation.descriptor(effect as IRuntimeOperation) : effect;
}

export function journalResponse(effect: IEffect, redact: boolean, result: unknown): unknown {
	const operation = operationOf(effect);
	if (operation?.response) {
		return operation.response(effect as IRuntimeOperation, result);
	}
	if (result === undefined || redact) {
		return undefined;
	}
	// Lossy on purpose: a returns: "module" result reaches here uncopied, and the record keeps what of it is data.
	return isFrozenCopy(result) ? result : clone(result);
}

/** Throws when `type` names a runtime operation or a read, which no effect declaration or implementation may take. */
export function refuseReservedType(type: string, where: string): void {
	if (Object.hasOwn(OPERATIONS, type)) {
		throw new Error(
			`[treflex] ${where}: "${type}" is one of the runtime's own operations, which the runtime carries out itself, so no ` +
				`declaration, implementation or stub can take its name. Observe it through its records instead ` +
				`(docs/reference/testing.md#runtime-operations-and-reads).`
		);
	}
	if (Object.hasOwn(READS, type)) {
		throw new Error(
			`[treflex] ${where}: "${type}" is a read, which the runtime answers from what it holds, so no declaration, implementation ` +
				`or stub can take its name.` +
				(type === "inFlight" ? " Stub it with createTestRuntime's inFlight option (docs/reference/testing.md#stubbing-inflight)." : "")
		);
	}
}
