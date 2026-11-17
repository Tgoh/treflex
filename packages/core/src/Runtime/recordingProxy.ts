import type { IRecordChange } from "../Types/IRecord";
import type { IWriteGateway } from "./createWriteGateway";
import { clone } from "../Utility/valueCodec";
import { BIND_WRITE, DETACH_PROBE, DraftDetachedError, refuseIdChange, refuseReceiverWrite, SEAT_WRITE } from "./draftNode";
import { isCode, refuseInSyncCall } from "./effectDeclarations";
import { TreflexRefusal } from "./refusal";
import { runningStep } from "./runningStep";
import { notifyWrite } from "./tracking";
import { freezeAll, isWrappable, rawOf, refuseNonPlain, unwrapValue } from "./viewProxy";

export interface IRecordingContext {
	currentJournalChanges: IRecordChange[] | null;
	isDraft?: boolean;
	gateway?:
		| (Pick<IWriteGateway, "observe"> &
				Partial<
					Pick<
						IWriteGateway,
						| "logWrite"
						| "logMark"
						| "unwindTo"
						| "noteGap"
						| "rollbacks"
						| "pathFrom"
						| "enforceWriteOrigin"
						| "refuseOutsideAction"
						| "refuseReplacement"
						| "refuseCrossing"
						| "isDetached"
						| "detachedPath"
						| "slotEnded"
					>
				>)
		| undefined;
	wrote?: ((target: object, key: string) => void) | undefined;
	// Whether any tap was attached at dispatch, whatever kinds it takes: the stale-path warnings
	// are a tap's witness, not change capture's.
	checkPaths?: boolean;
}

// Read off a recording proxy, answers the draft it belongs to. Symbol.for by the
// cross-module tag-symbol rule (see REGION_OP in open.ts).
export const DRAFT_SCOPE = Symbol.for("treflex.draftScope");

export interface IDraftScope {
	readonly ctx: IRecordingContext;
	readonly cache: WeakMap<object, any>;
	readonly lease: IDraftLease | null;
}

function enforceOrigin(ctx: IRecordingContext, t: object): void {
	if (!ctx.isDraft) {
		ctx.gateway?.enforceWriteOrigin?.(t);
	} else if (runningStep.draft() !== ctx) {
		ctx.gateway?.refuseOutsideAction?.(t);
		throw new TreflexRefusal("[treflex] a draft is written only during its own action's steps.");
	}
}

// `Symbol.for`, not `Symbol`: under a Vite duplicate load the trap and the prober hold
// different module instances, and a per-instance symbol would miss silently.
const RECORDING_TARGET = Symbol.for("treflex.recordingTarget");

const warnedStaleNode = new WeakSet<object>();
function verifyPathDenotesTarget(root: object, segments: PropertyKey[], t: object, verb: "write" | "delete"): void {
	let node: any = root;
	for (const segment of segments) {
		if (node === null || node === undefined) {
			node = undefined;
			break;
		}
		node = node[segment];
	}
	if (node === t || warnedStaleNode.has(t)) {
		return;
	}
	warnedStaleNode.add(t);
	const at = segments.join(".");
	if (node === null || node === undefined || typeof node !== "object") {
		console.warn(
			`[treflex] draft/orphaned-${verb}: a ${verb} at [${at}] went through a held reference whose node is no longer in the state tree — ` +
				`it landed on the detached node, invisibly. ` +
				`Write through a reference re-derived from the draft (docs/reference/actions.md#caveats).`
		);
	} else {
		console.warn(
			`[treflex] draft/stale-path-${verb}: a ${verb} at [${at}] went through a held reference to a node that no longer lives at that path — ` +
				`the record stream attributes it to a path a DIFFERENT node now occupies. ` +
				`Write through a reference re-derived from the draft (docs/reference/actions.md#caveats).`
		);
	}
}

export interface IDraftLease {
	check: () => void;
}

