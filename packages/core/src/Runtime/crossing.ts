import type { IEffect } from "../Types/IEffect";
import { cloneStrict, copyFrozen, copyFrozenList, type ICopyOptions, type IStrictClone } from "../Utility/valueCodec";
import { isAttached } from "./draftNode";
import { NonPlainDataError } from "./nonPlainDataError";
import { rawOf } from "./viewProxy";

// A read through a gone reference still raises.
function unwrapLive(node: object): object {
	const raw = rawOf(node);
	if (raw !== node && !isAttached(node)) {
		Reflect.ownKeys(node);
	}
	return raw;
}

const PLAIN: ICopyOptions = {
	unwrap: unwrapLive
};

function checked(copy: IStrictClone, what: string): unknown {
	if (!copy.ok) {
		throw new NonPlainDataError(what, copy.kind, copy.path, "Nothing was sent.");
	}
	return copy.value;
}

export function copyArguments<A extends readonly unknown[]>(actionName: string, args: A): A {
	return args.length === 0 ? args : (checked(copyFrozenList(args, PLAIN), `action "${actionName}": an argument`) as A);
}

export function copyListAtSender(values: readonly unknown[], what: string): unknown[] {
	return checked(copyFrozenList(values, PLAIN), what) as unknown[];
}

export function copyAtSender(value: unknown, what: string): unknown {
	return checked(copyFrozen(value, PLAIN), what);
}

export function copyPlain(value: unknown, what: string): unknown {
	return checked(cloneStrict(value, PLAIN), what);
}

export function copyEffectInput(effect: IEffect): IEffect {
	if (effect === null || typeof effect !== "object" || typeof effect.Type !== "string") {
		return effect;
	}
	return checked(copyFrozen(effect, PLAIN), `${effect.Type}: the input`) as IEffect;
}
