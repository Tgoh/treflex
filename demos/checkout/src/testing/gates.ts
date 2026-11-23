import type { IServerWait } from "../server/fakeServer";

/** A server wait for tests: a request of a gated type is answered only when the test releases it. */
export interface IGates {
	wait: IServerWait;
	/** How many requests of `type` are waiting. */
	waiting(type: string): number;
	/** Answers the oldest waiting request of `type`; false when none waits. */
	release(type: string): boolean;
}

export function createGates(gated: readonly string[]): IGates {
	const queue: {
		type: string;
		resolve: () => void;
	}[] = [];
	return {
		wait: (type, signal) => {
			if (!gated.includes(type)) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				const entry = {
					type,
					resolve
				};
				queue.push(entry);
				signal?.addEventListener(
					"abort",
					() => {
						const at = queue.indexOf(entry);
						if (at !== -1) queue.splice(at, 1);
						reject(signal.reason);
					},
					{
						once: true
					}
				);
			});
		},
		waiting: (type) => queue.filter((entry) => entry.type === type).length,
		release: (type) => {
			const at = queue.findIndex((entry) => entry.type === type);
			if (at === -1) return false;
			const [entry] = queue.splice(at, 1);
			entry!.resolve();
			return true;
		}
	};
}
