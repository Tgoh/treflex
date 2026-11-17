import type { IVersion } from "../Solid/host";
import type { IOpenGenerator } from "../Types/IAction";
import type { IRecordRoot } from "../Types/IRecord";
import type {
	IEnded,
	IResourceRetireReason,
	IResourceStatus,
	IResourceTypeOptions,
	IUntypedResourceContext,
	IUntypedResourceImplementation
} from "../Types/IResource";
import type { IDiagService } from "./createDiagService";
import type { IJournal } from "./createJournal";
import type { IReceiverRegistry } from "./createReceiverRegistry";
import type { IResourceRow, IResourceTable } from "./createResourceTable";
import type { IInternalDispatch } from "./processAction";
import type { ISetState } from "./sliceSetState";
import { host } from "../Solid/host";
import { callbackThrew } from "../Types/IRuntimeEvent";
import { jsonEquals } from "../Utility/jsonEquals";
import { serializeThrow } from "../Utility/serializeThrow";
import { clone, cloneStrict, copyFrozen, copyFrozenList } from "../Utility/valueCodec";
import { NonPlainDataError } from "./nonPlainDataError";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/resources": IResourceManager;
		"runtime/resolveOwner": IOwnerResolver;
	}
}

export interface IResolvedOwner {
	getState: () => any;
	setState: ISetState<any>;
}

export type IOwnerResolver = (ownerId: string, node?: object) => IResolvedOwner | undefined;

export interface IResourceMethodRequest {
	Key: string;
	OwnerId: string;
	Method: string;
	Args: unknown[];
}

export interface IResourceStubs {
	methods?:
		| Record<
				string,
				Record<
					string,
					(
						ctx: {
							ownerId: string;
						},
						...args: any[]
					) => unknown
				>
		  >
		| undefined;
	supplies?:
		| Record<
				string,
				(
					ctx: {
						ownerId: string;
					},
					value: any
				) => unknown
		  >
		| undefined;
	exposes?: Record<string, unknown> | undefined;
	statuses?: Record<string, IResourceStatus> | undefined;
}

export interface IResourceManager {
	registerType(type: string, implementation: IUntypedResourceImplementation, options?: IResourceTypeOptions): void;
	open(row: IResourceRow): void;
	close(key: string, ownerId: string): void;
	call(request: IResourceMethodRequest, signal: AbortSignal): Promise<unknown>;
	awaitsDelivery(key: string, ownerId: string): boolean;
	supply(key: string, ownerId: string, value: unknown): Promise<unknown>;
	status(key: string, ownerId: string): IResourceStatus;
	value(key: string, ownerId: string): unknown;
	// Meant for a runtime with no live instance: it retires nothing.
	pause(): void;
	load(rows: IResourceRow[]): void;
	resume(): void;
	drained(): Promise<void>;
	readonly permanentlyPaused: boolean;
	setStubs(stubs: IResourceStubs): void;
	receiverRegistered(receiverId: string): void;
	// A test seam for the retention of status reads; nothing in src reads it.
	trackedCellCount(): number;
	dispose(): void;
}

const NONE: IResourceStatus = {
	State: "none"
};

const QUEUE_DEPTH_REPORT = 100;

const ACCEPTED: Promise<void> = Promise.resolve();

interface IRegisteredType {
	implementation: IUntypedResourceImplementation;
	options: IResourceTypeOptions;
}

interface IInstance {
	cell: ICell;
	row: IResourceRow;
	phase: "queued" | "setup" | "live";
	retired: IResourceRetireReason | null;
	retirementError: DOMException | null;
	aborted: boolean;
	controller: AbortController;
	queue: Record<string, unknown>[];
	delivering: boolean;
	dropped: boolean;
	parked: AbortController | null;
	idle: (() => void)[];
	// Registered from inside an idle callback: run after the next delivery settles, or a
	// callback that re-registers with nothing to send would spin in the drain.
	idleAfterDelivery: (() => void)[];
	runningIdle: boolean;
	methods: Record<string, (...args: any[]) => unknown> | null;
	supplyHandler: ((value: any) => unknown) | null;
	setupOpen: boolean;
	waiting: (() => void)[];
	detail: string | undefined;
	ended: IEnded | null;
	endOnReceiverFailure: boolean;
	depthReported: boolean;
}

interface IEnding {
	instance: IInstance;
	actedOn: boolean;
	noticeSent: boolean;
}

interface ICell {
	key: string;
	ownerId: string;
	current: IInstance | null;
	status: IResourceStatus;
	exposed: {
		instance: IInstance;
		value: unknown;
		release?: ((value: any) => void) | undefined;
	} | null;
	ending: IEnding | null;
	inflight: Promise<void> | null;
	dirty: boolean;
	closedByApp: boolean;
	// Forgotten, or swept with its owner. A drain task queued before that
	// must not act on it: a same-$Id owner re-added in the same tick has a
	// new cell, and acting on this one would set up an unreachable instance.
	detached: boolean;
}

