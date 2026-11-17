import type { IAction } from "../Types/IAction";
import type { IReceiver } from "../Types/IReceiver";
import type { IDiagEmitter } from "../Types/IRuntimeEvent";
import { consoleDiag } from "../Types/IRuntimeEvent";
import { DEV } from "../Utility/devMode";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/receivers": IReceiverRegistry;
	}
}

export interface IReceiverRegistry {
	register(receiver: IReceiver<any, never>): void;
	get(id: string): IAction<any> | undefined;
	handles(id: string, topic: string): boolean;
	// Registration order.
	handling(topic: string): readonly string[];
	// Internal: called after every registration. Resource rows waiting on a
	// receiver connect from here.
	onRegister(listener: (id: string) => void): void;
}

function refuseMalformed(receiver: unknown): never {
	throw new TypeError(
		"[treflex] registerReceiver: this isn't a receiver. Register what receiver(id)(cases) returns, whole: its Id, Topics and handle."
	);
}

export function createReceiverRegistry(emitDiag: IDiagEmitter = consoleDiag): IReceiverRegistry {
	// Prototype-less: receiver ids and topics come off state and snapshot rows, so
	// "constructor" and "toString" are reachable strings. Over an object literal they
	// resolve to inherited members, and a truthy non-generator handle then counts as a
	// live receiver.
	const receivers: Record<string, IAction<any>> = Object.create(null);
	const topicsOf: Record<string, ReadonlySet<string>> = Object.create(null);
	const byTopic: Record<string, string[]> = Object.create(null);
	const listeners: ((id: string) => void)[] = [];

	function register(receiver: IReceiver<any, never>): void {
		if (
			receiver === null ||
			typeof receiver !== "object" ||
			typeof receiver.Id !== "string" ||
			receiver.Id === "" ||
			typeof receiver.handle !== "function" ||
			!Array.isArray(receiver.Topics) ||
			!receiver.Topics.every((topic: unknown) => typeof topic === "string")
		) {
			refuseMalformed(receiver);
		}
		const id: string = receiver.Id;
		const handle = receiver.handle as IAction<any>;
		const previous = receivers[id];
		// In development a re-registration is an HMR swap, and a stale handle must stop
		// serving the id. In production it's two modules landing on one spelling, and the
		// overwrite stands either way, so the diag is what makes it visible.
		if (!DEV && previous && previous !== handle) {
			emitDiag({
				severity: "warn",
				code: "receiver/id-collision",
				message:
					`[treflex] receiver id "${id}" was registered twice with different handles. ` +
					"The later registration wins, and every entity bound to this id, and every timer row naming it, now dispatches into it. " +
					"Two modules claim one receiver id: check the Receiver exports and the glob that feeds them.",
				data: {
					id
				}
			});
		}
		const topics = new Set<string>(receiver.Topics);
		const before = topicsOf[id];
		for (const topic of before ?? []) {
			if (topics.has(topic)) {
				continue;
			}
			const ids = byTopic[topic]!;
			ids.splice(ids.indexOf(id), 1);
			if (ids.length === 0) {
				delete byTopic[topic];
			}
		}
		for (const topic of topics) {
			if (before?.has(topic)) {
				continue;
			}
			if (byTopic[topic]) {
				byTopic[topic].push(id);
			} else {
				byTopic[topic] = [
					id
				];
			}
		}
		receivers[id] = handle;
		topicsOf[id] = topics;
		for (const listener of listeners) {
			listener(id);
		}
	}

	return {
		register,
		get: (id) => receivers[id],
		handles: (id, topic) => topicsOf[id]?.has(topic) === true,
		handling: (topic) => byTopic[topic] ?? [],
		onRegister(listener) {
			listeners.push(listener);
		}
	};
}
