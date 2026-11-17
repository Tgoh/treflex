declare const ASK_RESPONSE: unique symbol;

// The phantom member is a plain string at runtime, and its function position makes `R`
// invariant: an `IAskId<"yes">` must not widen to `IAskId<"yes" | "no">`, or an answer of
// "no" would type against a conversation that cannot receive it.
export type IAskId<R = unknown> = string & {
	readonly [ASK_RESPONSE]: (r: R) => R;
};
