import type { IAction, IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it } from "vitest";
import { start } from "../../src/Effects/start";

// start's target typing, pinned at compile time: every @ts-expect-error below
// is a case the compiler must refuse. The runtime assertion only keeps the
// file a test.

type Child = {
	$Id: string;
	Data: string;
};
type Other = {
	$Id: string;
	Count: number;
};
type Parent = {
	$Id: string;
	Children: Child[];
	Other: Other;
};

declare function childWrite(draft: Child): IActionGenerator;
declare function childWithArgs(draft: Child, label: string, n: number): IActionGenerator;
declare function stringDraft(draft: string): IActionGenerator;
declare function childOrString(draft: Child | string): IActionGenerator;
declare const init: IAction<any>;
declare const maybeId: string | undefined;

function* starts(draft: Parent): IActionGenerator {
	const child = draft.Children[0];

	// The node form: the target is the action's own draft type.
	yield* start(childWrite, child);
	yield* start(childWithArgs, child, "x", 1);
	// @ts-expect-error the forwarded args still follow the action
	yield* start(childWithArgs, child, 1, 1);

	// @ts-expect-error a node of another entity type
	yield* start(childWrite, draft.Other);
	// @ts-expect-error not an entity at all
	yield* start(childWrite, {
		Data: "x"
	});
	// @ts-expect-error the action's draft is a different entity type
	yield* start(starts, child);
	// @ts-expect-error a draft that may not be an entity takes no node
	yield* start(childOrString, child);

	// An untyped action, such as a feature's init, takes either form.
	yield* start(init, child);
	yield* start(init, child.$Id);
	yield* start(init, "id", {
		Any: "options"
	});
	// @ts-expect-error an untyped action still needs an id or an entity
	yield* start(init, maybeId);
	// @ts-expect-error an untyped action still needs an id or an entity
	yield* start(init, 42);

	// The id form is unchanged.
	yield* start(childWrite, child.$Id);
	yield* start(childWithArgs, "child-1", "x", 1);
	yield* start(stringDraft, "id");
	// @ts-expect-error the forwarded args still follow the action
	yield* start(childWithArgs, "child-1", "x");
}

describe("start target typing", () => {
	it("compiles the cases above", () => {
		expect(typeof starts).toBe("function");
	});
});
