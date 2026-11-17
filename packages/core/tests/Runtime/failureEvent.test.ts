import type { IActionGenerator, IActionYield } from "../../src/Types/IAction";
import type { IMessageOf } from "../../src/Types/IReceiver";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openResource } from "../../src/Effects/openResource";
import { parallel } from "../../src/Effects/parallel";
import { bind } from "../../src/Runtime/bind";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { receiver } from "../../src/Runtime/receiver";
import { settled } from "../../src/Testing/createTestRuntime";
import { unhandledDuring } from "../unhandledDuring";

interface IChild {
	$Id: string;
	Note: string;
}

interface IMiddle {
	$Id: string;
	Children: IChild[];
}

interface IRoot {
	$Id: string;
	Middles: IMiddle[];
}

type ICase = (draft: IMiddle, failure: IMessageOf<"Action/Error">) => Generator<any, void, any>;

const boom = new Error("boom");

const openResourceAny = openResource as unknown as (entity: object, key: string, ...rest: unknown[]) => IActionGenerator;

function* fails(_draft: IChild): IActionGenerator {
	throw boom;
}

function* wait(name: string): Generator<IActionYield, void, any> {
	yield {
		Type: "wait",
		Name: name
	} as IActionYield;
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function build(options: { middle?: ICase; onError?: boolean } = {}) {
	const gates = new Map<string, () => void>();
	const runtime = createRuntime<IRoot>(
		{
			$Id: "root",
			Middles: [
				{
					$Id: "middle",
					Children: [
						{
							$Id: "child",
							Note: ""
						}
					]
				}
			]
		},
		{
			...(options.onError === false
				? {}
				: {
						onError: () => {}
					}),
			implementations: {
				wait: (effect: { Name: string }) =>
					new Promise<void>((resolve) => {
						gates.set(effect.Name, resolve);
					})
			}
		}
	);
	const failures: IRuntimeEventOf<"failure">[] = [];
	runtime.on("failure", (event) => failures.push(event));
	const bound = async () => {
		if (options.middle) {
			const Middle = receiver<IMiddle>("MiddleErrorBoundary")({
				"Action/Error": options.middle
			});
			runtime.registerReceiver(Middle);
			await runtime.dispatch(function* bindMiddle(draft: IMiddle): IActionGenerator {
				bind(draft, Middle);
			}, "middle");
		}
	};
	return {
		runtime,
		failures,
		bound,
		open: (name: string) => gates.get(name)?.()
	};
}

describe("the failure event", () => {
	it("carries the failure an action ended with, taken by onError, once", async () => {
		const h = build();
		await h.runtime.dispatch(fails, "child").catch(() => {});
		await settled();
		expect(h.failures).toEqual([
			{
				Error: boom,
				ActionId: expect.any(String),
				ActionName: "fails",
				EntityId: "child",
				Status: "errored",
				Close: false,
				Taken: true
			}
		]);
	});

	it("says nothing took a failure that reached the top with no onError", async () => {
		const h = build({
			onError: false
		});
		const heard = await unhandledDuring(() => {
			void h.runtime.dispatch(fails, "child");
		});
		expect(heard).toEqual([
			boom
		]);
		expect(h.failures.map((failure) => failure.Taken)).toEqual([
			false
		]);
	});

	it("carries an error boundary's own failure beside the one it was handling, each once the route ends", async () => {
		const toast = new Error("toast failed");
		const h = build({
			middle: function* () {
				throw toast;
			}
		});
		await h.bound();
		await h.runtime.dispatch(fails, "child").catch(() => {});
		await settled();
		expect(
			h.failures.map((failure) => [
				failure.Error,
				failure.ActionName,
				failure.EntityId,
				failure.Taken,
				failure.Cause
			])
		).toEqual([
			[
				boom,
				"fails",
				"child",
				true,
				undefined
			],
			[
				toast,
				"MiddleErrorBoundary",
				"middle",
				true,
				boom
			]
		]);
	});

	it("fires when the route ends, behind an error boundary held by a long wait", async () => {
		const h = build({
			middle: function* () {}
		});
		await h.bound();
		function* holdsMiddle(_draft: IMiddle): IActionGenerator {
			yield* wait("hold");
		}
		void h.runtime.dispatch(holdsMiddle, "middle");
		await settled();
		void h.runtime.dispatch(fails, "child").catch(() => {});
		await settled();
		expect(h.failures).toEqual([]);
		h.open("hold");
		await settled();
		expect(
			h.failures.map((failure) => [
				failure.Error,
				failure.Taken
			])
		).toEqual([
			[
				boom,
				true
			]
		]);
	});

	it("carries a nested branch failure whose parallel had already been stopped by a sibling's failure, with no route", async () => {
		const h = build();
		const nested = new Error("nested");
		function* throwsAfter(name: string, error: Error): IActionGenerator {
			yield* wait(name);
			throw error;
		}
		function* both(_draft: IChild): IActionGenerator {
			yield* parallel(
				(function* (): IActionGenerator {
					yield* parallel(throwsAfter("inner", nested), wait("never"));
				})(),
				throwsAfter("outer", boom)
			);
		}
		const done = h.runtime.dispatch(both, "child").catch(() => {});
		await settled();
		h.open("inner");
		h.open("outer");
		await done;
		await settled();
		expect(
			h.failures
				.map((failure) => [
					failure.Error,
					failure.Status,
					failure.Close,
					failure.Taken
				])
				.sort((a, b) => Number(b[3]) - Number(a[3]))
		).toEqual([
			[
				boom,
				"errored",
				false,
				true
			],
			[
				nested,
				"errored",
				false,
				false
			]
		]);
	});

	it("leaves an r.run's failure to the promise it rejects, which the resource holds", async () => {
		const h = build();
		let run!: Promise<unknown>;
		(
			h.runtime as unknown as {
				registerResourceType(type: string, impl: (params: unknown, r: any) => void): void;
			}
		).registerResourceType("failure/run", (_params, r) => {
			run = r.run(
				(function* failsInRun(): IActionGenerator {
					throw boom;
				})()
			);
			run.catch(() => {});
		});
		await h.runtime.dispatch(function* opens(draft: IChild): IActionGenerator {
			yield* openResourceAny(draft, "Failure/Run", {
				Type: "failure/run"
			});
		}, "child");
		await settled();
		await expect(run).rejects.toBe(boom);
		expect(h.failures).toEqual([]);
	});

	it("isn't a handling channel: a subscriber's throw is a diag, and the failure is still taken where it was", async () => {
		const h = build();
		const diags: IRuntimeEventOf<"diag">[] = [];
		h.runtime.on("diag", (event) => diags.push(event));
		h.runtime.on("failure", () => {
			throw new Error("logger broke");
		});
		await h.runtime.dispatch(fails, "child").catch(() => {});
		await settled();
		expect(h.failures.map((failure) => failure.Taken)).toEqual([
			true
		]);
		expect(
			diags.map((diag) => [
				diag.code,
				diag.data?.source
			])
		).toEqual([
			[
				"runtime/callback-threw",
				'A "failure" subscriber'
			]
		]);
	});
});
