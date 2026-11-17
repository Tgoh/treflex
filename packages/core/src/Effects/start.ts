import type { IAction, IActionGenerator } from "../Types/IAction";
import type { IEffect } from "../Types/IEffect";
import type { IEntity } from "../Types/IEntity";
import { rawOf } from "../Runtime/viewProxy";

// A symbol, so the spread that copies a start's input carries it and the journal's descriptor,
// which names its fields, leaves the node out.
export const START_TARGET_NODE = Symbol.for("treflex.startTargetNode");

export interface IStartEffect extends IEffect {
	Type: "start";
	Action: IAction<any, any[], any>;
	EntityId: string;
	Args: any[];
	[START_TARGET_NODE]?: object;
}

export function start<S, A extends any[]>(action: IAction<S, A, any>, target: string, ...args: A): IActionGenerator;
export function start<S extends IEntity, A extends any[]>(
	action: IAction<S, A, any>,
	target: 0 extends 1 & S ? IEntity : NoInfer<S>,
	...args: A
): IActionGenerator;
export function* start(action: IAction<any, any[], any>, target: string | IEntity, ...args: any[]): IActionGenerator {
	const effect: IStartEffect = {
		Type: "start",
		Action: action,
		// A string only: the journal records EntityId uncloned, so a live
		// draft node must not reach the descriptor.
		EntityId: typeof target === "string" ? target : target.$Id,
		Args: args
	};
	if (typeof target !== "string") {
		effect[START_TARGET_NODE] = rawOf(target);
	}
	yield effect;
}
