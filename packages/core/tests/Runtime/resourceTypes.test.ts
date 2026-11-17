import type { IReceivableResourceKey, IResourceDeliveryOf } from "../../src/Registries/IResourceRegistry";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IHandleableKey } from "../../src/Types/IReceiver";
import { describe, expect, it } from "vitest";
import { openResource } from "../../src/Effects/openResource";
import { resource } from "../../src/Effects/resource";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { receiver } from "../../src/Runtime/receiver";
import { isEnded } from "../../src/Types/IResource";

// The registry typing, pinned at compile time: every @ts-expect-error below
// is a case the compiler must refuse. The runtime assertions only keep the
// file a test.

declare module "../../src/Registries/IResourceRegistry" {
	interface IResourceTypeRegistry {
		"types/sse": {
			Params: {
				Endpoint: string;
			};
			Message: unknown;
			ResumeFrom: "required";
		};
		"types/blob": {
			Params: {
				Url: string;
			};
			Message: {
				Size: number;
			};
			Value: string;
			Methods: {
				save(name: string): boolean;
			};
		};
		"types/upload": {
			Methods: {
				upload(id: string, store: string): string;
				remove(id: string): void;
			};
			Supply: readonly string[];
			SupplyResponse: {
				Id: string;
			}[];
		};
	}
	interface IResourceRegistry {
		"Types/Events": {
			Type: "types/sse";
			Message: {
				Events: number[];
				Last: number;
			};
			Params: {
				UserId: string;
			};
		};
		"Types/Preview": {
			Type: "types/blob";
			Message: never;
		};
		"Types/Blob": {
			Type: "types/blob";
		};
		"Types/Upload": {
			Type: "types/upload";
		};
		"Types/Typed": {
			Type: "types/blob";
			Message: {
				Type: string;
			};
		};
		"Types/Listy": {
			Type: "types/blob";
			Message: string[];
		};
	}
}

type IOwner = {
	$Id: string;
	Cursor: number;
	Nested: {
		Deep: number;
	};
};

const EventsReceiver = receiver<IOwner>("TypesEvents")({
	*"Types/Events"(draft, e) {
		if (isEnded(e)) {
			const reason: string = e.$Ended.Reason;
			void reason;
			return;
		}
		draft.Cursor = e.Last;
	}
});

const UploadReceiver = receiver<IOwner>("TypesUpload")({
	*"Types/Upload"(_draft, e) {
		// A type that never emits sends only the end notice.
		const reason: string = e.$Ended.Reason;
		void reason;
	}
});

function* opens(draft: IOwner): IActionGenerator {
	yield* openResource(
		draft,
		"Types/Events",
		EventsReceiver,
		{
			Type: "types/sse",
			Endpoint: "/e",
			UserId: "u"
		},
		{
			ResumeFrom: "Cursor"
		}
	);
	// @ts-expect-error ResumeFrom is required by the type
	yield* openResource(draft, "Types/Events", EventsReceiver, {
		Type: "types/sse",
		Endpoint: "/e",
		UserId: "u"
	});
	yield* openResource(
		draft,
		"Types/Events",
		EventsReceiver,
		{
			Type: "types/sse",
			Endpoint: "/e",
			UserId: "u"
		},
		{
			// @ts-expect-error ResumeFrom names a top-level scalar field
			ResumeFrom: "Nested"
		}
	);
	yield* openResource(
		draft,
		"Types/Events",
		EventsReceiver,
		// @ts-expect-error the key's own Params field is required
		{
			Type: "types/sse",
			Endpoint: "/e"
		},
		{
			ResumeFrom: "Cursor"
		}
	);
	yield* openResource(draft, "Types/Blob", {} as never, {
		// @ts-expect-error Type must match the key's type
		Type: "types/sse",
		Url: "x"
	});

	// A key overriding an emitting type's Message to never takes no receiver.
	yield* openResource(draft, "Types/Preview", {
		Type: "types/blob",
		Url: "blob:1"
	});
	// @ts-expect-error no receiver for a Message: never key
	yield* openResource(draft, "Types/Preview", EventsReceiver, {
		Type: "types/blob",
		Url: "blob:1"
	});

	// A type that never emits: the receiver is optional and hears only ends.
	yield* openResource(draft, "Types/Upload", {
		Type: "types/upload"
	});
	yield* openResource(draft, "Types/Upload", UploadReceiver, {
		Type: "types/upload"
	});

	// The message rule: a key whose Message carries Type, or is an array,
	// cannot be opened at all.
	yield* openResource(draft, "Types/Typed", {} as never, {
		// @ts-expect-error the params element is { $MessageMustBePlainObjectWithoutType: K }
		Type: "types/blob",
		Url: "x"
	});
	yield* openResource(draft, "Types/Listy", {} as never, {
		// @ts-expect-error the params element is { $MessageMustBePlainObjectWithoutType: K }
		Type: "types/blob",
		Url: "x"
	});

	const files = resource(draft, "Types/Upload");
	const guid = yield* files.upload("id", "store");
	const narrowed: string | undefined = guid;
	void narrowed;
	// @ts-expect-error the result may be undefined
	const strict: string = yield* files.upload("id", "store");
	void strict;
	// @ts-expect-error not a method of the type
	yield* files.publish();
	// @ts-expect-error argument types follow the declaration
	yield* files.upload(1, "store");

	// A type that declares no Methods has none on its handle.
	// @ts-expect-error sse declares no methods
	yield* resource(draft, "Types/Events").close();
}

type IAssert<T extends true> = T;
type IEquals<A, B> = [
	A
] extends [
	B
]
	? [
			B
		] extends [
			A
		]
		? true
		: false
	: false;

type IPinned = [
	// The override-to-never key joins no receiver vocabulary.
	IAssert<IEquals<Extract<IHandleableKey, "Types/Preview">, never>>,
	IAssert<IEquals<Extract<IReceivableResourceKey, "Types/Upload">, "Types/Upload">>,
	IAssert<
		IEquals<
			IResourceDeliveryOf<"Types/Upload">,
			{
				Type: "Types/Upload";
				$Ended: import("../../src/Types/IResource").IEnded;
			}
		>
	>
];

describe("resource registry typing", () => {
	it("compiles the cases above", () => {
		const pinned: IPinned | undefined = undefined;
		expect(pinned).toBeUndefined();
		expect(typeof opens).toBe("function");
	});

	it("types registration against the type's declaration", () => {
		const runtime = createRuntime({
			$Id: "root"
		});
		runtime.registerResourceType("types/blob", (params, r) => {
			const url: string = params.Url;
			void url;
			r.expose("blob:x");
			// @ts-expect-error the exposed value is the type's Value
			r.expose(1);
			void r.emit({
				Size: 1
			});
			void r.emit({
				// @ts-expect-error the message is the type's Message
				Bytes: 1
			});
			r.methods({
				save: (_ctx, name) => name.length > 0
			});
		});
		runtime.registerResourceType("types/upload", (_params, r) => {
			// @ts-expect-error every declared method needs a handler
			r.methods({
				upload: () => "guid"
			});
			r.onSupply((files) =>
				files.map((f) => ({
					Id: f
				}))
			);
		});
		runtime.registerResourceType("types/sse", (_params, r) => {
			r.methods({
				// @ts-expect-error sse declares no methods to handle
				foo: () => 1
			});
		});
		runtime.dispose();
		expect(true).toBe(true);
	});
});
