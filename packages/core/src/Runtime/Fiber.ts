export type IFiberStatus = "running" | "completed" | "errored" | "cancelled";

/** `"action"`: its action was stopped. `"group"`: a sibling branch failed, or its parent had already ended. */
export type IStopReason = "action" | "group";

export interface IFiber {
	id: string;
	status: IFiberStatus;
	stopped: boolean;
	stoppedBy: IStopReason | null;
	stopListeners: Set<() => void> | null;
	endWait: (() => void) | null;
	waitingOn: string | null;
	branch: boolean;
	open: boolean;
	controller: AbortController | null;
	branches: Set<IFiber> | null;
}

export type IFiberIdAllocator = () => string;

export function createFiber(id: string, branch = false): IFiber {
	return {
		id,
		status: "running",
		stopped: false,
		stoppedBy: null,
		stopListeners: null,
		endWait: null,
		waitingOn: null,
		branch,
		open: false,
		controller: null,
		branches: null
	};
}

// The order is what the record reads as. A park's abandonment is queued ahead of
// the closes, a branch's close ahead of its parent's, and the close ahead of the
// signal, so an effect that rejects on the abort finds the fiber gone and leaves
// no response.
export function stopFiber(fiber: IFiber, reason: IStopReason): void {
	if (fiber.stopped || fiber.status !== "running") {
		return;
	}
	fiber.stopped = true;
	fiber.stoppedBy = reason;
	const listeners = fiber.stopListeners;
	fiber.stopListeners = null;
	if (listeners) {
		for (const listener of listeners) {
			listener();
		}
	}
	if (fiber.branches) {
		for (const branch of fiber.branches) {
			stopFiber(branch, reason);
		}
	}
	fiber.endWait?.();
	fiber.controller?.abort();
}

export function fiberSignal(fiber: IFiber): AbortSignal {
	if (!fiber.controller) {
		fiber.controller = new AbortController();
		if (fiber.stopped) {
			fiber.controller.abort();
		}
	}
	return fiber.controller.signal;
}
