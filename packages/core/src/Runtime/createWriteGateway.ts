import type { IRecordRoot } from "../Types/IRecord";
import type { IDiagEmitter } from "../Types/IRuntimeEvent";
import type { IJournal } from "./createJournal";
import type { IFiber } from "./Fiber";
import type { IRootSetState, ISetState } from "./sliceSetState";
import { host } from "../Solid/host";
import { callbackThrew } from "../Types/IRuntimeEvent";
import { DEV } from "../Utility/devMode";
import { DraftDetachedError, EntityReplacedError, isMintedId, receiverFault, refuseWrittenId } from "./draftNode";
import { EMPTY_INDEX, NonPlainDataError } from "./nonPlainDataError";
import { TreflexRefusal } from "./refusal";
import { StateAliasError } from "./stateAlias";
import { StateCycleError } from "./stateCycle";
import { notifyWrite, tracking } from "./tracking";
import { type ISlotHome, MoveBetweenRootsError, slotHomes } from "./transient";
import { rawOf, view } from "./viewProxy";

export type IStateIdLookup = {
	[key: string]: {
		state: any;
		setState: ISetState<any>;
		path: string[];
	};
};

export type IStateIdLookupAccessor = () => IStateIdLookup;

// As of the last reconciliation. `left` is a node this gateway once placed, and `unknown` one it
// never did.
export type INodePlace =
	| {
			kind: "at";
			entityId: string;
			slot?: string;
			path: string[];
	  }
	| {
			kind: "left";
	  }
	| {
			kind: "unknown";
	  }
	| {
			kind: "no-entity";
	  };

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/stateIdLookup": IStateIdLookupAccessor;
		"runtime/writeGateway": IWriteGateway;
	}
}

// The dispose cascade's phases, in firing order: cancellation must land
// before the sweeps so no cleanup races a still-running action, tables
// release rows before the caches that resolve through them, and resource
// cleanups run against already-swept tables. Within a phase, registration
// order is preserved.
const DISPOSE_PHASE_ORDER = [
	"cancel",
	"tables",
	"caches",
	"resources"
] as const;
export type IDisposePhase = (typeof DISPOSE_PHASE_ORDER)[number];

export interface IWriteGateway extends ISlotHome {
	enforceWriteOrigin(target: object): void;
	refuseOutsideAction(target: object): never;
	refuseReplacement(target: object, value: object, fromReconcileRowsAdd?: boolean): void;
	refuseCrossing(target: object, live: object): void;
	// The node a draft reaches this owner's slot through, unwritten until a write reaches
	// it. Null for a stopped fiber whose owner's address has ended: it writes to a throwaway.
	slotRoot(owner: object, name: string, fresh: () => object): object | null;
	// A write through a slot's proxy to a node that has left, which only a stopped fiber can
	// make. `root` is the proxy's: only a slot's proxies are rooted at the top of the roots.
	slotEnded(root: object, raw: object): boolean;
	// Undefined when the index doesn't hold the $Id.
	rootNameOf(id: string): IRecordRoot | undefined;
	// False from the start of the $Id's cascade, while its cell still answers a lookup.
	addressLive(id: string): boolean;
	// A refused write never reaches the drain, so `onDrained` reports only containers
	// that took a write. `seating` marks a write through `seat`: the node it put
	// there never counts as plain data replacing an entity.
	observe(target: object, key: string, seating?: boolean): void;
	// After the write has landed, with what the slot held before it. `length` is the array's
	// length before an element write, and -1 otherwise; `order` an object's keys before a delete.
	logWrite(target: object, key: string, had: boolean, prev: unknown, length: number, order?: readonly string[]): void;
	logMark(): number;
	unwindTo(mark: number): void;
	// Indexes in [from, to) that a write may have left empty, judged when the frame ends.
	noteGap(target: readonly unknown[], from: number, to: number): void;
	// Counts the rollbacks so far: a draft's cached paths read after one may name a reorder it undid.
	rollbacks(): number;
	// The keys from `root` down to `node`, as of the last reconciliation; undefined when not below it.
	pathFrom(root: object, node: object): PropertyKey[] | undefined;
	// Whether a frame is open whose end can hold work until the frame has passed its check.
	frameOpen(): boolean;
	afterFrame(run: () => void, drop: () => void): void;
	frame<R>(fn: () => R): R;
	// A generator slice's frame. `ending` is
	// the executing fiber, held for the frame's duration: isDetached answers false
	// while it reads stopped, so the finally blocks of a stopped action write the
	// nodes that have left the tree.
	actionFrame<R>(fn: () => R, ending?: Pick<IFiber, "stopped">, slice?: ISliceHooks): R;
	exemptFrame<R>(fn: () => R): R;
	isDetached(raw: object): boolean;
	detachedPath(raw: object): readonly string[] | undefined;
	// Entities the fresh walk no longer finds run the full dispose cascade, children-first.
	resync(): void;
	// Late wiring: the root setState is built over the gateway, so the
	// gateway must exist first.
	connect(
		rootState: object,
		rootSetState: IRootSetState<any>,
		transientRoot?: Record<string, Record<string, object>>,
		componentRoot?: Record<string, Record<string, object>>
	): void;
	lookup: IStateIdLookupAccessor;
	// Raw and untracked, for indexes derived from the cells.
	cellOf(id: string): object | undefined;
	cellIds(): string[];
	// Called whenever an $Id's cell is added, repointed or deleted, a rollback's included. The
	// index is mid-reconcile then, so a listener only notes the id.
	onCell(callback: (id: string) => void): void;
	// Per-id cleanup registration: children-first across a removed subtree,
	// phases in DISPOSE_PHASE_ORDER, registrants in registration order
	// within a phase. The path is the entity's id-ancestry as of the last
	// reconciliation — still readable after the node has left the tree.
	onDispose(callback: (id: string, path: readonly string[]) => void, phase: IDisposePhase): void;
	// Cascades the entire tree, children-first.
	dispose(): void;
	// Null follows a rebuild, a resync's or a rollback's: it read the tree without the traps, so
	// any container may have changed. Up-links are current when it runs. Listeners
	// must not write. A listener's throw reaches neither the writer nor the other
	// listeners: it is a runtime/callback-threw diag.
	onDrained(callback: (touched: readonly object[] | null) => void): () => void;
	rootNode(): object;
	// A snapshot of the last reconciliation.
	nodeUpLink(node: object):
		| {
				parent: object | null;
				key: string;
		  }
		| undefined;
	// The $Id of the nearest entity at or above the node, as of the last reconciliation: a
	// transient or a ComponentState holder answers its owner. Undefined when the node has no meta, null
	// when no entity is above it.
	entityOf(node: object): string | null | undefined;
	// `at` is a dispatch's address: an entity the index owns, or the owner of the transient
	// the path starts in, and never a ComponentState holder's key.
	placeOf(node: object): INodePlace;
	readonly slotHome: ISlotHome;
}

export interface ISliceHooks {
	// Names what a rollback undoes, as "the slice ending at …", read only when one happens.
	endedAt(): string;
	rolledBack(refusal: Error): void;
	// Takes the starting of the dispatches the frame held, so the caller lands its record first.
	release(settle: () => void): void;
}

export interface IEntityAttachments {
	receiver: string | undefined;
	timers: number;
	resources: number;
	actions: readonly string[];
}

export interface IWriteGatewayOptions {
	journal: IJournal;
	emitDiag: IDiagEmitter;
	attachmentsOf?: (entityId: string) => IEntityAttachments;
	verifyIndex?: boolean | IVerifyIndexMode | undefined;
}

// Keyed by RAW node (rawOf of any proxy). The children map is the removal
// diff's "previous children"; id is the node's indexed identity at the last
// reconciliation.
type INodeMeta = {
	parent: object | null;
	key: string;
	children: Map<string, object>;
	id: string | null;
};

// Reading a slot must not write, so a draft's read holds it here until a write reaches it.
type IUnbornSlot = {
	ownerId: string;
	name: string;
	root: object;
	nodes: object[];
};

// The holder is reachable from the first read and goes under TransientState only at the first
// write. A reader subscribes to the holder's key, so another slot's first write wakes nobody.
type IOwnerSlots = {
	holder: Record<string, object>;
	unborn: Map<string, IUnbornSlot>;
};

