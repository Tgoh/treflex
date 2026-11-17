import type { IRuntime } from "../../src/Runtime/createRuntime";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IEffect } from "../../src/Types/IEffect";
import type { ISelectorGenerator } from "../../src/Types/ISelector";
import { describe, expect, it } from "vitest";
import { defineEffect } from "../../src/Effects/defineEffect";
import { entity } from "../../src/Effects/entity";
import { publish } from "../../src/Effects/publish";
import { select } from "../../src/Reads/select";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { NonPlainDataError } from "../../src/Runtime/nonPlainDataError";
import { transient } from "../../src/Runtime/transient";
import { copyComponentSeed } from "../../src/Runtime/viewProxy";
import { rootSetState } from "../testHelpers";

type TestState = {
	$Id: string;
	Data: string;
	Box?: unknown;
	Items?: unknown[];
};

const initialState = (): TestState => ({
	$Id: "parent",
	Data: "before"
});

function makeRuntime(state: TestState = initialState()) {
	return createRuntime<TestState>(state, {
		onError: () => {}
	});
}

function dispatch<A extends any[], R>(
	runtime: IRuntime<TestState>,
	action: (draft: TestState, ...args: A) => Generator<any, R, any>,
	...args: A
): Promise<R | undefined> {
	return runtime.processAction(
		action as any,
		() => runtime.state,
		rootSetState(runtime),
		() => "parent",
		...args
	);
}

class Foo {
	X = 1;
}

function* writeMap(draft: TestState): IActionGenerator {
	draft.Box = new Map([
		[
			"k",
			"v"
		]
	]);
}

function* writeSet(draft: TestState): IActionGenerator {
	draft.Box = new Set([
		1
	]);
}

function* writeDate(draft: TestState): IActionGenerator {
	draft.Box = new Date(0);
}

function* writeClass(draft: TestState): IActionGenerator {
	draft.Box = new Foo();
}

function* writeNested(draft: TestState): IActionGenerator {
	draft.Box = {
		Deep: {
			M: new Set()
		}
	};
}

function* writesPlain(draft: TestState): IActionGenerator {
	draft.Data = "changed";
	draft.Box = {
		N: 1,
		Flag: null,
		L: [
			true,
			0,
			"x"
		]
	};
}

describe("plain data on a write", () => {
	it("throws on a Map written to state, naming the path and constructor", async () => {
		const runtime = makeRuntime();
		await expect(dispatch(runtime, writeMap)).rejects.toThrow(/a write to state is not plain: Map at \[Box\]/);
		expect(runtime.state.Box).toBeUndefined();
	});

	it("throws on a Set", async () => {
		const runtime = makeRuntime();
		await expect(dispatch(runtime, writeSet)).rejects.toThrow(/a write to state is not plain: Set at \[Box\]/);
	});

	it("throws on a Date, pointing at the plain representation", async () => {
		const runtime = makeRuntime();
		await expect(dispatch(runtime, writeDate)).rejects.toThrow(/not plain: Date at \[Box\].*epoch milliseconds/);
	});

	it("throws on a class instance, naming its constructor", async () => {
		const runtime = makeRuntime();
		await expect(dispatch(runtime, writeClass)).rejects.toThrow(/a write to state is not plain: Foo at \[Box\]/);
	});

	it("names the full path to a nested offender", async () => {
		const runtime = makeRuntime();
		await expect(dispatch(runtime, writeNested)).rejects.toThrow(/a write to state is not plain: Set at \[Box\.Deep\.M\]/);
	});

	it("refuses a non-plain seed at construction, naming the path", () => {
		expect(() =>
			makeRuntime({
				...initialState(),
				Box: new Map([
					[
						"seed",
						1
					]
				])
			})
		).toThrow(/the initial state is not plain: Map at \[Box\]/);
		expect(() =>
			makeRuntime({
				...initialState(),
				Items: [
					1,
					new Map()
				]
			})
		).toThrow(/the initial state is not plain: Map at \[Items\.1\]/);
	});

	it("refuses an undefined inside a written array, nested or as an element, and a seed's too", async () => {
		const runtime = makeRuntime({
			...initialState(),
			Items: [
				1
			]
		});
		function* nested(draft: TestState): IActionGenerator {
			draft.Box = {
				L: [
					undefined
				]
			};
		}
		function* element(draft: TestState): IActionGenerator {
			draft.Items![0] = undefined;
		}
		function* pushed(draft: TestState): IActionGenerator {
			draft.Items!.push(undefined);
		}
		await expect(dispatch(runtime, nested)).rejects.toThrow(/not plain: undefined array element at \[Box\.L\.0\]/);
		await expect(dispatch(runtime, element)).rejects.toThrow(/not plain: undefined array element at \[Items\.0\]/);
		await expect(dispatch(runtime, pushed)).rejects.toThrow(/not plain: undefined array element at \[Items\.1\]/);
		expect(() =>
			makeRuntime({
				...initialState(),
				Items: [
					undefined
				]
			})
		).toThrow(/undefined array element/);
	});

	it("still deletes a key written as undefined", async () => {
		const runtime = makeRuntime({
			...initialState(),
			Box: 1
		});
		function* clears(draft: TestState): IActionGenerator {
			draft.Box = undefined;
		}
		await dispatch(runtime, clears);
		expect("Box" in runtime.state).toBe(false);
	});

	it("surfaces through the normal action-error path", async () => {
		const runtime = makeRuntime();
		const namesById = new Map<string, string>();
		const errors: string[] = [];
		runtime.on("record", (record) => {
			if (record.Kind === "action:start") {
				namesById.set(record.ActionId, record.Name ?? "(anonymous)");
			} else if (record.Kind === "action:end" && record.Status === "errored") {
				errors.push(namesById.get(record.ActionId) ?? record.ActionId);
			}
		});
		await dispatch(runtime, writeMap).catch(() => {});
		expect(errors).toStrictEqual([
			"writeMap"
		]);
	});

	it("leaves plain writes unaffected", async () => {
		const runtime = makeRuntime();
		await dispatch(runtime, writesPlain);
		expect(runtime.state.Data).toBe("changed");
		expect(runtime.state.Box).toStrictEqual({
			N: 1,
			Flag: null,
			L: [
				true,
				0,
				"x"
			]
		});
	});
});

