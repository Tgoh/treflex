import { settled } from "../src/Testing/createTestRuntime";

interface INodeProcess {
	listeners(event: "unhandledRejection"): ((reason: unknown) => void)[];
	removeAllListeners(event: "unhandledRejection"): void;
	on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
	off(event: "unhandledRejection", listener: (reason: unknown) => void): void;
}

// vitest's own listener fails the run on any unhandled rejection, so it steps aside while this listens.
export async function unhandledDuring(run: () => unknown): Promise<unknown[]> {
	const node = (
		globalThis as unknown as {
			process: INodeProcess;
		}
	).process;
	const others = node.listeners("unhandledRejection");
	const heard: unknown[] = [];
	const listen = (reason: unknown) => {
		heard.push(reason);
	};
	node.removeAllListeners("unhandledRejection");
	node.on("unhandledRejection", listen);
	try {
		run();
		await settled();
	} finally {
		node.off("unhandledRejection", listen);
		for (const other of others) {
			node.on("unhandledRejection", other);
		}
	}
	return heard;
}
