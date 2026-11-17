import type { IEntity, IResourceKey, IResourceStatus, IResourceSupplyOf, IResourceSupplyResponseOf, IResourceValueOf } from "treflex";
import type { IRuntimeInternal } from "treflex/internal";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { watch } from "treflex/internal";
import { useTreflex } from "./TreflexProvider";

export interface IUseResource<K extends IResourceKey> {
	value: IResourceValueOf<K> | undefined;
	status: IResourceStatus;
	supply: (value: IResourceSupplyOf<K>) => Promise<IResourceSupplyResponseOf<K> | undefined>;
}

export type IUseResourceOwner = IEntity | string | (() => IEntity | string | undefined);

const NONE: IResourceStatus = Object.freeze({
	State: "none"
});

function ownerIdOf(owner: IUseResourceOwner): string | undefined {
	const current = typeof owner === "function" ? owner() : owner;
	return typeof current === "object" ? current.$Id : current;
}

function sameStatus(a: IResourceStatus, b: IResourceStatus): boolean {
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key])
	);
}

export function useResource<K extends IResourceKey>(owner: IUseResourceOwner, key: K): IUseResource<K> {
	const { runtime } = useTreflex("useResource");
	const internal = runtime as IRuntimeInternal<any>;
	const resources = internal.get("runtime/resources");
	const ownerId = ownerIdOf(owner);
	const subscribe = useCallback(
		(onChange: () => void) =>
			ownerId === undefined
				? () => {}
				: watch(() => {
						resources.status(key, ownerId);
						resources.value(key, ownerId);
					}, onChange),
		[
			resources,
			key,
			ownerId
		]
	);
	const read = useMemo(() => {
		let held:
			| {
					status: IResourceStatus;
					value: unknown;
			  }
			| undefined;
		return () => {
			const status = ownerId === undefined ? NONE : resources.status(key, ownerId);
			const value = ownerId === undefined ? undefined : resources.value(key, ownerId);
			if (!held || held.value !== value || !sameStatus(held.status, status)) {
				held = {
					status,
					value
				};
			}
			return held;
		};
	}, [
		resources,
		key,
		ownerId
	]);
	const current = useSyncExternalStore(subscribe, read);
	const supply = useCallback(
		(value: IResourceSupplyOf<K>) => {
			const id = ownerIdOf(owner);
			if (id === undefined) {
				internal.emitDiag({
					severity: "warn",
					code: "resource/supply-dropped",
					message:
						`[treflex] a value supplied to resource "${key}" had no taker (no owner) and was dropped. ` +
						`The view still holds it, and anything it must stop is the view's to stop.`,
					data: {
						key,
						ownerId: undefined,
						reason: "no owner"
					}
				});
				return Promise.resolve(undefined);
			}
			return resources.supply(key, id, value) as Promise<IResourceSupplyResponseOf<K> | undefined>;
		},
		[
			internal,
			resources,
			owner,
			key
		]
	);
	return useMemo(
		() => ({
			value: current.value as IResourceValueOf<K> | undefined,
			status: current.status,
			supply
		}),
		[
			current,
			supply
		]
	);
}
