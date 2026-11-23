import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { describe, expect, it, vi } from "vitest";
import { defineEffect } from "../../src/Effects/defineEffect";
import { openResource } from "../../src/Effects/openResource";
import { resource } from "../../src/Effects/resource";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { settled } from "../../src/Testing/createTestRuntime";
import { deepNestingDepths, depthOf, nest } from "../testHelpers";

vi.mock("../../src/Utility/devMode", () => ({
	DEV: false
}));

class ConflictError extends Error {
	readonly at = new Date(0);
	constructor() {
		super("version 3 is taken");
		this.name = "ConflictError";
	}
}

const saveNow = defineEffect<
	{
		Type: "rejectionProd/saveNow";
	},
	number
>("rejectionProd/saveNow", {
	settles: "sync"
});

const openResourceAny = openResource as unknown as (entity: object, key: string, ...rest: unknown[]) => IActionGenerator;
const resourceAny = resource as unknown as (ownerId: string, key: string) => Record<string, () => IActionGenerator>;

function build(original: ConflictError) {
	const runtime = createRuntime(
		{
			$Id: "root"
		},
		{
			onError: () => {},
			implementations: {
				"rejectionProd/rejects": () => Promise.reject(original),
				"rejectionProd/throws": () => {
					throw original;
				},
				"rejectionProd/saveNow": () => {
					throw original;
				}
			}
		}
	);
	(
		runtime as unknown as {
			registerResourceType(type: string, impl: (params: unknown, r: any) => void): void;
		}
	).registerResourceType("rejectionProd/feed", (_params, r) => {
		r.methods({
			save: () => Promise.reject(original)
		});
	});
	const diags: IRuntimeEventOf<"diag">[] = [];
	runtime.on("diag", (event) => diags.push(event));
	return {
		runtime,
		diags
	};
}

function expectCopy(caught: unknown, original: ConflictError): void {
	expect(caught).not.toBe(original);
	expect(Object.getPrototypeOf(caught)).toBe(Error.prototype);
	expect((caught as Error).name).toBe("ConflictError");
	expect((caught as Error).message).toBe("version 3 is taken");
	expect((caught as ConflictError).at).toBe("1970-01-01T00:00:00.000Z");
}

describe("a rejection in production", () => {
	it.each([
		"rejectionProd/rejects",
		"rejectionProd/throws"
	])("crosses as a copy from %s, with no diag", async (type) => {
		const original = new ConflictError();
		const h = build(original);
		let caught: unknown;
		await h.runtime.dispatch(function* catches(): IActionGenerator {
			try {
				yield {
					Type: type
				} as never;
			} catch (error) {
				caught = error;
			}
		}, "root");
		expectCopy(caught, original);
		expect(h.diags).toEqual([]);
	});

	it("crosses as a copy from a settles: sync implementation, with no diag", async () => {
		const original = new ConflictError();
		const h = build(original);
		let caught: unknown;
		await h.runtime.dispatch(function* catches(): IActionGenerator {
			try {
				yield* saveNow();
			} catch (error) {
				caught = error;
			}
		}, "root");
		expectCopy(caught, original);
		expect(h.diags).toEqual([]);
	});

	it("crosses as a copy from a resource method's handler, with no diag", async () => {
		const original = new ConflictError();
		const h = build(original);
		await h.runtime.dispatch(function* opens(draft: { $Id: string }): IActionGenerator {
			yield* openResourceAny(draft, "RejectionProd/Feed", {
				Type: "rejectionProd/feed"
			});
		}, "root");
		await settled();
		let caught: unknown;
		await h.runtime.dispatch(function* calls(draft: { $Id: string }): IActionGenerator {
			try {
				yield* resourceAny(draft.$Id, "RejectionProd/Feed").save!();
			} catch (error) {
				caught = error;
			}
		}, "root");
		expectCopy(caught, original);
		expect(h.diags).toEqual([]);
	});
});

describe("a rejection nested deep, in production", () => {
	const { carried, uncarried } = deepNestingDepths();

	async function caughtFrom(thrown: unknown): Promise<unknown> {
		const runtime = createRuntime(
			{
				$Id: "root"
			},
			{
				onError: () => {},
				implementations: {
					"rejectionProd/deep": () => Promise.reject(thrown)
				}
			}
		);
		let caught: unknown = "nothing caught";
		await runtime.dispatch(function* catches(): IActionGenerator {
			try {
				yield {
					Type: "rejectionProd/deep"
				} as never;
			} catch (error) {
				caught = error;
			}
		}, "root");
		return caught;
	}

	it.skipIf(carried === undefined)("gives a thrown value its JSON carries and too deep to compare as itself", async () => {
		expect(depthOf(await caughtFrom(nest(carried!)))).toBe(carried);
	});

	it.skipIf(carried === undefined)("keeps an error's field its JSON carries and too deep to compare", async () => {
		const copy = (await caughtFrom(
			Object.assign(new Error("deep field"), {
				list: nest(carried!)
			})
		)) as {
			list: unknown;
		};
		expect(depthOf(copy.list)).toBe(carried);
	});

	it.skipIf(uncarried === undefined)("gives a thrown value too deep for JSON as undefined", async () => {
		expect(await caughtFrom(nest(uncarried!))).toBeUndefined();
	});

	it.skipIf(uncarried === undefined)("drops an error's field too deep for JSON", async () => {
		const copy = (await caughtFrom(
			Object.assign(new Error("deep field"), {
				list: nest(uncarried!)
			})
		)) as Error;
		expect(copy.message).toBe("deep field");
		expect(Object.hasOwn(copy, "list")).toBe(false);
	});
});
