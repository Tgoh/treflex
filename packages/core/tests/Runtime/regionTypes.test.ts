import type { IAction, IActionGenerator, IActionYield, IOpenGenerator, IOpenMark } from "../../src/Types/IAction";
import type { IEffect } from "../../src/Types/IEffect";
import { describe, expect, it } from "vitest";
import { parallel } from "../../src/Effects/parallel";
import { parallelSettled } from "../../src/Effects/parallelSettled";
import { publish } from "../../src/Effects/publish";
import { start } from "../../src/Effects/start";
import { latest, leading } from "../../src/Runtime/arrivalPolicy";
import { open } from "../../src/Runtime/open";

// open, pinned at compile time: every @ts-expect-error below is a case the compiler must
// refuse. The runtime assertion only keeps the file a test.

declare module "../../src/Registries/IMessageRegistry" {
	interface IMessageRegistry {
		"RegionTypes/Loaded": {};
	}
}

type IDoc = {
	$Id: string;
	X: number;
};

declare function fetchIt(): Generator<IEffect, string, any>;

function* loadPreview(doc: IDoc) {
	const r = yield* open(fetchIt());
	doc.X = r.length;
	return r;
}

function* plainEffect(doc: IDoc): IActionGenerator {
	const r = yield* fetchIt();
	doc.X = r.length;
}

function* openCallsOpen(doc: IDoc) {
	yield* open(fetchIt());
	yield* loadPreview(doc);
}

function* nestedOpen(doc: IDoc) {
	// @ts-expect-error open(x) takes an x that doesn't open
	yield* open(loadPreview(doc));
}

function* effectTyped(doc: IDoc): Generator<IEffect, void, any> {
	// @ts-expect-error a helper typed as yielding IEffect can't hide an open
	yield* open(fetchIt());
	doc.X = 1;
}

function* literalEffect(doc: IDoc): IActionGenerator {
	const r: {
		Body: number;
	} = yield {
		Type: "fetch",
		Url: "/x"
	};
	doc.X = r.Body;
}

function* normalPlain(doc: IDoc): IActionGenerator {
	// @ts-expect-error a normal action can't call an open function
	yield* loadPreview(doc);
}

function* normalOpensLeaf(_doc: IDoc): IActionGenerator {
	// @ts-expect-error a normal action can't open a wait
	yield* open(fetchIt());
}

function* inferredCaller(doc: IDoc) {
	yield* loadPreview(doc);
}

function* normalCallsInferred(doc: IDoc): IActionGenerator {
	// @ts-expect-error an unannotated caller passes the open function's type up
	yield* inferredCaller(doc);
}

function* branches(doc: IDoc) {
	yield* parallel(plainEffect(doc), plainEffect(doc));
	yield* parallelSettled(plainEffect(doc), plainEffect(doc));
	yield* open(parallel(plainEffect(doc), fetchIt()));
	// @ts-expect-error a branch can't open
	yield* parallel(loadPreview(doc), plainEffect(doc));
	// @ts-expect-error nor in parallelSettled
	yield* parallelSettled(plainEffect(doc), loadPreview(doc));
	// @ts-expect-error nor with open(...) passed straight in
	yield* parallel(open(fetchIt()), plainEffect(doc));
}

function* normalFansOut(doc: IDoc): IActionGenerator {
	const [a] = yield* parallel(fetchIt(), plainEffect(doc));
	const first: string = a;
	const [settled] = yield* parallelSettled(fetchIt());
	if (settled.ok) {
		const value: string = settled.value;
		doc.X = value.length + first.length;
	}
}

const loadOnce = leading(loadPreview);
const loadLatest = latest(function* loadLatest(doc: IDoc) {
	yield* open(fetchIt());
	doc.X++;
});

function* marked(doc: IDoc): IActionGenerator {
	// @ts-expect-error leading keeps the open marker
	yield* loadOnce(doc);
	// @ts-expect-error and so does latest
	yield* loadLatest(doc);
	yield* start(loadOnce, doc);
	yield* start(loadPreview, doc);
}

function* annotatedOpen(doc: IDoc): IOpenGenerator<string> {
	yield* start(plainEffect, doc);
	yield* publish("RegionTypes/Loaded");
	const r = yield* open(fetchIt());
	doc.X = r.length;
	return r;
}

function* callsAnnotated(doc: IDoc): IActionGenerator {
	// @ts-expect-error an annotated open function can't be called from a normal action
	yield* annotatedOpen(doc);
}

function* inferredMixed(doc: IDoc) {
	yield* start(plainEffect, doc);
	yield* publish("RegionTypes/Loaded");
	const r = yield* open(fetchIt());
	doc.X = r.length;
}

function* callsInferredMixed(doc: IDoc): IActionGenerator {
	// @ts-expect-error built-in effects outside the open don't hide the marker
	yield* inferredMixed(doc);
}

declare const step: IAction<IDoc>;

function* openAndWide(doc: IDoc) {
	yield* step(doc);
	yield* open(fetchIt());
}

function* callsOpenAndWide(doc: IDoc): IActionGenerator {
	// @ts-expect-error a call to an IAction beside the open keeps the marker
	yield* openAndWide(doc);
	// @ts-expect-error and an IAction may open, so a normal action can't call one
	yield* step(doc);
}

function* withStep<R, Y extends IActionYield | IOpenMark>(
	doc: IDoc,
	body: () => Generator<Y, R, any>
): Generator<IActionYield | Y, R, any> {
	yield* start(plainEffect, doc);
	return yield* body();
}

function* wrapsOpenBody(doc: IDoc) {
	return yield* withStep(doc, () => open(fetchIt()));
}

function* callsWrapsOpenBody(doc: IDoc): IActionGenerator {
	// @ts-expect-error a body-generic helper passes its open body's marker to its caller
	yield* wrapsOpenBody(doc);
	yield* withStep(doc, () => fetchIt());
}

function* allOfPlain<T extends Generator[]>(...g: T) {
	// @ts-expect-error a branch typed plain Generator yields unknown, which could hide an open
	return yield* parallel(...g);
}

function* allOf<T extends IActionGenerator<any>[]>(
	...g: [
		...T
	]
) {
	return yield* parallel(...g);
}

function* callsAllOf(doc: IDoc): IActionGenerator {
	yield* allOf(fetchIt(), plainEffect(doc));
	// @ts-expect-error a branch that opens is refused through the generic helper too
	yield* allOf(loadPreview(doc), plainEffect(doc));
}

const dispatchable: IAction<IDoc>[] = [
	loadPreview,
	plainEffect,
	openCallsOpen,
	loadOnce,
	annotatedOpen
];

describe("open, typed", () => {
	it("compiles the cases above", () => {
		const all = [
			openCallsOpen,
			nestedOpen,
			effectTyped,
			literalEffect,
			normalPlain,
			normalOpensLeaf,
			normalCallsInferred,
			branches,
			normalFansOut,
			marked,
			callsAnnotated,
			callsInferredMixed,
			callsOpenAndWide,
			callsWrapsOpenBody,
			allOfPlain,
			callsAllOf,
			...dispatchable
		];
		expect(all.every((fn) => typeof fn === "function")).toBe(true);
	});
});
