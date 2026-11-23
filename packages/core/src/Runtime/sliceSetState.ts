import type { IWriteGateway } from "./createWriteGateway";
import { host } from "../Reactive/host";
import { createRecordingProxy, type IRecordingContext } from "./recordingProxy";

type SetStateParam<T, Y> = (x: Y) => T;
export type ISetState<Y> = (...args: SetStateParam<any, Y>[]) => void;

export type IRootSetState<Y> = ISetState<Y> & {
	at: <N extends object>(node: N, path: PropertyKey[], ...args: SetStateParam<any, N>[]) => void;
};

export const sliceSetState = <T, Y>(setState: ISetState<Y>, ...args: SetStateParam<T, Y>[]): ISetState<T> => {
	const slice = setState.bind(null, ...args);
	return slice as unknown as ISetState<T>;
};

export const wrapSetState = <Y extends object>(root: Y, gateway?: IWriteGateway): IRootSetState<Y> => {
	// Never give this context a record sink. Its cache's locs refresh on every entry, so a
	// record's path would be relative to the root rather than to one action's draft.
	const observing: IRecordingContext = {
		currentJournalChanges: null,
		gateway
	};
	const observingCache = new WeakMap<object, any>();
	const run = (start: object, path: PropertyKey[], args: SetStateParam<any, any>[]) => {
		const apply = () => {
			let state: any = createRecordingProxy(start, observing, observingCache, path);
			for (const part of args) {
				state = part(state);
			}
		};
		if (gateway) {
			gateway.frame(apply);
		} else {
			host.batch(apply);
		}
	};
	const wrappedSetState: IRootSetState<Y> = (...args: SetStateParam<any, Y>[]) => run(root, [], args);
	wrappedSetState.at = (node, path, ...args) => run(node, path, args);

	return wrappedSetState;
};
