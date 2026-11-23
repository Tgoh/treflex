import { resetErrorHalt } from "solid-js";
import { settled } from "treflex";

type IProcessEvent = "unhandledRejection" | "uncaughtException";

interface INodeProcess {
	listeners(event: IProcessEvent): ((reason: unknown) => void)[];
	removeAllListeners(event: IProcessEvent): void;
	on(event: IProcessEvent, listener: (reason: unknown) => void): void;
	off(event: IProcessEvent, listener: (reason: unknown) => void): void;
}

// vitest's own listener fails the run on any unhandled rejection or uncaught exception, so it steps aside while this listens.
async function heardDuring(event: IProcessEvent, run: () => unknown): Promise<unknown[]> {
	const node = (
		globalThis as unknown as {
			process: INodeProcess;
		}
	).process;
	const others = node.listeners(event);
	const heard: unknown[] = [];
	const listen = (reason: unknown) => {
		heard.push(reason);
	};
	node.removeAllListeners(event);
	node.on(event, listen);
	try {
		await run();
		await settled();
		await new Promise((resolve) => setTimeout(resolve, 0));
	} finally {
		node.off(event, listen);
		for (const other of others) {
			node.on(event, other);
		}
	}
	return heard;
}

export const unhandledDuring = (run: () => unknown): Promise<unknown[]> => heardDuring("unhandledRejection", run);

/**
 * The errors Solid rethrew uncaught while `run` and its flushes ran. An error that escapes every boundary halts
 * Solid's scheduling for the whole page, so this lifts the halt after, for the tests that follow.
 */
export async function uncaughtDuring(run: () => unknown): Promise<unknown[]> {
	try {
		return await heardDuring("uncaughtException", run);
	} finally {
		resetErrorHalt();
	}
}
