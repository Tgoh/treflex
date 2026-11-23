/** A throw out of action code that the runtime caught. See docs/reference/failure.md#the-failure-event. */
export interface IFailureEvent {
	/** What the action ended with. */
	readonly Error: unknown;
	readonly ActionId: string;
	/** The durable name of the action that threw, or null. */
	readonly Name: string | null;
	/** The function's own name, for display, or null. An error boundary's own failure carries its receiver's id. */
	readonly Label: string | null;
	/** The entity the action ran on. */
	readonly EntityId: string;
	/** How the action ended. */
	readonly Status: "completed" | "errored" | "cancelled";
	/** Thrown out of a close: a `finally` that ran as its generator was stopped or failed. */
	readonly Close: boolean;
	/** Whether a taker on the route, an error boundary or `onError`, took it. A throw with no route has none. */
	readonly Taken: boolean;
	/** On an error boundary's own failure, the failure it was handling. */
	readonly Cause?: unknown;
}

export interface IRuntimeEventRegistry {
	// `code` is the stable contract a tool matches on, "area/what" shaped; `message`
	// is for humans and may change freely.
	diag: {
		severity: "info" | "warn";
		code: string;
		message: string;
		data?: Record<string, unknown>;
	};
	failure: IFailureEvent;
}

export type IRuntimeEventName = keyof IRuntimeEventRegistry;
export type IRuntimeEventOf<K extends IRuntimeEventName> = IRuntimeEventRegistry[K];

export type IRuntimeEventListener<K extends IRuntimeEventName> = (data: IRuntimeEventOf<K>) => void;

export type IDiagEmitter = (event: IRuntimeEventOf<"diag">) => void;

export type IFailureEmitter = (event: IFailureEvent) => void;

export const consoleDiag: IDiagEmitter = (event) => {
	(event.severity === "warn" ? console.warn : console.info)(event.message, event.data ?? "");
};

export function pairDiag(emit: (event: "diag", data: IRuntimeEventOf<"diag">) => void): IDiagEmitter {
	return (event) => {
		consoleDiag(event);
		emit("diag", event);
	};
}

/** The diag for a throw from code the runtime calls outside any action, which stops only that code. */
export function callbackThrew(source: string, error: unknown, data?: Record<string, unknown>): IRuntimeEventOf<"diag"> {
	return {
		severity: "warn",
		code: "runtime/callback-threw",
		message: `[treflex] ${source} threw. It stopped only itself, and the runtime went on. The error is in the data.`,
		data: {
			source,
			...data,
			error
		}
	};
}
