import type { IRuntimeServiceKey, IRuntimeServiceValue } from "../Registries/IRuntimeServiceRegistry";
import type { IAction } from "./IAction";

export interface IActionContext {
	entityId: string;

	actionId: string;

	// Fires when this fiber is told to end, and not when it completes or throws by
	// itself. The effect decides what that means for its work.
	readonly signal: AbortSignal;

	get<K extends IRuntimeServiceKey>(key: K): IRuntimeServiceValue<K>;

	processAction<T, A extends any[], R>(
		action: IAction<T, A, R>,
		getState: () => T,
		setState: import("../Runtime/sliceSetState").ISetState<T>,
		idAccessor: () => string,
		...args: A
	): Promise<R | undefined>;
}
