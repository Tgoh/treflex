export type IAction<S, A extends any[] = any[], R = any> = (draft: S, ...args: A) => IOpenGenerator<R>;

/**
 * Anything an action may yield except the open marker. The index signature lets an effect be
 * yielded as a literal with its fields.
 */
export interface IActionYield {
	readonly Type: string;
	readonly "treflex:open"?: never;
	readonly [field: string]: any;
}

/**
 * Carried in the yield type of `open(...)`, and so of every function that calls it. A generator
 * typed `IActionGenerator` can't call one, and neither can `open(...)` or a branch of `parallel`.
 */
export interface IOpenMark {
	readonly Type: "open";
	readonly "treflex:open": true;
}

export type IActionGenerator<R = void> = Generator<IActionYield, R, any>;

/** Anything an action may yield, the open marker included: the type of a function that may open. */
export type IOpenGenerator<R = void> = Generator<IActionYield | IOpenMark, R, any>;
