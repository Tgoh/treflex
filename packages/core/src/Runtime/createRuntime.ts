import type { IExternalKey, IExternalValue } from "../Registries/IExternalRegistry";
import type { IResourceKey, IResourceSupplyOf, IResourceSupplyResponseOf, IResourceTypeName } from "../Registries/IResourceRegistry";
import type { IRuntimeServiceKey, IRuntimeServiceValue } from "../Registries/IRuntimeServiceRegistry";
import type { IAction } from "../Types/IAction";
import type { IEntity } from "../Types/IEntity";
import type { IReceiver } from "../Types/IReceiver";
import type { IResourceImplementation, IResourceTypeOptions, IUntypedResourceImplementation } from "../Types/IResource";
import type { IDiagEmitter } from "../Types/IRuntimeEvent";
import type { IRead, ISelector } from "../Types/ISelector";
import type { IEffectImplementation, IRegisterImplementation } from "./createEffectRegistry";
import type { IEventBus } from "./createEventBus";
import type { IExternalHandle, IExternalProvider } from "./createExternalTable";
import type { IOwnerResolver, IResolvedOwner } from "./createResourceManager";
import type { IResourceRow } from "./createResourceTable";
import type { ITimerRow } from "./createTimerTable";
import type { IResolvedEntityCell, IRuntimeInternal } from "./internals";
import type { IErrorHandler, IProcessAction } from "./processAction";
import type { IReadContext } from "./processSelector";
import type { ISetState } from "./sliceSetState";
import { v4 as uuid } from "uuid";
import { mintedValues } from "../Effects/entity";
import { implement as generateGuidImpl } from "../Implementations/generateGuid";
import { host } from "../Solid/host";
import { pairDiag } from "../Types/IRuntimeEvent";
import { type IInFlightStub, IN_FLIGHT_YIELD, readInFlight } from "./arrivals";
import { createAskTable } from "./createAskTable";
import { createBindingIndex } from "./createBindingIndex";
import { createDataSourceMap } from "./createDataSourceMap";
import { createDiagService } from "./createDiagService";
import { createEffectRegistry } from "./createEffectRegistry";
import { createEventBus } from "./createEventBus";
import { createExternalTable } from "./createExternalTable";
import { createGetDataCache } from "./createGetDataCache";
import { createJournal } from "./createJournal";
import { createReceiverRegistry } from "./createReceiverRegistry";
import { createResourceManager } from "./createResourceManager";
import { createResourceTable } from "./createResourceTable";
import { createSelectorCache } from "./createSelectorCache";
import { createServiceStore } from "./createServiceStore";
import { createTimerScheduler } from "./createTimerScheduler";
import { createTimerTable } from "./createTimerTable";
import { COMPONENT_ROOT_KEY, createWriteGateway, type IVerifyIndexMode } from "./createWriteGateway";
import { mintedId, seat } from "./draftNode";
import { EntityGoneError } from "./entityGoneError";
import { hearCollisions } from "./named";
import { refuseReservedType } from "./operations";
import { PENDING_ASKS_YIELD, readPendingAsks, shareAsks } from "./pendingAsks";
import { createProcessAction } from "./processAction";
import { processSelector as processSelectorImpl } from "./processSelector";
import { assertReactiveHost } from "./reactiveHost";
import { wrapSetState } from "./sliceSetState";
import { slotHomes, slotOf, TRANSIENT_YIELD, unwrittenSlots } from "./transient";
import { copyComponentSeed, copySeed, rawOf, setViewDiagEmitter, view } from "./viewProxy";