function assertAttached(ctx: IRecordingContext, t: object, lease: IDraftLease | null): void {
	lease?.check();
	if (ctx.gateway?.isDetached?.(t)) {
		throw new DraftDetachedError("the node left the state tree", ctx.gateway.detachedPath?.(t) ?? []);
	}
}

// Present slots only: pop, shift and splice delete each dropped slot through
// the delete trap before setting length, and counting an absent slot again
// would record the same drop twice.
function shrinkDroppedSlots(t: unknown[], newLength: number): number[] {
	const slots: number[] = [];
	for (let i = newLength; i < t.length; i++) {
		if (String(i) in t) {
			slots.push(i);
		}
	}
	return slots;
}

// A shrink can land partway: the engine deletes from the top, stops at a non-configurable
// slot, sets length just above it and throws. What landed is read off the array after.
// Its Prev is only the old number, so the dropped values are recorded as synthesized deletes.
function writeLength(
	ctx: IRecordingContext,
	changes: IRecordChange[] | null,
	checkPaths: boolean,
	t: unknown[],
	value: unknown,
	path: PropertyKey[],
	root: object
): void {
	const before = t.length;
	const shrinkTo = Number(value);
	const candidates = shrinkTo < before ? shrinkDroppedSlots(t, shrinkTo) : [];
	const raws = candidates.map((slot) => t[slot]);
	let prevs: unknown[] = [];
	if (changes) {
		prevs = raws.map((raw) => clone(raw));
	}
	let landed = false;
	try {
		t.length = value as number;
		landed = true;
	} finally {
		const after = t.length;
		if (landed || after !== before) {
			const dropped = candidates.filter((slot) => slot >= after);
			const gateway = ctx.gateway;
			candidates.forEach((slot, i) => {
				if (slot >= after) {
					gateway?.logWrite?.(t, String(slot), true, raws[i], -1);
				}
			});
			gateway?.logWrite?.(t, "length", true, before, -1);
			gateway?.noteGap?.(t, before, after);
			gateway?.observe(t, "length");
			for (const slot of dropped) {
				ctx.gateway?.observe(t, String(slot));
			}
			if (checkPaths) {
				verifyPathDenotesTarget(root, path, t, "write");
			}
			if (changes) {
				for (let i = candidates.length - 1; i >= 0; i--) {
					const slot = candidates[i]!;
					if (slot >= after) {
						changes.push({
							Path: [
								...path,
								String(slot)
							],
							Prev: prevs[i],
							Deleted: true
						});
					}
				}
				changes.push({
					Path: [
						...path,
						"length"
					],
					Prev: before,
					Value: after
				});
			}
			notifyWrite(t, "length", after !== before, false, false);
			for (const slot of dropped) {
				notifyWrite(t, String(slot), true, true, false);
			}
		}
	}
}

function arrayIndex(key: string): number {
	return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295 ? Number(key) : -1;
}

// A mutator writes slot by slot through the traps, so one refused partway would leave the
// array half changed. Read off a draft array, each unwinds what it wrote before rethrowing.
const ATOMIC_MUTATORS = new Map<PropertyKey, (...args: unknown[]) => unknown>();
for (const name of [
	"copyWithin",
	"fill",
	"pop",
	"push",
	"reverse",
	"shift",
	"sort",
	"splice",
	"unshift"
] as const) {
	const method = Array.prototype[name] as (...args: unknown[]) => unknown;
	const wrapped = {
		[name](this: unknown, ...args: unknown[]): unknown {
			const scope = (this as Record<PropertyKey, unknown> | null | undefined)?.[DRAFT_SCOPE] as DraftTraps | undefined;
			const gateway = scope?.ctx.gateway;
			const mark = gateway?.logMark?.();
			const changes = scope?.ctx.currentJournalChanges;
			const recorded = changes?.length ?? 0;
			try {
				return method.apply(this, args);
			} catch (error) {
				if (mark !== undefined) {
					gateway?.unwindTo?.(mark);
				}
				if (changes) {
					changes.length = recorded;
				}
				throw error;
			}
		}
	}[name] as (...args: unknown[]) => unknown;
	ATOMIC_MUTATORS.set(name, wrapped);
}

