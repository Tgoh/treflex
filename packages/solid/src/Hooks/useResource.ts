import type { IEntity, IResourceKey, IResourceStatus, IResourceSupplyOf, IResourceSupplyResponseOf, IResourceValueOf } from "treflex";
import { untrack } from "solid-js";
import { runtimeFor } from "../Context/TreflexContext";

export interface IUseResource<K extends IResourceKey> {
	/** The exposed live value, undefined until one is exposed. */
	value: () => IResourceValueOf<K> | undefined;
	status: () => IResourceStatus;
	/** Copy a live value the browser may clear (a FileList) before passing it. Resolves undefined when nothing could take it. */
	supply: (value: IResourceSupplyOf<K>) => Promise<IResourceSupplyResponseOf<K> | undefined>;
}

/** An entity or an id is fixed. An accessor is followed: undefined is no owner. */
export type IUseResourceOwner = IEntity | string | (() => IEntity | string | undefined);

/**
 * The view's door to the resource `key` of `owner`: the one reader of its live value, and the one
 * supplier of live values to it.
 */
export function useResource<K extends IResourceKey>(owner: IUseResourceOwner, key: K): IUseResource<K> {
	const runtime = runtimeFor("useResource");
	const resources = runtime.get("runtime/resources");
	// The accessor's own reads are tracked, so value and status follow it; the
	// $Id read off the entity it returns is not.
	const ownerId: () => string | undefined =
		typeof owner === "function"
			? () => {
					const current = owner();
					return typeof current === "object" ? untrack(() => current.$Id) : current;
				}
			: (() => {
					const fixed = typeof owner === "string" ? owner : untrack(() => owner.$Id);
					return () => fixed;
				})();
	return {
		value: () => {
			const id = ownerId();
			return id === undefined ? undefined : (resources.value(key, id) as IResourceValueOf<K> | undefined);
		},
		status: () => {
			const id = ownerId();
			return id === undefined
				? {
						State: "none"
					}
				: resources.status(key, id);
		},
		// Untracked whole, as a dispatch is: a supply made inside an effect must
		// not subscribe it to the owner accessor or to anything the manager reads.
		supply: (value) =>
			untrack(() => {
				const id = ownerId();
				if (id === undefined) {
					runtime.emitDiag({
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
			})
	};
}
