import type { IActionGenerator, IAskEntry, IEntity, IRuntime, ISelectorGenerator, IWithId } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import { entity, inFlight, pendingAsks } from "treflex";
import { rawOf } from "treflex/internal";

// inFlightOf and pendingAsksOf have twins in packages/core/tests/testHelpers.ts and packages/react/tests/treeWrite.ts.
export function inFlightOf(runtime: IRuntime<any>, action: Function | readonly Function[], owner: IEntity): boolean {
	return runtime.processSelector(
		function* (): ISelectorGenerator<boolean> {
			return yield* inFlight(action, owner);
		},
		() => runtime.state
	);
}

export function pendingAsksOf(runtime: IRuntime<any>, owner: IEntity): readonly IAskEntry[] {
	return runtime.processSelector(
		function* (): ISelectorGenerator<readonly IAskEntry[]> {
			return yield* pendingAsks(owner);
		},
		() => runtime.state
	);
}

// What `yield* entity(fields)` returns when the mint answers `guid`, for a write that can't yield.
export function minted<T extends object = {}>(guid: string, fields?: T): IWithId<T> {
	const making = entity(fields ?? ({} as T));
	making.next();
	return making.next(guid).value as IWithId<T>;
}

// packages/core/tests/testHelpers.ts and packages/react/tests/treeWrite.ts hold the
// same helper: tsconfig's rootDir keeps a package's tests inside the package.
export function treeWrite<T extends object>(runtime: IRuntime<T>, write: (state: T) => void): void {
	const internal = runtime as IRuntimeInternal<T>;
	if (!internal.get("runtime/journal").enabled) {
		internal.get("runtime/writeGateway").exemptFrame(() => {
			internal.resolveCell(rawOf(runtime.state as IEntity).$Id)!.setState(write);
		});
		return;
	}
	let ran = false;
	let actionId: string | undefined;
	let failed = false;
	let failure: unknown;
	const stopListening = runtime.on("record", (record, live) => {
		if (record.Kind === "action:start") {
			actionId ??= record.ActionId;
		} else if (record.Kind === "action:end" && record.ActionId === actionId && record.Status === "errored") {
			failed = true;
			failure = live?.error;
		}
	});
	function* step(draft: T): IActionGenerator {
		ran = true;
		write(draft);
	}
	const rootId = (runtime.state as IEntity).$Id;
	try {
		runtime.dispatch(step, rootId).catch(() => {});
	} finally {
		stopListening();
	}
	if (failed) {
		throw failure;
	}
	if (!ran) {
		throw new Error(`treeWrite: the write never ran: the root entity "${rootId}" did not take the dispatch.`);
	}
}
