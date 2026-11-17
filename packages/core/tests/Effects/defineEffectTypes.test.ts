import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEffect } from "../../src/Types/IEffect";
import { describe, expect, it } from "vitest";
import { defineEffect, implementation } from "../../src/Effects/defineEffect";
import { generateGuid } from "../../src/Effects/generateGuid";

// The declaration typing, pinned at compile time: every @ts-expect-error
// below is a case the compiler must refuse. The runtime assertion only keeps
// the file a test.

interface INowTypesEffect extends IEffect {
	Type: "types/now";
}
interface IDelayTypesEffect extends IEffect {
	Type: "types/delay";
	Ms: number;
}
type IShapeTypesEffect =
	| {
			Type: "types/shape";
			Kind: "circle";
			Radius: number;
	  }
	| {
			Type: "types/shape";
			Kind: "square";
			Side: number;
	  };
type IMixedTypesEffect =
	| {
			Type: "types/a";
	  }
	| {
			Type: "types/b";
	  };

const now = defineEffect<INowTypesEffect, number>("types/now", {
	settles: "sync"
});
const delay = defineEffect<IDelayTypesEffect, void>("types/delay");
const shape = defineEffect<IShapeTypesEffect, string>("types/shape", {
	redact: true
});
const voidSync = defineEffect<
	{
		Type: "types/voidSync";
	},
	void
>("types/voidSync", {
	settles: "sync"
});

declare const flag: boolean;
declare const widened: {
	settles: string;
	redact: boolean;
};
declare const maybeSync: {
	settles?: "sync";
};
declare const thenable: PromiseLike<void>;
declare const anyFn: (effect: INowTypesEffect) => any;
declare const unknownFn: () => unknown;
declare const runtime: IRuntime<object>;

function* calls(): IActionGenerator<number> {
	// A descriptor with no fields of its own takes no payload.
	const at: number = yield* now();
	// @ts-expect-error nor a positional argument
	yield* now(5);
	yield* now(
		// @ts-expect-error nor an object of fields it does not have
		{
			Extra: 1
		}
	);
	yield* delay({
		Ms: 5
	});
	yield* generateGuid(
		// @ts-expect-error the built-in generateGuid takes no payload either
		{
			Foo: 1
		}
	);
	// @ts-expect-error a payload with fields is required
	yield* delay();
	yield* delay({
		// @ts-expect-error the payload is checked
		Ms: "5"
	});
	// A union keeps each variant's fields.
	yield* shape({
		Kind: "circle",
		Radius: 1
	});
	yield* shape({
		Kind: "circle",
		// @ts-expect-error a field from the other variant
		Side: 1
	});
	return at;
}

// Never called: the invalid declarations would throw at runtime.
function declarations(): void {
	// @ts-expect-error a union of descriptors with different Types
	defineEffect<IMixedTypesEffect, void>("types/a");
	// @ts-expect-error a Type that is not a literal
	defineEffect<IEffect, void>("anything");
	defineEffect<INowTypesEffect, number>("types/now", {
		// @ts-expect-error settles takes only "sync"
		settles: "async"
	});
	// @ts-expect-error a widened options object resolves to neither overload
	defineEffect<INowTypesEffect, number>("types/now", widened);
	// @ts-expect-error neither does an optional settles
	defineEffect<INowTypesEffect, number>("types/now", maybeSync);
	// @ts-expect-error a Type string that is not the descriptor's
	defineEffect<INowTypesEffect, number>("types/later");
	defineEffect<INowTypesEffect, number>("types/now", {
		// @ts-expect-error a misspelt option
		settle: "sync"
	});
}

function implementations(): void {
	const nowImpl = implementation(now, () => 1);
	const delayImpl = implementation(delay, async (effect) => {
		await Promise.resolve(effect.Ms);
	});
	implementation(delay, (effect) => {
		void effect.Ms;
	});
	// @ts-expect-error the result type is checked
	implementation(now, () => "1");
	// @ts-expect-error an async implementation for a sync type
	implementation(now, async () => 1);
	// @ts-expect-error an async implementation for a sync type whose result is void
	implementation(voidSync, async () => {});
	// @ts-expect-error a function that returns a promise only sometimes
	implementation(voidSync, () => (flag ? undefined : Promise.resolve()));
	// @ts-expect-error a plain thenable for a sync type
	implementation(voidSync, () => thenable);
	// any and unknown returns are accepted, and fall to the runtime throw.
	implementation(now, anyFn);
	implementation(voidSync, unknownFn);

	// Registration takes a tag, or a string with an untyped function.
	runtime.registerImplementation(nowImpl);
	runtime.registerImplementation(delayImpl);
	runtime.registerImplementation("types/now", () => 1);
	// @ts-expect-error a string registration needs a function
	runtime.registerImplementation("types/now");
}

describe("defineEffect typing", () => {
	it("compiles", () => {
		expect([
			calls,
			declarations,
			implementations
		]).toHaveLength(3);
	});
});