// Set by a SEAT_WRITE or BIND_WRITE call and read at the top of the trap it makes, which
// nothing can run ahead of.
let seating = false;
let seatOwned = false;
let binding = false;

// One per proxy, with the traps on the prototype, because an action's draft makes one for
// every node it touches.
//
// A proxy's location is its LAST access, not its first: cache hits refresh `path`, so a
// write through a re-derived reference records where the node lives now, and only a
// reference held without re-navigation keeps a stale one. A rollback undoes the reorders an
// access saw, so the first access after one reads the location back from the index.
class DraftTraps implements ProxyHandler<any> {
	proxy!: object;
	readonly ctx: IRecordingContext;
	readonly cache: WeakMap<object, DraftTraps>;
	root: object;
	path: PropertyKey[];
	epoch: number;
	readonly lease: IDraftLease | null;
	constructor(ctx: IRecordingContext, cache: WeakMap<object, DraftTraps>, root: object, path: PropertyKey[], lease: IDraftLease | null) {
		this.ctx = ctx;
		this.cache = cache;
		this.root = root;
		this.path = path;
		this.lease = lease;
		this.epoch = ctx.gateway?.rollbacks?.() ?? 0;
	}

	fresh(t: object): PropertyKey[] {
		const now = this.ctx.gateway?.rollbacks?.() ?? 0;
		if (this.epoch !== now) {
			this.epoch = now;
			this.path = this.ctx.gateway?.pathFrom?.(this.root, t) ?? this.path;
		}
		return this.path;
	}

	changesFor(t: object): IRecordChange[] | null {
		const changes = this.ctx.currentJournalChanges;
		return changes && this.ctx.gateway?.slotEnded?.(this.root, t) ? null : changes;
	}

	checksPaths(t: object): boolean {
		return this.ctx.checkPaths === true && !this.ctx.gateway?.slotEnded?.(this.root, t);
	}

	child(t: object, value: object, property: PropertyKey): unknown {
		return createRecordingProxy(
			value,
			this.ctx,
			this.cache,
			[
				...this.fresh(t),
				property
			],
			this.root,
			this.lease
		);
	}

	get(t: any, property: PropertyKey): unknown {
		if (property === RECORDING_TARGET) {
			return t;
		}
		if (property === DRAFT_SCOPE) {
			return this;
		}
		if (property === DETACH_PROBE) {
			return this.ctx.gateway?.isDetached?.(t) !== true;
		}
		if (property === SEAT_WRITE) {
			return (key: PropertyKey, value: unknown, owned: boolean) => {
				seating = true;
				seatOwned = owned;
				(this.proxy as Record<PropertyKey, unknown>)[key] = value;
			};
		}
		if (property === BIND_WRITE) {
			return (receiverId: string | undefined) => {
				binding = true;
				if (receiverId === undefined) {
					delete (this.proxy as Record<PropertyKey, unknown>).$Receiver;
				} else {
					(this.proxy as Record<PropertyKey, unknown>).$Receiver = receiverId;
				}
			};
		}
		// Ahead of the detachment check, so rawOf, Symbol.toStringTag and
		// Node's inspection symbol report on a gone reference instead of
		// throwing from inside the report.
		if (typeof property === "symbol") {
			return t[property];
		}
		assertAttached(this.ctx, t, this.lease);
		const value = t[property];
		if (
			typeof value === "function" &&
			Array.isArray(t) &&
			value === (Array.prototype as unknown as Record<PropertyKey, unknown>)[property]
		) {
			return ATOMIC_MUTATORS.get(property) ?? value;
		}
		return isWrappable(value) ? this.child(t, value, property) : value;
	}

	has(t: any, property: PropertyKey): boolean {
		if (typeof property !== "symbol") {
			assertAttached(this.ctx, t, this.lease);
		}
		return Reflect.has(t, property);
	}

	ownKeys(t: any): (string | symbol)[] {
		assertAttached(this.ctx, t, this.lease);
		return Reflect.ownKeys(t);
	}

