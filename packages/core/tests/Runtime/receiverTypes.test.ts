import { describe, expect, expectTypeOf, it } from "vitest";
import { receiver } from "../../src/Runtime/receiver";

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"ReceiverTypes/Changed": {
			Value: number;
		};
		"ReceiverTypes/Removed": {};
	}
}

type IOwner = {
	$Id: string;
	Value: number;
};

const Inferred = receiver<IOwner>("ReceiverTypesInferred")({
	*"ReceiverTypes/Changed"(draft, e) {
		expectTypeOf(e.Value).toEqualTypeOf<number>();
		// @ts-expect-error not a field of the event
		void e.Nope;
		draft.Value = e.Value;
	},
	*"ReceiverTypes/Removed"(draft) {
		draft.Value = 0;
	}
});

const MisspeltAnnotated = receiver<IOwner>("ReceiverTypesMisspeltAnnotated")({
	*"ReceiverTypes/Changed"(draft, e) {
		draft.Value = e.Value;
	},
	// @ts-expect-error no registry declares the key
	*"ReceiverTypes/Chnaged"(draft: IOwner) {
		draft.Value = 0;
	}
});

const MisspeltNoParams = receiver<IOwner>("ReceiverTypesMisspeltNoParams")({
	*"ReceiverTypes/Changed"(draft, e) {
		draft.Value = e.Value;
	},
	// @ts-expect-error no registry declares the key
	*"ReceiverTypes/Remvoed"() {}
});

const OnlyMisspelt = receiver<IOwner>("ReceiverTypesOnlyMisspelt")({
	// @ts-expect-error no registry declares the key
	*"ReceiverTypes/Chnaged"(draft: IOwner) {
		draft.Value = 0;
	}
});

const CastKey = receiver<IOwner>("ReceiverTypesCastKey")({
	*"ReceiverTypes/Changed"(draft, e) {
		draft.Value = e.Value;
	},
	*["ReceiverTypes/Chnaged" as any](draft: IOwner) {
		draft.Value = 0;
	}
});

describe("receiver case keys", () => {
	it("compiles the cases above", () => {
		const built = [
			Inferred,
			MisspeltAnnotated,
			MisspeltNoParams,
			OnlyMisspelt,
			CastKey
		];
		expect(built.every((r) => typeof r.handle === "function")).toBe(true);
	});
});
