import { globalWeakMap } from "./globalWeakMap";

type IErrorClass = abstract new (...args: never[]) => Error;

// The prototype map is on globalThis, so an instance from a second evaluation of treflex (a Vite
// duplicate load) still serializes with its Class. The name map is this evaluation's own, so a
// rebuild here gives the classes this evaluation's runtime throws.
const names = globalWeakMap<object, string>("__treflex_error_classes__");

const classes = new Map<string, IErrorClass>();

export function errorClass(name: string, errorClass: IErrorClass): void {
	names.set(errorClass.prototype, name);
	classes.set(name, errorClass);
}

export function errorClassNameOf(prototype: object): string | undefined {
	return names.get(prototype);
}

export function errorClassNamed(name: string): IErrorClass | undefined {
	return classes.get(name);
}
