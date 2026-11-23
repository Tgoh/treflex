export interface IVersion {
	track(): void;
	bump(): void;
}

export interface IOwnedMemo<T> {
	read: () => T;
	dispose: () => void;
}

export interface IReactiveHost {
	createVersion(): IVersion;
	isTracking(): boolean;
	// How many sources the listening scope has read so far this run.
	trackedReads(): number;
	batch<T>(fn: () => T): T;
	untrack<T>(fn: () => T): T;
	// A memo in its own detached root. The computation runs eagerly at
	// construction and again in the flush of every write it read. A compute
	// that throws is held and rethrown to each reader.
	createOwnedMemo<T>(compute: () => T): IOwnedMemo<T>;
	runUnowned<T>(fn: () => T): T;
	onCleanup(fn: () => void): void;
	// The symbol a read proxy answers by tracking its whole shape.
	TRACK: symbol;
}

/** An always-notify signal of an outside graph's own. */
export interface IMirror {
	track(): void;
	write(): void;
}

/** A reactive graph outside the engine, such as a binding's UI library, whose computations read treflex state. */
export interface IOutsideGraph {
	/** The symbol the graph's list helpers read a container's shape with. */
	readonly TRACK: symbol;
	/** Whether one of the graph's computations is reading now. */
	isReading(): boolean;
	createMirror(): IMirror;
	/** Clears the graph's listener, and only the graph's. */
	untrack<T>(fn: () => T): T;
}
