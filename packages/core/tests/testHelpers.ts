export { createTestRuntime } from "../src/Testing/createTestRuntime";

import type { IRuntime } from "../src/Runtime/createRuntime";
import type { IWriteGateway } from "../src/Runtime/createWriteGateway";
import type { IRuntimeInternal } from "../src/Runtime/internals";
import type { IRootSetState, ISetState } from "../src/Runtime/sliceSetState";
import type { IWorkTag } from "../src/Runtime/workTag";
import type { IActionGenerator } from "../src/Types/IAction";
import type { IAskEntry } from "../src/Types/IAskEntry";
import type { IEntity } from "../src/Types/IEntity";
import type { IReceiver, IReceiverId } from "../src/Types/IReceiver";
import type { ISelectorGenerator } from "../src/Types/ISelector";
import { vi } from "vitest";
import { entity, type IWithId } from "../src/Effects/entity";
import { inFlight } from "../src/Runtime/arrivals";
import { pendingAsks } from "../src/Runtime/pendingAsks";
import { wrapSetState } from "../src/Runtime/sliceSetState";
import { copySeed, rawOf, view } from "../src/Runtime/viewProxy";

const realQueueMicrotask = globalThis.queueMicrotask;

export function inFlightOf(
	runtime: IRuntime<any>,
	action: Function | IWorkTag | readonly (Function | IWorkTag)[],
	owner: IEntity
): boolean {
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

// The caller restores the mock.
export function captureSurfaced(): unknown[] {
	const surfaced: unknown[] = [];
	vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
		realQueueMicrotask(() => {
			try {
				callback();
			} catch (error) {
				surfaced.push(error);
			}
		});
	});
	return surfaced;
}

export function rootSetState<T extends object>(runtime: IRuntime<T>): ISetState<T> {
	const internal = runtime as IRuntimeInternal<T>;
	const raw = rawOf(runtime.state);
	const cell = internal.resolveCell((raw as unknown as IEntity).$Id);
	return (cell?.setState as ISetState<T> | undefined) ?? wrapSetState(raw, internal.get("runtime/writeGateway"));
}

export function treeWrite<T extends object>(runtime: IRuntime<T>, write: (state: T) => void): void {
	const internal = runtime as IRuntimeInternal<T>;
	// Inside a step a dispatch starts only after the step's frame, so the write would come too late.
	if (internal.get("runtime/journal").enabled && !internal.get("runtime/writeGateway").frameOpen()) {
		stepWrite(runtime, write);
		return;
	}
	frameWrite(runtime, write);
}

export function frameWrite<T extends object>(runtime: IRuntime<T>, write: (state: T) => void): void {
	(runtime as IRuntimeInternal<T>).get("runtime/writeGateway").exemptFrame(() => {
		rootSetState(runtime)(write);
	});
}

// The write as one action's first slice on the root entity. That slice runs inside the
// dispatch, and a first-slice failure lands its action:end there too, so a refusal or a
// flush's throw still throws here.
export function stepWrite<T extends object>(runtime: IRuntime<T>, write: (state: T) => void): void {
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
		throw new Error(`stepWrite: the write never ran: the root entity "${rootId}" did not take the dispatch.`);
	}
}

// What a binding does at a component's mount: the seed seated in ComponentState, its $Id answered.
export function mountComponent(runtime: IRuntime<any>, ownerId: string | undefined, seed: object): string {
	const internal = runtime as IRuntimeInternal<any>;
	const { id, raw } = internal.seedComponent(seed, "test");
	if (!internal.seatComponent(ownerId, raw)) {
		throw new Error(`mountComponent: the owner "${ownerId}" is not in the state tree.`);
	}
	return id;
}

// A receiver over a hand-written handle, which hears every topic listed and takes every timer or
// resource message, whatever its Type.
export function rawReceiver(
	id: string,
	topics: readonly string[],
	handle: (draft: any, data: any, ctx: any) => IActionGenerator
): IReceiver<any, never> {
	return {
		Id: id as IReceiverId,
		Topics: topics,
		handle
	};
}

// What `yield* entity(fields)` returns when the mint answers `guid`, for a write that can't yield.
export function minted<T extends object = {}>(guid: string, fields?: T): IWithId<T> {
	const making = entity((fields ?? {}) as object);
	making.next();
	return making.next(guid).value as IWithId<T>;
}

// A write past the traps, which is the route a same-$Id replacement still has: the refusal
// sits in the set trap, so only a resync finds it.
export function rawWrite<T>(
	runtime: {
		state: T;
	},
	write: (raw: T) => void
): void {
	write(rawOf(runtime.state));
	(
		runtime as unknown as {
			get(key: "runtime/writeGateway"): IWriteGateway;
		}
	)
		.get("runtime/writeGateway")
		.resync();
}

export function createTreeState<T extends object>(
	initial: T,
	gateway?: IWriteGateway
): {
	raw: T;
	state: T;
	setState: IRootSetState<T>;
} {
	const raw = copySeed(initial, "createTreeState(): the initial state");
	return {
		raw,
		state: view(raw),
		setState: wrapSetState(raw, gateway)
	};
}

// The shared intrinsics a prototype-pollution defect writes to. Watched by
// DESCRIPTOR rather than by own-property name, because the damage is as
// often a replacement as an addition: an entity whose $Id is "keys" reaching
// a poisoned bucket clobbers Object.keys, and the name list is identical
// before and after.
const WATCHED_INTRINSICS: [
	string,
	object
][] = [
	[
		"Object",
		Object
	],
	[
		"Object.prototype",
		Object.prototype
	],
	[
		"Array",
		Array
	],
	[
		"Array.prototype",
		Array.prototype
	],
	[
		"Function.prototype",
		Function.prototype
	]
];

type IIntrinsicPrint = Map<object, Map<string | symbol, unknown[]>>;

// Descriptor slots by identity. Object.getOwnPropertyDescriptors output is
// not deep-equal to itself across two calls (the descriptor objects nest
// into the intrinsics they describe), so the comparison has to be flat and
// reference-based rather than structural.
export function printIntrinsics(): IIntrinsicPrint {
	const print: IIntrinsicPrint = new Map();
	for (const [, target] of WATCHED_INTRINSICS) {
		const slots = new Map<string | symbol, unknown[]>();
		for (const key of Reflect.ownKeys(target)) {
			const d = Object.getOwnPropertyDescriptor(target, key) as PropertyDescriptor;
			slots.set(key, [
				d.value,
				d.get,
				d.set,
				d.writable,
				d.enumerable,
				d.configurable
			]);
		}
		print.set(target, slots);
	}
	return print;
}

export function intrinsicChanges(before: IIntrinsicPrint, after: IIntrinsicPrint): string[] {
	const names = new Map<object, string>(
		WATCHED_INTRINSICS.map(([name, target]) => [
			target,
			name
		])
	);
	const changes: string[] = [];
	for (const [target, beforeSlots] of before) {
		const name = names.get(target) ?? String(target);
		const afterSlots = after.get(target) as Map<string | symbol, unknown[]>;
		for (const key of beforeSlots.keys()) {
			if (!afterSlots.has(key)) {
				changes.push(`${name}.${String(key)} was removed`);
				continue;
			}
			const b = beforeSlots.get(key) as unknown[];
			const a = afterSlots.get(key) as unknown[];
			if (b.some((slot, i) => !Object.is(slot, a[i]))) {
				changes.push(`${name}.${String(key)} was replaced`);
			}
		}
		for (const key of afterSlots.keys()) {
			if (!beforeSlots.has(key)) {
				changes.push(`${name}.${String(key)} was added`);
			}
		}
	}
	return changes;
}
