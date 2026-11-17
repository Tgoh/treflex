import type { IImplementationTag } from "../Effects/defineEffect";
import type { IActionContext } from "../Types/IActionContext";
import type { IEffect } from "../Types/IEffect";
import { refuseReservedType } from "./operations";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/effects": IEffectRegistry;
	}
}

/** What answers an effect type: the action's yield goes to it with nothing in between. */
export type IEffectImplementation<E extends IEffect = IEffect> = (effect: E, action?: IActionContext) => any;

/** A tag from `implementation(declaration, fn)`, typed by its declaration, or a Type with an untyped function. */
export interface IRegisterImplementation {
	(tag: IImplementationTag<any, any>): void;
	<E extends IEffect>(name: string, impl: IEffectImplementation<E>): void;
}

// The one refusal an effect type with no implementation gets. Exported
// because createTestRuntime's preset replaces `generateGuid` with a stub
// that raises it, so an unstubbed yield of it is indistinguishable from a
// type nobody registered.
export function noImplementationMessage(type: string): string {
	return `No implementation registered for effect type: "${type}"`;
}

export interface IEffectRegistry {
	registerImplementation: IRegisterImplementation;
	processEffect: IEffectImplementation;
}

export function createEffectRegistry(): IEffectRegistry {
	const implementations: Record<string, IEffectImplementation> = Object.create(null);

	function register(name: string, impl: IEffectImplementation): void {
		refuseReservedType(name, "registerImplementation");
		if (implementations[name]) {
			console.warn(`[treflex] Implementation for effect "${name}" is being overwritten.`);
		}
		implementations[name] = impl;
	}

	const registerImplementation = ((nameOrTag: string | IImplementationTag<any, any>, impl?: IEffectImplementation): void => {
		if (typeof nameOrTag === "string") {
			register(nameOrTag, impl as IEffectImplementation);
			return;
		}
		register(nameOrTag.Type, nameOrTag.fn as IEffectImplementation);
	}) as IRegisterImplementation;

	function processEffect(effect: IEffect, action?: IActionContext) {
		const impl = implementations[effect.Type];
		if (!impl) {
			throw new Error(noImplementationMessage(effect.Type));
		}
		return impl(effect, action);
	}

	return {
		registerImplementation,
		processEffect
	};
}