describe("plain-data assert — action arguments", () => {
	it("refuses a Map passed as an action arg", async () => {
		const runtime = makeRuntime();
		function* takesMap(draft: TestState, m: Map<string, number>): IActionGenerator {
			draft.Data = `got:${m.size}`;
		}
		await expect(
			dispatch(
				runtime,
				takesMap as any,
				new Map([
					[
						"a",
						1
					]
				])
			)
		).rejects.toThrow(/action "takesMap": an argument is not plain: Map at \[0\]/);
	});

	it("still accepts plain args", async () => {
		const runtime = makeRuntime();
		function* takesData(
			draft: TestState,
			d: {
				A: number;
			}
		): IActionGenerator {
			draft.Data = `got:${d.A}`;
		}
		await dispatch(runtime, takesData as any, {
			A: 7
		});
		expect(runtime.state.Data).toBe("got:7");
	});
});

interface IProbeEffect extends IEffect {
	Type: "plain/probe";
	Input: unknown;
}
const probe = defineEffect<IProbeEffect, unknown>("plain/probe");

interface IDatedEffect extends IEffect {
	Type: "plain/dated";
}
const dated = defineEffect<IDatedEffect, unknown>("plain/dated");

const publishAny = publish as unknown as (topic: string, data?: object) => IActionGenerator;

describe("a Date refused on every way in, with NonPlainDataError", () => {
	const at = () => new Date(0);

	function build(): IRuntime<TestState> {
		return createRuntime<TestState>(initialState(), {
			onError: () => {},
			implementations: {
				"plain/probe": () => null,
				"plain/dated": at
			}
		});
	}

	function* aDate(): ISelectorGenerator<Date> {
		return at();
	}

	async function refusalOf(run: () => unknown): Promise<unknown> {
		try {
			await run();
		} catch (error) {
			return error;
		}
		return undefined;
	}

	it.each<
		[
			string,
			(runtime: IRuntime<TestState>) => unknown
		]
	>([
		[
			"a draft write",
			(runtime) =>
				runtime.dispatch(function* (draft: TestState): IActionGenerator {
					draft.Box = at();
				}, "parent")
		],
		[
			"a write into a transient",
			(runtime) =>
				runtime.dispatch(function* (draft: TestState): IActionGenerator {
					const slot = yield* transient(draft, "Plain/Slot", {
						At: 0 as unknown
					});
					slot.At = at();
				}, "parent")
		],
		[
			"a transient's default",
			(runtime) =>
				runtime.dispatch(function* (draft: TestState): IActionGenerator {
					yield* transient(draft, "Plain/Default", {
						At: at()
					});
				}, "parent")
		],
		[
			"an action argument",
			(runtime) => runtime.dispatch(function* (_draft: TestState, _when: Date): IActionGenerator {}, "parent", at())
		],
		[
			"an effect's input",
			(runtime) =>
				runtime.dispatch(function* (): IActionGenerator {
					yield* probe({
						Input: at()
					});
				}, "parent")
		],
		[
			"an effect's result",
			(runtime) =>
				runtime.dispatch(function* (): IActionGenerator {
					yield* dated();
				}, "parent")
		],
		[
			"a publish payload",
			(runtime) =>
				runtime.dispatch(function* (): IActionGenerator {
					yield* publishAny("Plain/Topic", {
						When: at()
					});
				}, "parent")
		],
		[
			"a select result in an action",
			(runtime) =>
				runtime.dispatch(function* (): IActionGenerator {
					yield* select(aDate);
				}, "parent")
		],
		[
			"entity()",
			(runtime) =>
				runtime.dispatch(function* (): IActionGenerator {
					yield* entity({
						When: at()
					});
				}, "parent")
		],
		[
			"a runtime's seed",
			() =>
				createRuntime<TestState>({
					...initialState(),
					Box: at()
				})
		],
		[
			"a component state seed",
			() =>
				copyComponentSeed(
					{
						When: at()
					},
					"~component",
					"useComponentState"
				)
		]
	])("%s", async (_way, run) => {
		const refusal = await refusalOf(() => run(build()));
		expect(refusal).toBeInstanceOf(NonPlainDataError);
		expect((refusal as NonPlainDataError).kind).toBe("Date");
	});
});
