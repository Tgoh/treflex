export const EMPTY_INDEX = "an empty index";

export const PROMISE_OR_THENABLE = "a promise or thenable";

function fixFor(kind: string): string {
	if (kind === EMPTY_INDEX) {
		return "An array holds no gaps, so write at `length` or use `push`.";
	}
	if (kind === PROMISE_OR_THENABLE) {
		return "An action returns plain data and does its async work through effects: declare the async call as an effect and yield* it.";
	}
	if (kind === "undefined array element") {
		return "It has no JSON form, so pass null instead and accept null at the other end.";
	}
	if (kind === "module result") {
		return 'A returns: "module" effect result stays in the action that yielded it: store or send data from it instead.';
	}
	return (
		"State and everything that crosses between entities is plain data (null, strings, booleans, finite numbers, plain " +
		"objects, arrays): epoch milliseconds for a Date, entries for a Map or Set, and a name for a function or a live object " +
		"(docs/reference/write-path.md#what-a-write-takes)."
	);
}

export class NonPlainDataError extends Error {
	readonly what: string;
	readonly kind: string;
	readonly path: readonly PropertyKey[];
	constructor(what: string, kind: string, path: readonly PropertyKey[], outcome?: string) {
		super(`[treflex] ${what} is not plain: ${kind} at [${path.map(String).join(".")}]. ${fixFor(kind)}${outcome ? ` ${outcome}` : ""}`);
		this.name = "NonPlainDataError";
		this.what = what;
		this.kind = kind;
		this.path = path;
	}
}