	getOwnPropertyDescriptor(t: any, property: PropertyKey): PropertyDescriptor | undefined {
		if (typeof property === "symbol") {
			return Reflect.getOwnPropertyDescriptor(t, property);
		}
		assertAttached(this.ctx, t, this.lease);
		// The engine probes this per key during spread and Object.keys, so
		// object values leave as recording sub-proxies, as from get, and
		// writes through them stay witnessed. Flags come through `...real`:
		// an array's non-configurable `length` breaks a proxy invariant otherwise.
		const real = Reflect.getOwnPropertyDescriptor(t, property);
		if (!real) {
			return undefined;
		}
		const value = t[property];
		return {
			...real,
			value: isWrappable(value) ? this.child(t, value, property) : value
		};
	}

	// In this order: whatever can throw ahead of the write, so a throw leaves nothing to
	// record, and the record ahead of the notify, so a flush's throw cannot lose it.
	set(t: any, property: PropertyKey, value: unknown): boolean {
		const refusing = !seating;
		const owned = seating && seatOwned;
		const bound = binding;
		seating = false;
		binding = false;
		if (typeof property === "symbol") {
			t[property] = value;
			return true;
		}
		const key = property as string;
		const ctx = this.ctx;
		const path = this.fresh(t);
		refuseInSyncCall("tried to write state");
		assertAttached(ctx, t, this.lease);
		if (key === "__proto__") {
			throw new TypeError("[treflex] draft: __proto__ cannot be written");
		}
		// Ahead of unwrapValue, whose copy would lose the identity a module result is recorded by.
		if (isCode(value)) {
			refuseNonPlain(
				[
					...path,
					key
				],
				typeof value === "function" ? "function" : "module result"
			);
		}
		const isArray = Array.isArray(t);
		if (value === undefined && isArray) {
			if (key === "length") {
				throw new TypeError("[treflex] draft: an array's length cannot be set to undefined");
			}
			refuseNonPlain(
				[
					...path,
					key
				],
				"undefined array element"
			);
		}
		const walked: object[] = [];
		const refuseCrossing = ctx.gateway?.refuseCrossing;
		const written = owned ? value : unwrapValue(value, path, key, walked, undefined, refuseCrossing && ((live) => refuseCrossing(t, live)));
		enforceOrigin(ctx, t);
		if (refusing) {
			if (key === "$Id" && written !== t.$Id) {
				refuseIdChange(t.$Id, written);
			}
			if (key === "$Receiver" && !bound && (written !== t.$Receiver || (written !== undefined && typeof t.$Id !== "string"))) {
				refuseReceiverWrite(t, written);
			}
			if (written !== null && typeof written === "object") {
				ctx.gateway?.refuseReplacement?.(t, written as object);
			}
		}
		if (key === "length" && isArray) {
			writeLength(ctx, this.changesFor(t), this.checksPaths(t), t, written, path, this.root);
			ctx.wrote?.(t, key);
			return true;
		}
		const journalChanges = this.changesFor(t);
		const lengthBefore = isArray ? (t.length as number) : 0;
		// Own-property, not `in`: a key shadowing Object.prototype ("constructor") would
		// read an inherited function as a previous value.
		const had = Object.hasOwn(t, key);
		if (written === undefined && !had) {
			return true;
		}
		const prev = had ? t[key] : undefined;
		let change: IRecordChange | null = null;
		if (journalChanges) {
			change = {
				Path: [
					...path,
					key
				],
				Prev: clone(prev)
			};
			if (written === undefined) {
				change.Deleted = true;
			} else {
				change.Value = clone(written);
			}
			if (!had) {
				change.Created = true;
			}
		}
		const order = written === undefined && !isArray ? Object.keys(t) : undefined;
		if (written === undefined) {
			delete t[key];
		} else {
			t[key] = written;
			freezeAll(walked);
		}
		ctx.gateway?.logWrite?.(t, key, had, prev, isArray ? lengthBefore : -1, order);
		if (isArray) {
			const index = arrayIndex(key);
			if (index > lengthBefore) {
				ctx.gateway?.noteGap?.(t, lengthBefore, index);
			}
		}
		// Ahead of the path check: the first write to a slot is what puts it where its path says.
		ctx.gateway?.observe(t, key, !refusing);
		const lengthChanged = isArray && t.length !== lengthBefore;
		if (this.checksPaths(t)) {
			verifyPathDenotesTarget(this.root, path, t, "write");
		}
		if (change) {
			if (lengthChanged) {
				change.GrewFrom = lengthBefore;
			}
			journalChanges?.push(change);
		}
		ctx.wrote?.(t, key);
		const has = Object.hasOwn(t, key);
		notifyWrite(t, key, prev !== written || had !== has, had !== has, lengthChanged);
		return true;
	}

