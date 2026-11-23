const CLEAN = 0;
const CHECK = 1;
const DIRTY = 2;

type IState = typeof CLEAN | typeof CHECK | typeof DIRTY;

export type IEquals<T> = false | ((a: T, b: T) => boolean);

const RUNAWAY_LIMIT = 1_000_000;

interface IOwner {
	owned: Computation<any>[] | null;
	cleanups: (() => void)[] | null;
	disposed: boolean;
}

interface INode {
	observers: Computation<any>[] | null;
	// observerSlots[i] is the index of this node in observers[i].sources.
	observerSlots: number[] | null;
	// The epoch of the run that last tracked this node.
	trackedIn: number;
}

let Listener: Computation<any> | null = null;
let Owner: IOwner | null = null;
let batchDepth = 0;
let flushing = false;
let epochs = 0;
let queue: Computation<any>[] = [];
let spare: Computation<any>[] = [];

const same = <T>(a: T, b: T): boolean => a === b;

function surface(error: unknown): void {
	queueMicrotask(() => {
		throw error;
	});
}

function link(node: Computation<any>, source: INode): void {
	if (node.sources === null) {
		node.sources = [];
		node.sourceSlots = [];
	}
	if (source.observers === null) {
		source.observers = [];
		source.observerSlots = [];
	}
	const sources = node.sources;
	const sourceSlots = node.sourceSlots!;
	const observers = source.observers;
	const observerSlots = source.observerSlots!;
	sourceSlots.push(observers.length);
	observers.push(node);
	observerSlots.push(sources.length);
	sources.push(source);
}

function unlinkFrom(node: Computation<any>, from: number): void {
	const sources = node.sources;
	const sourceSlots = node.sourceSlots;
	if (sources === null || sourceSlots === null) {
		return;
	}
	while (sources.length > from) {
		const source = sources.pop()!;
		const slot = sourceSlots.pop()!;
		const observers = source.observers!;
		const observerSlots = source.observerSlots!;
		const moved = observers.pop()!;
		const movedSlot = observerSlots.pop()!;
		if (slot < observers.length) {
			observers[slot] = moved;
			observerSlots[slot] = movedSlot;
			moved.sourceSlots![movedSlot] = slot;
		}
	}
}

// A run keeps the edges it re-reads in the order it read them last time, and drops the unread rest at its first
// divergence, so a computation that reads the same sources each run re-links nothing.
function track(source: INode): void {
	const listener = Listener;
	if (listener === null || source.trackedIn === listener.epoch) {
		return;
	}
	source.trackedIn = listener.epoch;
	const index = listener.cursor;
	const sources = listener.sources;
	if (sources !== null && index < sources.length) {
		if (sources[index] === source) {
			listener.cursor = index + 1;
			return;
		}
		unlinkFrom(listener, index);
	}
	link(listener, source);
	listener.cursor = index + 1;
}

function markObservers(source: INode, state: IState): void {
	const observers = source.observers;
	if (observers === null) {
		return;
	}
	const slots = source.observerSlots!;
	for (let i = 0; i < observers.length; i++) {
		const observer = observers[i]!;
		// A running computation hears only the sources it has already read in this run: one it reads later will see
		// the write when it reads it.
		if (observer.running && slots[i]! >= observer.cursor) {
			continue;
		}
		mark(observer, state);
	}
}

function mark(node: Computation<any>, state: IState): void {
	if (node.state >= state || node.disposed) {
		return;
	}
	const wasClean = node.state === CLEAN;
	node.state = state;
	if (wasClean) {
		queue.push(node);
		markObservers(node, CHECK);
	}
}

function cleanOwner(owner: IOwner): void {
	const owned = owner.owned;
	if (owned !== null) {
		owner.owned = null;
		for (let i = owned.length - 1; i >= 0; i--) {
			owned[i]!.dispose();
		}
	}
	const cleanups = owner.cleanups;
	if (cleanups !== null) {
		owner.cleanups = null;
		for (let i = cleanups.length - 1; i >= 0; i--) {
			cleanups[i]!();
		}
	}
}

function disposeOwner(owner: IOwner): void {
	if (owner.disposed) {
		return;
	}
	owner.disposed = true;
	cleanOwner(owner);
}

function updateIfNeeded(node: Computation<any>): void {
	if (node.disposed || node.running) {
		return;
	}
	if (node.state === CHECK) {
		const sources = node.sources!;
		for (let i = 0; i < sources.length; i++) {
			const source = sources[i]!;
			if (source instanceof Computation) {
				updateIfNeeded(source);
				if ((node.state as IState) === DIRTY) {
					break;
				}
			}
		}
		if (node.state === CHECK) {
			node.state = CLEAN;
		}
	}
	if (node.state === DIRTY) {
		node.run();
	}
}