// The ComponentState holder for mounts under a root with no $Id, which no entity owns.
export const COMPONENT_ROOT_KEY = "";

export const VERIFY_MIN_CADENCE = 16;
export const VERIFY_MAX_CADENCE = 4096;
export const VERIFY_NODE_BUDGET = 32;

export const TRIPWIRE_MASK = VERIFY_MIN_CADENCE - 1;

const REPLACED_ENTITIES_NAMED = 10;

// `arrival` is the node an ordinary write put in the slot. A shift within an array,
// and a node `seat` put there, is not one.
type IVacatedSlot = {
	parent: object;
	key: string;
	child: object;
	arrival: object | null;
};

type IContainerAfterReplacement = {
	node: object;
	at: string[];
	ownKey: string | null;
	former: object | null;
};

type IPlainReplacement = {
	at: string[];
	entities: (IEntityAttachments & {
		id: string;
	})[];
};

export type IVerifyIndexMode = "always" | "budgeted" | "off";

function verifyCadenceFor(nodeCount: number): number {
	const scaled = Math.ceil(nodeCount / VERIFY_NODE_BUDGET);
	return Math.min(VERIFY_MAX_CADENCE, Math.max(VERIFY_MIN_CADENCE, scaled));
}

// DEV alone would be "always": this package ships raw TypeScript, so a
// consumer's dev server and test run compile these sources under the same
// flag and would pay walks against their own trees. This repo's vitest config
// sets TREFLEX_VERIFY_INDEX to `always`.
function defaultVerifyMode(): IVerifyIndexMode {
	const flag = (
		globalThis as {
			process?: {
				env?: Record<string, string | undefined>;
			};
		}
	).process?.env?.TREFLEX_VERIFY_INDEX;
	if (flag === "always" || flag === "budgeted" || flag === "off") {
		return flag;
	}
	return DEV ? "budgeted" : "off";
}

type ILoopHit = {
	path: string[];
	loop: string[];
};

type IAliasHit = {
	node: object;
	parent: object;
	key: string;
};

type IUndoWrite = {
	target: object;
	key: string;
	had: boolean;
	prev: unknown;
	length: number;
	// An object's keys before a delete: a key put back goes last, so the keys after it follow it again.
	order?: readonly string[] | undefined;
};

type IUndo = IUndoWrite | (() => void);

function undo(entry: IUndo): void {
	if (typeof entry === "function") {
		entry();
		return;
	}
	const { key, had, prev, length, order } = entry;
	const target = entry.target as Record<string, unknown>;
	const isArray = Array.isArray(target);
	const lengthBefore = isArray ? target.length : 0;
	const hadNow = Object.hasOwn(target, key);
	if (had) {
		target[key] = prev;
	} else {
		delete target[key];
	}
	if (order && !hadNow) {
		for (const later of order.slice(order.indexOf(key) + 1)) {
			if (Object.hasOwn(target, later)) {
				const value = target[later];
				delete target[later];
				target[later] = value;
			}
		}
	}
	if (isArray && length >= 0 && target.length !== length) {
		target.length = length;
	}
	notifyWrite(target, key, true, hadNow !== had, isArray && target.length !== lengthBefore);
}

type IExpectedCell = {
	raw: object;
	path: string[];
};

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

function entityIdOf(node: object): string | null {
	const id = (
		node as {
			$Id?: unknown;
		}
	).$Id;
	return typeof id === "string" && id !== "" ? id : null;
}

function holdsData(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || value === undefined) {
		return false;
	}
	if (typeof value !== "object") {
		return true;
	}
	if (seen.has(value)) {
		return false;
	}
	seen.add(value);
	for (const key in value) {
		if (key !== "$Id" && holdsData((value as Record<string, unknown>)[key], seen)) {
			return true;
		}
	}
	return false;
}

function holdsArrivingData(container: object, former: ReadonlySet<unknown> | null): boolean {
	for (const key in container) {
		const child = (container as Record<string, unknown>)[key];
		if (key !== "$Id" && !former?.has(child) && holdsData(child)) {
			return true;
		}
	}
	return false;
}

function holdsEntityRows(container: object): boolean {
	for (const key in container) {
		const row = (container as Record<string, unknown>)[key];
		if (row !== null && typeof row === "object" && Object.hasOwn(row, "$Id")) {
			return true;
		}
	}
	return false;
}

function describeAttachments({ receiver, timers, resources, actions }: IEntityAttachments): string {
	const parts: string[] = [];
	if (receiver !== undefined) {
		parts.push(`bound to receiver "${receiver}"`);
	}
	if (timers > 0) {
		parts.push(`${timers} timer(s)`);
	}
	if (resources > 0) {
		parts.push(`${resources} resource(s)`);
	}
	if (actions.length > 0) {
		parts.push(`running ${actions.map((name) => `"${name}"`).join(", ")}`);
	}
	return parts.join(", ");
}