export function createResourceManager(deps: {
	table: IResourceTable;
	receivers: IReceiverRegistry;
	resolveOwner: IOwnerResolver;
	dispatchInternal: IInternalDispatch;
	journal: IJournal;
	diag: IDiagService;
	onDispose: (callback: (id: string) => void) => void;
	pause?: boolean | undefined;
	rootOf?: (ownerId: string) => IRecordRoot | undefined;
}): IResourceManager {
	const { table, receivers, resolveOwner, dispatchInternal, journal, diag } = deps;
	const types = new Map<string, IRegisteredType>();
	const cells = new Map<string, ICell>();
	const cellsByOwner = new Map<string, Set<ICell>>();
	// By owner, so the owner's disposal drops a view's tracking whether or
	// not the key was ever opened.
	const versions = new Map<string, Map<string, IVersion>>();
	const unaborted = new Set<IInstance>();
	// Supplies and drain waits that dispose drops unrun still resolve, so
	// nothing awaits forever.
	const unsettled = new Set<(value?: unknown) => void>();
	const permanentlyPaused = deps.pause === true;
	let paused = false;
	let stubs: IResourceStubs | null = null;
	let disposed = false;
	let retracting = false;

	const cellKey = (key: string, ownerId: string) =>
		JSON.stringify([
			key,
			ownerId
		]);
	const isPaused = () => permanentlyPaused || paused;

	const tasks: (() => void)[] = [];
	let scheduled = false;

	function enqueue(task: () => void): void {
		if (disposed) {
			return;
		}
		tasks.push(task);
		if (!scheduled) {
			scheduled = true;
			queueMicrotask(drain);
		}
	}

	function drain(): void {
		scheduled = false;
		while (tasks.length > 0 && !disposed) {
			const task = tasks.shift()!;
			try {
				task();
			} catch (error) {
				diag.emit(callbackThrew("A resource manager task", error));
			}
		}
	}

	function cellFor(key: string, ownerId: string): ICell {
		const ck = cellKey(key, ownerId);
		let cell = cells.get(ck);
		if (!cell) {
			cell = {
				key,
				ownerId,
				current: null,
				status: NONE,
				exposed: null,
				ending: null,
				inflight: null,
				dirty: false,
				closedByApp: false,
				detached: false
			};
			cells.set(ck, cell);
			let owned = cellsByOwner.get(ownerId);
			if (!owned) {
				owned = new Set();
				cellsByOwner.set(ownerId, owned);
			}
			owned.add(cell);
		}
		return cell;
	}

	// A cell with a delivery still in flight is kept, because a reopen waits on
	// it, and is looked at again when the delivery settles.
	function forgetIfEmpty(cell: ICell): void {
		if (
			!cell.detached &&
			cell.status.State === "none" &&
			cell.ending === null &&
			cell.inflight === null &&
			cell.exposed === null &&
			!cell.dirty &&
			(cell.current === null || cell.current.retired !== null) &&
			!table.get(cell.key, cell.ownerId)
		) {
			forget(cell);
		}
	}

	function forget(cell: ICell): void {
		const ck = cellKey(cell.key, cell.ownerId);
		if (cells.get(ck) !== cell) {
			return;
		}
		cell.detached = true;
		cells.delete(ck);
		const owned = cellsByOwner.get(cell.ownerId);
		owned?.delete(cell);
		if (owned?.size === 0) {
			cellsByOwner.delete(cell.ownerId);
		}
	}

	function versionFor(key: string, ownerId: string): IVersion {
		let owned = versions.get(ownerId);
		if (!owned) {
			owned = new Map();
			versions.set(ownerId, owned);
		}
		let version = owned.get(key);
		if (!version) {
			version = host.createVersion();
			owned.set(key, version);
		}
		return version;
	}

	function bump(cell: ICell): void {
		versions.get(cell.ownerId)?.get(cell.key)?.bump();
	}

	function setStatus(cell: ICell, status: IResourceStatus): void {
		cell.status = status;
		bump(cell);
	}

	function reportRelease(key: string, error: unknown): void {
		diag.emit(
			callbackThrew(`Resource "${key}"'s release of an exposed value`, error, {
				key
			})
		);
	}

	function runRelease(exposed: NonNullable<ICell["exposed"]>): void {
		if (!exposed.release) {
			return;
		}
		try {
			exposed.release(exposed.value);
		} catch (error) {
			reportRelease(exposed.instance.cell.key, error);
		}
	}

	function clearValue(instance: IInstance): void {
		const cell = instance.cell;
		if (cell.exposed?.instance !== instance) {
			return;
		}
		const exposed = cell.exposed;
		cell.exposed = null;
		bump(cell);
		runRelease(exposed);
	}

	function abortNow(instance: IInstance): void {
		if (instance.aborted) {
			return;
		}
		instance.aborted = true;
		unaborted.delete(instance);
		clearValue(instance);
		instance.controller.abort(retirementError(instance));
	}

	// One AbortError per instance, so r.signal.reason, a call's ctx.signal
	// reason and r.run's rejection are the same object.
	function retirementError(instance: IInstance): DOMException {
		instance.retirementError ??= new DOMException(instance.retired ?? "disposed", "AbortError");
		return instance.retirementError;
	}

	function dropQueue(instance: IInstance): void {
		instance.queue = [];
		instance.dropped = true;
		instance.parked?.abort();
	}

	function flushWaiting(instance: IInstance): void {
		const waiting = instance.waiting;
		instance.waiting = [];
		for (const resume of waiting) {
			resume();
		}
	}

	function retire(instance: IInstance, reason: IResourceRetireReason): void {
		if (instance.retired) {
			return;
		}
		instance.retired = reason;
		instance.idle = [];
		instance.idleAfterDelivery = [];
		if (reason !== "ended") {
			dropQueue(instance);
		}
		enqueue(() => {
			flushWaiting(instance);
			abortNow(instance);
		});
	}

	function actOnEnding(cell: ICell): void {
		const ending = cell.ending;
		if (!ending || ending.actedOn) {
			return;
		}
		ending.actedOn = true;
		dropQueue(ending.instance);
	}

	function endInstance(instance: IInstance, ended: IEnded): void {
		if (instance.retired) {
			return;
		}
		const cell = instance.cell;
		instance.ended = ended;
		retire(instance, "ended");
		const ending: IEnding = {
			instance,
			actedOn: false,
			noticeSent: false
		};
		cell.ending = ending;
		enqueue(() => {
			if (cell.current === instance) {
				setStatus(cell, {
					State: "ended",
					...ended
				});
			}
		});
		enqueue(() => pump(instance));
	}

	function failInstance(instance: IInstance, error: unknown): void {
		// A setup that ended itself and then threw has already said why.
		if (instance.retired !== null) {
			return;
		}
		const ended: IEnded = {
			Reason: "failed",
			Error: serializeThrow(error)
		};
		diag.emit({
			severity: "warn",
			code: "resource/ended",
			message: `[treflex] resource "${instance.cell.key}" on "${instance.cell.ownerId}" failed: ${String(error)}`,
			data: {
				key: instance.cell.key,
				ownerId: instance.cell.ownerId,
				error: ended.Error
			}
		});
		endInstance(instance, ended);
	}

	// The table's watch and an effect's direct notification both land here, and
	// the two for one write collapse into one change.
	function rowChanged(key: string, ownerId: string, cause: "app" | "owner"): void {
		if (disposed) {
			return;
		}
		const cell = cellFor(key, ownerId);
		const row = table.get(key, ownerId);
		actOnEnding(cell);
		const current = cell.current;
		const active = current !== null && current.retired === null;
		if (row && active && rowsEqual(current.row, row)) {
			return;
		}
		if (active) {
			retire(current, row ? "replaced" : cause === "owner" ? "disposed" : "closed");
		}
		if (!row && cause === "app") {
			cell.closedByApp = true;
		}
		markDirty(cell);
	}

	function markDirty(cell: ICell): void {
		if (cell.dirty) {
			return;
		}
		cell.dirty = true;
		enqueue(() => reconcile(cell));
	}

	function reconcile(cell: ICell): void {
		cell.dirty = false;
		if (cell.detached) {
			return;
		}
		const row = table.get(cell.key, cell.ownerId);
		const closedByApp = cell.closedByApp;
		cell.closedByApp = false;
		if (!row) {
			if (closedByApp || cell.status.State !== "ended") {
				setStatus(cell, NONE);
			}
			forgetIfEmpty(cell);
			return;
		}
		if (cell.current && cell.current.retired === null) {
			return;
		}
		// The ending's own finish, or an app act on the cell, settles it.
		if (cell.ending && !cell.ending.actedOn) {
			return;
		}
		if (isPaused()) {
			setStatus(cell, {
				State: "pending",
				Waiting: "paused"
			});
			return;
		}
		const registered = types.get(row.Params.Type);
		if (!registered) {
			setStatus(cell, {
				State: "pending",
				Waiting: "type"
			});
			diag.emitOnce(
				JSON.stringify([
					"resource/unregistered-type",
					row.Params.Type,
					row.Key,
					row.OwnerId
				]),
				{
					severity: "warn",
					code: "resource/unregistered-type",
					message:
						`[treflex] resource "${row.Key}" on "${row.OwnerId}" names type "${row.Params.Type}", which no ` +
						`registerResourceType call has registered. The row is recorded and opens when the type registers.`,
					data: {
						type: row.Params.Type,
						key: row.Key,
						ownerId: row.OwnerId
					}
				}
			);
			return;
		}
		if (row.ReceiverId !== null && !receivers.get(row.ReceiverId)) {
			setStatus(cell, {
				State: "pending",
				Waiting: "receiver"
			});
			diag.emitOnce(
				JSON.stringify([
					"receiver/unresolved",
					"resource",
					row.Key,
					row.OwnerId,
					row.ReceiverId
				]),
				{
					severity: "warn",
					code: "receiver/unresolved",
					message:
						`[treflex] resource "${row.Key}" on "${row.OwnerId}" names receiver "${row.ReceiverId}", which resolves to no ` +
						`registered handle. The resource waits unconnected until runtime.registerReceiver registers it.`,
					data: {
						key: row.Key,
						ownerId: row.OwnerId,
						receiverId: row.ReceiverId,
						kind: "resource"
					}
				}
			);
			return;
		}
		// The predecessor's abort runs before its successor's setup, even when
		// this reconcile was queued ahead of the retirement's own drain task.
		const previous = cell.current;
		if (previous && !previous.aborted) {
			flushWaiting(previous);
			abortNow(previous);
		}
		const instance: IInstance = {
			cell,
			row,
			phase: "queued",
			retired: null,
			retirementError: null,
			aborted: false,
			controller: new AbortController(),
			queue: [],
			delivering: false,
			dropped: false,
			parked: null,
			idle: [],
			idleAfterDelivery: [],
			runningIdle: false,
			methods: null,
			supplyHandler: null,
			setupOpen: false,
			waiting: [],
			detail: undefined,
			ended: null,
			endOnReceiverFailure: registered.options.endOnReceiverFailure === true,
			depthReported: false
		};
		cell.current = instance;
		unaborted.add(instance);
		setStatus(cell, {
			State: "pending",
			Waiting: "setup"
		});
		// The owner's cursor must reflect everything already delivered, so a
		// replacement waits for the cell's in-flight delivery, and only this
		// cell waits.
		if (cell.inflight) {
			cell.inflight.then(() => enqueue(() => setup(instance)));
		} else {
			setup(instance);
		}
	}

	function setup(instance: IInstance): void {
		if (instance.retired || disposed || instance.cell.detached) {
			flushWaiting(instance);
			return;
		}
		const implementation = types.get(instance.row.Params.Type)?.implementation;
		if (!implementation) {
			return;
		}
		instance.phase = "setup";
		instance.setupOpen = true;
		let returned: unknown;
		try {
			returned = implementation(clone(instance.row.Params), createSurface(instance));
		} catch (error) {
			instance.setupOpen = false;
			failInstance(instance, error);
			flushWaiting(instance);
			return;
		}
		instance.setupOpen = false;
		if (instance.retired === null) {
			instance.phase = "live";
			setStatus(instance.cell, liveStatus(instance));
		}
		flushWaiting(instance);
		if (returned !== null && typeof (returned as PromiseLike<unknown>)?.then === "function") {
			(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
				if (instance.retired === null && !disposed) {
					failInstance(instance, error);
				}
			});
		}
	}

	function liveStatus(instance: IInstance): IResourceStatus {
		return instance.detail === undefined
			? {
					State: "live"
				}
			: {
					State: "live",
					Detail: instance.detail
				};
	}

	function readResumeFrom(row: IResourceRow): string | number | boolean | null | undefined {
		if (row.ResumeFrom === null) {
			return undefined;
		}
		const owner = resolveOwner(row.OwnerId);
		if (!owner) {
			return undefined;
		}
		const field = row.ResumeFrom;
		const value = host.untrack(() => (owner.getState() as Record<string, unknown> | undefined)?.[field]);
		return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
	}

	function createSurface(instance: IInstance): IUntypedResourceContext {
		const cell = instance.cell;
		const resumeFrom = readResumeFrom(instance.row);
		const setupOnly = (member: string) => {
			const error = new Error(
				`[treflex] resource "${cell.key}": r.${member} registers during setup only — the synchronous part of the ` +
					`implementation, before its first await. Register it before awaiting anything.`
			);
			error.name = "ResourceSetupError";
			return error;
		};
		return {
			emit(message) {
				return emit(instance, message);
			},
			onIdle(callback) {
				if (instance.retired) {
					return;
				}
				if (instance.runningIdle) {
					instance.idleAfterDelivery.push(callback);
					return;
				}
				instance.idle.push(callback);
				enqueue(() => pump(instance));
			},
			methods(handlers) {
				if (!instance.setupOpen) {
					throw setupOnly("methods");
				}
				instance.methods = {
					...(handlers as Record<string, (...args: any[]) => unknown>)
				};
			},
			onSupply(handler) {
				if (!instance.setupOpen) {
					throw setupOnly("onSupply");
				}
				instance.supplyHandler = handler as (value: unknown) => unknown;
			},
			expose(value, release) {
				if (instance.retired) {
					try {
						release?.(value);
					} catch (error) {
						reportRelease(cell.key, error);
					}
					return;
				}
				const previous = cell.exposed;
				cell.exposed = {
					instance,
					value,
					release
				};
				bump(cell);
				if (previous) {
					runRelease(previous);
				}
			},
			run(effect) {
				return run(instance, effect);
			},
			status(detail) {
				if (instance.retired) {
					return;
				}
				instance.detail = detail;
				if (instance.phase === "live") {
					enqueue(() => {
						if (cell.current === instance && instance.retired === null) {
							setStatus(cell, liveStatus(instance));
						}
					});
				}
			},
			resumeFrom,
			end(reason) {
				endInstance(instance, {
					Reason: reason ?? "ended"
				});
			},
			signal: instance.controller.signal,
			ownerId: cell.ownerId,
			key: cell.key
		};
	}

	function run<R>(instance: IInstance, effect: Generator<unknown, R, any>): Promise<R> {
		if (instance.retired) {
			return Promise.reject(retirementError(instance));
		}
		const { key, ownerId } = instance.cell;
		const owner = resolveOwner(ownerId);
		if (!owner) {
			return Promise.reject(new Error(`[treflex] r.run: the owner "${ownerId}" of resource "${key}" is not in the state tree.`));
		}
		function* resourceRun(): IOpenGenerator<R> {
			return yield* effect as IOpenGenerator<R>;
		}
		// The check is on the instance, not r.signal: an owner's disposal
		// cancels the action, which resolves undefined, before the drain
		// aborts r.signal.
		return dispatchInternal(resourceRun, owner.getState, owner.setState, () => ownerId, [], {
			origin: {
				Kind: "resource:run",
				Key: key,
				OwnerId: ownerId
			},
			signal: instance.controller.signal
		}).then(
			(result) => {
				if (instance.retired) {
					throw retirementError(instance);
				}
				return clone(result) as R;
			},
			(error: unknown) => {
				throw instance.retired ? retirementError(instance) : error;
			}
		);
	}

	function emit(instance: IInstance, message: unknown): Promise<void> {
		if (instance.retired) {
			return ACCEPTED;
		}
		const { key, ownerId } = instance.cell;
		const problem = messageProblem(message);
		const checked =
			problem === null
				? copyFrozen({
						Type: key,
						...(message as object)
					})
				: null;
		if (problem !== null || !checked?.ok) {
			const detail =
				problem ??
				(checked && !checked.ok
					? `it carries a non-plain ${checked.kind} at [${checked.path.map(String).join(".")}]`
					: "it is not plain data");
			diag.emit({
				severity: "warn",
				code: "resource/invalid-message",
				message:
					`[treflex] resource "${key}" on "${ownerId}" emitted a message that was not delivered: ${detail}. A message is a ` +
					`plain, non-array object of plain data with no Type and no $-prefixed field; wrap anything else ({ Event: wire }).`,
				data: {
					key,
					ownerId
				}
			});
			promoteIdleLater(instance);
			return ACCEPTED;
		}
		instance.queue.push(checked.value as Record<string, unknown>);
		if (instance.queue.length > QUEUE_DEPTH_REPORT && !instance.depthReported) {
			instance.depthReported = true;
			diag.emit({
				severity: "warn",
				code: "resource/queue-depth",
				message:
					`[treflex] resource "${key}" on "${ownerId}" has more than ${QUEUE_DEPTH_REPORT} emits queued behind its ` +
					`receiver. Batch what arrives and emit it from r.onIdle, or keep the receiver quick.`,
				data: {
					key,
					ownerId,
					depth: instance.queue.length
				}
			});
		}
		enqueue(() => pump(instance));
		return ACCEPTED;
	}

	function pump(instance: IInstance): void {
		const cell = instance.cell;
		// A detached cell's instance is retired; only an ending still left on
		// it has a queue to drop.
		if (instance.delivering || disposed || (cell.detached && cell.ending === null)) {
			return;
		}
		const ending = cell.ending?.instance === instance ? cell.ending : null;
		if (ending?.actedOn) {
			dropQueue(instance);
			if (cell.ending === ending) {
				cell.ending = null;
			}
			return;
		}
		if (instance.retired !== null && instance.retired !== "ended") {
			return;
		}
		const next = instance.queue.shift();
		if (next) {
			deliver(instance, next);
			return;
		}
		if (ending && !ending.noticeSent) {
			ending.noticeSent = true;
			const row = table.get(cell.key, cell.ownerId);
			if (row && row.ReceiverId !== null) {
				deliver(
					instance,
					{
						Type: cell.key,
						$Ended: {
							...instance.ended!
						}
					},
					() => enqueue(() => finishEnding(ending))
				);
			} else {
				finishEnding(ending);
			}
			return;
		}
		runIdle(instance);
	}

	function runIdle(instance: IInstance): void {
		const callbacks = instance.idle;
		instance.idle = [];
		instance.runningIdle = true;
		try {
			for (const callback of callbacks) {
				if (instance.retired !== null) {
					return;
				}
				try {
					callback();
				} catch (error) {
					failInstance(instance, error);
				}
			}
		} finally {
			instance.runningIdle = false;
		}
	}

	function finishEnding(ending: IEnding): void {
		const cell = ending.instance.cell;
		if (cell.ending === ending) {
			cell.ending = null;
		}
		if (ending.actedOn) {
			return;
		}
		retracting = true;
		try {
			table.close(cell.key, cell.ownerId);
		} finally {
			retracting = false;
		}
	}

	// For a message no delivery will settle. On a timer, not in this drain: a callback that
	// registers again and emits again would otherwise keep the drain from ending.
	function promoteIdleLater(instance: IInstance): void {
		setTimeout(() => {
			if (instance.retired !== null || disposed || instance.idleAfterDelivery.length === 0) {
				return;
			}
			instance.idle.push(...instance.idleAfterDelivery);
			instance.idleAfterDelivery = [];
			enqueue(() => pump(instance));
		}, 0);
	}

	function deliver(instance: IInstance, data: Record<string, unknown>, onSettled?: () => void): void {
		const cell = instance.cell;
		const { key, ownerId } = cell;
		const row = table.get(key, ownerId);
		const handle = row && row.ReceiverId !== null ? receivers.get(row.ReceiverId) : undefined;
		const owner = handle ? resolveOwner(ownerId) : undefined;
		if (!handle || !owner) {
			onSettled?.();
			promoteIdleLater(instance);
			enqueue(() => pump(instance));
			return;
		}
		if (journal.wants("message:deliver")) {
			journal.append({
				T: performance.now(),
				Kind: "message:deliver",
				Topic: key,
				PublisherId: ownerId,
				RecipientIds: [
					ownerId
				]
			});
		}
		instance.delivering = true;
		const parked = new AbortController();
		instance.parked = parked;
		let settle!: () => void;
		const inflight = new Promise<void>((resolve) => {
			settle = resolve;
		});
		dispatchInternal(
			handle,
			owner.getState,
			owner.setState,
			() => ownerId,
			[
				data,
				{
					publisher: {
						Id: ownerId
					}
				}
			],
			{
				origin: {
					Kind: "resource:deliver",
					Key: key,
					OwnerId: ownerId
				},
				signal: parked.signal,
				onStart: () => {
					instance.parked = null;
					if (instance.dropped || disposed) {
						return false;
					}
					// Not at dispatch: a reopen by the action holding the owner would wait on a
					// delivery queued behind that same action.
					cell.inflight = inflight;
					return true;
				}
			}
		)
			.then(undefined, (error: unknown) => {
				if (journal.wants("receiver:error")) {
					journal.append(
						{
							T: performance.now(),
							Kind: "receiver:error",
							Topic: key,
							RecipientId: ownerId,
							PublisherId: ownerId
						},
						{
							error
						}
					);
				}
				if (instance.endOnReceiverFailure) {
					failForReceiver(instance);
				}
			})
			.then(() => {
				instance.delivering = false;
				if (cell.inflight === inflight) {
					cell.inflight = null;
				}
				instance.idle.push(...instance.idleAfterDelivery);
				instance.idleAfterDelivery = [];
				settle();
				onSettled?.();
				enqueue(() => {
					pump(instance);
					forgetIfEmpty(cell);
				});
			});
	}

	function failForReceiver(instance: IInstance): void {
		const failed: IEnded = {
			Reason: "receiver-failed"
		};
		if (instance.retired === null) {
			instance.queue = [];
			endInstance(instance, failed);
			return;
		}
		const cell = instance.cell;
		const ending = cell.ending;
		if (instance.retired !== "ended" || ending?.instance !== instance || ending.actedOn || ending.noticeSent) {
			return;
		}
		instance.queue = [];
		instance.ended = failed;
		enqueue(() => {
			if (cell.current === instance) {
				setStatus(cell, {
					State: "ended",
					...failed
				});
			}
		});
	}

	function reportUnanswerable(key: string, ownerId: string, what: string): void {
		const cell = cells.get(cellKey(key, ownerId));
		// An ended instance the drain has not yet stamped counts.
		if (cell?.status.State === "ended" || cell?.current?.retired === "ended") {
			diag.emitOnce(
				JSON.stringify([
					"resource/used-after-end",
					key,
					ownerId
				]),
				{
					severity: "warn",
					code: "resource/used-after-end",
					message: `[treflex] ${what} on resource "${key}" of "${ownerId}" found the resource ended, and resolves undefined. Reopen it to use it again.`,
					data: {
						key,
						ownerId
					}
				}
			);
			return;
		}
		diag.emitOnce(
			JSON.stringify([
				"resource/not-open",
				key,
				ownerId
			]),
			{
				severity: "warn",
				code: "resource/not-open",
				message:
					`[treflex] ${what} on resource "${key}" of "${ownerId}" found no open resource, and resolves undefined. ` +
					`Open it with openResource first, or check the key and the owner.`,
				data: {
					key,
					ownerId
				}
			}
		);
	}

	function plainResult(value: unknown, what: string): unknown {
		const checked = cloneStrict(value);
		if (!checked.ok) {
			throw new NonPlainDataError(`${what}: the result`, checked.kind, checked.path);
		}
		return checked.value;
	}

	function drained(): Promise<void> {
		return new Promise((resolve) => {
			if (disposed) {
				resolve();
				return;
			}
			const settle = () => {
				unsettled.delete(settle);
				resolve();
			};
			unsettled.add(settle);
			enqueue(settle);
		});
	}

	async function call(request: IResourceMethodRequest, signal: AbortSignal): Promise<unknown> {
		const { Key: key, OwnerId: ownerId, Method: method } = request;
		const what = `method "${method}"`;
		const args = copyFrozenList(request.Args);
		if (!args.ok) {
			throw new NonPlainDataError(
				`resource(${JSON.stringify(ownerId)}, "${key}").${method}: an argument`,
				args.kind,
				args.path,
				"Nothing was sent."
			);
		}
		const row = table.get(key, ownerId);
		if (!row) {
			reportUnanswerable(key, ownerId, what);
			return undefined;
		}
		if (stubs) {
			const stub = stubs.methods?.[key]?.[method];
			if (!stub) {
				throw new Error(
					`[treflex] test runtime: ${what} on resource "${key}" has no stub. Pass ` +
						`resources: { methods: { "${key}": { ${method}: (ctx, ...args) => ... } } } to createTestRuntime.`
				);
			}
			return plainResult(
				await stub(
					{
						ownerId
					},
					...(args.value as unknown[])
				),
				`the stub for ${what} on "${key}"`
			);
		}
		const ck = cellKey(key, ownerId);
		let cell = cells.get(ck);
		let instance = cell?.current ?? null;
		// A row whose instance is still to come (an open or a replace this
		// tick, a reopen of an ended cell) is set up in the drain: wait for
		// it rather than answer for an instance that does not exist yet.
		if (!cell || cell.dirty || !instance || (instance.retired !== null && instance.retired !== "ended")) {
			await drained();
			if (disposed) {
				return undefined;
			}
			cell = cells.get(ck);
			instance = cell?.current ?? null;
		}
		if (!instance || instance.retired) {
			if (instance?.retired === "ended") {
				reportUnanswerable(key, ownerId, what);
			}
			return undefined;
		}
		if (instance.phase !== "live") {
			const waitingOn = instance;
			await new Promise<void>((resume) => waitingOn.waiting.push(resume));
			if (instance.retired) {
				return undefined;
			}
		}
		const handler = instance.methods?.[method];
		if (!handler) {
			diag.emitOnce(
				JSON.stringify([
					"resource/unknown-method",
					key,
					method
				]),
				{
					severity: "warn",
					code: "resource/unknown-method",
					message: `[treflex] resource "${key}" (type "${row.Params.Type}") registered no ${what}; the call resolves undefined.`,
					data: {
						key,
						method,
						type: row.Params.Type
					}
				}
			);
			return undefined;
		}
		let result: unknown;
		try {
			result = await handler(
				{
					signal: AbortSignal.any([
						instance.controller.signal,
						signal
					])
				},
				...(args.value as unknown[])
			);
		} catch (error) {
			if (instance.retired) {
				return undefined;
			}
			throw error;
		}
		if (instance.retired) {
			return undefined;
		}
		return plainResult(result, `${what} on resource "${key}"`);
	}

	function supplyDropped(key: string, ownerId: string, reason: string): undefined {
		diag.emit({
			severity: "warn",
			code: "resource/supply-dropped",
			message:
				`[treflex] a value supplied to resource "${key}" of "${ownerId}" had no taker (${reason}) and was dropped. ` +
				`The view still holds it, and anything it must stop is the view's to stop.`,
			data: {
				key,
				ownerId,
				reason
			}
		});
		return undefined;
	}

	function supply(key: string, ownerId: string, value: unknown): Promise<unknown> {
		if (journal.wants("resource:supply")) {
			journal.append({
				T: performance.now(),
				Kind: "resource:supply",
				Root: deps.rootOf?.(ownerId) ?? "AppState",
				Key: key,
				OwnerId: ownerId
			});
		}
		return new Promise((outerResolve, outerReject) => {
			const resolve = (value: unknown) => {
				unsettled.delete(resolve);
				outerResolve(value);
			};
			const reject = (error: unknown) => {
				unsettled.delete(resolve);
				outerReject(error);
			};
			unsettled.add(resolve);
			const settle = (work: () => unknown) => {
				Promise.resolve().then(work).then(resolve, reject);
			};
			const take = () => {
				const row = table.get(key, ownerId);
				if (!row) {
					resolve(supplyDropped(key, ownerId, "no open resource"));
					return;
				}
				if (stubs) {
					const stub = stubs.supplies?.[key];
					if (!stub) {
						reject(
							new Error(
								`[treflex] test runtime: a supply to resource "${key}" has no stub. Pass resources: { supplies: { "${key}": (ctx, value) => ... } } ` +
									`to createTestRuntime.`
							)
						);
						return;
					}
					settle(async () =>
						plainResult(
							await stub(
								{
									ownerId
								},
								value
							),
							`the supply stub for "${key}"`
						)
					);
					return;
				}
				const instance = cells.get(cellKey(key, ownerId))?.current;
				if (!instance || instance.retired) {
					resolve(supplyDropped(key, ownerId, isPaused() ? "paused" : "no live instance"));
					return;
				}
				const hand = () => {
					if (instance.retired) {
						resolve(supplyDropped(key, ownerId, "retired before setup"));
						return;
					}
					const handler = instance.supplyHandler;
					if (!handler) {
						resolve(supplyDropped(key, ownerId, "no onSupply registered"));
						return;
					}
					let returned: unknown;
					try {
						returned = handler(value);
					} catch (error) {
						reject(error);
						return;
					}
					settle(async () => {
						const response = await returned;
						return instance.retired ? undefined : plainResult(response, `the supply handler of "${key}"`);
					});
				};
				if (instance.phase === "live") {
					hand();
				} else {
					instance.waiting.push(hand);
				}
			};
			if (disposed) {
				resolve(undefined);
				return;
			}
			enqueue(take);
		});
	}

	function stubbedStatus(key: string, ownerId: string): IResourceStatus | undefined {
		if (!stubs || !table.get(key, ownerId)) {
			return undefined;
		}
		const status = stubs.statuses?.[key];
		if (status) {
			return {
				...status
			} as IResourceStatus;
		}
		const anyStub =
			stubs.methods?.[key] !== undefined ||
			stubs.supplies?.[key] !== undefined ||
			(stubs.exposes !== undefined && key in stubs.exposes) ||
			stubs.statuses?.[key] !== undefined;
		return anyStub
			? {
					State: "live"
				}
			: undefined;
	}

	function status(key: string, ownerId: string): IResourceStatus {
		const ck = cellKey(key, ownerId);
		versionFor(key, ownerId).track();
		const stubbed = stubbedStatus(key, ownerId);
		if (stubbed) {
			return stubbed;
		}
		const current = cells.get(ck)?.status ?? NONE;
		return {
			...current
		} as IResourceStatus;
	}

	function value(key: string, ownerId: string): unknown {
		const ck = cellKey(key, ownerId);
		versionFor(key, ownerId).track();
		if (stubs?.exposes && key in stubs.exposes) {
			return table.get(key, ownerId) ? stubs.exposes[key] : undefined;
		}
		return cells.get(ck)?.exposed?.value;
	}

	table.watch((key, ownerId, _row, cause) => {
		if (retracting) {
			return;
		}
		rowChanged(key, ownerId, cause === "owner" ? "owner" : "app");
	});

	// Runs in the cascade's resources phase, after the table's own sweep.
	// It still runs when an ending already retracted the row, so the cell's
	// status and value always clear with its owner.
	deps.onDispose((ownerId) => {
		if (disposed) {
			return;
		}
		const owned = cellsByOwner.get(ownerId);
		cellsByOwner.delete(ownerId);
		for (const cell of owned ?? []) {
			actOnEnding(cell);
			if (cell.current && cell.current.retired === null) {
				retire(cell.current, "disposed");
			}
			cell.detached = true;
			cell.status = NONE;
			cells.delete(cellKey(cell.key, cell.ownerId));
		}
		// Dropped now, so a same-$Id owner re-added in this tick tracks fresh
		// versions; the old ones are bumped in the drain so their readers
		// re-read.
		const tracked = versions.get(ownerId);
		versions.delete(ownerId);
		if (tracked) {
			enqueue(() => {
				for (const version of tracked.values()) {
					version.bump();
				}
			});
		}
	});

	function registerType(type: string, implementation: IUntypedResourceImplementation, options: IResourceTypeOptions = {}): void {
		const replacing = types.has(type);
		types.set(type, {
			implementation,
			options: {
				...options
			}
		});
		for (const row of table.entries()) {
			if (row.Params.Type !== type) {
				continue;
			}
			const cell = cellFor(row.Key, row.OwnerId);
			if (cell.current && cell.current.retired === null) {
				if (!replacing) {
					continue;
				}
				retire(cell.current, "replaced");
			}
			markDirty(cell);
		}
	}

	function resume(): void {
		if (!paused) {
			return;
		}
		paused = false;
		for (const cell of cells.values()) {
			markDirty(cell);
		}
		for (const row of table.entries()) {
			markDirty(cellFor(row.Key, row.OwnerId));
		}
	}

	function dispose(): void {
		if (disposed) {
			return;
		}
		for (const cell of cells.values()) {
			actOnEnding(cell);
			const current = cell.current;
			if (current && current.retired === null) {
				current.retired = "disposed";
				dropQueue(current);
			}
		}
		disposed = true;
		tasks.length = 0;
		for (const resolve of [
			...unsettled
		]) {
			resolve(undefined);
		}
		for (const instance of [
			...unaborted
		]) {
			flushWaiting(instance);
			abortNow(instance);
		}
		for (const cell of cells.values()) {
			if (cell.exposed) {
				const exposed = cell.exposed;
				cell.exposed = null;
				runRelease(exposed);
			}
			// A view still mounted across dispose must not read live with no
			// instance behind it.
			setStatus(cell, NONE);
		}
	}

	return {
		registerType,
		open(row) {
			table.open(row);
			rowChanged(row.Key, row.OwnerId, "app");
		},
		close(key, ownerId) {
			table.close(key, ownerId);
			rowChanged(key, ownerId, "app");
		},
		call,
		awaitsDelivery(key, ownerId) {
			const cell = cells.get(cellKey(key, ownerId));
			if (stubs || !cell || cell.inflight === null || !table.get(key, ownerId)) {
				return false;
			}
			const current = cell.current;
			return cell.dirty || (current !== null && current.retired === null && current.phase !== "live");
		},
		supply,
		status,
		value,
		pause() {
			paused = true;
		},
		load(rows) {
			table.load(rows);
			for (const row of table.entries()) {
				markDirty(cellFor(row.Key, row.OwnerId));
			}
		},
		resume,
		drained,
		trackedCellCount: () => {
			let count = 0;
			for (const owned of versions.values()) {
				count += owned.size;
			}
			return count;
		},
		permanentlyPaused,
		setStubs(next) {
			stubs = next;
		},
		receiverRegistered(receiverId) {
			for (const row of table.entries()) {
				if (row.ReceiverId !== receiverId) {
					continue;
				}
				// A live instance already has its receiver: an HMR swap is no
				// reason to set anything up again.
				const cell = cellFor(row.Key, row.OwnerId);
				if (cell.current === null || cell.current.retired !== null) {
					markDirty(cell);
				}
			}
		},
		dispose
	};
}

function rowsEqual(a: IResourceRow, b: IResourceRow): boolean {
	return a.ReceiverId === b.ReceiverId && a.ResumeFrom === b.ResumeFrom && jsonEquals(a.Params, b.Params);
}

// The message rule beyond plain data: only Message is spread into the
// receiver's argument, so it cannot carry Type or a treflex-reserved field.
function messageProblem(message: unknown): string | null {
	if (message === null || typeof message !== "object") {
		return "it is not an object";
	}
	if (Array.isArray(message)) {
		return "it is an array";
	}
	for (const key of Object.keys(message)) {
		if (key === "Type") {
			return "it carries its own Type";
		}
		if (key.startsWith("$")) {
			return `it carries the reserved field "${key}"`;
		}
	}
	return null;
}