export interface IRuntimeOptions {
	onError?: IErrorHandler | undefined;
	/**
	 * The index consistency walk: `true` on every reconciliation, `false`
	 * never, `"budgeted"` scaled by tree size. Omitted, it is budgeted under
	 * DEV and off otherwise, and the TREFLEX_VERIFY_INDEX env var overrides that.
	 */
	verifyIndex?: boolean | IVerifyIndexMode | undefined;
	/**
	 * Effect implementations seeded at construction, an entry for `generateGuid` replacing the
	 * built-in without the overwrite warning. Untyped: nothing checks an entry against its key. A
	 * runtime operation's or a read's name throws.
	 */
	implementations?: Record<string, IEffectImplementation<any>>;
	/** Pauses the timer scheduler for good: rows record and no tick fires. */
	pauseTimers?: boolean | undefined;
	/** Pauses the resource manager for good: rows record and nothing connects. Methods and supplies resolve undefined. */
	pauseResources?: boolean | undefined;
	/**
	 * Requires a `named` mark on every action dispatched on an entity in AppState with no resource
	 * origin. Unnamed, it fails with `UnnamedActionError` in development, and runs with `Name: null`
	 * and diags `action/unnamed` in production. See docs/reference/runtime.md#requirenames.
	 */
	requireNames?: boolean | undefined;
	/** The code this runtime runs, written into a snapshot as `Build`. A non-empty string. See docs/reference/runtime.md#build. */
	build?: string | undefined;
}

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/build": string | null;
	}
}

/** An entity's `$Id`, or its live node in the tree (a view or a raw node). A copy carrying the `$Id` is refused. */
export type IDispatchTarget = string | IEntity;

/** What `runtime.locate` answers. See docs/reference/views.md#a-form-over-part-of-an-entity. */
export interface ILocation {
	readonly EntityId: string;
	/** Present for a node in a transient of `EntityId`: the transient's name, where `Path` starts. */
	readonly TransientName?: string;
	readonly Path: readonly string[];
}

/** What createRuntime returns. See docs/reference/runtime.md. */
export interface IRuntime<T extends object> {
	state: T;
	processAction: IProcessAction;
	/**
	 * Runs the action on an entity in any root, named by its `$Id` or given as its live node. An id
	 * the index cannot serve diags `dispatch/unresolved-entity`, and a node the index doesn't hold
	 * under its `$Id` diags `dispatch/node-mismatch`; both reject before the action starts.
	 */
	dispatch: <S, A extends any[], R>(action: IAction<S, A, R>, target: IDispatchTarget, ...args: A) => Promise<R | undefined>;
	/** Where a node of this tree stands, as an entity to dispatch on. See docs/reference/views.md#a-form-over-part-of-an-entity. */
	locate: (node: unknown) => ILocation | undefined;
	processSelector: <S, R>(selector: ISelector<S, R>, getState: () => any, accessor?: (state: any) => any) => R;
	registerImplementation: IRegisterImplementation;
	/** Takes the whole receiver, its Id, Topics and handle. */
	registerReceiver: (receiver: IReceiver<any, never>) => void;
	/** Re-registering a type replaces every instance of it. */
	registerResourceType: <K extends IResourceTypeName>(
		type: K,
		implementation: IResourceImplementation<K>,
		options?: IResourceTypeOptions
	) => void;
	/** Copies of the resource rows, every one or one owner's. */
	resources: (owner?: IEntity | string) => IResourceRow[];
	/** Copies of the timer rows, every one or one owner's. */
	timers: (owner?: IEntity | string) => ITimerRow[];
	/** What useResource's supply does, from outside a view. */
	supplyResource: <K extends IResourceKey>(
		owner: IEntity | string,
		key: K,
		value: IResourceSupplyOf<K>
	) => Promise<IResourceSupplyResponseOf<K> | undefined>;
	/**
	 * Gives this runtime a value under `key`, which `external(key)` reads. Providing a key again
	 * replaces its provider. See docs/reference/derived-reads.md#providing-a-value.
	 */
	provideExternal: <K extends IExternalKey>(key: K, provider: IExternalProvider<IExternalValue<K>>) => IExternalHandle;
	set: <K extends IRuntimeServiceKey>(key: K, value: IRuntimeServiceValue<K>) => void;
	on: IEventBus["on"];
	dispose: () => void;
}

