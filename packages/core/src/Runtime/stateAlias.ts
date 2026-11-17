import { TreflexRefusal } from "./refusal";

export class StateAliasError extends TreflexRefusal {
	readonly path: readonly string[];
	readonly heldAt: readonly string[];
	readonly others: number;
	constructor(path: readonly string[], heldAt: readonly string[], others: number, undone: string) {
		const more = others > 0 ? ` ${others} other slot${others === 1 ? " was" : "s were"} met in the same step.` : "";
		super(
			`[treflex] state alias: the node at [${path.join(".")}] is also held at [${heldAt.join(".")}].${more} ` +
				`State is a tree, so a node sits in one place. ${undone} ` +
				`Store the node's $Id in one of them, resolving it through the lookup, or store a deep copy: a spread shares what is nested in it.`
		);
		this.name = "StateAliasError";
		this.path = path;
		this.heldAt = heldAt;
		this.others = others;
	}
}
