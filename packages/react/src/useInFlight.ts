import type { IEntity, ISelectorGenerator } from "treflex";
import type { IEntityRef } from "./IEntityView";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { inFlight } from "treflex";
import { watch } from "treflex/internal";
import { nodeOf } from "./createFrames";
import { useTreflex } from "./TreflexProvider";

type IReading = Parameters<typeof inFlight>[0];

export type IUseInFlightOwner = IEntityRef | string | undefined;

function ownerIdOf(owner: IUseInFlightOwner): string | undefined {
	if (typeof owner !== "object") {
		return owner;
	}
	const node = nodeOf(owner) as Partial<IEntity> | undefined;
	if (node && typeof node.$Id !== "string") {
		throw new TypeError("[treflex-react] useInFlight(): the owner is not an entity, so nothing runs on it.");
	}
	return (node ?? owner).$Id;
}

function useStableReading(reading: IReading): IReading {
	const held = useRef(reading);
	const prev = held.current;
	if (
		prev !== reading &&
		!(Array.isArray(prev) && Array.isArray(reading) && prev.length === reading.length && prev.every((item, at) => item === reading[at]))
	) {
		held.current = reading;
	}
	return held.current;
}

/**
 * Whether work `inFlight` reads, an action, a work tag or a list of them, is in flight on the entity
 * `owner` names. For display: it catches up with a dispatch at the re-render after it, so a repeat is
 * dropped by `leading`, not by a check of this before dispatching.
 */
export function useInFlight(reading: IReading, owner: IUseInFlightOwner): boolean {
	const { runtime, frames } = useTreflex("useInFlight");
	const id = ownerIdOf(owner);
	const stable = useStableReading(reading);
	const read = useMemo(() => {
		function* busy(draft: IEntity): ISelectorGenerator<boolean> {
			return yield* inFlight(stable, draft);
		}
		return () => {
			const node = id === undefined ? undefined : frames.node(id);
			return node === undefined ? false : runtime.processSelector(busy, () => node);
		};
	}, [
		runtime,
		frames,
		id,
		stable
	]);
	const subscribe = useCallback(
		(onChange: () => void) => watch(read, onChange),
		[
			read
		]
	);
	return useSyncExternalStore(subscribe, read);
}
