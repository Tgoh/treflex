import type { IDiagEmitter } from "../Types/IRuntimeEvent";
import type { ISelector } from "../Types/ISelector";
import type { IRuntime } from "./createRuntime";
import type { IRuntimeStoreReader } from "./processAction";
import type { ISetState } from "./sliceSetState";

export interface IResolvedEntityCell {
	state: unknown;
	setState: ISetState<any>;
}

export interface IRuntimeInternal<T extends object> extends IRuntime<T> {
	/** The bindings' memoized read: a view's selector, cached per entity. */
	runSelector: <S, R>(selector: ISelector<S, R>, getState: () => any) => R;
	// The seed's copy with its minted $Id, readable before it is seated.
	seedComponent(
		seed: unknown,
		where: string
	): {
		id: string;
		raw: object;
	};
	// Seats the seed in ComponentState under `ownerId`, or under the root when undefined, in an
	// exempt frame, so a held owner doesn't delay it. Again after an unmount, it seats it again.
	// False, and nothing seated, when the owner is gone or leaving or the runtime is disposed. An
	// owner in ComponentState throws: component mounts are flat.
	seatComponent(ownerId: string | undefined, raw: object): boolean;
	// Moves a seated mount under another owner, keeping its node. False when it isn't seated, and
	// when the new owner can't hold it, which unmounts it.
	reseatComponent(id: string, ownerId: string | undefined): boolean;
	// Idempotent: the owner's removal may have taken the entity already. True when this removed it.
	unmountComponent(id: string): boolean;
	get: IRuntimeStoreReader;
	// undefined when the id is not indexed: an unknown id, or an entity the
	// cascade has taken.
	// Untracked — resolving is navigation, not a reactive read.
	resolveCell(entityId: string): IResolvedEntityCell | undefined;
	emitDiag: IDiagEmitter;
	disposed(): boolean;
}
