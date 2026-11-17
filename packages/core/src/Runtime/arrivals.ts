import type { IVersion } from "../Solid/host";
import type { IEntity } from "../Types/IEntity";
import type { IDiagEmitter } from "../Types/IRuntimeEvent";
import type { IReadGenerator } from "../Types/ISelector";
import { host } from "../Solid/host";
import { callbackThrew } from "../Types/IRuntimeEvent";
import { DRAFT_SCOPE, type IDraftScope } from "./recordingProxy";
import { slotHomes } from "./transient";
import { rawOf } from "./viewProxy";
import { type IWorkTag, isWorkTag, tagsOf } from "./workTag";

// Symbol.for by the cross-module tag-symbol rule (see REGION_OP in open.ts).
export const ARRIVAL_POLICY = Symbol.for("treflex.arrivalPolicy");

export interface IArrivalPolicy {
	readonly kind: "leading" | "latest";
}

interface IWorkEntry {
	// Taken at arrival: a tag marked later doesn't count work already on the record.
	readonly counts: readonly object[];
	readonly ended: boolean;
}

/** The work on one entity key that has arrived and not settled, in arrival order. */
export interface IWork<E extends IWorkEntry = IWorkEntry> {
	readonly entries: E[];
	readonly versions: Map<object, IVersion>;
}

const workByHome = new WeakMap<object, Map<string, IWork>>();

// Registered under every object a draft or a view can lead back to: a draft's recording context
// holds the gateway, and a view's node leads to the gateway's slot home.
export function shareWork(homes: readonly object[], works: Map<string, IWork<any>>): void {
	for (const home of homes) {
		workByHome.set(home, works);
	}
}

export function workOf<E extends IWorkEntry>(works: Map<string, IWork<E>>, key: string): IWork<E> {
	let work = works.get(key);
	if (!work) {
		work = {
			entries: [],
			versions: new Map()
		};
		works.set(key, work);
	}
	return work;
}

export function versionOf(work: IWork<any>, counted: object): IVersion {
	let version = work.versions.get(counted);
	if (!version) {
		version = host.createVersion();
		work.versions.set(counted, version);
	}
	return version;
}

export function isInFlight(work: IWork<any>, counted: object): boolean {
	return work.entries.some((entry) => !entry.ended && entry.counts.includes(counted));
}

export function countsOf(fn: object, matchedCase: object | undefined): readonly object[] {
	const counts: object[] = [
		fn
	];
	if (matchedCase !== undefined && matchedCase !== fn) {
		counts.push(matchedCase);
	}
	const tagged = counts.length;
	for (let at = 0; at < tagged; at++) {
		for (const tag of tagsOf(counts[at])) {
			if (!counts.includes(tag)) {
				counts.push(tag);
			}
		}
	}
	return counts;
}

// A microtask on, because a view effect over a selector reading inFlight or pendingAsks runs inside the
// bump: called inline, it would run in the middle of the gate's or the ask table's bookkeeping, and
// its throw or dispatch with it.
export function bumpLater(version: IVersion, report: IDiagEmitter): void {
	queueMicrotask(() => {
		try {
			version.bump();
		} catch (error) {
			report(callbackThrew("A view reading inFlight or pendingAsks", error));
		}
	});
}

export function policyOf(action: unknown): IArrivalPolicy | null {
	if (typeof action !== "function") {
		return null;
	}
	return ((action as unknown as Record<symbol, unknown>)[ARRIVAL_POLICY] as IArrivalPolicy | undefined) ?? null;
}

export const IN_FLIGHT_YIELD = "inFlight";

/**
 * The actions and work tags a test counts as in flight on an owner, on top of the record. Called
 * once per read. See docs/reference/testing.md#stubbing-inflight.
 */
export type IInFlightStub = (ownerId: string) => readonly (Function | IWorkTag)[] | undefined;

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/inFlightStub": {
			stub(stub: IInFlightStub | undefined): void;
		};
	}
}

/**
 * Whether a dispatch of `action`, or a receiver delivery whose case is `action`, has arrived on
 * `owner` and not yet ended: running, at a wait inside `open(...)`, or queued behind other work.
 * A work tag reads any work carrying it, and a list reads any of its items. A `yield*` call is
 * part of its caller and never counts. `yield*` it with the draft an action or a selector was
 * given, or an entity under it; a selector reacts to it, and a view reads it with `useInFlight`.
 */
export function* inFlight(action: Function | IWorkTag | readonly (Function | IWorkTag)[], owner: IEntity): IReadGenerator<boolean> {
	return yield {
		Type: IN_FLIGHT_YIELD,
		Actions: Array.isArray(action)
			? [
					...action
				]
			: [
					action
				],
		Owner: owner
	};
}

export function readInFlight(actions: readonly unknown[], owner: IEntity, stub: IInFlightStub | undefined): boolean {
	for (const action of actions) {
		if (typeof action !== "function" && !isWorkTag(action)) {
			throw new TypeError("[treflex] inFlight(): pass an action or a work tag, or a list of them.");
		}
	}
	const raw = rawOf(owner);
	const scope = (owner as unknown as Record<symbol, IDraftScope | undefined>)[DRAFT_SCOPE];
	const home = scope ? (scope.ctx.gateway as object | undefined) : raw !== owner ? slotHomes.get(raw) : undefined;
	if (!home) {
		throw new Error(
			scope || raw !== owner
				? "[treflex] inFlight(): the owner is not on the state tree, so no runtime keeps a record of work on it."
				: "[treflex] inFlight(): the owner is a plain object. A value snapshot or a React view reaches no runtime: a view passes its node, view or ref to useInFlight, and a selector reads the draft it is given."
		);
	}
	const id = (
		raw as {
			$Id?: unknown;
		}
	).$Id;
	if (typeof id !== "string") {
		throw new TypeError("[treflex] inFlight(): the owner is not an entity, so nothing runs on it.");
	}
	const works = workByHome.get(home);
	const work = works && workOf(works, id);
	const stubbed = stub?.(id) ?? [];
	let any = false;
	for (const action of actions as (Function | IWorkTag)[]) {
		if (work) {
			versionOf(work, action).track();
			any ||= isInFlight(work, action);
		}
		any ||= stubbed.some((item) => item === action || tagsOf(item).includes(action as IWorkTag));
	}
	return any;
}
