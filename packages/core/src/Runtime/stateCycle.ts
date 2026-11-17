import { TreflexRefusal } from "./refusal";

export class StateCycleError extends TreflexRefusal {
	readonly path: readonly string[];
	readonly loop: readonly string[];
	readonly others: number;
	constructor(path: readonly string[], loop: readonly string[], others: number, undone: string) {
		const more = others > 0 ? ` ${others} other closing slot${others === 1 ? " was" : "s were"} met in the same step.` : "";
		super(
			`[treflex] state cycle: the slot at [${path.join(".")}] closes a loop: following [${loop.join(".")}] from the node that holds it leads back to that node.${more} ` +
				`State is a tree. ${undone} Remove the back-reference and store the node's $Id instead, ` +
				`resolving it through the lookup, or store a copy of the data it needs.`
		);
		this.name = "StateCycleError";
		this.path = path;
		this.loop = loop;
		this.others = others;
	}
}