	defineProperty(_t: any, property: PropertyKey, descriptor: PropertyDescriptor): boolean {
		if (
			typeof property === "symbol" ||
			descriptor.get !== undefined ||
			descriptor.set !== undefined ||
			descriptor.configurable !== true ||
			descriptor.enumerable !== true ||
			descriptor.writable !== true ||
			!("value" in descriptor)
		) {
			return false;
		}
		return Reflect.set(this.proxy, property, descriptor.value);
	}

	deleteProperty(t: any, property: PropertyKey): boolean {
		const bound = binding;
		binding = false;
		if (typeof property === "symbol") {
			delete t[property];
			return true;
		}
		const ctx = this.ctx;
		const path = this.fresh(t);
		refuseInSyncCall("tried to write state");
		assertAttached(ctx, t, this.lease);
		enforceOrigin(ctx, t);
		const journalChanges = this.changesFor(t);
		if (!Object.hasOwn(t, property)) {
			return true;
		}
		if (property === "$Id") {
			refuseIdChange(t.$Id, undefined);
		}
		if (property === "$Receiver" && !bound) {
			refuseReceiverWrite(t, undefined);
		}
		const prev = t[property];
		let change: IRecordChange | null = null;
		if (journalChanges) {
			change = {
				Path: [
					...path,
					property
				],
				Prev: clone(prev),
				Deleted: true
			};
		}
		const order = Array.isArray(t) ? undefined : Object.keys(t);
		delete t[property];
		ctx.gateway?.logWrite?.(t, property as string, true, prev, -1, order);
		if (Array.isArray(t)) {
			const index = arrayIndex(property as string);
			if (index >= 0) {
				ctx.gateway?.noteGap?.(t, index, index + 1);
			}
		}
		ctx.gateway?.observe(t, property as string);
		if (this.checksPaths(t)) {
			verifyPathDenotesTarget(this.root, path, t, "delete");
		}
		if (change) {
			journalChanges?.push(change);
		}
		ctx.wrote?.(t, property as string);
		notifyWrite(t, property as string, true, true, false);
		return true;
	}
}

export function createRecordingProxy<T>(
	target: T,
	ctx: IRecordingContext,
	cache: WeakMap<object, any>,
	path: PropertyKey[] = [],
	root?: object,
	lease: IDraftLease | null = null
): T {
	if (target === null || typeof target !== "object") {
		return target;
	}
	const cached = cache.get(target) as DraftTraps | undefined;
	if (cached) {
		cached.path = path;
		cached.epoch = ctx.gateway?.rollbacks?.() ?? 0;
		if (root) {
			cached.root = root;
		}
		return cached.proxy as T;
	}
	// A raw write can leave a slot holding a proxy. Wrapped as it stands, it is a new identity
	// per read, so a walk round a loop through it never meets a node twice.
	const raw = rawOf(target);
	if (raw !== target) {
		return createRecordingProxy(raw, ctx, cache, path, root, lease);
	}
	const traps = new DraftTraps(ctx, cache, root ?? target, path, lease);
	traps.proxy = new Proxy(target, traps);
	cache.set(target, traps);
	return traps.proxy as T;
}
