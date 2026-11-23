import * as engine from "../src/Reactive/engine";
import { host } from "../src/Reactive/host";

export const root = engine.createRoot;

// Runs at once, and in a flush in the order it was marked.
export function effect(fn: () => void): void {
	engine.createComputation(fn, false, false);
}

export function memo<T>(fn: () => T): () => T {
	const node = engine.createComputation(fn, (a: T, b: T) => a === b, false);
	return () => node.read();
}

export function signal<T>(value: T): [
	read: () => T,
	write: (next: T) => void
] {
	const node = new engine.Signal(value);
	return [
		() => node.read(),
		(next: T) => node.write(next)
	];
}

export const batch = <T>(fn: () => T): T => host.batch(fn);
export const untrack = <T>(fn: () => T): T => host.untrack(fn);
export const onCleanup = (fn: () => void): void => host.onCleanup(fn);
export const TRACK = host.TRACK;