function flush(): void {
	if (flushing || queue.length === 0) {
		return;
	}
	flushing = true;
	let failed = false;
	let error: unknown;
	let ran = 0;
	try {
		while (queue.length > 0) {
			const pending = queue;
			queue = spare;
			for (let i = 0; i < pending.length; i++) {
				if (++ran > RUNAWAY_LIMIT) {
					for (let j = i; j < pending.length; j++) {
						pending[j]!.state = CLEAN;
					}
					for (const node of queue) {
						node.state = CLEAN;
					}
					queue.length = 0;
					const runaway = new Error(
						`[treflex] Potential infinite loop: one flush ran more than ${RUNAWAY_LIMIT} computations, so a computation is probably writing what it reads. The flush was abandoned.`
					);
					if (failed) {
						surface(runaway);
					} else {
						failed = true;
						error = runaway;
					}
					break;
				}
				try {
					updateIfNeeded(pending[i]!);
				} catch (e) {
					if (failed) {
						surface(e);
					} else {
						failed = true;
						error = e;
					}
				}
			}
			pending.length = 0;
			spare = pending;
		}
	} finally {
		flushing = false;
	}
	if (failed) {
		throw error;
	}
}

export class Signal<T> implements INode {
	observers: Computation<any>[] | null = null;
	observerSlots: number[] | null = null;
	trackedIn = 0;
	value: T;
	readonly equals: IEquals<T>;

	constructor(value: T, equals: IEquals<T> = same) {
		this.value = value;
		this.equals = equals;
	}

	read(): T {
		track(this);
		return this.value;
	}

	write(next: T): void {
		if (this.equals !== false && this.equals(this.value, next)) {
			return;
		}
		this.value = next;
		markObservers(this, DIRTY);
		if (batchDepth === 0) {
			flush();
		}
	}
}

export class Computation<T> implements INode, IOwner {
	observers: Computation<any>[] | null = null;
	observerSlots: number[] | null = null;
	trackedIn = 0;
	sources: INode[] | null = null;
	// sourceSlots[i] is the index of this computation in sources[i].observers.
	sourceSlots: number[] | null = null;
	// How many of `sources` the current run has read.
	cursor = 0;
	epoch = 0;
	state: IState = CLEAN;
	running = false;
	owned: Computation<any>[] | null = null;
	cleanups: (() => void)[] | null = null;
	disposed = false;
	value: T | undefined = undefined;
	onChange: (() => void) | null = null;
	readonly fn: (prev: T | undefined) => T;
	readonly equals: IEquals<T>;

	constructor(fn: (prev: T | undefined) => T, equals: IEquals<T>) {
		this.fn = fn;
		this.equals = equals;
	}

	read(): T {
		if (this.state !== CLEAN) {
			updateIfNeeded(this);
		}
		track(this);
		return this.value as T;
	}

	run(): void {
		this.state = CLEAN;
		cleanOwner(this);
		this.running = true;
		this.cursor = 0;
		const first = this.epoch === 0;
		this.epoch = ++epochs;
		const listener = Listener;
		const owner = Owner;
		Listener = this;
		Owner = this;
		let next: T;
		try {
			next = this.fn(this.value);
		} finally {
			Listener = listener;
			Owner = owner;
			this.running = false;
			unlinkFrom(this, this.disposed ? 0 : this.cursor);
		}
		if (this.disposed) {
			return;
		}
		if (first) {
			this.value = next;
		} else if (this.equals === false || !this.equals(this.value as T, next)) {
			this.value = next;
			markObservers(this, DIRTY);
			if (this.onChange !== null) {
				this.onChange();
			}
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.state = CLEAN;
		unlinkFrom(this, 0);
		cleanOwner(this);
	}
}

// The first run is a batch of its own: a write it makes flushes after it, and re-runs it if it had read what it wrote.
export function createComputation<T>(fn: (prev: T | undefined) => T, equals: IEquals<T>, detached: boolean): Computation<T> {
	const node = new Computation(fn, equals);
	if (!detached && Owner !== null) {
		if (Owner.owned === null) {
			Owner.owned = [];
		}
		Owner.owned.push(node);
	}
	batch(() => node.run());
	return node;
}

export function createRoot<T>(fn: (dispose: () => void) => T): T {
	const root: IOwner = {
		owned: null,
		cleanups: null,
		disposed: false
	};
	const listener = Listener;
	const owner = Owner;
	Listener = null;
	Owner = root;
	try {
		return fn(() => disposeOwner(root));
	} finally {
		Listener = listener;
		Owner = owner;
	}
}

// The callback's error wins over the flush's: the batch's writes still flush, and a flush that throws as well
// surfaces its error in a microtask.
export function batch<T>(fn: () => T): T {
	batchDepth++;
	let result: T;
	try {
		result = fn();
	} catch (error) {
		batchDepth--;
		if (batchDepth === 0) {
			try {
				flush();
			} catch (flushError) {
				surface(flushError);
			}
		}
		throw error;
	}
	batchDepth--;
	if (batchDepth === 0) {
		flush();
	}
	return result;
}

export function untrack<T>(fn: () => T): T {
	const listener = Listener;
	Listener = null;
	try {
		return fn();
	} finally {
		Listener = listener;
	}
}

export function runUnowned<T>(fn: () => T): T {
	const listener = Listener;
	const owner = Owner;
	Listener = null;
	Owner = null;
	try {
		return fn();
	} finally {
		Listener = listener;
		Owner = owner;
	}
}

export function onCleanup(fn: () => void): void {
	if (Owner !== null) {
		if (Owner.cleanups === null) {
			Owner.cleanups = [];
		}
		Owner.cleanups.push(fn);
	}
}

export function isTracking(): boolean {
	return Listener !== null;
}

export function trackedReads(): number {
	return Listener === null ? 0 : Listener.cursor;
}