export function createWriteGateway(options: IWriteGatewayOptions): IWriteGateway {
	const { journal, emitDiag } = options;

	const verifyMode: IVerifyIndexMode =
		options.verifyIndex === undefined
			? defaultVerifyMode()
			: typeof options.verifyIndex === "string"
				? options.verifyIndex
				: options.verifyIndex
					? "always"
					: "off";

	let rootRaw: object | null = null;
	let rootSetState: IRootSetState<any> | null = null;

	// Replaced wholesale on resync so detached nodes lose their entries —
	// stale meta on a node that later re-enters the tree would defeat the
	// walk's "already in place here" pruning.
	let meta = new WeakMap<object, INodeMeta>();
	// Every node meta was ever written for, which a resync's fresh map forgets.
	const known = new WeakSet<object>();
	const detached = new WeakMap<
		object,
		{
			path: string[];
			// A same-$Id replacement leaves the node with its address alive. Set when the
			// $Id's cascade runs, and gone with the entry if the node comes back.
			addressEnded?: true;
		}
	>();
	let transientRaw: Record<string, Record<string, object>> = Object.create(null);
	let componentRaw: Record<string, Record<string, object>> = Object.create(null);
	const isHolderRoot = (node: object | null): boolean => node === transientRaw || node === componentRaw;
	// Set when a slot or a component holder first appears, and never cleared: a node that left a
	// holder root keeps that root after the holders empty, so the crossing check can't skip then.
	let holdersSeen = false;
	const ownerSlots = new Map<string, IOwnerSlots>();
	const unbornNodes = new WeakMap<object, IUnbornSlot>();
	// The root each node written since the last drain went into, since it has no meta until the
	// drain gives it one.
	const arrivingRoot = new Map<object, object>();
	// Read raw inside the gateway and served through the view proxy. Every
	// write goes through the three helpers, which bump the tracking layer as
	// a tree write would; a cell is only ever written on genuine change.
	const cells: IStateIdLookup = Object.create(null);
	const cellsView = view(cells);
	const cellListeners: ((id: string) => void)[] = [];
	const cellChanged = (id: string): void => {
		for (const listener of cellListeners) {
			listener(id);
		}
	};
	function setCell(id: string, cell: IStateIdLookup[string]): void {
		const had = Object.hasOwn(cells, id);
		cells[id] = cell;
		notifyWrite(cells, id, true, !had, false);
		cellChanged(id);
	}
	function deleteCell(id: string): void {
		if (!Object.hasOwn(cells, id)) {
			return;
		}
		delete cells[id];
		notifyWrite(cells, id, true, true, false);
		cellChanged(id);
	}
	function setCellField<K extends "state" | "path">(id: string, field: K, value: IStateIdLookup[string][K]): void {
		const cell = cells[id]!;
		cell[field] = value;
		notifyWrite(cell, field, true, false, false);
		if (field === "state") {
			cellChanged(id);
		}
	}
	const home: ISlotHome = {
		readSlot: (ownerId, name) => {
			if (!ownerSlots.has(ownerId) && !cells[ownerId]) {
				return undefined;
			}
			const { holder } = slotsOf(ownerId);
			tracking.trackKey(holder, name);
			const root = holder[name];
			return root && view(root);
		}
	};

	const disposeCallbacks: Record<IDisposePhase, ((id: string, path: readonly string[]) => void)[]> = {
		cancel: [],
		tables: [],
		caches: [],
		resources: []
	};

	function onDispose(callback: (id: string, path: readonly string[]) => void, phase: IDisposePhase): void {
		disposeCallbacks[phase].push(callback);
	}

	// Callers guarantee children have already cascaded. Appending the record
	// after the phase loops is what keeps a tap subscriber that mutates a
	// reactive store from waking a disposing entity's still-subscribed
	// readers.
	function runDisposePipeline(id: string, path: readonly string[]): void {
		const recordRoot = rootNameOf(id) ?? "AppState";
		const gone = detached.get(cells[id]?.state as object);
		if (gone) {
			gone.addressEnded = true;
		}
		dropSlots(id);
		dropComponents(id);
		for (const phase of DISPOSE_PHASE_ORDER) {
			for (const callback of disposeCallbacks[phase]) {
				try {
					callback(id, path);
				} catch (error) {
					emitDiag(
						callbackThrew(`A ${phase} dispose callback for "${id}"`, error, {
							entityId: id
						})
					);
				}
			}
		}
		if (journal.wants("entity:dispose")) {
			journal.append({
				T: performance.now(),
				Kind: "entity:dispose",
				Root: recordRoot,
				EntityId: id,
				Path: [
					...path
				]
			});
		}
		ownerSlots.delete(id);
	}

	let frameDepth = 0;
	let exemptDepth = 0;
	let draining = false;
	let drainsSinceVerify = 0;
	let verifyCadence = VERIFY_MIN_CADENCE;
	// A fiber the teardown stopped closes a microtask later, and its finally can
	// still write. The index is empty by then, with the tree standing.
	let disposed = false;
	let sliceEnding: Pick<IFiber, "stopped"> | undefined;
	const pending = new Map<object, Set<string>>();
	const seatedNodes = new WeakSet<object>();
	const replacedByPlain = new Map<object, IPlainReplacement>();
	const containerVerdicts = new Map<object, boolean>();
	const formerChildSets = new Map<object, ReadonlySet<unknown>>();
	let removalSlot: IVacatedSlot | null = null;
	const drainListeners: ((touched: readonly object[] | null) => void)[] = [];
	const drained = new Set<object>();
	let resynced = false;
	let formerSlots: IAliasHit[] = [];
	// Holds every write since the last pass that passed the check.
	let undoLog: IUndo[] = [];
	const gaps = new Map<readonly unknown[], number[]>();
	let deferred: {
		run: () => void;
		drop: () => void;
	}[] = [];
	// Set while a reconcile walks, so what it changes in the index can be undone with the writes.
	let checking = false;
	let rebuilding = false;
	let sliceLoop: ILoopHit | null = null;
	let sliceLoops = 0;
	let rollbacks = 0;

	// Cells re-pointed during the current walk pass, as { id, incumbent }.
	// writeCell cannot decide a collision at the moment it happens: mid-pass
	// the incumbent's up-link may still be stale. Every candidate is
	// therefore re-tested once the pass has walked every touched container.
	let cellCandidates: {
		id: string;
		incumbent: object;
	}[] = [];

	function noteCellRepoint(id: string, incumbent: object): void {
		cellCandidates.push({
			id,
			incumbent
		});
	}

	// Callers hold the draining latch and untrack. Every pass is judged: the first carries the
	// frame's own writes, and a later one a dispose callback's, past the frame's undoing.
	function drainPending(hooks?: ISliceHooks): Error | null {
		let first = true;
		while (pending.size > 0) {
			while (pending.size > 0) {
				const touched = [
					...pending
				];
				pending.clear();
				const refusal = host.batch(() => reconcile(touched, hooks));
				if (refusal) {
					if (first) {
						return refusal;
					}
					throw new Error(
						`[treflex] a write made in the dispose cascade left an alias, a loop, two nodes with one $Id or an empty array index ` +
							`in the tree, and was undone: ${refusal.message}`
					);
				}
				first = false;
				if (drainListeners.length > 0) {
					for (const [container] of touched) {
						drained.add(container);
					}
				}
			}
			reportPlainReplacements();
		}
		return null;
	}

	function logWrite(target: object, key: string, had: boolean, prev: unknown, length: number, order?: readonly string[]): void {
		if (frameDepth > 0) {
			undoLog.push({
				target,
				key,
				had,
				prev,
				length,
				order
			});
		}
	}

	function logUndo(fn: () => void): void {
		if (frameDepth > 0 || checking) {
			undoLog.push(fn);
		}
	}

	function rawWrite(target: Record<string, unknown>, key: string, value: unknown): void {
		const had = Object.hasOwn(target, key);
		const prev = target[key];
		target[key] = value;
		logWrite(target, key, had, prev, -1);
	}

	function unwindTo(mark: number): void {
		while (undoLog.length > mark) {
			undo(undoLog.pop()!);
		}
	}

	function noteGap(target: readonly unknown[], from: number, to: number): void {
		if (frameDepth === 0 || to <= from) {
			return;
		}
		const ranges = gaps.get(target);
		if (ranges) {
			ranges.push(from, to);
		} else {
			gaps.set(target, [
				from,
				to
			]);
		}
	}

	function commit(): void {
		undoLog = [];
		gaps.clear();
	}

	function rollback(): void {
		const log = undoLog;
		undoLog = [];
		gaps.clear();
		for (let i = log.length - 1; i >= 0; i--) {
			undo(log[i]!);
		}
		rollbacks++;
		rebuildIndex("rollback");
	}

	function undoneBy(hooks: ISliceHooks | undefined): string {
		const what = hooks?.endedAt() ?? "the write";
		return `${what.charAt(0).toUpperCase()}${what.slice(1)} was undone, so state is as it was before it.`;
	}

	// Judged after phase 1, ahead of every disposal, so a refused frame has done nothing
	// a rollback can't take back.
	function sliceRefusal(aliasHits: readonly IAliasHit[], hooks: ISliceHooks | undefined): Error | null {
		if (sliceLoop) {
			return new StateCycleError(sliceLoop.path, sliceLoop.loop, sliceLoops - 1, undoneBy(hooks));
		}
		if (aliasHits.length > 0) {
			const hit = aliasHits[0]!;
			return new StateAliasError(
				keyPathOf(hit.node),
				[
					...keyPathOf(hit.parent),
					hit.key
				],
				aliasHits.length - 1,
				undoneBy(hooks)
			);
		}
		for (const { id, incumbent } of cellCandidates) {
			const current = cells[id]?.state as object | undefined;
			if (!current || current === incumbent || entityIdOf(incumbent) !== id) {
				continue;
			}
			const im = meta.get(incumbent);
			if (im && upLinksHold(incumbent, im)) {
				return new EntityReplacedError(id, keyPathOf(incumbent), false, {
					at: keyPathOf(current),
					undone: undoneBy(hooks)
				});
			}
		}
		// A gap wider than the frame's write count can't have been filled, so the scan stops there.
		const bound = undoLog.length + 1;
		for (const [array, ranges] of gaps) {
			const m = meta.get(array);
			if (!m || !upLinksHold(array, m)) {
				continue;
			}
			for (let r = 0; r < ranges.length; r += 2) {
				const from = ranges[r]!;
				const end = Math.min(ranges[r + 1]!, array.length, from + bound);
				for (let i = from; i < end; i++) {
					if (!(i in array)) {
						return new NonPlainDataError(
							"a write to state",
							EMPTY_INDEX,
							[
								...keyPathOf(array),
								String(i)
							],
							undoneBy(hooks)
						);
					}
				}
			}
		}
		return null;
	}

	// A drain counts: a dispatch from a dispose callback or a record tap would otherwise run its
	// first slice inside the drain, where a refusal is past undoing.
	function frameOpen(): boolean {
		return frameDepth > 0 || draining;
	}

	function afterFrame(run: () => void, drop: () => void): void {
		if (!frameOpen()) {
			run();
			return;
		}
		deferred.push({
			run,
			drop
		});
	}

	function takeDeferred(refused: boolean): () => void {
		const held = deferred;
		deferred = [];
		return () => {
			for (const { run, drop } of held) {
				if (refused) {
					drop();
				} else {
					run();
				}
			}
		};
	}

	function slotsOf(ownerId: string): IOwnerSlots {
		let slots = ownerSlots.get(ownerId);
		if (!slots) {
			holdersSeen = true;
			slots = {
				holder: Object.create(null),
				unborn: new Map()
			};
			ownerSlots.set(ownerId, slots);
		}
		return slots;
	}

	function ownerPath(ownerId: string): string[] {
		return cells[ownerId]?.path ?? [];
	}

	function slotRoot(owner: object, name: string, fresh: () => object): object | null {
		const id = entityIdOf(owner);
		if (!id) {
			throw new Error(`[treflex] transient("${name}"): the owner is not an entity, and a transient belongs to an entity.`);
		}
		if (!slotHomes.has(owner)) {
			throw new Error(`[treflex] transient("${name}"): the owner "${id}" is not on the state tree.`);
		}
		if (isDetached(owner)) {
			throw new DraftDetachedError("the owner left the state tree, and its transient went with it", detached.get(owner)?.path);
		}
		if (detached.get(owner)?.addressEnded || !cells[id]) {
			return null;
		}
		const slots = slotsOf(id);
		const held = slots.holder[name] ?? slots.unborn.get(name)?.root;
		if (held) {
			return held;
		}
		const unborn: IUnbornSlot = {
			ownerId: id,
			name,
			root: fresh(),
			nodes: []
		};
		const visit = (node: object): void => {
			unborn.nodes.push(node);
			unbornNodes.set(node, unborn);
			for (const child of Object.values(node)) {
				if (child !== null && typeof child === "object") {
					visit(child);
				}
			}
		};
		visit(unborn.root);
		slots.unborn.set(name, unborn);
		return unborn.root;
	}

	function bearSlot(unborn: IUnbornSlot): void {
		const { ownerId, name, root } = unborn;
		const { holder, unborn: waiting } = slotsOf(ownerId);
		waiting.delete(name);
		for (const node of unborn.nodes) {
			unbornNodes.delete(node);
			arrivingRoot.set(node, transientRaw);
		}
		logUndo(() => {
			waiting.set(name, unborn);
			for (const node of unborn.nodes) {
				unbornNodes.set(node, unborn);
			}
		});
		rawWrite(holder, name, root);
		notifyWrite(holder, name, true, true, false);
		if (transientRaw[ownerId] === holder) {
			observe(holder, name);
		} else {
			rawWrite(transientRaw, ownerId, holder);
			observe(transientRaw, ownerId);
		}
	}

	// This and dropComponents run ahead of the owner's own pipeline, so an entity in a holder
	// disposes first and can still resolve its lineage through the owner while it cleans up.
	function dropSlots(ownerId: string): void {
		const slots = ownerSlots.get(ownerId);
		if (!slots) {
			return;
		}
		for (const unborn of slots.unborn.values()) {
			for (const node of unborn.nodes) {
				unbornNodes.delete(node);
				markDetached(node);
			}
		}
		slots.unborn.clear();
		const { holder } = slots;
		for (const name of Object.keys(holder)) {
			const root = holder[name]!;
			delete holder[name];
			notifyWrite(holder, name, true, true, false);
			meta.get(holder)?.children.delete(name);
			removeSubtree(root);
		}
		if (transientRaw[ownerId] === holder) {
			delete transientRaw[ownerId];
			meta.get(transientRaw)?.children.delete(ownerId);
			removeSubtree(holder);
		}
	}

	function dropComponents(ownerId: string): void {
		const holder = componentRaw[ownerId];
		if (!holder) {
			return;
		}
		delete componentRaw[ownerId];
		notifyWrite(componentRaw, ownerId, true, true, false);
		meta.get(componentRaw)?.children.delete(ownerId);
		removeSubtree(holder);
	}

	function rootOf(node: object): object | null {
		let current = node;
		while (true) {
			if (unbornNodes.has(current)) {
				return transientRaw;
			}
			const m = meta.get(current);
			if (!m) {
				return arrivingRoot.get(current) ?? rootNamed(detached.get(current)?.path[0]);
			}
			if (m.parent === null || m.parent === rootRaw) {
				return current;
			}
			current = m.parent;
		}
	}

	// A node that left keeps the root it left, so it can come back there and nowhere else.
	function rootNamed(name: string | undefined): object | null {
		if (name === "TransientState") {
			return transientRaw;
		}
		if (name === "ComponentState") {
			return componentRaw;
		}
		if (name === "AppState") {
			return (rootRaw as Record<string, object> | null)?.AppState ?? null;
		}
		return null;
	}

	function refuseCrossing(target: object, live: object): void {
		if (meta.get(live)?.parent === target || !holdersSeen) {
			return;
		}
		const from = rootOf(live);
		const to = rootOf(target);
		if (from && to && from !== to) {
			throw new MoveBetweenRootsError(placeOf(live, from), placeOf(target, to));
		}
	}

	function placeOf(node: object, root: object): string[] {
		if (meta.has(node)) {
			return keyPathOf(node);
		}
		const unborn = unbornNodes.get(node);
		if (unborn) {
			return [
				"TransientState",
				unborn.ownerId,
				unborn.name
			];
		}
		return [
			nameOfRoot(root),
			"…"
		];
	}

	function nameOfRoot(root: object): IRecordRoot {
		return root === transientRaw ? "TransientState" : root === componentRaw ? "ComponentState" : "AppState";
	}

	function rootNameOf(id: string): IRecordRoot | undefined {
		const cell = cells[id];
		const root = cell && rootOf(cell.state as object);
		return root ? nameOfRoot(root) : undefined;
	}

	function enforceWriteOrigin(target: object): void {
		if (exemptDepth === 0) {
			refuseOutsideAction(target);
		}
	}

	function refuseOutsideAction(target: object): never {
		const at = keyPathOf(rawOf(target));
		const location = at.length > 0 ? ` at [${at.join(".")}]` : "";
		const message =
			`[treflex] state mutations belong to actions — this write${location} reached the state tree outside a step of the action that owns it. ` +
			`A draft is written only during its own action's steps, so not in a timer, a promise callback or another action's body. ` +
			`Dispatch an action to make this write. An external system pushing state in is a resource.`;
		emitDiag({
			severity: "warn",
			code: "state/outside-action-write",
			message,
			data: {
				path: at
			}
		});
		throw new TreflexRefusal(message);
	}

	// A node with meta was walked when it arrived, and a write below it since came
	// through here itself, so only what is new to the tree is searched. The cell still
	// holds a node removed earlier in this frame, so a remove and re-assign is caught.
	// A target with no meta in a stopped fiber's frame is its finally writing the node that
	// left: nothing it writes can enter the tree. A node that left isn't hand-written, whatever
	// its $Id: it was seated once, and it's coming back.
	function refuseReplacement(target: object, value: object, fromReconcileRowsAdd = false): void {
		if (meta.has(value)) {
			return;
		}
		const root = rootOf(target);
		holdersSeen ||= isHolderRoot(root);
		const seen = new Set<object>();
		const visit = (node: object): void => {
			if (seen.has(node) || meta.has(node)) {
				return;
			}
			seen.add(node);
			if (root) {
				arrivingRoot.set(node, root);
			}
			const id = (
				node as {
					$Id?: unknown;
				}
			).$Id;
			if (id !== undefined) {
				const incumbent = typeof id === "string" ? (cells[id]?.state as object | undefined) : undefined;
				if (incumbent) {
					if (incumbent !== node && (meta.has(target) || sliceEnding?.stopped !== true)) {
						throw new EntityReplacedError(id as string, keyPathOf(incumbent), fromReconcileRowsAdd);
					}
				} else if (!isMintedId(id) && !detached.has(node)) {
					refuseWrittenId(id);
				}
			}
			const fault = receiverFault(node);
			if (fault) {
				throw new TypeError(`[treflex] draft: this write holds ${fault.problem}, and the write was refused. ${fault.rule}`);
			}
			for (const key of Object.keys(node)) {
				const child = (node as Record<string, unknown>)[key];
				if (child !== null && typeof child === "object") {
					visit(child);
				}
			}
		};
		visit(value);
	}

	// A frameless write sits in pending until the next frame's drain. Every
	// mutation entry point opens a frame, so nothing legitimate waits.
	function observe(target: object, key: string, seating = false): void {
		const raw = rawOf(target);
		const unborn = unbornNodes.get(raw);
		if (unborn) {
			bearSlot(unborn);
		}
		if (seating) {
			const seated = (raw as Record<string, unknown>)[key];
			if (seated !== null && typeof seated === "object") {
				seatedNodes.add(rawOf(seated));
			}
		}
		const keys = pending.get(raw);
		if (keys) {
			keys.add(key);
			return;
		}
		pending.set(
			raw,
			new Set([
				key
			])
		);
	}

	// One host batch spans fn and the frame-end drain, so a memo re-running in
	// the mutation's own flush observes the post-reconciliation index, and a
	// mutation and its cascade land as one flush.
	function runFrame<R>(exempt: boolean, fn: () => R, hooks?: ISliceHooks): R {
		const outermost = frameDepth === 0 && !draining;
		let settle: (() => void) | null = null;
		try {
			return host.batch(() => {
				frameDepth++;
				if (exempt) {
					exemptDepth++;
				}
				let threw = false;
				try {
					return fn();
				} catch (error) {
					threw = true;
					throw error;
				} finally {
					if (exempt) {
						exemptDepth--;
					}
					frameDepth--;
					if (frameDepth === 0) {
						let refusal: Error | null = null;
						let drained = false;
						try {
							refusal = drain(hooks);
							drained = true;
						} finally {
							// Inside the batch: its flush can open a frame of its own, which would
							// otherwise take this frame's held dispatches as its own.
							if (outermost) {
								settle = takeDeferred(!drained || refusal !== null);
							}
						}
						if (refusal) {
							hooks?.rolledBack(refusal);
							if (!threw) {
								// biome-ignore lint/correctness/noUnsafeFinally: the refusal replaces the frame's result
								throw refusal;
							}
						}
					}
				}
			});
		} finally {
			const held = settle as (() => void) | null;
			if (held) {
				if (hooks) {
					hooks.release(held);
				} else {
					held();
				}
			}
		}
	}

	function markDetached(node: object): void {
		detached.set(node, {
			path: keyPathOf(node)
		});
	}

	function isDetached(raw: object): boolean {
		if (!detached.has(raw)) {
			return false;
		}
		return sliceEnding?.stopped !== true;
	}

	function drain(hooks?: ISliceHooks): Error | null {
		if (draining) {
			return null;
		}
		if (pending.size === 0) {
			commit();
			arrivingRoot.clear();
			// A notice held across an open frame can have nothing left to reconcile.
			notifyDrained();
			return null;
		}
		draining = true;
		let refusal: Error | null = null;
		try {
			host.untrack(() => {
				// A dispose cleanup that writes the tree re-enters mid-drain:
				// its nested frame's end finds `draining` set and returns, and
				// the loop picks the new touches up.
				refusal = drainPending(hooks);
			});
			arrivingRoot.clear();
			notifyDrained();
			if (verifyMode !== "off" && !disposed && ++drainsSinceVerify >= verifyCadence) {
				drainsSinceVerify = 0;
				const visited = verifyAgainstTree();
				verifyCadence = verifyMode === "always" ? 1 : verifyCadenceFor(visited);
			}
		} finally {
			commit();
			draining = false;
		}
		return refusal;
	}

	function notifyDrained(): void {
		if (!resynced && drained.size === 0) {
			return;
		}
		const touched = resynced
			? null
			: [
					...drained
				];
		resynced = false;
		drained.clear();
		for (const listener of [
			...drainListeners
		]) {
			try {
				listener(touched);
			} catch (error) {
				emitDiag(callbackThrew("An onDrained listener", error));
			}
		}
	}

	function reconcile(
		touched: [
			object,
			Set<string>
		][],
		hooks: ISliceHooks | undefined
	): Error | null {
		checking = true;
		// Phase 1: additions, moves, identity changes. A touched node without
		// meta is either brand new, so a touched ancestor's walk adopts it, or
		// detached.
		//
		// The attachment check is load-bearing: the collection-replacement
		// idiom (push into an array, then assign a filtered copy) touches the
		// old array too, and walking that detached array would steal the
		// up-links of elements the new array carried over, so phase 2 would
		// dispose live entities. A node whose check fails may be mid-move, so
		// failures defer and retry until a pass makes no progress.
		const vacated: IVacatedSlot[] = [];
		// Cascaded with the removals, never inside phase 1: a dispose callback
		// can write the tree, and re-entering the gateway mid-walk would
		// reconcile against half-updated up-links.
		const identitiesLost: {
			id: string;
			node: object;
		}[] = [];
		let queue = touched;
		while (queue.length > 0) {
			const deferred: [
				object,
				Set<string>
			][] = [];
			let progress = false;
			for (const [node, keys] of queue) {
				const m = meta.get(node);
				if (!m) {
					continue;
				}
				if (!upLinksHold(node, m)) {
					deferred.push([
						node,
						keys
					]);
					continue;
				}
				walkContainer(node, m, keys, vacated, identitiesLost);
				progress = true;
			}
			if (!progress) {
				break;
			}
			queue = deferred;
		}
		// Between the phases: up-links are current only now, and the check reads them.
		const refusal = sliceRefusal(settleFormerSlots(), hooks);
		checking = false;
		sliceLoop = null;
		sliceLoops = 0;
		cellCandidates = [];
		if (refusal) {
			rollback();
			return refusal;
		}
		commit();
		for (const { id, node } of identitiesLost) {
			const cell = cells[id];
			if (cell && cell.state === node) {
				runDisposePipeline(id, [
					...cell.path
				]);
				deleteCell(id);
			}
		}
		// Phase 2: removals, strictly after every phase-1 walk, so a node that
		// moved between two touched containers has already updated its up-link
		// and is never mistaken for a removal.
		const arraysWithArrivals = new Set<object>();
		for (const { parent, arrival } of vacated) {
			if (arrival && Array.isArray(parent)) {
				arraysWithArrivals.add(parent);
			}
		}
		for (const slot of vacated) {
			const { parent, key, child } = slot;
			const cm = meta.get(child);
			// Both halves matter: a node moved to another container fails the
			// parent test, and a splice's shifted survivor fails the key test.
			if (!cm || cm.parent !== parent || cm.key !== key) {
				continue;
			}
			removalSlot = slot.arrival || arraysWithArrivals.has(parent) ? slot : null;
			removeSubtree(child);
			removalSlot = null;
		}
		containerVerdicts.clear();
		formerChildSets.clear();
		return null;
	}

	function reportPlainReplacements(): void {
		if (replacedByPlain.size === 0) {
			return;
		}
		const reports = [
			...replacedByPlain.values()
		];
		replacedByPlain.clear();
		for (const { at, entities } of reports) {
			const named = entities.slice(0, REPLACED_ENTITIES_NAMED);
			emitDiag({
				severity: "warn",
				code: "entity/replaced-by-plain-data",
				message:
					`[treflex] plain data with no $Id replaced the entities at [${at.join(".")}], and everything attached to them has ended: ` +
					`${named.map((entity) => `"${entity.id}" (${describeAttachments(entity)})`).join("; ")}` +
					`${entities.length > named.length ? `; and ${entities.length - named.length} more` : ""}. ` +
					`If this is a refresh, reconcileRows() keeps the rows that match, and what is attached to them. To load one entity, write its fields. ` +
					`To make a new one, use entity().`,
				data: {
					at: at.join("."),
					entities: named
				}
			});
		}
	}

	// Meta staleness only ever fails the check, never passes it falsely: each
	// link is verified against the current tree.
	function upLinksHold(node: object, m: INodeMeta): boolean {
		let current: object = node;
		let cm: INodeMeta | undefined = m;
		while (cm) {
			if (cm.parent === null) {
				return current === rootRaw;
			}
			if ((cm.parent as any)[cm.key] !== current) {
				return false;
			}
			current = cm.parent;
			cm = meta.get(current);
		}
		return false;
	}

	// The tree is already final here, so a slot that stopped holding the node is a move and
	// costs nothing further. One still holding it may be in a container that left the tree,
	// and only a settled pass can tell.
	function noteFormerSlot(node: object, cm: INodeMeta): void {
		const parent = cm.parent as object;
		if ((parent as Record<string, unknown>)[cm.key] === node) {
			formerSlots.push({
				node,
				parent,
				key: cm.key
			});
		}
	}

	function settleFormerSlots(): readonly IAliasHit[] {
		if (formerSlots.length === 0) {
			return formerSlots;
		}
		const hits = formerSlots;
		formerSlots = [];
		const aliases: IAliasHit[] = [];
		let parent: object | null = null;
		let attached = false;
		for (const hit of hits) {
			if (hit.parent !== parent) {
				parent = hit.parent;
				const pm = meta.get(parent);
				attached = pm !== undefined && upLinksHold(parent, pm);
			}
			if (attached) {
				aliases.push(hit);
			}
		}
		return aliases;
	}

	// The per-slot work is bounded by the written keys rather than by the
	// container's size, which keeps a push into a large collection off the
	// collection's length.
	function walkContainer(
		node: object,
		m: INodeMeta,
		keys: ReadonlySet<string>,
		vacated: IVacatedSlot[],
		identitiesLost: {
			id: string;
			node: object;
		}[]
	): void {
		const ancestry = entityAncestryOf(m);
		const id = entityIdOf(node);
		let selfPathChanged = false;
		if (id !== m.id) {
			// The old $Id's registrations would outlive the entity, so the old
			// identity is disposed, in phase 2 with the other cascades.
			if (m.id) {
				identitiesLost.push({
					id: m.id,
					node
				});
			}
			m.id = id;
			selfPathChanged = true;
		}
		const selfPath = id
			? [
					...ancestry,
					id
				]
			: ancestry;
		if (id && writeCell(id, node, selfPath)) {
			selfPathChanged = true;
		}
		for (const key of keys) {
			const prev = m.children.get(key);
			const child = childAt(node, key);
			const isNode = !!child && typeof child === "object";
			if (isNode) {
				m.children.set(key, child as object);
			} else {
				m.children.delete(key);
			}
			if (prev && prev !== child) {
				vacated.push({
					parent: node,
					key,
					child: prev,
					arrival: isNode && isArrival(child as object, node) ? (child as object) : null
				});
			}
			if (!isNode) {
				continue;
			}
			const cm = meta.get(child as object);
			if (!cm) {
				adoptSubtree(child as object, node, key, selfPath);
				continue;
			}
			if (prev === child) {
				continue;
			}
			const reparented = cm.parent !== node;
			if (reparented && closesLoop(child as object, node, key)) {
				m.children.delete(key);
				continue;
			}
			if (reparented || cm.key !== key) {
				noteFormerSlot(child as object, cm);
			}
			// The up-link always updates, because the removal guard and
			// keyPathOf both read it. Paths do not: they are id-ancestry
			// chains, so a splice (same container, new key) cannot change one
			// and only a genuine reparent recomputes.
			cm.parent = node;
			cm.key = key;
			if (reparented) {
				fixPaths(child as object, cm, selfPath);
			}
		}
		if (selfPathChanged) {
			fixChildPaths(node, m, selfPath);
		}
	}

	function adoptSubtree(node: object, parent: object, key: string, ancestry: string[]): void {
		holdersSeen ||= isHolderRoot(parent);
		const gone = detached.get(node);
		if (gone) {
			detached.delete(node);
			logUndo(() => detached.set(node, gone));
		}
		const id = entityIdOf(node);
		const m: INodeMeta = {
			parent,
			key,
			children: new Map(),
			id
		};
		meta.set(node, m);
		known.add(node);
		const above = isHolderRoot(parent) ? ownerPath(key) : ancestry;
		const selfPath = id
			? [
					...above,
					id
				]
			: above;
		if (id) {
			writeCell(id, node, selfPath);
		}
		for (const k of Object.keys(node)) {
			const child = childAt(node, k) as object;
			if (!child || typeof child !== "object") {
				continue;
			}
			const cm = meta.get(child);
			if (cm && closesLoop(child, node, k)) {
				continue;
			}
			m.children.set(k, child);
			if (cm) {
				noteFormerSlot(child, cm);
				cm.parent = node;
				cm.key = k;
				fixPaths(child, cm, selfPath);
			} else {
				adoptSubtree(child, node, k, selfPath);
			}
		}
	}

	// A write to a raw object can seat a proxy the traps never unwrapped. Adopted as it
	// stands, it re-wraps on every read, so a loop through it never repeats an identity.
	function childAt(node: object, key: string): unknown {
		const child = (node as Record<string, unknown>)[key];
		const raw = rawOf(child);
		if (raw !== child) {
			Reflect.set(node, key, raw);
		}
		return raw;
	}

	function linkAbove(node: object): object | null {
		const m = meta.get(node);
		if (!m) {
			return null;
		}
		return isHolderRoot(m.parent) ? ((cells[m.key]?.state as object | undefined) ?? null) : m.parent;
	}

	function closesLoop(child: object, node: object, key: string): boolean {
		let current: object | null = node;
		while (current && current !== child) {
			current = linkAbove(current);
		}
		if (!current) {
			return false;
		}
		const between: string[] = [];
		for (let up: object = node; up !== child; up = linkAbove(up) as object) {
			between.unshift((meta.get(up) as INodeMeta).key);
		}
		const path = [
			...keyPathOf(node),
			key
		];
		if (rebuilding) {
			throw new Error(
				`[treflex] a rebuild met a loop at [${path.join(".")}] — a write past the traps left a node holding its own ancestor.`
			);
		}
		sliceLoop ??= {
			path,
			loop: [
				key,
				...between
			]
		};
		sliceLoops++;
		return true;
	}

	function fixPaths(node: object, m: INodeMeta, ancestry: string[]): void {
		const selfPath = m.id
			? [
					...ancestry,
					m.id
				]
			: ancestry;
		if (m.id && !writeCell(m.id, node, selfPath)) {
			// Descendant paths hang off this one — unchanged here means
			// unchanged below.
			return;
		}
		fixChildPaths(node, m, selfPath);
	}

	// The key test is not redundant with the parent test: `m.children` can hold one child at
	// two slots, and descending from both doubles the walk per level of a ladder.
	function fixChildPaths(node: object, m: INodeMeta, ancestry: string[]): void {
		for (const [key, child] of m.children) {
			const cm = meta.get(child);
			if (cm && cm.parent === node && cm.key === key) {
				fixPaths(child, cm, ancestry);
			}
		}
	}

	function isArrival(child: object, container: object): boolean {
		if (seatedNodes.has(child)) {
			return false;
		}
		return !(Array.isArray(container) && meta.get(child)?.parent === container);
	}

	function noteAttachments(id: string, node: object): void {
		if (!removalSlot) {
			return;
		}
		const attached = options.attachmentsOf?.(id);
		if (
			!attached ||
			(attached.receiver === undefined && attached.timers === 0 && attached.resources === 0 && attached.actions.length === 0)
		) {
			return;
		}
		const container = containerAfterReplacement(removalSlot, node);
		if (!container || clearedOwnKey(container) || !holdsPlainRows(container)) {
			return;
		}
		const report = replacedByPlain.get(container.node);
		const entity = {
			id,
			...attached
		};
		if (report) {
			report.entities.push(entity);
		} else {
			replacedByPlain.set(container.node, {
				at: container.at,
				entities: [
					entity
				]
			});
		}
	}

	function holdsPlainRows({ node, former }: IContainerAfterReplacement): boolean {
		if (replacedByPlain.has(node)) {
			return true;
		}
		let verdict = containerVerdicts.get(node);
		if (verdict === undefined) {
			verdict = holdsArrivingData(node, former && formerChildren(former)) && !holdsEntityRows(node);
			containerVerdicts.set(node, verdict);
		}
		return verdict;
	}

	// Read off the removed node's meta, which still holds what it held before the write.
	function formerChildren(node: object): ReadonlySet<unknown> {
		let children = formerChildSets.get(node);
		if (!children) {
			children = new Set(meta.get(node)?.children.values());
			formerChildSets.set(node, children);
		}
		return children;
	}

	function clearedOwnKey({ node, ownKey }: IContainerAfterReplacement): boolean {
		return ownKey !== null && Object.hasOwn(node, ownKey) && ((node as Record<string, unknown>)[ownKey] ?? null) === null;
	}

	function containerAfterReplacement(slot: IVacatedSlot, node: object): IContainerAfterReplacement | null {
		const below: string[] = [];
		const holders: object[] = [];
		for (let current = node; current !== slot.child; ) {
			const m = meta.get(current);
			if (!m?.parent) {
				return null;
			}
			below.unshift(m.key);
			holders.unshift(m.parent);
			current = m.parent;
		}
		if (below.length === 0) {
			if (Array.isArray(slot.parent)) {
				return {
					node: slot.parent,
					at: keyPathOf(slot.parent),
					ownKey: slot.key,
					former: null
				};
			}
			return slot.arrival && !Object.hasOwn(slot.arrival, "$Id")
				? {
						node: slot.arrival,
						at: [
							...keyPathOf(slot.parent),
							slot.key
						],
						ownKey: null,
						former: slot.child
					}
				: null;
		}
		const at = [
			...keyPathOf(slot.parent),
			slot.key
		];
		let reached: unknown = slot.arrival;
		for (let depth = 0; depth < below.length - 1; depth++) {
			const key = below[depth]!;
			reached = reached !== null && typeof reached === "object" ? (reached as Record<string, unknown>)[key] : undefined;
			if (formerChildren(holders[depth]!).has(reached)) {
				return null;
			}
			at.push(key);
		}
		return reached !== null && typeof reached === "object"
			? {
					node: reached,
					at,
					ownKey: below[below.length - 1]!,
					former: holders[holders.length - 1]!
				}
			: null;
	}

	// The cell leaves the index only after the pipeline, so cleanups run
	// against a still-resolvable entity.
	function removeSubtree(node: object): void {
		const m = meta.get(node);
		if (!m) {
			return;
		}
		// Ahead of the recursion, so keyPathOf still reads a live up-link chain.
		markDetached(node);
		for (const child of m.children.values()) {
			const cm = meta.get(child);
			if (cm && cm.parent === node) {
				removeSubtree(child);
			}
		}
		if (m.id) {
			const id = m.id;
			const cell = cells[id];
			if (cell && cell.state === node) {
				// Ahead of the pipeline, whose phases retract what this reads.
				noteAttachments(id, node);
				runDisposePipeline(id, [
					...cell.path
				]);
				deleteCell(id);
			}
		}
		meta.delete(node);
	}

	// Returns whether anything changed, the callers' pruning signal. Callers
	// hold untrack: the compare reads must not subscribe anything.
	function writeCell(id: string, node: object, path: string[]): boolean {
		const existing = cells[id];
		if (!existing) {
			// The raw node is stored, so lookup()[id].state is reference-equal
			// to the tree's own view of the node.
			setCell(id, {
				state: node,
				setState: makeCellSetState(id),
				path: [
					...path
				]
			});
			slotHomes.set(node, home);
			return true;
		}
		let changed = false;
		const incumbent = existing.state as object;
		if (incumbent !== node) {
			// Either the incumbent left or was replaced, or the tree now holds
			// the $Id twice. Only a settled pass can tell those apart.
			noteCellRepoint(id, incumbent);
			setCellField(id, "state", node);
			slotHomes.set(node, home);
			changed = true;
		}
		if (!pathsEqual(existing.path, path)) {
			setCellField(id, "path", [
				...path
			]);
			changed = true;
			// An owner's holders sit outside its subtree, so the walk that moved the owner does not reach them.
			for (const holder of [
				transientRaw[id],
				componentRaw[id]
			]) {
				const hm = holder && meta.get(holder);
				if (hm) {
					fixPaths(holder, hm, path);
				}
			}
		}
		return changed;
	}

	function pathFrom(root: object, node: object): PropertyKey[] | undefined {
		const keys: string[] = [];
		let current = rawOf(node) as object;
		const top = rawOf(root) as object;
		while (current !== top) {
			const m = meta.get(current);
			if (!m || m.parent === null) {
				return undefined;
			}
			keys.push(m.key);
			current = m.parent;
		}
		return keys.reverse();
	}

	function makeCellSetState(id: string): ISetState<any> {
		return (...args: ((x: any) => any)[]) => {
			// A caller inside a computation must not subscribe to the cell it
			// is writing through.
			const raw = host.untrack(() => {
				const cell = cells[id];
				return cell ? (cell.state as object) : null;
			});
			if (!raw || !rootSetState) {
				return;
			}
			rootSetState.at(raw, keyPathOf(raw), ...args);
		};
	}

	function keyPathOf(node: object): string[] {
		const keys: string[] = [];
		let current: object | null = node;
		while (current && current !== rootRaw) {
			const m = meta.get(current);
			if (!m || m.parent === null) {
				break;
			}
			keys.push(m.key);
			current = m.parent;
		}
		keys.reverse();
		return keys;
	}

	function entityAncestryOf(m: INodeMeta): string[] {
		const ids: string[] = [];
		let key = m.key;
		let current = m.parent;
		while (current) {
			if (isHolderRoot(current)) {
				ids.reverse();
				return [
					...ownerPath(key),
					...ids
				];
			}
			const pm = meta.get(current);
			if (!pm) {
				break;
			}
			if (pm.id) {
				ids.push(pm.id);
			}
			key = pm.key;
			current = pm.parent;
		}
		ids.reverse();
		return ids;
	}

	// A rollback leaves the tree as the last passed pass did, so the containers it touched need
	// no notice, and its dropped cells are the refused pass's arrivals, which nothing was attached
	// to, so they leave with no cascade. A plain node has no cell to drop, so marking the departed
	// is what gives it the mark a removal walk would have left.
	function rebuildIndex(mode: "resync" | "rollback"): void {
		pending.clear();
		if (mode === "resync") {
			resynced = drainListeners.length > 0;
		}
		const previous = meta;
		// Fresh graph: detached nodes must lose their meta or a later
		// re-attachment at the same key would prune as "already here".
		meta = new WeakMap<object, INodeMeta>();
		cellCandidates = [];
		formerSlots = [];
		const seen = new Set<string>();
		host.batch(() => {
			rebuilding = true;
			try {
				rebuildNode(rootRaw!, null, "", [], seen);
			} finally {
				rebuilding = false;
				cellCandidates = [];
			}
			if (mode === "rollback") {
				markDepartedNodes(previous);
			}
			// Descendants sort ahead of their ancestors, so the cascade stays
			// children-first per dropped subtree.
			const dropped = Object.keys(cells)
				.filter((id) => !seen.has(id))
				.map((id) => ({
					id,
					path: [
						...cells[id]!.path
					]
				}))
				.sort((a, b) => (a.path.join(" ") < b.path.join(" ") ? 1 : -1));
			for (const { id, path } of dropped) {
				// Re-read the cell rather than trusting the list: a
				// dispose callback can resync re-entrantly, and the inner
				// rebuild deletes cells this one still holds ids for. The
				// meta test keeps a node a bypassed write re-identified in
				// place, which never left, from being marked detached.
				const node = cells[id]?.state as object | undefined;
				if (node && !meta.has(node) && !detached.has(node)) {
					detached.set(node, {
						path: []
					});
				}
				if (mode === "resync") {
					runDisposePipeline(id, path);
				}
				deleteCell(id);
			}
		});
	}

	// A mark the undo restored is kept, since it may carry an ended address, and a slot the undo
	// put back unborn is waiting for its first write, not gone.
	function markDepartedNodes(previous: WeakMap<object, INodeMeta>): void {
		const keys: string[] = [];
		const visit = (node: object, m: INodeMeta): void => {
			if (!meta.has(node) && !detached.has(node) && !unbornNodes.has(node)) {
				detached.set(node, {
					path: [
						...keys
					]
				});
			}
			for (const [key, child] of m.children) {
				const cm = previous.get(child);
				if (cm && cm.parent === node && cm.key === key) {
					keys.push(key);
					visit(child, cm);
					keys.pop();
				}
			}
		};
		const rootMeta = previous.get(rootRaw as object);
		if (rootMeta) {
			visit(rootRaw as object, rootMeta);
		}
	}

	function resync(): void {
		if (!rootRaw) {
			return;
		}
		const wasDraining = draining;
		draining = true;
		try {
			host.untrack(() => {
				rebuildIndex("resync");
				drainPending();
			});
			if (!wasDraining) {
				notifyDrained();
			}
		} finally {
			draining = wasDraining;
		}
		if (verifyMode !== "off") {
			// Unconditional here, off the budget: the rebuild re-derived the
			// whole index.
			drainsSinceVerify = 0;
			const visited = verifyAgainstTree();
			verifyCadence = verifyMode === "always" ? 1 : verifyCadenceFor(visited);
		}
		if (!wasDraining && frameDepth === 0) {
			takeDeferred(false)();
		}
	}

	function brokenByRawWrite(what: string): Error {
		return new Error(`[treflex] a rebuild met ${what}, which only a write past the traps can make.`);
	}

	function rebuildNode(node: object, parent: object | null, key: string, ancestry: string[], seen: Set<string>): void {
		holdersSeen ||= isHolderRoot(parent);
		detached.delete(node);
		const id = entityIdOf(node);
		const m: INodeMeta = {
			parent,
			key,
			children: new Map(),
			id
		};
		meta.set(node, m);
		known.add(node);
		const above = isHolderRoot(parent) ? ownerPath(key) : ancestry;
		let selfPath = above;
		if (id) {
			if (seen.has(id)) {
				throw brokenByRawWrite(`a second node carrying the $Id "${id}", at [${keyPathOf(node).join(".")}]`);
			}
			selfPath = [
				...above,
				id
			];
			seen.add(id);
			writeCell(id, node, selfPath);
		}
		for (const k of Object.keys(node)) {
			const child = childAt(node, k) as object;
			if (!child || typeof child !== "object") {
				continue;
			}
			const cm = meta.get(child);
			const childId = entityIdOf(child);
			// Holders walk in the order they were born, so an owner can be met in its own holder
			// ahead of the place it sits.
			if (!cm && childId && (transientRaw[childId] || componentRaw[childId])) {
				closesLoop(child, node, k);
			}
			if (cm) {
				closesLoop(child, node, k);
				throw brokenByRawWrite(
					`the node at [${keyPathOf(child).join(".")}] again at [${[
						...keyPathOf(node),
						k
					].join(".")}]`
				);
			}
			m.children.set(k, child);
			rebuildNode(child, node, k, selfPath, seen);
		}
	}

	// The drain latch is held so a cleanup's writes queue instead of
	// recursing; whatever they touched is dead with the runtime, so the queue
	// is dropped.
	function dispose(): void {
		if (!rootRaw) {
			return;
		}
		const wasDraining = draining;
		draining = true;
		disposed = true;
		try {
			host.untrack(() => {
				host.batch(() => removeSubtree(rootRaw!));
			});
		} finally {
			draining = wasDraining;
			pending.clear();
		}
		if (!wasDraining && frameDepth === 0) {
			takeDeferred(false)();
		}
	}

	function verifyAgainstTree(): number {
		if (!rootRaw) {
			return 0;
		}
		const expected = new Map<string, IExpectedCell>();
		const visited = freshWalk(rootRaw, [], [], expected, new Set());
		host.untrack(() => {
			for (const [id, exp] of expected) {
				const cell = cells[id];
				if (!cell) {
					throw new Error(`[treflex] index is missing entity "${id}" — a write path bypassed the gateway.`);
				}
				if (cell.state !== exp.raw) {
					throw new Error(`[treflex] index holds a stale node for entity "${id}" — a write path bypassed the gateway.`);
				}
				if (!pathsEqual(cell.path, exp.path)) {
					throw new Error(`[treflex] index path for entity "${id}" is [${cell.path.join(".")}] but the tree says [${exp.path.join(".")}].`);
				}
			}
			for (const id of Object.keys(cells)) {
				if (!expected.has(id)) {
					throw new Error(`[treflex] index holds entity "${id}" which is no longer in the tree — a removal went unwitnessed.`);
				}
			}
			for (const ownerId of Object.keys(transientRaw)) {
				if (!cells[ownerId]) {
					throw new Error(`[treflex] the transients of "${ownerId}" outlived it.`);
				}
			}
			for (const ownerId of Object.keys(componentRaw)) {
				if (ownerId !== COMPONENT_ROOT_KEY && !cells[ownerId]) {
					throw new Error(`[treflex] the component state mounted under "${ownerId}" outlived it.`);
				}
			}
		});
		return visited;
	}

	function freshWalk(node: object, path: string[], keys: string[], out: Map<string, IExpectedCell>, walked: Set<object>): number {
		walked.add(node);
		let visited = 1;
		const id = entityIdOf(node);
		let selfPath = path;
		if (id) {
			if (out.has(id)) {
				throw new Error(
					`[treflex] the tree holds the $Id "${id}" twice, again at [${keys.join(".")}] — a write path bypassed the gateway.`
				);
			}
			selfPath = [
				...path,
				id
			];
			out.set(id, {
				raw: node,
				path: selfPath
			});
		}
		for (const k of Object.keys(node)) {
			const child = rawOf((node as any)[k]);
			if (!child || typeof child !== "object") {
				continue;
			}
			keys.push(k);
			if (walked.has(child)) {
				throw new Error(
					`[treflex] the tree holds a node twice, again at [${keys.join(".")}], so it is no longer a tree — a write path bypassed the gateway.`
				);
			}
			visited += freshWalk(child, isHolderRoot(node) ? ownerPath(k) : selfPath, keys, out, walked);
			keys.pop();
		}
		return visited;
	}

	function connect(
		rootState: object,
		setStateForRoot: IRootSetState<any>,
		transientRoot?: Record<string, Record<string, object>>,
		componentRoot?: Record<string, Record<string, object>>
	): void {
		rootRaw = rawOf(rootState);
		rootSetState = setStateForRoot;
		transientRaw = transientRoot ?? transientRaw;
		componentRaw = componentRoot ?? componentRaw;
		resync();
	}

	return {
		...home,
		enforceWriteOrigin,
		refuseOutsideAction,
		refuseReplacement,
		refuseCrossing,
		slotRoot,
		slotEnded: (root, raw) => root === rootRaw && detached.has(raw),
		rootNameOf,
		addressLive: (id) => {
			const cell = cells[id];
			return cell !== undefined && !detached.get(cell.state as object)?.addressEnded;
		},
		observe,
		logWrite,
		logMark: () => undoLog.length,
		unwindTo,
		noteGap,
		rollbacks: () => rollbacks,
		pathFrom,
		frameOpen,
		afterFrame,
		frame: (fn) => runFrame(false, fn),
		actionFrame: (fn, ending, slice) => {
			const prev = sliceEnding;
			sliceEnding = ending;
			try {
				return runFrame(false, fn, slice);
			} finally {
				sliceEnding = prev;
			}
		},
		exemptFrame: (fn) => runFrame(true, fn),
		resync,
		connect,
		isDetached,
		detachedPath: (raw) => detached.get(raw)?.path,
		lookup: () => cellsView,
		cellOf: (id) => cells[id]?.state as object | undefined,
		cellIds: () => Object.keys(cells),
		onCell(callback) {
			cellListeners.push(callback);
		},
		onDispose,
		dispose,
		onDrained(callback) {
			drainListeners.push(callback);
			return () => {
				const at = drainListeners.indexOf(callback);
				if (at !== -1) {
					drainListeners.splice(at, 1);
				}
				if (drainListeners.length === 0) {
					drained.clear();
					resynced = false;
				}
			};
		},
		rootNode: () => rootRaw as object,
		nodeUpLink: (node) => {
			const m = meta.get(rawOf(node));
			return m
				? {
						parent: m.parent,
						key: m.key
					}
				: undefined;
		},
		slotHome: home,
		entityOf: (node) => {
			let m = meta.get(rawOf(node));
			if (!m) {
				return undefined;
			}
			while (m) {
				if (m.id) {
					return m.id;
				}
				if (m.parent === null) {
					return null;
				}
				if (isHolderRoot(m.parent)) {
					return m.key;
				}
				m = meta.get(m.parent);
			}
			return null;
		},
		placeOf: (node) => {
			let current = rawOf(node) as object;
			let m = meta.get(current);
			if (!m) {
				return {
					kind: known.has(current) ? "left" : "unknown"
				};
			}
			const path: string[] = [];
			while (m) {
				if (m.id) {
					return {
						kind: "at",
						entityId: m.id,
						path: path.reverse()
					};
				}
				if (m.parent === null) {
					break;
				}
				if (m.parent === transientRaw) {
					const slot = path.pop();
					if (slot === undefined) {
						break;
					}
					return cells[m.key]
						? {
								kind: "at",
								entityId: m.key,
								slot,
								path: path.reverse()
							}
						: {
								kind: "left"
							};
				}
				path.push(m.key);
				current = m.parent;
				m = meta.get(current);
			}
			return {
				kind: "no-entity"
			};
		}
	};
}