export function createRuntime<T extends object>(initialState: T, options?: IRuntimeOptions): IRuntime<T> {
	assertReactiveHost();
	const build = options?.build;
	if (build !== undefined && (typeof build !== "string" || build === "")) {
		throw new TypeError(
			`[treflex] createRuntime(): build is a non-empty string naming the code, or undefined, not ${build === "" ? '""' : String(build)}.`
		);
	}
	// The "record" channel is closed over, so the bus and the journal can be
	// constructed in either order.
	const bus = createEventBus(
		(listener, kinds) => journal.tap(listener, kinds),
		(event) => emitDiag(event)
	);

	const emitDiag: IDiagEmitter = pairDiag(bus.emit);
	// The bus half only: the view layer owns the console line.
	const unregisterViewDiag = setViewDiagEmitter((event) => bus.emit("diag", event));

	const journal = createJournal(emitDiag);

	const { set, get } = createServiceStore();

	let branches = 0;
	const allocateBranchId = () => `branch-${++branches}`;

	const gateway = createWriteGateway({
		journal,
		emitDiag,
		attachmentsOf: (entityId) => ({
			receiver: bindings.receiverOf(entityId),
			timers: timers.ownerCount(entityId),
			resources: resourceTable.ownerKeys(entityId).length,
			actions: dispatchLoop.runningActions(entityId)
		}),
		verifyIndex: options?.verifyIndex
	});

	type IRoot = {
		AppState: T;
		TransientState: Record<string, Record<string, object>>;
		ComponentState: Record<string, Record<string, object>>;
	};
	// Both holder roots are keyed by owner $Id, which can be any string, and neither reaches a
	// snapshot.
	const rawRoot: IRoot = {
		AppState: copySeed(initialState, "createRuntime(): the initial state"),
		TransientState: Object.create(null),
		ComponentState: Object.create(null)
	};
	const rawSetState = wrapSetState(rawRoot, gateway);
	const receiverRegistry = createReceiverRegistry(emitDiag);
	// Ahead of connect, so the seed's bindings reach it.
	const bindings = createBindingIndex({
		gateway,
		receivers: receiverRegistry,
		emitDiag
	});
	gateway.connect(rawRoot, rawSetState, rawRoot.TransientState, rawRoot.ComponentState);

	const state = view(rawRoot.AppState);

	let disposed = false;
	const holderKeyOfMount = new Map<string, string>();
	// The home is registered ahead of the seat, so a read before it (React's first render) finds
	// nothing running and no asks rather than refusing a node no runtime knows.
	function seedComponent(
		seed: unknown,
		where: string
	): {
		id: string;
		raw: object;
	} {
		const id = mintedId(uuid());
		const raw = copyComponentSeed(seed, id, where);
		slotHomes.set(raw, gateway.slotHome);
		return {
			id,
			raw
		};
	}
	function holderKeyFor(ownerId: string | undefined): string {
		const rootId = (
			rawRoot.AppState as {
				$Id?: unknown;
			}
		).$Id;
		return ownerId ?? (typeof rootId === "string" && rootId !== "" ? rootId : COMPONENT_ROOT_KEY);
	}
	// An owner already gone, or leaving in its cascade, would never end a holder seated under it.
	function canHold(key: string, where: string): boolean {
		if (disposed || (key !== COMPONENT_ROOT_KEY && !gateway.addressLive(key))) {
			return false;
		}
		if (gateway.rootNameOf(key) === "ComponentState") {
			throw new Error(
				`[treflex] ${where}: component state can't mount under "${key}", an entity in ComponentState. Component mounts are flat, ` +
					`under the nearest entity in AppState or TransientState, so pass that entity's $Id as the owner.`
			);
		}
		return true;
	}
	function onlyMountIn(holder: Record<string, object>, id: string): boolean {
		for (const other in holder) {
			if (other !== id) {
				return false;
			}
		}
		return true;
	}
	function seatComponent(ownerId: string | undefined, raw: object): boolean {
		const id = (raw as IEntity).$Id;
		if (holderKeyOfMount.has(id)) {
			return true;
		}
		const key = holderKeyFor(ownerId);
		if (!canHold(key, "seatComponent")) {
			return false;
		}
		holderKeyOfMount.set(id, key);
		gateway.exemptFrame(() => {
			rawSetState((s: IRoot) => {
				if (!s.ComponentState[key]) {
					s.ComponentState[key] = {};
				}
				// Owned: React renders from this raw before the seat, so the seated node must be it.
				seat(s.ComponentState[key]!, id, raw, true);
			});
		});
		return true;
	}
	function unmountComponent(id: string): boolean {
		const key = holderKeyOfMount.get(id);
		holderKeyOfMount.delete(id);
		if (disposed || key === undefined) {
			return false;
		}
		const holder = rawRoot.ComponentState[key];
		if (!holder || !Object.hasOwn(holder, id)) {
			return false;
		}
		const last = onlyMountIn(holder, id);
		gateway.exemptFrame(() => {
			rawSetState((s: IRoot) => {
				if (last) {
					delete s.ComponentState[key];
				} else {
					delete s.ComponentState[key]![id];
				}
			});
		});
		return true;
	}
	function reseatComponent(id: string, ownerId: string | undefined): boolean {
		const from = holderKeyOfMount.get(id);
		if (disposed || from === undefined) {
			return false;
		}
		const to = holderKeyFor(ownerId);
		if (to === from) {
			return true;
		}
		if (!canHold(to, "reseatComponent")) {
			unmountComponent(id);
			return false;
		}
		const last = onlyMountIn(rawRoot.ComponentState[from]!, id);
		holderKeyOfMount.set(id, to);
		// One frame, so the reconcile sees a move within the root and cascades nothing.
		gateway.exemptFrame(() => {
			rawSetState((s: IRoot) => {
				if (!s.ComponentState[to]) {
					s.ComponentState[to] = {};
				}
				s.ComponentState[to]![id] = s.ComponentState[from]![id]!;
				if (last) {
					delete s.ComponentState[from];
				} else {
					delete s.ComponentState[from]![id];
				}
			});
		});
		return true;
	}

	gateway.onDispose((id) => {
		holderKeyOfMount.delete(id);
	}, "tables");

	const effects = createEffectRegistry();
	const { registerImplementation, processEffect } = effects;

	const dataSources = createDataSourceMap({
		onDispose: (callback) => gateway.onDispose(callback, "tables"),
		journal,
		rootOf: gateway.rootNameOf
	});
	// Untracked, or a reactive scope that dispatches would re-run whenever the
	// entity moves.
	const resolvePath = (id: string): readonly string[] => host.untrack(() => gateway.lookup()[id]?.path ?? []);
	const timers = createTimerTable({
		onDispose: (callback) => gateway.onDispose(callback, "tables"),
		journal,
		rootOf: gateway.rootNameOf
	});
	const resourceTable = createResourceTable({
		onDispose: (callback) => gateway.onDispose(callback, "tables"),
		journal,
		rootOf: gateway.rootNameOf
	});
	const asks = createAskTable({
		onDispose: (callback) => gateway.onDispose(callback, "tables"),
		journal,
		pathOf: (id) => gateway.lookup()[id]?.path,
		report: emitDiag
	});
	shareAsks(
		[
			gateway,
			gateway.slotHome
		],
		(ownerId) => asks.under(ownerId)
	);
	const diag = createDiagService(emitDiag);
	const stateIdLookupAccessor = gateway.lookup;
	// processRead is hoisted from below; no selector runs before
	// createRuntime returns.
	const selectorCache = createSelectorCache({
		onDispose: (callback) => gateway.onDispose(callback, "caches"),
		processRead,
		diag,
		stateOf: (entityId) => stateIdLookupAccessor()[entityId]?.state
	});

	type IMismatch = "superseded" | "foreign";
	// Keyed by the refused node, so a held stale node reports once however many good dispatches
	// on its $Id come between its refusals.
	const reportedMismatch = new WeakMap<object, Set<IMismatch>>();
	const MISMATCH: Record<IMismatch, string> = {
		superseded:
			"is a superseded node: it has left the tree, and the $Id now names another node or none. Read the entity again from the tree",
		foreign:
			"is not a node of this runtime's tree: a copy or other plain value carrying the $Id, or another runtime's node. Pass the $Id, or the tree's own node"
	};
	const refuseMismatch = (verb: "dispatch" | "start", raw: object, entityId: string, cellState: unknown): void => {
		// A start's target is most often the row the step just wrote, and the action holds only what
		// entity() returned for it, which the write copied into the tree.
		if (rawOf(cellState) === raw || (verb === "start" && mintedValues.has(raw))) {
			reportedMismatch.delete(raw);
			return;
		}
		const place = gateway.placeOf(raw).kind;
		const cause: IMismatch = place === "left" ? "superseded" : "foreign";
		const message = `[treflex] ${verb}: the node given for "${entityId}" ${MISMATCH[cause]}.`;
		let reported = reportedMismatch.get(raw);
		if (!reported) {
			reported = new Set();
			reportedMismatch.set(raw, reported);
		}
		if (!reported.has(cause)) {
			reported.add(cause);
			emitDiag({
				severity: "warn",
				code: "dispatch/node-mismatch",
				message,
				data: {
					entityId,
					cause
				}
			});
		}
		throw new Error(message);
	};

	// The whole read is untracked, `.setState` included: reading a property
	// off a lookup cell subscribes a tracked caller (see resolveCell).
	const resolveOwner: IOwnerResolver = (ownerId, node) =>
		host.untrack((): IResolvedOwner | undefined => {
			const cell = stateIdLookupAccessor()[ownerId];
			if (!cell) {
				return undefined;
			}
			if (node) {
				refuseMismatch("start", node, ownerId, cell.state);
			}
			return {
				getState: () => cell.state,
				setState: cell.setState
			};
		});

	const externals = createExternalTable(host, emitDiag);

	const getDataCache = createGetDataCache({
		onDispose: (callback) => gateway.onDispose(callback, "caches"),
		report: emitDiag,
		resolveData: (key, fromId) => dataSources.resolve(key, fromId, stateIdLookupAccessor()),
		resolveGlobalData: (key) => dataSources.resolveGlobal(key, stateIdLookupAccessor())
	});

	set("runtime/journal", journal);
	set("runtime/diag", diag);
	set("runtime/effects", effects);
	set("runtime/bindings", bindings);
	set("runtime/receivers", receiverRegistry);
	set("runtime/dataSources", dataSources);
	set("runtime/timers", timers);
	set("runtime/resourceTable", resourceTable);
	set("runtime/resolveOwner", resolveOwner);
	set("runtime/asks", asks);
	let inFlightStub: IInFlightStub | undefined;
	set("runtime/inFlightStub", {
		stub: (stub) => {
			inFlightStub = stub;
		}
	});
	set("runtime/stateIdLookup", stateIdLookupAccessor);
	set("runtime/externals", externals);
	set("runtime/writeGateway", gateway);
	set("runtime/build", build ?? null);

	const dispatchLoop = createProcessAction({
		effectProcessor: processEffect,
		processRead,
		onError: options?.onError,
		emitDiag,
		runtimeStoreReader: get,
		onDispose: (callback) => gateway.onDispose(callback, "cancel"),
		allocateBranchId,
		journal,
		gateway,
		resolvePath,
		emitFailure: (event) => bus.emit("failure", event),
		requireNames: options?.requireNames === true
	});
	const { processAction, dispatchInternal } = dispatchLoop;
	set("runtime/inFlightActions", dispatchLoop.inFlightActions);

	const resourceManager = createResourceManager({
		table: resourceTable,
		receivers: receiverRegistry,
		resolveOwner,
		dispatchInternal,
		journal,
		diag,
		onDispose: (callback) => gateway.onDispose(callback, "resources"),
		pause: options?.pauseResources,
		rootOf: gateway.rootNameOf
	});
	set("runtime/resources", resourceManager);
	receiverRegistry.onRegister((id) => resourceManager.receiverRegistered(id));

	const timerScheduler = createTimerScheduler({
		table: timers,
		get,
		dispatch: dispatchInternal,
		pause: options?.pauseTimers
	});
	set("runtime/timerSchedule", {
		nextDue: timerScheduler.nextDue,
		load: timerScheduler.load
	});

	// One registration per Type, so replacing generateGuid does not trip the overwrite warning.
	const seeded: NonNullable<IRuntimeOptions["implementations"]> = {
		generateGuid: generateGuidImpl.fn,
		...options?.implementations
	};
	for (const [name, impl] of Object.entries(seeded)) {
		refuseReservedType(name, "createRuntime's implementations option");
		registerImplementation(name, impl);
	}

	function processRead(yielded: IRead, ctx: IReadContext): unknown {
		switch (yielded.Type) {
			case "getData":
				return getDataCache.resolve(yielded.Key, yielded.FromId);
			// Not `getData` with no FromId: a scoped read whose anchor is
			// unusable must fail as a scoped read rather than widen into this.
			case "getDataGlobal":
				return getDataCache.resolveGlobal(yielded.Key);
			// Unmemoised: the calling selector's own memo caches it.
			case "getDataPath":
				return dataSources.resolveWithPath(yielded.Key, yielded.FromId, stateIdLookupAccessor());
			case "select": {
				const parentAccessor = ctx.accessor;
				const yieldedAccessor = yielded.Accessor;
				const resolvedAccessor = yieldedAccessor
					? parentAccessor
						? (s: any) => yieldedAccessor(parentAccessor(s))
						: yieldedAccessor
					: parentAccessor;
				// An action's read runs fresh: a memo a view built can lag the record of running
				// work by a microtask, and its nested inFlight answers would go unrecorded.
				if (ctx.inFlightAnswers) {
					return processSelectorImpl(yielded.Selector, ctx.getState, resolvedAccessor, processRead, ctx.inFlightAnswers, ctx.externalReads);
				}
				return selectorCache.runSelector(yielded.Selector, ctx.getState, resolvedAccessor, false);
			}
			case TRANSIENT_YIELD:
				return slotOf(yielded.Owner, yielded.Name, yielded.Initial);
			case IN_FLIGHT_YIELD: {
				const answer = readInFlight(yielded.Actions, yielded.Owner, inFlightStub);
				ctx.inFlightAnswers?.push(answer);
				return answer;
			}
			case PENDING_ASKS_YIELD:
				return readPendingAsks(yielded.Owner);
			case "external": {
				const reads = ctx.externalReads;
				if (!reads) {
					return externals.read(yielded.Key);
				}
				const read = externals.peek(yielded.Key);
				const value = reads.copy(read.value, yielded.Key);
				reads.answers.push({
					key: yielded.Key,
					provided: read.provided,
					redacted: read.redacted,
					value
				});
				return value;
			}
			default: {
				const unhandled: never = yielded;
				throw new Error(
					`[treflex] No read registered for type: "${
						(
							unhandled as {
								Type: unknown;
							}
						).Type
					}"`
				);
			}
		}
	}

	const processSelector = <S, R>(selector: ISelector<S, R>, getState: () => any, accessor?: (state: any) => any): R =>
		processSelectorImpl(selector, getState, accessor, processRead);

	// The whole read is untracked, `.state` and `.setState` included: the
	// lookup is a tracked view, and a dispatch prologue in a reactive scope
	// would otherwise re-run on every replacement of the entity, a loop when
	// the action dispatched is what replaces it.
	const resolveCell = (entityId: string): IResolvedEntityCell | undefined =>
		host.untrack(() => {
			const cell = stateIdLookupAccessor()[entityId];
			return cell
				? {
						state: cell.state,
						setState: cell.setState
					}
				: undefined;
		});
	const runSelector = <S, R>(selector: ISelector<S, R>, getState: () => any): R =>
		selectorCache.runSelector(selector, getState, undefined, true) as R;

	const reportedUnresolved = new Set<string>();
	const failUnresolved = (entityId: string, foreign: boolean): never => {
		const message =
			`[treflex] dispatch: no entity "${entityId}" in the state tree — an unknown id, an entity the cascade ` +
			`has taken, a state root with no $Id${foreign ? ", or another runtime's node" : ""}. A root takes a dispatch only with a ` +
			`$Id of its own, so give it one.`;
		if (!reportedUnresolved.has(entityId)) {
			reportedUnresolved.add(entityId);
			emitDiag({
				severity: "warn",
				code: "dispatch/unresolved-entity",
				message,
				data: {
					entityId,
					cause: "unresolved"
				}
			});
		}
		throw new EntityGoneError(entityId, message);
	};
	const dispatch = <S, A extends any[], R>(action: IAction<S, A, R>, target: IDispatchTarget, ...args: A): Promise<R | undefined> => {
		let entityId: string;
		let node: object | undefined;
		try {
			if (typeof target === "string") {
				entityId = target;
			} else if (typeof target === "object" && target !== null) {
				node = rawOf(target) as object;
				const id = host.untrack(() => (node as Partial<IEntity>).$Id);
				if (typeof id !== "string") {
					throw new TypeError(
						"[treflex] dispatch: the target is not an entity. Dispatch on the entity, and for part of one, pass where " +
							"runtime.locate(node) puts it as an argument."
					);
				}
				entityId = id;
			} else {
				throw new TypeError(
					`[treflex] dispatch: the target is an entity's $Id or its node, not ${target === null ? "null" : typeof target}.`
				);
			}
		} catch (error) {
			return Promise.reject(error);
		}
		const resolve = (given?: object) =>
			host.untrack(() => {
				const cell = stateIdLookupAccessor()[entityId];
				if (!cell) {
					return failUnresolved(entityId, given !== undefined && gateway.placeOf(given).kind === "unknown");
				}
				return {
					state: cell.state,
					setState: cell.setState
				};
			});
		// Rejects rather than throwing: a synchronous throw would fire before
		// the caller's `.catch` could attach.
		let setState: ISetState<any>;
		try {
			const cell = resolve(node);
			if (node) {
				refuseMismatch("dispatch", node, entityId, cell.state);
			}
			setState = cell.setState;
		} catch (error) {
			return Promise.reject(error);
		}
		reportedUnresolved.delete(entityId);
		return processAction(
			action,
			() => resolve().state as S,
			setState,
			() => entityId,
			...args
		);
	};

	const locate = (node: unknown): ILocation | undefined => {
		if (node === null || node === undefined) {
			return undefined;
		}
		if (typeof node !== "object") {
			throw new TypeError(`[treflex] locate: a ${typeof node} is not a node of the state tree.`);
		}
		const unwritten = unwrittenSlots.get(rawOf(node));
		if (unwritten !== undefined) {
			throw new Error(
				`[treflex] locate: the value is the default a read of transient "${unwritten}" answered while nothing had written ` +
					"the transient, so no node stands behind it. Write the transient in an action first, and read it again."
			);
		}
		const place = host.untrack(() => gateway.placeOf(node));
		switch (place.kind) {
			case "at":
				return Object.freeze(
					place.slot === undefined
						? {
								EntityId: place.entityId,
								Path: Object.freeze(place.path)
							}
						: {
								EntityId: place.entityId,
								TransientName: place.slot,
								Path: Object.freeze(place.path)
							}
				);
			case "left":
				return undefined;
			case "unknown":
				throw new Error(
					"[treflex] locate: the value is not a node of this runtime's tree: a copy, a plain object, a binding's handle such as a " +
						"React view (useLocate maps one), or a node from another runtime."
				);
			case "no-entity":
				throw new Error("[treflex] locate: no entity is above the node, so no dispatch reaches it. Give the state root a $Id.");
		}
	};

	let stopHearingCollisions = (): void => {};
	// A microtask late, so a diag listener attached straight after construction hears the collisions raised before it.
	queueMicrotask(() => {
		if (!disposed) {
			stopHearingCollisions = hearCollisions(emitDiag);
		}
	});

	function dispose() {
		disposed = true;
		unregisterViewDiag();
		stopHearingCollisions();
		// Before the cascade: no tick or delivery may dispatch into a disposing
		// runtime.
		timerScheduler.dispose();
		resourceManager.dispose();
		externals.dispose();
		gateway.dispose();
		// getDataGlobal memos live in detached roots the cascade never reaches.
		getDataCache.dispose();
	}

	const rowsOf = <
		R extends {
			OwnerId: string;
		}
	>(
		rows: R[],
		owner: IEntity | string | undefined
	): R[] => {
		if (owner === undefined) {
			return rows;
		}
		const ownerId = typeof owner === "string" ? owner : owner.$Id;
		return rows.filter((row) => row.OwnerId === ownerId);
	};

	const internalSurface: IRuntimeInternal<T> = {
		state,
		processAction,
		dispatch,
		locate,
		processSelector,
		runSelector,
		resolveCell,
		emitDiag,
		registerImplementation,
		registerReceiver: receiverRegistry.register,
		registerResourceType: (type, implementation, options) =>
			resourceManager.registerType(type, implementation as unknown as IUntypedResourceImplementation, options),
		resources: (owner) => rowsOf(resourceTable.entries(), owner),
		timers: (owner) => rowsOf(timers.entries(), owner),
		supplyResource: (owner, key, value) =>
			resourceManager.supply(key, typeof owner === "string" ? owner : owner.$Id, value) as Promise<any>,
		provideExternal: (key, provider) => externals.provide(key, provider as IExternalProvider<unknown>),
		set,
		on: bus.on,
		dispose,
		seedComponent,
		seatComponent,
		reseatComponent,
		unmountComponent,
		disposed: () => disposed,
		get
	};
	return internalSurface;
}
